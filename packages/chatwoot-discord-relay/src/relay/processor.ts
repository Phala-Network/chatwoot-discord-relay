// Brings one conversation's forum post up to date from Chatwoot's API: relays every message
// after the stored cursor, in order, then corrects the post's tags, title, and archived flag and
// links the post from the conversation.

import { type Budget, BudgetExhaustedError } from "../../../../shared/budget.ts";
import {
  type ChatwootClient,
  type ChatwootConversation,
  type ChatwootMessage,
  chatwootClient,
  isAnsweringReply,
  MESSAGE_PAGE_SIZE,
  toRelayConversation,
  toRelayMessage,
} from "../../../../shared/chatwoot/api.ts";
import { errorFields, log } from "../../../../shared/log.ts";
import type { RelayConversation } from "../../../../shared/types.ts";
import { ticketCard } from "../commands/components.ts";
import { relaysInbox, type Settings } from "../config.ts";
import { type DiscordRest, isInvalidRequest } from "../discord/rest.ts";
import { fetchAvatarUrl } from "../discord/users.ts";
import type { Store } from "../store.ts";
import { mentionedUserIds } from "./format.ts";
import { FINISH_REQUESTS, PAGE_REQUESTS, requestsPerMessage } from "./limits.ts";
import { type ForumClient, Relay, type RelayStore } from "./relay.ts";
import { relayDerived } from "./updates.ts";

const INBOX_CACHE_MS = 24 * 60 * 60 * 1000;
const AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;
/** After a failed avatar lookup, the agent's Chatwoot avatar is used this long before trying again. */
const AVATAR_RETRY_MS = 60 * 60 * 1000;

/** The relay as configured by `settings`. */
export function relayFor(settings: Settings, forum: ForumClient, store: RelayStore): Relay {
  const triageUserId = settings.config.triage.userId;
  return new Relay({
    forum,
    store,
    frontendUrl: settings.frontendUrl,
    avatars: settings.avatars,
    target: (accountId) => {
      const account = settings.account(accountId);
      if (!account) throw new Error(`Account ${accountId} is not configured`);
      const tags = settings.config.forumTags[account.forumChannelId] ?? {};
      return { forumChannelId: account.forumChannelId, name: account.name, tags };
    },
    topicAttribute: settings.config.relay.topicAttribute,
    maxChunks: settings.config.relay.maxChunks,
    triage: triageUserId ? { ...settings.config.triage, userId: triageUserId } : undefined,
    card: ticketCard,
    linkedAgent: settings.linkedAgent,
    // Normally every message is relayed within the sweep's window (by its webhook, or else by
    // the sweep), so an older one is history: a first sync, or a catch-up after downtime.
    liveSeconds: settings.config.reconcile.lookbackSeconds,
  });
}

export interface ProcessorContext {
  settings: Settings;
  store: Store;
  relay: Relay;
  forum: ForumClient;
  rest: DiscordRest;
  chatwoot: ChatwootClient;
  budget: Budget;
  enqueueMetadata: (accountId: number, inboxId?: number, discordUserId?: string) => void;
}

/** "yield" means the invocation's request budget ran low; run again in a fresh invocation. */
export type ProcessOutcome = "done" | "yield" | "pending";

