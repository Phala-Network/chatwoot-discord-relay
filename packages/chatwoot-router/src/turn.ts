// Chatwoot's status activity is the turn boundary. Keep only the guard needed to reject an
// obsolete handoff or a missing/deleted boundary, not an effects ledger or a turn history.
import { z } from "zod";
import { type ChatwootClient, type ChatwootMessage, MESSAGE_HISTORY_PAGE_SIZE } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import type { RoutingStore } from "./routing.ts";
import type { Transition } from "./webhook.ts";

const guardSchema = z.object({
  boundary: z.number().optional(),
  claimed: z.boolean().optional(),
  pending: z.boolean().optional(),
  transitionAt: z.number().optional(),
  expected: z.object({ status: z.string(), at: z.number().optional(), after: z.number().optional() }).optional(),
  handoff: z.boolean().default(false),
  failures: z.number().int().min(0).default(0),
});
type Guard = z.infer<typeof guardSchema>;

function readGuard(store: RoutingStore, accountId: number, conversationId: number): Guard {
  const parsed = guardSchema.safeParse(parseJson(store.get(`turn:${accountId}:${conversationId}`)));
  return parsed.success ? parsed.data : { handoff: false, failures: 0 };
}

function saveGuard(store: RoutingStore, accountId: number, conversationId: number, guard: Guard): void {
  store.set(`turn:${accountId}:${conversationId}`, JSON.stringify(guard));
}

export function expectActivity(
  store: RoutingStore,
  accountId: number,
  conversationId: number,
  transition: Transition,
): void {
  const guard = readGuard(store, accountId, conversationId);
  if (transition.at !== undefined && transition.at <= (guard.transitionAt ?? 0)) return;
  if (transition.at === undefined && guard.expected?.status === transition.status) return;
  // An activity read before its first status webhook can claim that transition. A boundary
  // already matched to a timestamp cannot also satisfy a different transition in the same second.
  const claimed = guard.claimed ?? guard.transitionAt !== undefined;
  const after = transition.at === undefined || claimed ? (guard.boundary ?? 0) : 0;
  saveGuard(store, accountId, conversationId, {
    ...guard,
    // A first webhook must not relax a newer activity requirement already observed locally.
    expected: { ...transition, after: Math.max(guard.expected?.after ?? 0, after) },
    transitionAt: transition.at ?? guard.transitionAt,
    handoff: false,
    failures: 0,
  });
}

/** Preserve an observed pending departure across retries, without using metadata timestamps. */
export function observeStatus(store: RoutingStore, accountId: number, conversationId: number, status: string): void {
  const guard = readGuard(store, accountId, conversationId);
  const pending = status === "pending";
  if (guard.pending && !pending) expectActivity(store, accountId, conversationId, { status });
  if (guard.pending !== pending) {
    saveGuard(store, accountId, conversationId, { ...readGuard(store, accountId, conversationId), pending });
  }
}

export function requestHandoff(store: RoutingStore, accountId: number, conversationId: number): void {
  saveGuard(store, accountId, conversationId, { ...readGuard(store, accountId, conversationId), handoff: true });
}

/** Counts processing failures for this turn, independently of an old queued job's backoff. */
export function recordFailure(store: RoutingStore, accountId: number, conversationId: number): number {
  const guard = readGuard(store, accountId, conversationId);
  guard.failures += 1;
  if (guard.failures >= 3) guard.handoff = true;
  saveGuard(store, accountId, conversationId, guard);
  return guard.failures;
}

export function clearFailures(store: RoutingStore, accountId: number, conversationId: number): void {
  const guard = readGuard(store, accountId, conversationId);
  if (guard.failures) saveGuard(store, accountId, conversationId, { ...guard, failures: 0 });
}

class ActivityPendingError extends Error {
  constructor() {
    super("Chatwoot status activity is not available yet");
    this.name = "ActivityPendingError";
  }
}

export async function readTurn(
  chatwoot: ChatwootClient,
  store: RoutingStore,
  accountId: number,
  conversationId: number,
) {
  const messages: ChatwootMessage[] = [];
  const pages: ChatwootMessage[][] = [];
  let before: number | undefined;
  let boundary: ChatwootMessage | undefined;
  let complete = false;
  let deleted = false;
  for (let page = 0; page < 5; page += 1) {
    const batch = await chatwoot.listMessages(accountId, conversationId, before === undefined ? {} : { before });
    pages.push(batch);
    for (const message of batch.toReversed()) {
      if (message.message_type === 2 && message.content_attributes?.deleted) {
        deleted = true;
        break;
      }
      if (message.message_type === 2 && message.content_attributes?.activity?.type === "conversation_status_changed") {
        boundary = message;
        break;
      }
      messages.push(message);
    }
    complete = boundary !== undefined || batch.length < MESSAGE_HISTORY_PAGE_SIZE;
    if (complete || deleted) break;
    const next = batch[0]?.id;
    if (next === undefined || (before !== undefined && next >= before)) break;
    before = next;
  }
  // A webhook may have updated the guard while pages were being read.
  const guard = readGuard(store, accountId, conversationId);
  const missing = guard.boundary !== undefined && (boundary?.id ?? 0) < guard.boundary;
  const expected = guard.expected;
  const activity = boundary?.content_attributes?.activity;
  // Activity timestamps have second precision. The status webhook carries fractional seconds.
  const late =
    expected &&
    (!boundary ||
      boundary.id <= (expected.after ?? 0) ||
      (expected.at !== undefined && (boundary.created_at ?? 0) < Math.floor(expected.at)) ||
      activity?.status !== expected.status);
  if (late && !guard.handoff && !deleted && !missing) throw new ActivityPendingError();
  if (boundary && boundary.id !== guard.boundary && guard.boundary !== undefined && !missing && !late) {
    guard.handoff = false;
    guard.failures = 0;
  }
  if (!missing && complete) {
    if (guard.boundary !== (boundary?.id ?? 0)) guard.claimed = false;
    guard.boundary = boundary?.id ?? 0;
  }
  if (expected && !late) {
    guard.claimed = expected.at !== undefined;
    delete guard.expected;
  }
  if (deleted || missing || !complete) guard.handoff = true;
  saveGuard(store, accountId, conversationId, guard);
  return { pages, messages: messages.toReversed(), boundary: boundary?.id ?? 0, handoff: guard.handoff };
}
