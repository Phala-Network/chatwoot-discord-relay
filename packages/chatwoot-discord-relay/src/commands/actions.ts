// Runs a deferred command against Chatwoot as the invoking agent, using that agent's own access
// token, so Chatwoot applies its normal permissions and records who did it.

import type { APIMessageTopLevelComponent } from "discord-api-types/v10";
import { BudgetExhaustedError, JobDeadlineError } from "../../../../shared/budget.ts";
import {
  type ChatwootClient,
  ChatwootError,
  chatwootClient,
  type Fetch,
  personAssignee,
  type StatusChange,
} from "../../../../shared/chatwoot/api.ts";
import { parallel } from "../../../../shared/concurrent.ts";
import { errorFields, log } from "../../../../shared/log.ts";
import type { RateLimitStore } from "../../../../shared/rate-limit.ts";
import type { Settings } from "../config.ts";
import { clip, defused } from "../relay/format.ts";
import { downloadAttachment } from "./attachments.ts";
import { FAILED, filesTooLarge, NOT_LINKED, UNKNOWN_RESULT, UserError } from "./common.ts";
import { assigneeMenu, panel } from "./components.ts";
import { PRIORITY_NAMES } from "./definitions.ts";
import type { CommandAction, CommandJob } from "./job.ts";

export interface CommandResult {
  /** The confirmation shown to the invoker (only they see it). */
  content: string;
  /**
   * What goes with the result: Assign to's menu, or the Manage panel drawn again with the ticket as
   * it is now (a Components V2 message; see respond in hub.ts).
   */
  components?: APIMessageTopLevelComponent[] | undefined;
  /** Chatwoot could not find the conversation: it may have been deleted. */
  conversationGone: boolean;
  confirmed?: boolean | undefined;
}

export interface CommandExecution {
  settings: Settings;
  fetch: Fetch;
  limits?: RateLimitStore;
  retryable?: () => boolean;
  confirmUnknown?: (chatwoot: ChatwootClient, action: CommandAction) => Promise<string | undefined>;
  deferPanel?: boolean;
  attachment?: (
    file: CommandJob["action"] & { type: "message" },
    index: number,
  ) => Promise<{ blob: Blob; filename: string }>;
}