export async function processConversation(
  context: ProcessorContext,
  accountId: number,
  conversationId: number,
): Promise<ProcessOutcome> {
  const { settings, store, relay, chatwoot, budget } = context;
  const account = settings.account(accountId);
  if (!account) return "done";
  const limits = settings.config.relay;
  const perMessage = requestsPerMessage(limits.maxChunks);

  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) {
    log.warn("conversation no longer exists in Chatwoot", { accountId, conversationId });
    await relay.closeDeleted(accountId, conversationId);
    return "done";
  }
  if (!relaysInbox(account, raw.inbox_id)) return "done";
  let conversation = toRelayConversation(conversationId, raw);
  if (!store.conversation(accountId, conversationId)?.threadId) {
    await recoverThread(context, accountId, account.forumChannelId, conversation);
  }

  const recorded = store.conversation(accountId, conversationId);
  let cursor = recorded?.cursor;
  if (cursor === undefined && recorded?.threadId) {
    // An adopted post (from the link attribute) already holds the history. With a cutover
    // watermark, continue after it; otherwise start after the latest message.
    if (limits.startAfterMessageId > 0) {
      cursor = limits.startAfterMessageId;
    } else {
      const latest = await chatwoot.listMessages(accountId, conversationId);
      cursor = Math.max(0, ...latest.map((message) => message.id));
    }
    store.setCursor(accountId, conversationId, cursor);
  }
  if (cursor === undefined) {
    // Persist the starting point before posting, so a post created by a failed attempt is not
    // mistaken for an adopted one (whose history would be skipped) on retry.
    cursor = limits.startAfterMessageId;
    store.setCursor(accountId, conversationId, cursor);
  }

  let inboxName: string | null | undefined;
  for (;;) {
    if (budget.remaining < perMessage + PAGE_REQUESTS) return "yield";
    budget.checkpoint();
    const pageVersion = store.get(`answer-version:${accountId}:${conversationId}`);
    const page = await chatwoot.listMessages(accountId, conversationId, { after: cursor });
    for (const message of page) {
      if (message.id <= cursor) continue;
      if (budget.remaining < perMessage) return "yield";
      let answered = false;
      if (
        message.message_type === 0 &&
        !message.private &&
        !message.content_attributes?.deleted &&
        !conversation.contact.blocked
      ) {
        const fresh = await chatwoot.getConversation(accountId, conversationId);
        if (!fresh) return "done";
        if (!relaysInbox(account, fresh.inbox_id)) return "done";
        conversation = toRelayConversation(conversationId, fresh);
        if (
          fresh.status === "pending" &&
          fresh.inbox_id !== undefined &&
          (await chatwoot.inboxBot(accountId, fresh.inbox_id))
        ) {
          return "pending";
        }
        const live =
          message.created_at == null ||
          Date.now() - message.created_at * 1000 <= settings.config.reconcile.lookbackSeconds * 1000;
        if (
          fresh.status === "open" &&
          settings.config.triage.userId &&
          live &&
          !message.content_attributes?.email?.auto_reply
        ) {
          const reply =
            page.some((later) => later.id > message.id && isAnsweringReply(later)) ||
            (page.length < MESSAGE_PAGE_SIZE &&
            store.get(`answer-scan:${accountId}:${conversationId}:${message.id}`) === undefined
              ? false
              : await answeringReply(context, accountId, conversationId, message.id));
          if (reply === "yield") return "yield";
          answered = reply;
        }
      }
      if (inboxName === undefined && !store.conversation(accountId, conversationId)?.threadId) {
        inboxName = await cachedInboxName(context, accountId, raw);
      }
      if (store.get(`answer-version:${accountId}:${conversationId}`) !== pageVersion) return "yield";
      budget.checkpoint();
      if (budget.remaining < perMessage) return "yield";
      const scanKey = `answer-scan:${accountId}:${conversationId}:${message.id}`;
      const scan = store.get(scanKey);
      const relayMessage = toRelayMessage(message, {
        account: { id: accountId, name: account.name },
        inboxName: inboxName ?? null,
        conversation,
        ...(await linkedAgents(context, message, accountId)),
      });
      if (
        store.get(`answer-version:${accountId}:${conversationId}`) !== pageVersion ||
        (scan !== undefined && store.get(scanKey) !== scan)
      )
        return "yield";
      relayMessage.answered = answered;
      try {
        await relay.relay(relayMessage);
        // With its current state: an update reported before the message was relayed is not lost.
        await relayDerived(context, accountId, conversation, message);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) return "yield";
        // Only a request Discord refuses as invalid counts towards skipping the message. Anything
        // else (a rate limit, a server error, a timeout, a missing permission) waits for the
        // job's retry, however long it takes, so the message is never skipped for it.
        if (!isInvalidRequest(error)) throw error;
        const attempts = store.recordFailure(accountId, conversationId, message.id);
        if (attempts < limits.maxAttempts) throw error;
        log.error("relay gave up on message", {
          accountId,
          conversationId,
          messageId: message.id,
          attempts,
          ...errorFields(error),
        });
        try {
          await relay.notify(
            accountId,
            conversation,
            `⚠️ Chatwoot message ${message.id} could not be relayed. Check it in Chatwoot.`,
            `failed:${message.id}`,
          );
        } catch (noticeError) {
          if (noticeError instanceof BudgetExhaustedError) return "yield";
          log.warn("failed relay notice unavailable", { accountId, conversationId, ...errorFields(noticeError) });
        }
      }
      cursor = message.id;
      store.setCursor(accountId, conversationId, cursor);
      store.delete(scanKey);
    }
    if (page.length < MESSAGE_PAGE_SIZE) break;
  }

  const post = store.conversation(accountId, conversationId);
  const threadId = post?.threadId;
  if (threadId) {
    if (budget.remaining < FINISH_REQUESTS) return "yield";
    if (post?.announcePending) await relay.announceAssignee(accountId, conversation);
    await relay.sync(accountId, conversation, threadId);
    await linkPost(context, accountId, account.forumChannelId, conversation, threadId);
  }
  return "done";
}

