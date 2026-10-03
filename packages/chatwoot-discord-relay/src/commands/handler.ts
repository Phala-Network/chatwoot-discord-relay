// Turns one Discord interaction into an immediate response, plus a deferred job for anything
// that has to talk to Chatwoot. Runs in the Worker, so it must stay fast (Discord waits 3 s).

import {
  type APIApplicationCommandInteraction,
  type APIAttachment,
  type APIInteraction,
  type APIInteractionResponse,
  type APIMessageComponentInteraction,
  type APIModalInteractionResponse,
  type APIModalSubmitInteraction,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  TextInputStyle,
} from "discord-api-types/v10";
import type { Settings } from "../config.ts";
import { draftFromMessage, lastCodeBlock } from "../relay/format.ts";
import { filesTooLarge, fileTooLarge, isDiscordAttachmentUrl, NOT_LINKED, UserError } from "./common.ts";
import { BUTTONS, blockConfirmation, NONE, PANEL } from "./components.ts";
import { CONTENT_MAX, REPLY_WITH_THIS } from "./definitions.ts";
import type { Draft } from "./draft.ts";
import { type AttachmentRef, type CommandAction, type CommandJob, prioritySchema } from "./job.ts";

interface Ticket {
  accountId: number;
  conversationId: number;
}

interface HandlerDeps {
  settings: Settings;
  /** The conversation the relay mapped to this forum post, if any. */
  ticketForThread(threadId: string): Promise<Ticket | undefined>;
  draftOf(threadId: string, answerId: string): Promise<Draft>;
}

export interface HandlerResult {
  response: APIInteractionResponse;
  job?: CommandJob;
}

export async function handleInteraction(interaction: APIInteraction, deps: HandlerDeps): Promise<HandlerResult> {
  if (interaction.type === InteractionType.Ping) return { response: { type: InteractionResponseType.Pong } };
  if (
    interaction.type !== InteractionType.ApplicationCommand &&
    interaction.type !== InteractionType.ModalSubmit &&
    interaction.type !== InteractionType.MessageComponent
  ) {
    return privately("Unsupported interaction.");
  }

  try {
    const threadId = interaction.channel?.id ?? interaction.channel_id;
    const ticket = threadId ? await deps.ticketForThread(threadId) : undefined;
    const account = ticket && deps.settings.account(ticket.accountId);
    if (!threadId || !ticket || !account) {
      return privately("Use this command inside a ticket post in the Chatwoot forum.");
    }

    const userId = invokerId(interaction);
    if (!userId || !deps.settings.chatwootUserFor(userId) || !deps.settings.agentToken(userId))
      return privately(NOT_LINKED);

    const context: Context = {
      deps,
      interaction,
      userId,
      threadId,
      ticket,
      title: `${account.name} #${ticket.conversationId}`,
      panel: interaction.type === InteractionType.MessageComponent && interaction.data.custom_id.startsWith("panel:"),
    };
    switch (interaction.type) {
      case InteractionType.ModalSubmit:
        return submit(context, interaction);
      case InteractionType.MessageComponent:
        return await component(context, interaction);
      default:
        return command(context, interaction);
    }
  } catch (error) {
    if (error instanceof UserError) return privately(`❌ ${error.message}`);
    throw error;
  }
}

interface Context {
  deps: HandlerDeps;
  interaction: APIApplicationCommandInteraction | APIModalSubmitInteraction | APIMessageComponentInteraction;
  userId: string;
  threadId: string;
  ticket: Ticket;
  title: string;
  /** From the Manage panel: the job draws the panel again in place of a confirmation. */
  panel: boolean;
}

function command(context: Context, interaction: APIApplicationCommandInteraction): HandlerResult {
  const { data } = interaction;
  if (data.type === ApplicationCommandType.Message) {
    return data.name === REPLY_WITH_THIS ? replyWithThis(context, interaction) : privately("Unknown command.");
  }
  switch (data.name) {
    case "reply":
    case "note":
      return inline(context, interaction, data.name) ?? { response: editor(context, data.name, undefined) };
    case "resolve":
      return defer(context, { type: "status", status: "resolved" });
    case "reopen":
      return defer(context, { type: "status", status: "open" });
    case "pending":
      return defer(context, { type: "status", status: "pending" });
    case "snooze":
      return snooze(context, stringOption(interaction, "until") ?? "until_next_reply", Date.now());
    case "priority": {
      const level = stringOption(interaction, "level");
      if (level === "none") return defer(context, { type: "priority", priority: null });
      const priority = prioritySchema.safeParse(level);
      if (!priority.success) throw new UserError("Choose a priority from the list.");
      return defer(context, { type: "priority", priority: priority.data });
    }
    case "block":
      return defer(context, { type: "block" });
    case "unblock":
      return defer(context, { type: "unblock" });
    case "unassign":
      return defer(context, { type: "unassign" });
    case "label":
      return label(context, interaction);
    case "assign": {
      const option =
        data.type === ApplicationCommandType.ChatInput ? data.options?.find((o) => o.name === "agent") : undefined;
      const target = option && "value" in option ? String(option.value) : context.userId;
      const chatwootUserId = context.deps.settings.chatwootUserFor(target);
      if (chatwootUserId === undefined) throw new UserError("That Discord user is not linked to a Chatwoot agent.");
      return defer(context, { type: "assign", chatwootUserId });
    }
    default:
      return privately("Unknown command.");
  }
}

