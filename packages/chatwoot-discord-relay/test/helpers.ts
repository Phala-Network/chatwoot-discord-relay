// Shared fixtures and fakes. Outbound HTTP is mocked at the fetch boundary.

import type { RelayMessage } from "../../../shared/types.ts";
import { buildSettings, configSchema, type Settings, secretsSchema } from "../src/config.ts";
import type { ForumClient, PostFields, RelayStore, WebhookMessage } from "../src/relay/relay.ts";
import { UnknownSendError, UnknownThreadError } from "../src/relay/relay.ts";

export const ALICE = "100000000000000011";
export const BOB = "100000000000000012";
export const CAROL = "100000000000000013"; // linked but has no token
export const TRIAGE = "100000000000000777";
export const FORUM = "100000000000000055";

type Overrides = Omit<Partial<RelayMessage>, "conversation"> & { conversation?: Partial<RelayMessage["conversation"]> };

export function message(overrides: Overrides = {}): RelayMessage {
  const { conversation, ...rest } = overrides;
  return {
    id: 101,
    messageType: "incoming",
    private: false,
    content: "My agent will not connect",
    attachments: [],
    account: { id: 3, name: "Acme" },
    inboxName: "Acme — Product App",
    sender: { name: "Jane Doe", type: "contact" },
    ...rest,
    conversation: {
      id: 12,
      status: "open",
      channel: "Channel::WebWidget",
      contact: { name: "Jane Doe", email: "jane@example.com" },
      labels: [],
      customAttributes: {},
      ...conversation,
    },
  };
}

// Discord ids from the time of the relay tests' clock (2026-09-27T20:00:00Z) on.
let lastSnowflake = (BigInt(Date.parse("2026-09-27T20:00:00Z")) - 1420070400000n) << 22n;

/** A new Discord id, greater than every one before it, as Discord's grow with time. */
export function snowflake(): string {
  lastSnowflake += 1n;
  return String(lastSnowflake);
}

export class MemoryStore implements RelayStore {
  rows = new Map<string, Partial<PostFields>>();
  parts = new Map<string, string[]>();
  counters = new Map<string, number>();
  decisions = new Map<string, string>();

  conversation(a: number, c: number) {
    const row = this.rows.get(`${a}:${c}`);
    if (!row) return undefined;
    const { threadId, state, announcedAssignee, announcePending, titleSubject, title, titleMessageId } = row;
    const { cardId, cardCovered, answerId, answerSourceId, customerMessageId } = row;
    return {
      threadId,
      state,
      announcedAssignee,
      assigneeNoticeId: row.assigneeNoticeId,
      announcePending,
      titleSubject,
      title,
      titleMessageId,
      cardId,
      cardCovered,
      answerId,
      answerSourceId,
      customerMessageId,
    };
  }
  updateConversation(a: number, c: number, patch: Partial<PostFields>) {
    this.rows.set(`${a}:${c}`, { ...this.rows.get(`${a}:${c}`), ...patch });
  }
  thread(a: number, c: number) {
    return this.rows.get(`${a}:${c}`)?.threadId;
  }
  postedParts(a: number, c: number, messageId: number) {
    return this.parts.get(`${a}:${c}:${messageId}`) ?? [];
  }
  firstPart(a: number, c: number, discordId: string) {
    for (const [key, parts] of this.parts) {
      if (key.startsWith(`${a}:${c}:`) && parts.includes(discordId)) return parts[0];
    }
    return undefined;
  }
  savePostedPart(a: number, c: number, messageId: number, part: number, discordId: string) {
    const parts = this.postedParts(a, c, messageId);
    parts[part] = discordId;
    this.parts.set(`${a}:${c}:${messageId}`, parts);
  }
  forgetThread(a: number, c: number) {
    this.rows.delete(`${a}:${c}`);
    for (const key of this.parts.keys()) if (key.startsWith(`${a}:${c}:`)) this.parts.delete(key);
  }
  once(name: string, decide: () => string) {
    const value = this.decisions.get(name) ?? decide();
    this.decisions.set(name, value);
    return value;
  }
  increment(name: string) {
    const count = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, count);
    return count;
  }
}

/** Forum tag ids by what they stand for, like `forumTags` of one forum. */
export const TAGS: Record<string, string> = {
  "account:3": "t-acme",
  "account:1": "t-globex",
  "status:open": "t-open",
  "status:pending": "t-pending",
  "status:resolved": "t-resolved",
};

type ThreadPatch = { archived: boolean; applied_tags?: string[]; name?: string };

/**
 * Records webhook executions like Discord would: a new post gets channel id "thread-<n>" and
 * every message a new Discord id (see snowflake). Like Discord, posting into an archived post unarchives it, and
 * an archived post's tags cannot change unless the same update unarchives it.
 */
