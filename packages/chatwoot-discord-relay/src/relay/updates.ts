// What a Chatwoot message's state adds to its post beyond its text, when the message is relayed
// and when Chatwoot reports it updated: a customer's response to an interactive message, a
// notice when an agent's reply could not be delivered, and removal when the message is deleted.

import { type ChatwootMessage, toRelayConversation } from "../../../../shared/chatwoot/api.ts";
import { log } from "../../../../shared/log.ts";
import type { RelayConversation } from "../../../../shared/types.ts";
import { clip } from "./format.ts";
import type { ProcessorContext } from "./processor.ts";
import { interactiveMessage, responseText } from "./response.ts";

/**
 * Acts on a message reported as updated once Chatwoot's API confirms the change: a deleted
 * message's Discord messages are deleted, and what its state adds is posted (see relayDerived).
 * Only a message already relayed is acted on: before that (no post yet, or its job has not
 * reached it), its conversation's job relays it with its current state.
 */
export async function processMessageUpdate(
  context: ProcessorContext,
  accountId: number,
  conversationId: number,
  messageId: number,
): Promise<void> {
  const { settings, store, chatwoot, relay } = context;
  const post = store.conversation(accountId, conversationId);
  const threadId = post?.threadId;
  if (!settings.account(accountId) || !threadId || post?.cursor === undefined || messageId > post.cursor) return;
  const message = await chatwoot.getMessage(accountId, conversationId, messageId);
  if (!message) return;
  if (message.content_attributes?.deleted === true) {
    await deleteRelayedMessage(context, accountId, conversationId, messageId, threadId);
    return;
  }
  const raw = await chatwoot.getConversation(accountId, conversationId);
  if (!raw) return; // Deleted: the conversation's own job closes the post.
  const conversation = toRelayConversation(conversationId, raw);
  await relayDerived(context, accountId, conversation, message);
  // Posting unarchives the post and covers its card: bring both back, also when a retry finds
  // the post already made (sync does nothing when nothing is due).
  await relay.sync(accountId, conversation, threadId);
}

/**
 * Posts what a message's state adds, once: a customer's response to it (under the customer's
 * name) or a notice that it could not be delivered. Chatwoot lets a customer submit again (a
 * CSAT rating can be changed for 14 days), and only changed text is posted again. A blocked
 * contact's response is not posted, like their messages. Each post is recorded, so it is removed
 * with the message.
 */
export async function relayDerived(
  { store, relay }: ProcessorContext,
  accountId: number,
  conversation: RelayConversation,
  message: ChatwootMessage,
): Promise<void> {
  const derived = derivedText(message);
  if (!derived || (derived.kind === "response" && conversation.contact.blocked)) return;
  const digest = await sha256(derived.text);
  if (store.postedResponse(accountId, conversation.id, message.id) === digest) return;
  const key = `derived-revision:${accountId}:${conversation.id}:${message.id}`;
  const revision = Number(store.get(key) ?? 0);
  const sendKey = `derived:${message.id}:${revision}`;
  const discordId =
    derived.kind === "response"
      ? await relay.postResponse(accountId, conversation, derived.text, sendKey)
      : await relay.notify(accountId, conversation, derived.text, sendKey);
  if (discordId === undefined) return;
  store.savePostedResponse(accountId, conversation.id, message.id, digest);
  store.saveDerivedMessage(accountId, conversation.id, message.id, discordId);
  store.set(key, String(revision + 1));
  log.info(derived.kind === "response" ? "response posted" : "delivery failure posted", {
    accountId,
    conversationId: conversation.id,
    messageId: message.id,
  });
}

function derivedText(message: ChatwootMessage): { kind: "response" | "notice"; text: string } | undefined {
  if (message.content_attributes?.deleted === true) return undefined;
  if (message.status === "failed" && message.message_type === 1) {
    const reason = message.content_attributes?.external_error?.trim();
    return {
      kind: "notice",
      text: `⚠️ A reply could not be delivered to the customer${reason ? `: ${clip(reason, 300)}` : "."}`,
    };
  }
  const text = responseText(interactiveMessage(message.content_type, message.content, message.content_attributes));
  return text ? { kind: "response", text } : undefined;
}

/** Removes a deleted message's Discord messages, and its text from the post's title. */
async function deleteRelayedMessage(
  context: ProcessorContext,
  accountId: number,
  conversationId: number,
  messageId: number,
  threadId: string,
): Promise<void> {
  const { settings, store, forum, chatwoot, relay } = context;
  const account = settings.account(accountId);
  if (!account) return;
  const parts = store.postedParts(accountId, conversationId, messageId);
  for (const discordId of parts) {
    await forum.deleteMessage(account.forumChannelId, threadId, discordId);
    store.deletePostedPart(accountId, conversationId, messageId, discordId);
  }
  const derived = store.derivedMessages(accountId, conversationId, messageId);
  for (const discordId of derived) {
    await forum.deleteMessage(account.forumChannelId, threadId, discordId);
    store.deleteDerivedMessage(accountId, conversationId, messageId, discordId);
  }
  if (parts.length + derived.length > 0) {
    log.info("deleted message removed from post", { accountId, conversationId, messageId, parts: parts.length });
  }
  if (store.conversation(accountId, conversationId)?.titleMessageId === messageId) {
    const raw = await chatwoot.getConversation(accountId, conversationId);
    if (raw) await relay.dropTitleSubject(accountId, toRelayConversation(conversationId, raw), threadId);
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
