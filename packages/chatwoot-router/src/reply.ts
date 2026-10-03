import { type ChatwootClient, type ChatwootMessage, MESSAGE_HISTORY_PAGE_SIZE } from "../../../shared/chatwoot/api.ts";

/** A Chatwoot creation receipt, not a channel delivery receipt. */
export function confirmedReply(message: ChatwootMessage | undefined, botId: number | undefined): boolean {
  return (
    message !== undefined &&
    Number.isSafeInteger(message.id) &&
    message.id > 0 &&
    message.message_type === 1 &&
    message.private === false &&
    message.sender?.type === "agent_bot" &&
    message.sender.id === botId &&
    message.status !== "failed" &&
    !message.content_attributes?.deleted
  );
}

/** Read past turn boundaries, including replies made by the former relay's brand bot. */
export async function replyHistory(
  chatwoot: ChatwootClient,
  accountId: number,
  conversationId: number,
  botId: number | undefined,
  freshPages: readonly ChatwootMessage[][] = [],
): Promise<"found" | "complete-none" | "unknown"> {
  let before: number | undefined;
  for (let page = 0; page < 5; page += 1) {
    // Read failures propagate to the caller, which persists handoff before trying it.
    const messages =
      freshPages[page] ??
      (await chatwoot.listMessages(accountId, conversationId, before === undefined ? {} : { before }));
    for (const message of messages) {
      if (confirmedReply(message, botId)) return "found";
      if (message.message_type !== 1 || message.private === true) continue;
      // A deleted/failed brand reply still prohibits another attempt. Missing identity or
      // visibility cannot prove absence; never reinterpret malformed history as no reply.
      if (
        message.sender?.type == null ||
        (message.sender.type === "agent_bot" && (message.sender.id == null || message.sender.id === botId))
      )
        return "unknown";
    }
    if (messages.length < MESSAGE_HISTORY_PAGE_SIZE) return "complete-none";
    const next = messages[0]?.id;
    if (next === undefined || (before !== undefined && next >= before)) return "unknown";
    before = next;
  }
  return "unknown";
}
