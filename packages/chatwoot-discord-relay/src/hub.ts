// The single Durable Object that owns all state and does all background work.
//
// Requests (webhook events, deferred commands, sweeps) only write a job row and set an
// alarm, so they return quickly. The alarm drains due jobs one at a time, which serializes work
// per conversation (and globally), and yields to a fresh invocation before it would exceed the
// per-invocation subrequest limit. Commands run at most once; failed background jobs back off (up
// to 30 minutes) and retry until they succeed, so an outage of any length loses no background
// work; nothing depends on a single delivery succeeding.

import { DurableObject } from "cloudflare:workers";
import {
  type APIInteraction,
  type APIMessageTopLevelComponent,
  ComponentType,
  MessageFlags,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  Routes,
} from "discord-api-types/v10";
import { z } from "zod";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import {
  Budget,
  BudgetExhaustedError,
  JobDeadlineError,
  METADATA_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
} from "../../../shared/budget.ts";
import { ChatwootError, chatwootClient, toRelayConversation } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { retryDelay } from "../../../shared/store.ts";
import { type CommandExecution, commandPanel, executeCommand, statusMessage } from "./commands/actions.ts";
import { downloadAttachment } from "./commands/attachments.ts";
import { UNKNOWN_RESULT } from "./commands/common.ts";
import { text } from "./commands/components.ts";
import { type HandlerResult, handleInteraction } from "./commands/handler.ts";
import { type CommandAction, type CommandJob, commandJobSchema } from "./commands/job.ts";
import { relaysInbox, type Settings } from "./config.ts";
import { DiscordForum } from "./discord/forum.ts";
import { DiscordHttpError, DiscordRest } from "./discord/rest.ts";
import type { Env } from "./env.ts";
import { postQueue } from "./queue.ts";
import {
  latestMessageId,
  type ProcessorContext,
  processConversation,
  refreshMetadata,
  relayFor,
} from "./relay/processor.ts";
import { processMessageUpdate } from "./relay/updates.ts";
import { loadSettings } from "./settings.ts";
import { type Job, Store } from "./store.ts";

export const HUB_NAME = "global";

const id = z.number().int().positive();
const resultSchema = z.object({
  content: z.string(),
  conversationGone: z.boolean(),
  confirmed: z.boolean().optional(),
  components: z
    .array(
      z.custom<APIMessageTopLevelComponent>((value) => typeof value === "object" && value !== null && "type" in value),
    )
    .optional(),
});
const payloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), job: commandJobSchema }),
  z.object({ type: z.literal("feedback"), job: commandJobSchema, result: resultSchema, expiresAt: z.number() }),
  z.object({ type: z.literal("sync"), accountId: id, conversationId: id }),
  z.object({
    type: z.literal("metadata"),
    accountId: id,
    inboxId: id.optional(),
    discordUserId: z.string().optional(),
  }),
  z.object({ type: z.literal("sweep"), accountId: id }),
  z.object({ type: z.literal("conversation"), accountId: id, conversationId: id }),
  z.object({ type: z.literal("message-updated"), accountId: id, conversationId: id, messageId: id }),
  z.object({ type: z.literal("queue") }),
  z.object({ type: z.literal("answer"), accountId: id, conversationId: id, answerId: z.string(), replyTo: z.string() }),
]);
type JobPayload = z.infer<typeof payloadSchema>;

const PRIORITY = {
  command: 1,
  answer: 2,
  feedback: 0,
  sync: 2,
  conversation: 2,
  "message-updated": 2,
  sweep: 3,
  queue: 4,
  metadata: 5,
} as const;
/** Requests a job may need before it can start without being cut short. */
const COMMAND_BUDGET = 20;
const MIN_BUDGET = 2;
const sweepPassSchema = z.object({ cutoff: z.number(), page: z.number().int().positive(), startedAt: z.number() });
const PASS_TTL_MS = 24 * 60 * 60 * 1000;
/** Commands that change nothing in Chatwoot: their post needs no sync. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(["panel", "pick-assignee"]);
/** A job that takes longer than this is logged, to tell a slow upstream from a busy queue. */
const SLOW_JOB_MS = 5000;
/** Posts without a card a sweep queues at most, and how long before one is queued again. */
const CARD_BACKFILL_PER_SWEEP = 10;
const CARD_BACKFILL_RETRY_MS = 24 * 60 * 60 * 1000;
/** Stop draining and continue in a new invocation after this long (alarms may run 15 minutes). */
const RUN_WALL_MS = 5 * 60 * 1000;
/**
 * Discord interaction tokens are valid for 15 minutes. A command that cannot start within this
 * time is dropped, and the invoker is told while the token still works: running it later could
 * not report its result, and the invoker may already have acted in Chatwoot, so running it
 * could, for example, send a reply twice.
 */