/**
 * The snooze time as Chatwoot's dashboard computes it (findSnoozeTime in
 * dashboard/helper/snoozeHelpers.js at v4.18.0): Unix seconds, taken when the command is used.
 * "Until next reply" sends no time.
 */
function snooze(context: Context, option: string, now: number): HandlerResult {
  switch (option) {
    case "until_next_reply":
      return defer(context, { type: "status", status: "snoozed" });
    case "an_hour_from_now":
      return defer(context, { type: "status", status: "snoozed", snoozedUntil: Math.floor((now + HOUR) / 1000) });
    default:
      throw new UserError("Choose a snooze option from the list.");
  }
}

const HOUR = 60 * 60 * 1000;

/** `/label add <label>` or `/label remove <label>`. */
function label(context: Context, interaction: APIApplicationCommandInteraction): HandlerResult {
  const { data } = interaction;
  const change = data.type === ApplicationCommandType.ChatInput ? data.options?.[0] : undefined;
  if (change?.type !== ApplicationCommandOptionType.Subcommand || (change.name !== "add" && change.name !== "remove")) {
    return privately("Unknown command.");
  }
  const option = change.options?.find((candidate) => candidate.name === "label");
  const name = option?.type === ApplicationCommandOptionType.String ? option.value.trim().toLowerCase() : "";
  if (name === "") throw new UserError("Name a label.");
  return defer(context, { type: "label", change: change.name, label: name });
}

function stringOption(interaction: APIApplicationCommandInteraction, name: string): string | undefined {
  const { data } = interaction;
  if (data.type !== ApplicationCommandType.ChatInput) return undefined;
  const option = data.options?.find((o) => o.name === name);
  return option?.type === ApplicationCommandOptionType.String ? option.value : undefined;
}

/**
 * /reply or /note with its `message` or `attachment` option sends at once; without either it
 * opens the editor (undefined).
 */
function inline(
  context: Context,
  interaction: APIApplicationCommandInteraction,
  kind: "reply" | "note",
): HandlerResult | undefined {
  const { data } = interaction;
  if (data.type !== ApplicationCommandType.ChatInput) return undefined;
  const text = stringOption(interaction, "message");
  const upload = data.options?.find((option) => option.name === "attachment");
  const fileId = upload?.type === ApplicationCommandOptionType.Attachment ? upload.value : undefined;
  if (text === undefined && fileId === undefined) return undefined;

  const file = fileId === undefined ? undefined : data.resolved?.attachments?.[fileId];
  if (fileId !== undefined && !file) throw new UserError("That attachment could not be read. Try again.");
  const files = file ? [attachmentRef(file)] : [];
  return message(context, kind, text?.trim() ?? "", files);
}

function message(
  context: Context,
  kind: "reply" | "note",
  content: string,
  files: AttachmentRef[],
  sendAsAgent = false,
): HandlerResult {
  if (content === "" && files.length === 0) throw new UserError("Add a message or an attachment.");
  checkFiles(files, context.deps.settings);
  return defer(context, {
    type: "message",
    private: kind === "note",
    content,
    files,
    ...(sendAsAgent ? { sendAsAgent } : {}),
  });
}

function submit(context: Context, interaction: APIModalSubmitInteraction): HandlerResult {
  const kind = interaction.data.custom_id.split(":", 1)[0];
  if (kind !== "reply" && kind !== "note") throw new UserError("Unknown form.");

  const inputs = interaction.data.components.flatMap((component) =>
    component.type === ComponentType.Label ? [component.component] : [],
  );
  // Ids are "<name>:<nonce>" (see `editor`).
  const input = (name: string) => inputs.find((component) => component.custom_id.split(":", 1)[0] === name);
  const text = input("content");
  const upload = input("files");
  const from = input("from");
  const content = text?.type === ComponentType.TextInput ? text.value.trim() : "";
  const files = uploadedFiles(interaction, upload?.type === ComponentType.FileUpload ? upload.values : []);
  return message(context, kind, content, files, from?.type === ComponentType.Checkbox && from.value);
}