/** Persist only continuation: re-read the final/answer page after yielding, before Notifier decides once. */
async function answeringReply(
  { store, chatwoot, budget }: ProcessorContext,
  accountId: number,
  conversationId: number,
  messageId: number,
): Promise<boolean | "yield"> {
  const key = `answer-scan:${accountId}:${conversationId}:${messageId}`;
  let after = Number(store.get(key) ?? messageId);
  for (;;) {
    if (budget.remaining < 2) return "yield";
    store.set(key, String(after));
    const messages = await chatwoot.listMessages(accountId, conversationId, { after });
    // An update received during the read invalidates it too; do not restore its stale cursor.
    if (store.get(key) === undefined) return "yield";
    if (messages.some(isAnsweringReply)) return true;
    if (messages.length < MESSAGE_PAGE_SIZE) return false;
    const next = messages.at(-1)?.id;
    if (next === undefined || next <= after) throw new Error("Chatwoot message page did not advance");
    after = next;
    store.set(key, String(after));
  }
}

/**
 * Re-adopts a post recorded in the conversation's link attribute when this service has no
 * mapping (e.g. after a cutover or a lost state), as long as the post still exists in the
 * account's forum and is not mapped to another conversation.
 */
async function recoverThread(
  { settings, store, forum }: ProcessorContext,
  accountId: number,
  forumChannelId: string,
  conversation: RelayConversation,
): Promise<void> {
  const attribute = settings.config.relay.linkAttribute;
  if (!attribute) return;
  const threadId = threadIdFromUrl(conversation.customAttributes[attribute]);
  if (!threadId || store.ticketForThread(threadId)) return;
  if (!(await forum.threadExists(forumChannelId, threadId))) return;
  store.adoptThread(accountId, conversation.id, threadId);
  log.info("recovered post from conversation link", { accountId, conversationId: conversation.id, threadId });
}

/**
 * Records the post URL in the conversation's link attribute unless it already points to the
 * post, e.g. after the post was created or recreated. It runs last: a failure fails the job,
 * whose retry (the messages and the post's state are already recorded) only links.
 */
async function linkPost(
  { settings, chatwoot, forum }: ProcessorContext,
  accountId: number,
  forumChannelId: string,
  conversation: RelayConversation,
  threadId: string,
): Promise<void> {
  const attribute = settings.config.relay.linkAttribute;
  if (!attribute) return;
  const url = await forum.postUrl(forumChannelId, threadId);
  if (conversation.customAttributes[attribute] === url) return;
  await chatwoot.setCustomAttributes(accountId, conversation.id, { [attribute]: url });
  conversation.customAttributes[attribute] = url;
}

/** The thread id in a https://discord.com/channels/<guild>/<thread> link. */
function threadIdFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d{17,20}\/(\d{17,20})\/?$/.exec(
    value.trim(),
  )?.[1];
}