export async function executeCommand(job: CommandJob, execution: CommandExecution): Promise<CommandResult> {
  const { settings, fetch, limits, retryable, confirmUnknown, attachment, deferPanel = false } = execution;
  // The link is checked again here: it may have changed since the command was queued.
  const chatwootUserId = settings.chatwootUserFor(job.discordUserId);
  const token = settings.agentToken(job.discordUserId);
  if (chatwootUserId === undefined || !token) return { content: `❌ ${NOT_LINKED}`, conversationGone: false };
  const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, token, fetch, limits);
  const { accountId, conversationId, action } = job;

  try {
    const profile = await chatwoot.getProfile();
    if (profile.id === undefined) throw new UserError(NOT_LINKED);
    // A token stored for the wrong Discord user would act as someone else.
    if (profile.id !== chatwootUserId) {
      log.error("agent token belongs to another Chatwoot user", { discordUserId: job.discordUserId, chatwootUserId });
      throw new UserError(TOKEN_MISMATCH);
    }
    // The token works, but its user was removed from the account (or never was in it).
    if (!profile.accounts?.some((account) => account.id === accountId)) throw new UserError(NOT_IN_ACCOUNT);

    let message = "";
    switch (action.type) {
      case "panel":
        break;
      case "pick-assignee": {
        const [conversation, agents] = await parallel(
          existing(chatwoot.getConversation(accountId, conversationId)),
          chatwoot.listAgents(accountId),
        );
        const ticket = `${settings.account(accountId)?.name ?? "Ticket"} #${conversationId}`;
        return {
          content: `👤 Assign **${ticket}** to:`,
          components: assigneeMenu(named(agents), personAssignee(conversation)?.id ?? null),
          conversationGone: false,
          confirmed: true,
        };
      }
      case "labels": {
        const [known, conversation] = await parallel(
          chatwoot.listLabels(accountId),
          existing(chatwoot.getConversation(accountId, conversationId)),
        );
        const unknown = action.labels.find((label) => !known.includes(label));
        if (unknown !== undefined) throw new UserError(`There is no label "${unknown}" in this Chatwoot account.`);
        // The panel sets the topic label; the ticket's kinds stay.
        const kinds = kindLabels(settings);
        const kept = (conversation.labels ?? []).filter((label) => kinds.has(label) && !action.labels.includes(label));
        await chatwoot.setLabels(accountId, conversationId, [...action.labels, ...kept]);
        message = action.labels.length > 0 ? `Label set to ${action.labels.join(", ")}.` : "Labels removed.";
        break;
      }
      case "status": {
        const { status, snoozedUntil } = action;
        if (status === "pending") {
          const conversation = await existing(chatwoot.getConversation(accountId, conversationId));
          if (conversation.inbox_id === undefined) throw new UserError("This conversation has no inbox.");
          const bot = await chatwoot.inboxBot(accountId, conversation.inbox_id);
          if (bot) {
            await chatwoot.assign(accountId, conversationId, bot.id, "AgentBot");
            message = "Handed back to the inbox bot.";
            break;
          }
        }
        await chatwoot.setStatus(
          accountId,
          conversationId,
          snoozedUntil === undefined ? { status } : { status, snoozed_until: snoozedUntil },
        );
        message = statusMessage(status, snoozedUntil);
        break;
      }
      case "priority":
        await chatwoot.setPriority(accountId, conversationId, action.priority);
        message = action.priority ? `Priority set to ${PRIORITY_NAMES[action.priority]}.` : "Priority removed.";
        break;
      case "block": {
        // What Chatwoot's "Block contact" does (Conversation#mute!), through the documented API:
        // resolve the conversation and set the contact's `blocked` flag.
        const contactId = (await existing(chatwoot.getConversation(accountId, conversationId))).meta?.sender?.id;
        if (contactId === undefined) throw new UserError("This conversation has no contact to block.");
        await chatwoot.setStatus(accountId, conversationId, { status: "resolved" });
        await chatwoot.setContactBlocked(accountId, contactId, true);
        message = "Contact blocked and conversation resolved. Their new messages will not be posted here.";
        break;
      }
      case "unblock": {
        // Chatwoot's "Unblock contact": clears the contact's `blocked` flag; the conversation stays as it is.
        const contactId = (await existing(chatwoot.getConversation(accountId, conversationId))).meta?.sender?.id;
        if (contactId === undefined) throw new UserError("This conversation has no contact to unblock.");
        await chatwoot.setContactBlocked(accountId, contactId, false);
        message = "Contact unblocked. Their new messages will be posted here again.";
        break;
      }
      case "assign": {
        // Chatwoot assigns a user who is not an agent of the account as no one (it unassigns:
        // Conversations::AssignmentService at v4.18.0), so membership is checked first.
        const agents = await chatwoot.listAgents(accountId);
        const assignee = agents.find((agent) => agent.id === action.chatwootUserId);
        if (!assignee) throw new UserError("That agent is not in this Chatwoot account.");
        await chatwoot.assign(accountId, conversationId, action.chatwootUserId);
        // The name Chatwoot shows as the assignee, which is also the post's assignee tag.
        message = `Assigned to ${assignee.name ?? "the agent"}.`;
        break;
      }
      case "unassign":
        await chatwoot.unassign(accountId, conversationId);
        message = "Unassigned.";
        break;
      case "label": {
        // Chatwoot sets a conversation's labels as a whole list.
        const { change, label } = action;
        const [current, known] = await parallel(
          chatwoot.conversationLabels(accountId, conversationId),
          change === "add" ? chatwoot.listLabels(accountId) : Promise.resolve([]),
        );
        if (change === "add") {
          if (!known.includes(label)) throw new UserError(`There is no label "${label}" in this Chatwoot account.`);
          if (!current.includes(label)) await chatwoot.setLabels(accountId, conversationId, [...current, label]);
          message = `Label ${label} added.`;
        } else {
          if (!current.includes(label)) throw new UserError(`This conversation has no label "${label}".`);
          await chatwoot.setLabels(
            accountId,
            conversationId,
            current.filter((name) => name !== label),
          );
          message = `Label ${label} removed.`;
        }
        break;
      }
      case "message": {
        const limits = settings.config.attachments;
        const files = [];
        let total = 0;
        for (const [index, file] of action.files.entries()) {
          const downloaded = attachment
            ? await attachment(action, index)
            : await downloadAttachment(file, limits.maxFileBytes, fetch);
          total += downloaded.blob.size;
          if (total > limits.maxTotalBytes) throw filesTooLarge(limits.maxTotalBytes);
          files.push(downloaded);
        }
        if (!action.private) {
          const conversation = await existing(chatwoot.getConversation(accountId, conversationId));
          // Chatwoot accepts the message but the channel would fail it, e.g. after WhatsApp's
          // 24-hour window (Conversations::MessageWindowService at v4.18.0).
          if (conversation.can_reply === false) throw new UserError(CANNOT_REPLY);
          // A public reply to an unassigned conversation assigns it to the replying agent.
          if (!personAssignee(conversation)) await chatwoot.assign(accountId, conversationId, profile.id);
        }
        await chatwoot.createMessage(accountId, conversationId, {
          content: action.content,
          private: action.private,
          files,
          // Only a Chatwoot build that reads it sends from the agent's address.
          sendAsAgent: settings.config.chatwoot.sendAsAgent && action.sendAsAgent === true,
        });
        // Customers see an agent's display name (`available_name`).
        message = action.private ? "Note added." : `Sent to the customer as ${profile.available_name || profile.name}.`;
        break;
      }
    }
    log.info("command done", { action: action.type, discordUserId: job.discordUserId, accountId, conversationId });
    if ((job.panel === true && !deferPanel) || action.type === "panel") {
      const ticket = `${settings.account(accountId)?.name ?? "Ticket"} #${conversationId}`;
      return {
        content: message ? `✅ ${message}` : ticket,
        components: await drawPanel(chatwoot, accountId, conversationId, ticket, message, settings),
        conversationGone: false,
        confirmed: true,
      };
    }
    return { content: `✅ ${message}`, conversationGone: false, confirmed: true };
  } catch (error) {
    const tracked = typeof retryable === "function";
    const canRetry = retryable?.() ?? false;
    if (
      tracked &&
      !canRetry &&
      ((error instanceof ChatwootError && error.status >= 500) ||
        error instanceof TypeError ||
        (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) ||
        error instanceof JobDeadlineError)
    ) {
      const confirmed = await confirmUnknown?.(chatwoot, action);
      if (confirmed !== undefined) return { content: `✅ ${confirmed}`, conversationGone: false, confirmed: true };
      return { content: UNKNOWN_RESULT, conversationGone: false };
    }
    if (
      tracked &&
      canRetry &&
      (error instanceof TypeError ||
        error instanceof BudgetExhaustedError ||
        error instanceof JobDeadlineError ||
        (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) ||
        (error instanceof ChatwootError && (error.status === 429 || error.status >= 500)))
    )
      throw error;
    const gone = error instanceof ConversationGoneError || (error instanceof ChatwootError && error.status === 404);
    return {
      content:
        tracked && !canRetry && !(error instanceof ChatwootError) && !(error instanceof UserError)
          ? UNKNOWN_RESULT
          : failure(error, job),
      conversationGone: gone,
    };
  }
}