export class FakeForum implements ForumClient {
  calls: Array<[string | undefined, WebhookMessage]> = [];
  /** The id of each call's message. */
  ids: string[] = [];
  /** Message edits, as [messageId, payload]. */
  edits: Array<[string, WebhookMessage]> = [];
  patches: Array<[string, ThreadPatch]> = [];
  deleted: string[] = [];
  archived = new Set<string>();
  /** Users added to posts, as [threadId, userId]. */
  members: Array<[string, string]> = [];
  failAddMember = false;
  failThreadWith: "gone" | "error" | undefined;
  /** Fails the next execution into a thread after this many succeed. */
  failAfter: number | undefined;
  /** Posts the next message into a thread but loses Discord's answer. */
  loseAnswer = false;
  private readonly unknownSends = new Set<string>();
  /** Fails the next request that archives a post. */
  failArchive = false;

  constructor(public guildId = "100000000000000044") {}

  async execute(_forum: string, payload: WebhookMessage, threadId?: string, sendKey?: string) {
    if (sendKey && this.unknownSends.has(sendKey)) throw new UnknownSendError();
    if (threadId && this.failAfter !== undefined) {
      if (this.failAfter === 0) {
        this.failAfter = undefined;
        throw new Error("Discord HTTP 500");
      }
      this.failAfter -= 1;
    }
    if (threadId && this.failThreadWith) {
      const failure = this.failThreadWith;
      this.failThreadWith = undefined;
      throw failure === "gone" ? new UnknownThreadError(threadId) : new Error("Discord HTTP 500");
    }
    this.calls.push([threadId, payload]);
    if (threadId) this.archived.delete(threadId);
    const messageId = snowflake();
    this.ids.push(messageId);
    if (threadId && this.loseAnswer) {
      this.loseAnswer = false;
      if (sendKey) this.unknownSends.add(sendKey);
      throw new UnknownSendError();
    }
    return { channelId: threadId ?? `thread-${this.calls.length}`, messageId };
  }

  async updateThread(_forum: string, threadId: string, patch: ThreadPatch) {
    if (this.failThreadWith === "gone") {
      this.failThreadWith = undefined;
      throw new UnknownThreadError(threadId);
    }
    if (patch.archived && this.failArchive) {
      this.failArchive = false;
      throw new Error("Discord HTTP 500");
    }
    if (this.archived.has(threadId) && patch.archived !== false) {
      throw new Error("Discord HTTP 400: Thread is archived");
    }
    this.patches.push([threadId, patch]);
    if (patch.archived) this.archived.add(threadId);
    else this.archived.delete(threadId);
  }

  async editMessage(_forum: string, threadId: string, messageId: string, payload: WebhookMessage) {
    // Like Discord, which refuses changes in an archived post.
    if (this.archived.has(threadId)) throw new Error("Discord HTTP 400: Thread is archived");
    if (this.deleted.includes(messageId)) return false;
    this.edits.push([messageId, payload]);
    return true;
  }

  async deleteMessage(_forum: string, _threadId: string, messageId: string) {
    this.deleted.push(messageId);
  }

  async threadExists() {
    return true;
  }

  async postUrl(_forum: string, threadId: string) {
    return `https://discord.com/channels/${this.guildId}/${threadId}`;
  }

  async addMember(threadId: string, userId: string) {
    if (this.failAddMember) throw new Error("Discord HTTP 403: Missing Access");
    // Like Discord, which requires the post not to be archived.
    if (this.archived.has(threadId)) throw new Error("Discord HTTP 400: Thread is archived");
    this.members.push([threadId, userId]);
  }

  contents(): string[] {
    return this.calls.map(([, payload]) => payload.content ?? "");
  }

  /** The messages posted, cards left out. */
  messages(): Array<[string | undefined, WebhookMessage]> {
    return this.calls.filter(([, payload]) => payload.content !== undefined);
  }
}

export function testSettings(
  overrides: Record<string, unknown> = {},
  secretOverrides: Record<string, string> = {},
): Settings {
  const config = configSchema.parse({
    chatwoot: { baseUrl: "https://chatwoot.example.com" },
    accounts: [
      { id: 3, name: "Acme", forumChannelId: FORUM },
      { id: 1, name: "Globex", forumChannelId: FORUM },
    ],
    agents: [
      { discordUserId: ALICE, chatwootUserId: 42 },
      { discordUserId: BOB, chatwootUserId: 43 },
      { discordUserId: CAROL, chatwootUserId: 45 },
    ],
    triage: { userId: TRIAGE },
    ...overrides,
  });
  const secrets = secretsSchema.parse({
    DISCORD_BOT_TOKEN: "bot",
    DISCORD_PUBLIC_KEY: "0".repeat(64),
    CHATWOOT_RELAY_TOKEN: "relay-token",
    CHATWOOT_WEBHOOK_SECRETS: JSON.stringify({ "3": "secret-acme", "1": "secret-globex" }),
    CHATWOOT_AGENT_TOKENS: JSON.stringify({ [ALICE]: "token-alice", [BOB]: "token-bob" }),
    ...secretOverrides,
  });
  return buildSettings(config, secrets);
}

export { json, mockFetch, on, type Recorded, type Route, takeUnmatched } from "../../../shared/test/http.ts";