/** The newest message id Chatwoot included with a conversation, if any. */
export function latestMessageId(conversation: ChatwootConversation): number | undefined {
  const ids = (conversation.messages ?? []).flatMap((message) => (message.id === undefined ? [] : [message.id]));
  return ids.length === 0 ? undefined : Math.max(...ids);
}

/** The inbox name for a new post's ticket header; omitted when Chatwoot will not say. */
async function cachedInboxName(
  context: ProcessorContext,
  accountId: number,
  conversation: ChatwootConversation,
): Promise<string | null> {
  const { store, enqueueMetadata } = context;
  const inboxId = conversation.inbox_id;
  if (!inboxId) return null;
  const key = `inbox:${accountId}:${inboxId}`;
  const cached = store.get(key);
  if (cached !== undefined) return cached || null;
  enqueueMetadata(accountId, inboxId);
  return null;
}

/**
 * The linked agents a message involves: for a private note that mentions Chatwoot users
 * (Chatwoot notifies mentions in notes only: Messages::MentionService at v4.18.0), the linked
 * agents among them by Chatwoot user id; for a message sent by a linked agent, their Discord
 * avatar.
 */
async function linkedAgents(
  context: ProcessorContext,
  message: ChatwootMessage,
  accountId: number,
): Promise<{ mentionedAgents?: ReadonlyMap<number, string>; discordAvatarUrl?: string }> {
  const mentioned = message.private && message.content ? mentionedUserIds(message.content) : [];
  const senderId = message.message_type === 1 && message.sender?.type === "user" ? message.sender.id : undefined;
  const linked = new Map<number, string>();
  for (const userId of mentioned) {
    const discordId = context.settings.linkedAgent(userId)?.discordUserId;
    if (discordId) linked.set(userId, discordId);
  }
  const senderDiscordId = context.settings.linkedAgent(senderId)?.discordUserId;
  const discordAvatarUrl = senderDiscordId ? await cachedDiscordAvatar(context, senderDiscordId, accountId) : undefined;
  return {
    ...(mentioned.length > 0 ? { mentionedAgents: linked } : {}),
    ...(discordAvatarUrl ? { discordAvatarUrl } : {}),
  };
}

/**
 * A linked agent's Discord avatar, looked up at most once a day; undefined when Discord will
 * not say, and then not asked again for a while.
 */
async function cachedDiscordAvatar(
  context: ProcessorContext,
  discordUserId: string,
  accountId: number,
): Promise<string | undefined> {
  const { store, enqueueMetadata } = context;
  const key = `avatar:${discordUserId}`;
  const cached = store.get(key);
  if (cached !== undefined) return cached || undefined;
  enqueueMetadata(accountId, undefined, discordUserId);
  return undefined;
}

function decorativeChatwoot({ settings, budget, store }: ProcessorContext): ChatwootClient {
  return chatwootClient(
    settings.config.chatwoot.baseUrl,
    settings.secrets.CHATWOOT_RELAY_TOKEN,
    (request) =>
      budget.fetch(new Request(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(300)]) })),
    store,
  );
}

export async function refreshMetadata(
  context: ProcessorContext,
  payload: { accountId: number; inboxId?: number | undefined; discordUserId?: string | undefined },
): Promise<void> {
  const { store, rest } = context;
  if (payload.inboxId) {
    const key = `inbox:${payload.accountId}:${payload.inboxId}`;
    try {
      const name = await decorativeChatwoot(context).inboxName(payload.accountId, payload.inboxId);
      store.set(key, name ?? "", name ? INBOX_CACHE_MS : 60_000);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      store.set(key, "", 60_000);
    }
  }
  if (payload.discordUserId) {
    const key = `avatar:${payload.discordUserId}`;
    try {
      store.set(key, await fetchAvatarUrl(rest, payload.discordUserId, AbortSignal.timeout(300)), AVATAR_CACHE_MS);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      store.set(key, "", AVATAR_RETRY_MS);
    }
  }
}