function failure(error: unknown, { action, accountId, conversationId }: CommandJob): string {
  if (error instanceof UserError) return `❌ ${error.message}`;
  if (error instanceof ChatwootError && error.status === 401) {
    return "❌ Chatwoot rejected your access token. Ask an admin to update it.";
  }
  if (error instanceof ChatwootError && (error.status === 403 || error.status === 404)) {
    return "❌ You do not have access to this conversation.";
  }
  log.error("command failed", { action: action.type, accountId, conversationId, ...errorFields(error) });
  // A request that timed out may still have been carried out.
  if (
    error instanceof JobDeadlineError ||
    (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name))
  )
    return TIMED_OUT;
  return FAILED;
}

const TIMED_OUT =
  "❌ Chatwoot or Discord did not answer in time. Check in Chatwoot whether it was done before trying again.";

/** Longest customer name in the panel's title. */
const CUSTOMER_NAME_LIMIT = 60;

/** The Manage panel for the conversation as it is now. */
async function drawPanel(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  ticket: string,
  done: string,
  settings: Settings,
): Promise<APIMessageTopLevelComponent[]> {
  const [conversation, agents, known] = await parallel(
    existing(chatwoot.getConversation(accountId, conversationId)),
    chatwoot.listAgents(accountId),
    chatwoot.listLabels(accountId),
  );
  const kinds = kindLabels(settings);
  // Its label menu is for the topic: kinds are labels of their own (recorded by chatwoot-router).
  const topics = (labels: string[]) => labels.filter((label) => !kinds.has(label));
  const labels = topics(known);
  // The customer's name is their own text: it must not mention anyone.
  const customer = defused(clip(conversation.meta?.sender?.name ?? "", CUSTOMER_NAME_LIMIT));
  const title = `### ${customer ? `${ticket} · ${customer}` : ticket}`;
  return panel(
    done ? `${title}\n✅ ${done}` : title,
    {
      assigneeId: personAssignee(conversation)?.id ?? null,
      labels: topics(conversation.labels ?? []),
      status: conversation.status ?? "open",
    },
    named(agents),
    labels,
  );
}