/** Files from the editor's upload field, as Discord describes them in the resolved data. */
function uploadedFiles(interaction: APIModalSubmitInteraction, ids: string[]): AttachmentRef[] {
  const resolved: Partial<Record<string, APIAttachment>> = interaction.data.resolved?.attachments ?? {};
  return ids.flatMap((id) => {
    const file = resolved[id];
    return file ? [attachmentRef(file)] : [];
  });
}

function attachmentRef(file: APIAttachment): AttachmentRef {
  return {
    url: file.url,
    filename: file.filename,
    size: file.size,
    ...(file.content_type ? { contentType: file.content_type } : {}),
  };
}

function checkFiles(files: AttachmentRef[], settings: Settings): void {
  const limits = settings.config.attachments;
  if (files.length > limits.maxFiles) throw new UserError(`Attach at most ${limits.maxFiles} files.`);
  if (files.some((file) => file.size > limits.maxFileBytes)) throw fileTooLarge(limits.maxFileBytes);
  if (files.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) throw filesTooLarge(limits.maxTotalBytes);
  if (!files.every((file) => isDiscordAttachmentUrl(file.url))) {
    throw new UserError("Attachments must be uploaded in Discord.");
  }
}

function replyWithThis(context: Context, interaction: APIApplicationCommandInteraction): HandlerResult {
  const draft = draftOf(context, interaction);
  if (draft === undefined || draft === "") {
    return privately("That message has no draft. Right-click the triage bot message that contains the draft.");
  }
  return { response: editor(context, "reply", draft) };
}

/**
 * A message command carries its target message, content included. From the triage bot, its last
 * code block (its answer's draft; a message without one has no draft); from anyone else, the last
 * code block, or the whole message when there is none.
 */
function draftOf(context: Context, interaction: APIApplicationCommandInteraction): string | undefined {
  const { data } = interaction;
  if (data.type !== ApplicationCommandType.Message) return undefined;
  const message = data.resolved.messages[data.target_id];
  const content = message?.content ?? "";
  const triage = context.deps.settings.config.triage;
  if (triage.userId && message?.author.id === triage.userId) return lastCodeBlock(content);
  return draftFromMessage(content);
}

/**
 * Modal with a text field, an optional upload field, and for a reply the choice to send an email
 * from the agent's own address. Every editor gets ids unique to its interaction: Discord keeps
 * unsubmitted modal input per custom_id and would otherwise show text from an earlier, cancelled
 * editor instead of this draft.
 */
function editor(context: Context, kind: "reply" | "note", value: string | undefined): APIModalInteractionResponse {
  const nonce = context.interaction.id;
  const maxFiles = context.deps.settings.config.attachments.maxFiles;
  const label = kind === "note" ? "Private note" : "Message to the customer";
  const title = `${kind === "note" ? "Note" : "Reply"} · ${context.title}`;
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: `${kind}:${nonce}`,
      title: Array.from(title).slice(0, 45).join(""),
      components: [
        {
          type: ComponentType.Label,
          label,
          component: {
            type: ComponentType.TextInput,
            custom_id: `content:${nonce}`,
            style: TextInputStyle.Paragraph,
            required: false,
            max_length: CONTENT_MAX,
            ...(value ? { value: value.slice(0, CONTENT_MAX) } : {}),
          },
        },
        ...(maxFiles > 0
          ? [
              {
                type: ComponentType.Label as const,
                label: "Attachments",
                description: "Optional: images or files",
                component: {
                  type: ComponentType.FileUpload as const,
                  custom_id: `files:${nonce}`,
                  min_values: 0,
                  max_values: maxFiles,
                  required: false,
                },
              },
            ]
          : []),
        ...(kind === "reply" && context.deps.settings.config.chatwoot.sendAsAgent
          ? [
              {
                type: ComponentType.Label as const,
                label: "Send from my email address",
                description: "Email tickets: from your address on the inbox's domain, not the inbox's",
                component: { type: ComponentType.Checkbox as const, custom_id: `from:${nonce}` },
              },
            ]
          : []),
      ],
    },
  };
}