const COMMAND_START_DEADLINE_MS = 12 * 60 * 1000;
const EXPIRED = "❌ This could not start in time, so nothing was done. Please try again.";
/** How long a triage answer's draft is kept for Reply with draft, and the answer remembered. */
const ANSWER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** How long the support queue may be posted after it is due: Discord's nonce check covers a few minutes. */
const QUEUE_RETRY_MS = 3 * 60 * 1000;

export class Hub extends DurableObject<Env> {
  private readonly store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.store.migrate();
  }

  /**
   * Queues a conversation for syncing, at the earliest after `delayMs`.
   */
  async enqueueConversation(accountId: number, conversationId: number, delayMs = 0): Promise<void> {
    this.enqueue({ type: "conversation", accountId, conversationId }, Date.now() + delayMs);
    if (delayMs > 0) this.enqueue({ type: "sync", accountId, conversationId });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /**
   * Queues a check of a message reported as deleted (its Discord messages are removed), as
   * answered by the customer (the response is posted), or with a changed outgoing delivery status.
   */
  async enqueueMessageUpdate(accountId: number, conversationId: number, messageId: number): Promise<void> {
    // Do this on receipt: the conversation job runs before the message-update job.
    if (this.store.invalidateAnswerScans(accountId, conversationId)) {
      this.enqueue({ type: "conversation", accountId, conversationId });
    }
    this.enqueue({ type: "message-updated", accountId, conversationId, messageId });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  async interaction(interaction: APIInteraction): Promise<HandlerResult["response"]> {
    const settings = await loadSettings(this.env);
    const result = await handleInteraction(interaction, {
      settings,
      ticketForThread: async (threadId) => this.store.ticketForThread(threadId),
      draftOf: async (_threadId, answerId) => {
        const draft = this.store.get(answerKey(answerId));
        return draft === undefined ? { missing: "unreadable" as const } : { text: draft };
      },
    });
    if (result.job) await this.enqueueCommand(result.job);
    return result.response;
  }

  /** Queues a command once per interaction: a repeated (replayed) request is ignored. */
  async enqueueCommand(job: CommandJob): Promise<void> {
    if (!this.store.acceptInteraction(job.interactionId)) {
      log.warn("repeated interaction ignored", { interactionId: job.interactionId });
      return;
    }
    this.enqueue({ type: "command", job });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /** Queues a reconciliation sweep for every configured account (called by the cron trigger). */
  async requestSweep(): Promise<void> {
    this.store.wakeHeldJobs();
    for (const account of (await loadSettings(this.env)).config.accounts)
      this.enqueue({ type: "sweep", accountId: account.id });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /** Queues the hourly support queue, if configured (called by the cron trigger at minute 0). */
  async requestQueue(): Promise<void> {
    if (!(await loadSettings(this.env)).config.queue) return;
    this.enqueue({ type: "queue" });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  /**
   * The triage bot's answer `answerId` to message `replyTo` is in the post, with the reply draft it proposes: the
   * draft is kept for Reply with draft, and the post's card offers it under the answer (Relay.answered).
   * Each answer is taken once, so a repeated call adds nothing.
   */
  async triageAnswered(threadId: string, answerId: string, replyTo: string, draft: string): Promise<void> {
    const ticket = this.store.ticketForThread(threadId);
    if (!ticket || this.store.get(answerKey(answerId)) !== undefined) return;
    this.store.set(answerKey(answerId), draft, ANSWER_TTL_MS);
    this.enqueue({ type: "answer", ...ticket, answerId, replyTo });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  async ticketForThread(threadId: string): Promise<{ accountId: number; conversationId: number } | null> {
    return this.store.ticketForThread(threadId) ?? null;
  }

  /** Cloudflare runs at most one alarm() at a time per Durable Object. */
  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.relay.subrequestBudget);
    const services = this.services(settings, budget);
    const startedAt = Date.now();
    let yielded = false;

    this.store.prune();
    for (let job = this.store.nextDueJob(); job; job = this.store.nextDueJob()) {
      const parsed = payloadSchema.safeParse(parseJson(job.payload));
      if (!parsed.success) {
        log.warn("unreadable job dropped", { job: job.key });
        this.store.deleteJob(job.key);
        continue;
      }
      const payload = parsed.data;
      if (budget.remaining < requiredBudget(payload) || Date.now() - startedAt > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      budget.startSlice();
      const jobStarted = Date.now();
      const outcome = await this.run(job, payload, services);
      const ms = Date.now() - jobStarted;
      if (ms > SLOW_JOB_MS) log.warn("slow job", { job: job.key, ms });
      if (outcome === "yield") {
        this.store.deferJob(job);
        yielded = true;
        break;
      }
    }
    await scheduleAlarm(this.ctx, yielded ? Date.now() : this.store.nextWakeup());
  }

  private async run(job: Job, payload: JobPayload, services: ProcessorContext): Promise<"done" | "yield"> {
    try {
      switch (payload.type) {
        case "command": {
          const saved = resultSchema.safeParse(
            parseJson(this.store.get(`command:${payload.job.interactionId}:result`)),
          );
          const attempted = this.store.get(`command:${payload.job.interactionId}:started`) !== undefined;
          const result = saved.success
            ? saved.data
            : attempted
              ? { content: UNKNOWN_RESULT, conversationGone: false }
              : Date.now() - job.createdAt > COMMAND_START_DEADLINE_MS
                ? { content: EXPIRED, conversationGone: false }
                : await this.runCommand(payload.job, services);
          this.store.set(`command:${payload.job.interactionId}:result`, JSON.stringify(result), 60 * 60 * 1000);
          this.enqueue({ type: "feedback", job: payload.job, result, expiresAt: job.createdAt + 15 * 60 * 1000 });
          if (result.conversationGone)
            this.enqueue({
              type: "conversation",
              accountId: payload.job.accountId,
              conversationId: payload.job.conversationId,
            });
          else if (result.content !== EXPIRED && !READ_ONLY_ACTIONS.has(payload.job.action.type))
            this.enqueue({
              type: "sync",
              accountId: payload.job.accountId,
              conversationId: payload.job.conversationId,
            });
          this.store.clearCommandFiles(payload.job.interactionId);
          this.store.completeJob(job);
          return "done";
        }
        case "feedback": {
          if (Date.now() < payload.expiresAt) {
            await respond(services.rest, payload.job, payload.result.content, payload.result.components);
            if (payload.result.confirmed === true && !payload.result.components) {
              try {
                const components = await commandPanel(
                  payload.job,
                  payload.result,
                  services.settings,
                  services.budget.fetch,
                  this.store,
                );
                if (components) await respond(services.rest, payload.job, payload.result.content, components);
              } catch (error) {
                log.warn("optional command panel failed", {
                  interactionId: payload.job.interactionId,
                  ...errorFields(error),
                });
              }
            }
          }
          this.store.completeJob(job);
          return "done";
        }
        case "sync":
          await this.syncAfterCommand(payload, services);
          this.store.completeJob(job);
          return "done";
        case "metadata":
          await refreshMetadata(services, payload);
          this.store.completeJob(job);
          return "done";
        case "sweep":
          await this.sweep(payload.accountId, services);
          this.store.completeJob(job);
          return "done";
        case "conversation": {
          const outcome = await processConversation(services, payload.accountId, payload.conversationId);
          if (outcome === "pending") {
            this.store.holdJob(job);
            return "done";
          }
          if (outcome === "done") this.store.completeJob(job);
          return outcome;
        }
        case "message-updated":
          await processMessageUpdate(services, payload.accountId, payload.conversationId, payload.messageId);
          this.store.completeJob(job);
          return "done";
        case "queue":
          // Discord drops a repeated post by its nonce only for a few minutes: however the job
          // is retried or deferred, nothing is posted after that, so the queue and its pings are
          // never posted twice (the next hour's queue lists the same tickets). The run keeps the
          // job's time, so every attempt posts the same messages with the same nonces.
          if ((await postQueue(services, job.createdAt, job.createdAt + QUEUE_RETRY_MS)) === "yield") return "yield";
          this.store.completeJob(job);
          return "done";
        case "answer":
          // The card moves under the answer when the conversation's post is synced next.
          services.relay.answered(payload.accountId, payload.conversationId, payload.answerId, payload.replyTo);
          this.store.completeJob(job);
          this.enqueue({ type: "conversation", accountId: payload.accountId, conversationId: payload.conversationId });
          return "done";
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof JobDeadlineError) return "yield";
      const backoff = retryDelay(job.attempts);
      if ((error instanceof DiscordHttpError || error instanceof ChatwootError) && error.retryAfterMs !== undefined) {
        // Rate limited: wait as long as Discord asks without counting an attempt, so no rate
        // limit, however long, drops the job.
        const delay = error.retryAfterMs;
        log.warn("job rate limited; will retry", { job: job.key, delayMs: delay });
        this.store.deferJob(job, delay);
        return "done";
      }
      // Transient failures are warnings; a job that keeps failing is an error.
      const logAt = job.attempts + 1 >= 3 ? log.error : log.warn;
      logAt("job failed; will retry", {
        job: job.key,
        attempts: job.attempts + 1,
        delayMs: backoff,
        ...errorFields(error),
      });
      this.store.retryJob(job, backoff);
      return "done";
    }
  }

  private async runCommand(job: CommandJob, services: ProcessorContext) {
    const key = `command:${job.interactionId}:started`;
    const token = services.settings.agentToken(job.discordUserId);
    let beforeLabels: string[] | undefined;
    if (token && ["label", "labels"].includes(job.action.type)) {
      const beforeClient = chatwootClient(
        services.settings.config.chatwoot.baseUrl,
        token,
        services.budget.fetchWith(METADATA_TIMEOUT_MS),
        this.store,
      );
      const before = await beforeClient.getConversation(job.accountId, job.conversationId);
      if (before) beforeLabels = await beforeClient.conversationLabels(job.accountId, job.conversationId);
    }
    let confirmed = false;
    const fetch = async (request: Request) => {
      services.budget.checkpoint();
      if (services.budget.remaining < 1) throw new BudgetExhaustedError();
      const mutation = request.method !== "GET" && request.method !== "HEAD";
      if (mutation) {
        services.budget.requireTime(
          request.headers.get("content-type")?.startsWith("multipart/form-data")
            ? TRANSFER_TIMEOUT_MS
            : METADATA_TIMEOUT_MS,
        );
        this.store.set(key, "unknown", 60 * 60 * 1000);
      }
      const response = await services.budget.fetchWith(
        request.headers.get("content-type")?.startsWith("multipart/form-data")
          ? TRANSFER_TIMEOUT_MS
          : METADATA_TIMEOUT_MS,
      )(request);
      if (mutation && response.status === 429 && !confirmed) this.store.delete(key);
      if (mutation && response.ok) confirmed = true;
      return response;
    };
    const execution: CommandExecution = {
      settings: services.settings,
      fetch,
      limits: this.store,
      retryable: () => this.store.get(key) === undefined,
      confirmUnknown: (chatwoot, action) =>
        this.confirmUnknownCommand(chatwoot, job, action, services.settings, beforeLabels),
      deferPanel: true,
      attachment: async (action, index) => {
        const file = action.files[index];
        if (!file) throw new Error("Missing command attachment");
        services.budget.checkpoint();
        const cached = this.store.commandFile(job.interactionId, index, file.contentType || "application/octet-stream");
        if (cached) return { blob: cached, filename: file.filename || "attachment" };
        const downloaded = await downloadAttachment(
          file,
          services.settings.config.attachments.maxFileBytes,
          services.budget.fetchWith(TRANSFER_TIMEOUT_MS),
        );
        await this.store.saveCommandFile(job.interactionId, index, downloaded.blob);
        return downloaded;
      },
    };
    return executeCommand(job, execution);
  }

  private async confirmUnknownCommand(
    chatwoot: ReturnType<typeof chatwootClient>,
    job: CommandJob,
    action: CommandAction,
    settings: Settings,
    beforeLabels: string[] | undefined,
  ): Promise<string | undefined> {
    try {
      const conversation = await chatwoot.getConversation(job.accountId, job.conversationId);
      if (!conversation) return undefined;
      switch (action.type) {
        case "status":
          if (action.status === "pending" && conversation.inbox_id !== undefined) {
            const bot = await chatwoot.inboxBot(job.accountId, conversation.inbox_id);
            if (bot) {
              if (conversation.meta?.assignee_type !== "AgentBot" || conversation.meta.assignee?.id !== bot.id)
                return undefined;
              return "Handed back to the inbox bot.";
            }
          }
          if (String(conversation.status) !== action.status) return undefined;
          if (action.status === "snoozed" && (conversation.snoozed_until ?? undefined) !== action.snoozedUntil)
            return undefined;
          return statusMessage(action.status, action.snoozedUntil);
        case "priority":
          if (conversation.priority === action.priority)
            return action.priority ? `Priority set to ${action.priority}.` : "Priority removed.";
          return undefined;
        case "assign":
          if (conversation.meta?.assignee?.id === action.chatwootUserId && conversation.meta?.assignee_type === "User")
            return `Assigned to the agent.`;
          return undefined;
        case "unassign":
          return conversation.meta?.assignee ? undefined : "Unassigned.";
        case "label": {
          if (beforeLabels === undefined) return undefined;
          const labels = await chatwoot.conversationLabels(job.accountId, job.conversationId);
          const expected =
            action.change === "add"
              ? [...new Set([...beforeLabels, action.label])]
              : beforeLabels.filter((label) => label !== action.label);
          if (sameLabels(labels, expected))
            return action.change === "add" ? `Label ${action.label} added.` : `Label ${action.label} removed.`;
          return undefined;
        }
        case "labels": {
          if (beforeLabels === undefined) return undefined;
          const labels = await chatwoot.conversationLabels(job.accountId, job.conversationId);
          const kinds = new Set(settings.config.router?.keepLabels ?? []);
          const expected = [...new Set([...action.labels, ...beforeLabels.filter((label) => kinds.has(label))])];
          if (sameLabels(labels, expected))
            return action.labels.length > 0 ? `Label set to ${action.labels.join(", ")}.` : "Labels removed.";
          return undefined;
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async syncAfterCommand(
    job: { accountId: number; conversationId: number },
    { chatwoot, relay }: ProcessorContext,
  ): Promise<void> {
    const { accountId, conversationId } = job;
    const threadId = this.store.conversation(accountId, conversationId)?.threadId;
    if (!threadId) return;
    const conversation = await chatwoot.getConversation(accountId, conversationId);
    if (conversation) await relay.sync(accountId, toRelayConversation(conversationId, conversation), threadId);
  }

  /**
   * Finds conversations whose post is behind (new messages, or tags/status/archive state that
   * differ) and queues them. Covers webhooks that were never delivered and service downtime.
   * A pass reads conversations newest activity first, down to the start of its window (since the
   * previous pass started, at least `lookbackSeconds`, at most `maxCatchUpSeconds`), one page
   * per job, continuing where it stopped until it is done. Activity means a new message
   * (Chatwoot's `last_activity_at`); a change that creates none, such as only a custom
   * attribute, relies on its webhook. Once a pass it also queues posts still without a card
   * (backfillCards).
   */
  private async sweep(accountId: number, { settings, chatwoot, relay }: ProcessorContext): Promise<void> {
    const key = `sweep:${accountId}:pass`;
    const saved = sweepPassSchema.safeParse(parseJson(this.store.get(key)));
    const now = Date.now();
    const last = Number(this.store.get(`sweep:${accountId}:last`) ?? 0);
    const { lookbackSeconds, maxCatchUpSeconds } = settings.config.reconcile;
    const window = Math.min(
      Math.max(last > 0 ? (now - last) / 1000 + 60 : lookbackSeconds, lookbackSeconds),
      maxCatchUpSeconds,
    );
    const pass = saved.success ? saved.data : { cutoff: now / 1000 - window, page: 1, startedAt: now };
    const account = settings.account(accountId);
    let seen = 0;
    let queued = 0;
    const conversations = await chatwoot.listConversations(accountId, pass.page);
    let reachedCutoff = conversations.length === 0;
    for (const conversation of conversations) {
      if ((conversation.last_activity_at ?? 0) < pass.cutoff) {
        reachedCutoff = true;
        break;
      }
      const conversationId = conversation.id;
      if (conversationId === undefined || !account || !relaysInbox(account, conversation.inbox_id)) continue;
      seen += 1;
      const row = this.store.conversation(accountId, conversationId);
      const latest = latestMessageId(conversation);
      const needsCursor = row?.threadId !== undefined && row.cursor === undefined;
      const cursor = row?.cursor ?? settings.config.relay.startAfterMessageId;
      const behind = needsCursor || (latest !== undefined && latest > cursor);
      const stale =
        row?.threadId !== undefined &&
        (row.state !== relay.stateOf(toRelayConversation(conversationId, conversation)) || row.cardCovered === 1);
      if (behind || stale) {
        this.enqueue({ type: "conversation", accountId, conversationId });
        queued += 1;
      }
    }
    if (pass.page === 1) queued += this.backfillCards(accountId);
    if (reachedCutoff) {
      // The next pass covers list movement while this pass ran.
      this.store.set(`sweep:${accountId}:last`, String(pass.startedAt));
      this.store.delete(key);
      log.info("sweep done", { accountId, pages: pass.page, seen, queued });
    } else {
      this.store.set(key, JSON.stringify({ ...pass, page: pass.page + 1 }), PASS_TTL_MS);
      this.enqueue({ type: "sweep", accountId });
      log.info("sweep continues", { accountId, nextPage: pass.page + 1, seen, queued });
    }
  }

  /**
   * Queues a few of the account's posts without a card (from before cards) whose ticket is not
   * resolved, however long ago their last activity, each at most once a day. Returns how many.
   */
  private backfillCards(accountId: number): number {
    const ids = this.store.takePostsWithoutCard(accountId, CARD_BACKFILL_PER_SWEEP, CARD_BACKFILL_RETRY_MS);
    for (const conversationId of ids) this.enqueue({ type: "conversation", accountId, conversationId });
    return ids.length;
  }

  private services(settings: Settings, budget: Budget): ProcessorContext {
    const rest = new DiscordRest(settings.secrets.DISCORD_BOT_TOKEN, budget.fetch, this.store);
    const chatwoot = chatwootClient(
      settings.config.chatwoot.baseUrl,
      settings.secrets.CHATWOOT_RELAY_TOKEN,
      budget.fetch,
      this.store,
    );
    const forum = new DiscordForum(rest, this.store);
    const relay = relayFor(settings, forum, this.store);
    return {
      settings,
      store: this.store,
      relay,
      forum,
      chatwoot,
      budget,
      rest,
      enqueueMetadata: (accountId, inboxId, discordUserId) =>
        this.enqueue({
          type: "metadata",
          accountId,
          ...(inboxId ? { inboxId } : {}),
          ...(discordUserId ? { discordUserId } : {}),
        }),
    };
  }

  private enqueue(payload: JobPayload, notBefore?: number): void {
    this.store.enqueue(jobKey(payload), PRIORITY[payload.type], JSON.stringify(payload), notBefore);
  }
}

/**
 * Replaces the invoker's "thinking…" with `content`, and `components`: menus under the content,
 * or, when they include more than action rows, a Components V2 message (the Manage panel, the one
 * the job came from or a new one), which has no content.
 */
async function respond(
  rest: DiscordRest,
  job: CommandJob,
  content: string,
  given?: APIMessageTopLevelComponent[],
): Promise<void> {
  // A job from the Manage panel replaces that Components V2 message, which cannot take content.
  const components = given ?? (job.panel ? [text(content)] : undefined);
  const v2 = components?.some((component) => component.type !== ComponentType.ActionRow);
  const body = v2
    ? { flags: MessageFlags.IsComponentsV2, components }
    : { content, ...(components ? { components } : {}) };
  await rest.patch<RESTPatchAPIWebhookWithTokenMessageResult, RESTPatchAPIWebhookWithTokenMessageJSONBody>(
    Routes.webhookMessage(job.applicationId, job.token, "@original"),
    { body: { ...body, allowed_mentions: { parse: [] } }, auth: false, interaction: true },
  );
}

/** One job per key: a job queued again while it waits is not queued twice. */
function jobKey(payload: JobPayload): string {
  switch (payload.type) {
    case "command":
    case "feedback":
      return `${payload.type}:${payload.job.interactionId}`;
    case "metadata":
      return `metadata:${payload.accountId}:${payload.inboxId ?? ""}:${payload.discordUserId ?? ""}`;
    case "sweep":
      return `sweep:${payload.accountId}`;
    case "queue":
      return "queue";
    case "sync":
    case "conversation":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}`;
    case "answer":
      return answerKey(payload.answerId);
    case "message-updated":
      return `${payload.type}:${payload.accountId}:${payload.conversationId}:${payload.messageId}`;
  }
}

function requiredBudget(payload: JobPayload): number {
  if (payload.type === "command") return COMMAND_BUDGET;
  if (payload.type === "queue") return 3;
  return payload.type === "sweep" ? 1 : MIN_BUDGET;
}

function answerKey(answerId: string): string {
  return `answer:${answerId}`;
}

function sameLabels(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && [...actual].sort().join("\0") === [...expected].sort().join("\0");
}