/** The account's agents, each with a name to show. */
function named(agents: Array<{ id?: number; name?: string }>): Array<{ id: number; name: string }> {
  return agents.flatMap((agent) =>
    agent.id === undefined ? [] : [{ id: agent.id, name: agent.name ?? `#${agent.id}` }],
  );
}

export function statusMessage(status: StatusChange["status"], snoozedUntil: number | undefined): string {
  switch (status) {
    case "open":
      return "Reopened.";
    case "resolved":
      return "Resolved.";
    case "pending":
      return "Marked as pending.";
    case "snoozed":
      // Discord shows the timestamp in each reader's own time zone.
      return snoozedUntil === undefined ? "Snoozed until the next reply." : `Snoozed until <t:${snoozedUntil}:f>.`;
  }
}

const TOKEN_MISMATCH =
  "Your Chatwoot access token belongs to another Chatwoot user, so nothing was done. Ask an admin to fix your link.";

const NOT_IN_ACCOUNT =
  "Your Chatwoot user is no longer an agent in this Chatwoot account. Ask an admin to add you back, or to unlink your Discord account.";

const CANNOT_REPLY =
  "This conversation's channel does not accept a reply right now (for example, its reply window has closed). Reply in Chatwoot, for example with a template.";

class ConversationGoneError extends UserError {
  constructor() {
    super("This conversation no longer exists in Chatwoot.");
  }
}

async function existing<T>(conversation: Promise<T | undefined>): Promise<T> {
  const found = await conversation;
  if (found === undefined) throw new ConversationGoneError();
  return found;
}

function kindLabels(settings: Settings): ReadonlySet<string> {
  return new Set(settings.config.router?.keepLabels ?? []);
}

export async function commandPanel(
  job: CommandJob,
  result: CommandResult,
  settings: Settings,
  fetch: Fetch,
  limits?: RateLimitStore,
): Promise<APIMessageTopLevelComponent[] | undefined> {
  if (!job.panel || result.components || result.confirmed !== true) return undefined;
  const token = settings.agentToken(job.discordUserId);
  const userId = settings.chatwootUserFor(job.discordUserId);
  if (!token || userId === undefined) return undefined;
  const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, token, fetch, limits);
  const profile = await chatwoot.getProfile();
  if (profile.id !== userId || !profile.accounts?.some((account) => account.id === job.accountId)) return undefined;
  const ticket = `${settings.account(job.accountId)?.name ?? "Ticket"} #${job.conversationId}`;
  return drawPanel(chatwoot, job.accountId, job.conversationId, ticket, result.content.slice(2).trim(), settings);
}