function defer(context: Context, action: CommandAction): HandlerResult {
  const { interaction } = context;
  return {
    // A panel change updates the panel itself; anything else answers with a new private message.
    response: context.panel
      ? { type: InteractionResponseType.DeferredMessageUpdate }
      : { type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: MessageFlags.Ephemeral } },
    job: {
      interactionId: interaction.id,
      applicationId: interaction.application_id,
      token: interaction.token,
      discordUserId: context.userId,
      accountId: context.ticket.accountId,
      conversationId: context.ticket.conversationId,
      action,
      ...(context.panel ? { panel: true } : {}),
    },
  };
}

/** A ticket button, or a change in the Manage panel. */
async function component(context: Context, interaction: APIMessageComponentInteraction): Promise<HandlerResult> {
  const { data } = interaction;
  // Reply with draft carries its answer: "ticket:draft:<answer message id>".
  const answerId = data.custom_id.startsWith(`${BUTTONS.draft}:`) ? data.custom_id.slice(BUTTONS.draft.length + 1) : "";
  if (/^\d{17,20}$/.test(answerId)) {
    const draft = await context.deps.draftOf(context.threadId, answerId);
    if ("text" in draft) return { response: editor(context, "reply", draft.text) };
    if (draft.missing === "none") return privately("That answer has no draft.");
    return privately(
      `That answer's draft is no longer stored here. Right-click [the answer](https://discord.com/channels/${interaction.guild_id ?? "@me"}/${context.threadId}/${answerId}) and choose Apps → ${REPLY_WITH_THIS}.`,
    );
  }
  switch (data.custom_id) {
    case BUTTONS.reply:
      return { response: editor(context, "reply", undefined) };
    case BUTTONS.take: {
      const chatwootUserId = context.deps.settings.chatwootUserFor(context.userId);
      if (chatwootUserId === undefined) return privately(NOT_LINKED);
      return defer(context, { type: "assign", chatwootUserId });
    }
    case BUTTONS.resolve:
      return defer(context, { type: "status", status: "resolved" });
    case BUTTONS.reopen:
      return defer(context, { type: "status", status: "open" });
    case BUTTONS.snooze:
      return snooze(context, "until_next_reply", Date.now());
    case BUTTONS.block:
      return {
        response: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content:
              "Block this contact? The ticket is resolved, and their new messages are muted (`/unblock` undoes it).",
            components: blockConfirmation(),
            flags: MessageFlags.Ephemeral,
            allowed_mentions: { parse: [] },
          },
        },
      };
    case BUTTONS.blockConfirmed:
      return inPlace(context, { type: "block" }, "⏳ Blocking…");
    case BUTTONS.assign:
      return defer(context, { type: "pick-assignee" });
    case BUTTONS.assignee: {
      if (data.component_type !== ComponentType.StringSelect) return privately("Unknown menu.");
      const [agent = NONE] = data.values;
      return inPlace(context, agent === NONE ? { type: "unassign" } : assignee(agent), "⏳ Assigning…");
    }
    case BUTTONS.manage:
      return defer(context, { type: "panel" });
  }
  // The panel's status buttons carry their value: "panel:status:resolved".
  if (data.custom_id.startsWith(`${PANEL.status}:`)) {
    const status = data.custom_id.slice(PANEL.status.length + 1);
    if (status === "open" || status === "resolved") return defer(context, { type: "status", status });
    return snooze(context, status, Date.now());
  }
  if (data.component_type !== ComponentType.StringSelect) return privately("Unknown button.");
  const values = data.values;
  switch (data.custom_id) {
    case PANEL.assignee: {
      const [agent = ""] = values;
      return agent === NONE ? defer(context, { type: "unassign" }) : defer(context, assignee(agent));
    }
    case PANEL.labels: {
      const [label = NONE] = values;
      return defer(context, { type: "labels", labels: label === NONE ? [] : [label] });
    }
    default:
      return privately("Unknown menu.");
  }
}

/**
 * A deferred command whose result replaces the private message it came from (a confirmation, a
 * menu): "@original" is the message the button or menu is on, shown meanwhile as `interim`.
 */
function inPlace(context: Context, action: CommandAction, interim: string): HandlerResult {
  return {
    ...defer(context, action),
    response: { type: InteractionResponseType.UpdateMessage, data: { content: interim, components: [] } },
  };
}

function assignee(value: string): CommandAction {
  const chatwootUserId = Number(value);
  if (!Number.isSafeInteger(chatwootUserId) || chatwootUserId <= 0)
    throw new UserError("Choose an agent from the list.");
  return { type: "assign", chatwootUserId };
}

export function privately(content: string): HandlerResult {
  return {
    response: {
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { content, flags: MessageFlags.Ephemeral, allowed_mentions: { parse: [] } },
    },
  };
}

function invokerId(interaction: APIInteraction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}
