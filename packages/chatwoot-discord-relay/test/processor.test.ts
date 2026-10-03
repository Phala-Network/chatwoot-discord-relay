// The processor against the real Store (in a Durable Object's SQLite), with Chatwoot and
// Discord faked at the fetch boundary, so every request counts against the budget.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import type { Settings } from "../src/config.ts";
import { DiscordForum } from "../src/discord/forum.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { minimumBudget, requestsPerMessage } from "../src/relay/limits.ts";
import { type ProcessOutcome, processConversation, refreshMetadata, relayFor } from "../src/relay/processor.ts";
import { processMessageUpdate } from "../src/relay/updates.ts";
import { Store } from "../src/store.ts";
import { ALICE, BOB, FORUM, json, mockFetch, on, type Recorded, TRIAGE, testSettings } from "./helpers.ts";

const GUILD = "100000000000000044";
const now = () => Math.floor(Date.now() / 1000);

interface FakeMessage {
  id: number;
  content: string | null;
  message_type: number;
  private?: boolean;
  created_at?: number;
  status?: string;
  content_type?: string;
  content_attributes?: Record<string, unknown>;
  sender?: { id: number; type: string; name?: string; thumbnail?: string; avatar_url?: string };
  attachments?: Array<Record<string, unknown>>;
}

/** One Chatwoot conversation (#12 in account 3) and its messages, and the Discord forum. */
class World {
  conversation: Record<string, unknown> = {
    id: 12,
    status: "open",
    inbox_id: 2,
    custom_attributes: {},
    meta: { sender: { name: "Jane Doe" }, channel: "Channel::WebWidget" },
  };
  messages: FakeMessage[] = [];
  bot: { id: number; account_id: number } | null = null;
  failLinks = 0;
  /** Assignee announcements Discord fails before accepting them. */
  failAnnouncements = 0;
  failAnnouncementsStatus = 503;
  /** Posts deleted in Discord. */
  goneThreads = new Set<string>();
  /** New posts Discord fails before accepting them. */
  failPosts = 0;
  failPostsStatus = 503;
  /** Discord's answer to posting into a thread, while it fails. */
  threadFailure: (() => Response) | undefined;
  /** Discord users by id; others are unknown to Discord. */
  discordUsers: Record<string, { avatar: string | null; discriminator: string }> = {};
  private threads = 0;
  readonly requests: Recorded[];

  constructor() {
    const base = "chatwoot.example.com/api/v1/accounts/3";
    this.requests = mockFetch(
      on("GET", `${base}/conversations/12`, () => json(this.conversation)),
      on("GET", `${base}/conversations/12/messages`, (request) => {
        const after = request.url.searchParams.get("after");
        const before = request.url.searchParams.get("before");
        const found = this.messages.filter(
          (message) =>
            (after === null || message.id > Number(after)) && (before === null || message.id < Number(before)),
        );
        return json({ meta: {}, payload: after === null ? found.slice(-20) : found.slice(0, 100) });
      }),
      on("POST", `${base}/conversations/12/custom_attributes`, (request) => {
        if (this.failLinks > 0) {
          this.failLinks -= 1;
          return json({ error: "unavailable" }, { status: 503 });
        }
        const attributes = JSON.parse(request.body).custom_attributes;
        this.conversation.custom_attributes = { ...Object(this.conversation.custom_attributes), ...attributes };
        return json({});
      }),
      on("GET", `${base}/inboxes/2/agent_bot`, () => json({ agent_bot: this.bot })),
      on("GET", `${base}/inboxes/2`, () => json({ id: 2, name: "Web" })),
      on("GET", "discord.com/api/v10/applications/@me", () => json({ id: "100000000000000001" })),
      on("GET", `discord.com/api/v10/channels/${FORUM}/webhooks`, () =>
        json([{ id: "1", token: "tok", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("GET", `discord.com/api/v10/channels/${FORUM}`, () =>
        json({ id: FORUM, guild_id: GUILD, available_tags: [] }),
      ),
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+$/, (request) => {
        const id = request.url.pathname.split("/").at(-1) ?? "";
        return this.goneThreads.has(id)
          ? json({ message: "Unknown Channel", code: 10003 }, { status: 404 })
          : json({ id, parent_id: FORUM });
      }),
      on("PATCH", /^discord\.com\/api\/v10\/channels\/\d+$/, () => json({})),
      on("PATCH", /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/[^/]+$/, () => json({})),
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+\/messages$/, () => json([])),
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/[^/]+$/,
        () => new Response(null, { status: 204 }),
      ),
      on("GET", /^discord\.com\/api\/v10\/users\/\d+$/, (request) => {
        const id = request.url.pathname.split("/").at(-1) ?? "";
        const user = this.discordUsers[id];
        return user
          ? json({ id, username: "agent", ...user })
          : json({ message: "Unknown User", code: 10013 }, { status: 404 });
      }),
      on(
        "PUT",
        /^discord\.com\/api\/v10\/channels\/\d+\/thread-members\/\d+$/,
        () => new Response(null, { status: 204 }),
      ),
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/.+$/,
        () => new Response(null, { status: 204 }),
      ),
      on("POST", "discord.com/api/v10/webhooks/1/tok", (request) => {
        const thread = request.url.searchParams.get("thread_id");
        if (thread && this.threadFailure) return this.threadFailure();
        if (
          thread &&
          this.failAnnouncements > 0 &&
          String(JSON.parse(request.body).content).startsWith("-# Assigned to")
        ) {
          this.failAnnouncements -= 1;
          return json({ message: "unavailable" }, { status: this.failAnnouncementsStatus });
        }
        if (thread) return json({ id: String(100000000000001000n + BigInt(this.requests.length)), channel_id: thread });
        if (this.failPosts > 0) {
          this.failPosts -= 1;
          return json({ message: "unavailable" }, { status: this.failPostsStatus });
        }
        this.threads += 1;
        return json({ id: "card", channel_id: `20000000000000000${this.threads}` });
      }),
    ).requests;
  }

  /** The contents posted into threads. */
  replies(): string[] {
    return this.posts()
      .filter((post) => post.thread)
      .map((post) => String(post.body.content));
  }

  /** The messages the webhook posted, cards left out. */
  posts(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.webhookPosts().filter((post) => post.body.content !== undefined);
  }

  /** The cards the webhook posted. */
  cards(): Array<Record<string, unknown>> {
    return this.webhookPosts()
      .filter((post) => post.body.content === undefined)
      .map((post) => post.body);
  }

  private webhookPosts(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.sent("POST", "/webhooks/1/tok").map((request) => ({
      thread: request.url.searchParams.get("thread_id"),
      body: JSON.parse(request.body),
    }));
  }

  sent(method: string, path: string): Recorded[] {
    return this.requests.filter((request) => request.method === method && request.url.pathname.endsWith(path));
  }
}

async function withStore<T>(run: (store: Store) => Promise<T>): Promise<T> {
  return runInDurableObject(env.HUB.getByName(`processor-${crypto.randomUUID()}`), (_instance, state) => {
    const store = new Store(state.storage.sql);
    store.migrate();
    return run(store);
  });
}

/** What the Hub gives a job: services over one invocation's budget. */
function context(store: Store, settings: Settings, limit = settings.config.relay.subrequestBudget) {
  const budget = new Budget(limit);
  const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, "relay-token", budget.fetch);
  const rest = new DiscordRest("bot", budget.fetch);
  const forum = new DiscordForum(rest, store);
  return {
    settings,
    store,
    forum,
    rest,
    budget,
    chatwoot,
    relay: relayFor(settings, forum, store),
    enqueueMetadata: () => undefined,
  };
}

/** Runs the conversation job until it is done, each run with a fresh budget, like the Hub does. */
async function sync(store: Store, settings: Settings, limit?: number): Promise<ProcessOutcome[]> {
  const outcomes: ProcessOutcome[] = [];
  for (let run = 0; run < 30; run += 1) {
    const outcome = await processConversation(context(store, settings, limit), 3, 12);
    outcomes.push(outcome);
    if (outcome === "done") return outcomes;
  }
  throw new Error("never finished");
}

afterEach(() => vi.restoreAllMocks());

describe("processConversation", () => {
  it("upgrades a 0.1.0 post without replaying history or re-notifying its unchanged owner, then notifies reassignment", async () => {
    const world = new World();
    world.conversation.meta = {
      ...Object(world.conversation.meta),
      assignee: { id: 42, name: "Kim Lee" },
      assignee_type: "User",
    };
    world.messages = [
      { id: 500, content: "Already relayed", message_type: 0 },
      { id: 501, content: "Update from Kim", message_type: 1 },
      { id: 502, content: "Kim updated the ticket", message_type: 2 },
    ];
    await runInDurableObject(env.HUB.getByName("legacy-processor"), async (_instance, state) => {
      // A legacy database fixture, independent of the current migration implementation.
      const sql = state.storage.sql;
      for (const table of [
        "conversations",
        "jobs",
        "deliveries",
        "counters",
        "cache",
        "posted_messages",
        "submitted_responses",
        "interactions",
        "derived_messages",
      ])
        sql.exec(`DROP TABLE IF EXISTS ${table}`);
      sql.exec(`
        CREATE TABLE conversations (
          account_id INTEGER NOT NULL, conversation_id INTEGER NOT NULL, thread_id TEXT, state TEXT,
          cursor INTEGER, fail_message_id INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_id, conversation_id)
        );
        CREATE UNIQUE INDEX conversations_thread ON conversations (thread_id);
        CREATE TABLE jobs (
          key TEXT PRIMARY KEY, priority INTEGER NOT NULL, payload TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
          not_before INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX jobs_due ON jobs (not_before);
        CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
        CREATE TABLE counters (name TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
        UPDATE schema_version SET version = 1;
        INSERT INTO conversations (account_id, conversation_id, thread_id, state, cursor)
          VALUES (3, 12, '100000000000000101', 'open|Kim Lee|billing', 500);
      `);
      const store = new Store(sql);
      store.migrate();
      await sync(store, testSettings());
      await sync(store, testSettings());
      expect(world.replies()).toEqual(["Update from Kim", "_Kim updated the ticket_"]);
      expect(world.sent("PUT", `/thread-members/${ALICE}`)).toEqual([]);
      expect(world.posts().every((post) => post.thread === "100000000000000101")).toBe(true);
      expect(world.cards()).toHaveLength(1);
      expect(world.sent("POST", "/webhooks/1/tok").every((request) => request.url.searchParams.has("thread_id"))).toBe(
        true,
      );
      world.conversation.meta = {
        ...Object(world.conversation.meta),
        assignee: { id: 43, name: "Bob" },
        assignee_type: "User",
      };
      world.messages.push({ id: 503, content: "Assigned to Bob", message_type: 2 });
      await sync(store, testSettings());
      await sync(store, testSettings());
      expect(world.replies()).toEqual([
        "Update from Kim",
        "_Kim updated the ticket_",
        "_Assigned to Bob_",
        `-# Assigned to <@${BOB}>`,
      ]);
      expect(world.sent("PUT", `/thread-members/${BOB}`)).toHaveLength(1);
    });
  });

  it("starts after the cutover watermark, for new and adopted posts alike", async () => {
    const settings = testSettings({ relay: { startAfterMessageId: 500 } });
    const world = new World();
    world.messages = [
      { id: 499, content: "before the cutover", message_type: 0 },
      { id: 500, content: "the other relay's last", message_type: 0 },
      { id: 501, content: "after", message_type: 0 },
    ];
    await withStore(async (store) => {
      await sync(store, settings);
      expect(world.replies()).toEqual([`after\n-# <@${TRIAGE}>`]);
    });

    // An adopted post (linked from the conversation) continues after the watermark too.
    world.conversation.custom_attributes = {
      discord_thread: `https://discord.com/channels/${GUILD}/300000000000000001`,
    };
    const before = world.posts().length;
    await withStore(async (store) => {
      await sync(store, settings);
      expect(world.posts().slice(before)).toEqual([
        { thread: "300000000000000001", body: expect.objectContaining({ content: `after\n-# <@${TRIAGE}>` }) },
      ]);
    });
  });

  it("rebuilds a deleted post with all unfinished parts and responses, without replaying completed history", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "Completed history", message_type: 1 },
      {
        id: 2,
        content: "Your email?",
        message_type: 3,
        content_type: "input_email",
        content_attributes: { submitted_email: "jane@example.com" },
      },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      const oldThread = world.posts().find((post) => post.thread)?.thread;
      if (!oldThread) throw new Error("Test post missing");
      const long = "a".repeat(1674) + "b".repeat(1000);
      world.messages.push({ id: 3, content: long, message_type: 1 });
      let parts = 0;
      world.threadFailure = () => {
        parts += 1;
        return parts === 1
          ? json({ id: "100000000000008001", channel_id: oldThread })
          : json({ message: "rate limited", retry_after: 1 }, { status: 429 });
      };
      await expect(sync(store, settings)).rejects.toThrow("429");
      expect(world.posts().at(-2)?.body.content).toBe(long.slice(0, 1674));
      // The deleted thread invalidates unfinished parts and response digests, but not the completed cursor.
      world.goneThreads.add(oldThread);
      world.threadFailure = () => {
        world.threadFailure = undefined;
        world.failPosts = 1;
        world.failPostsStatus = 429;
        return json({ message: "Unknown Channel", code: 10003 }, { status: 404 });
      };
      // Fail after forgetting the deleted thread, before a new post or cursor can mask a lost checkpoint.
      await expect(sync(store, settings)).rejects.toThrow("429");
      await sync(store, settings);
      expect(world.replies().filter((text) => text === "Completed history")).toHaveLength(1);
      const newThread = world.posts().at(-1)?.thread;
      expect(newThread).not.toBe(oldThread);
      const rebuilt = world.posts().filter((post) => post.thread === newThread);
      expect(rebuilt.map((post) => post.body.content).join("")).toBe(long);
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      await sync(store, settings);
      expect(
        world
          .posts()
          .filter((post) => post.thread === newThread)
          .map((post) => post.body.content),
      ).toEqual([...rebuilt.map((post) => post.body.content), "Your email?\n\n**Email:** jane@example.com"]);
    });
  });

  it("relays assigned history silently, then announces the owner only after a live message", async () => {
    const world = new World();
    world.conversation.meta = {
      ...Object(world.conversation.meta),
      assignee: { id: 42, name: "Alice" },
      assignee_type: "User",
    };
    world.messages = [
      { id: 1, content: "last month", message_type: 0, created_at: now() - 30 * 86400 },
      { id: 2, content: "an answer", message_type: 1, created_at: now() - 30 * 86400 },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      expect(world.replies()).toEqual(["last month", "an answer"]);
      expect(
        world
          .posts()
          .filter((post) => post.thread)
          .map((post) => post.body.allowed_mentions),
      ).toEqual([{ parse: [] }, { parse: [] }]);
      expect(world.sent("PUT", `/thread-members/${ALICE}`)).toEqual([]);
      world.messages.push({ id: 3, content: "just now", message_type: 0, created_at: now() - 5 });
      await sync(store, settings);
      await sync(store, settings);
      expect(world.replies()).toEqual([
        "last month",
        "an answer",
        `just now\n-# <@${TRIAGE}>`,
        `-# Assigned to <@${ALICE}>`,
      ]);
      expect(world.posts().at(-1)?.body.allowed_mentions).toEqual({ parse: [], users: [ALICE] });
      expect(world.sent("PUT", `/thread-members/${ALICE}`)).toHaveLength(1);
    });
  });

  it("pages through more than 100 messages in one run", async () => {
    const world = new World();
    world.messages = Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      content: `n${index + 1}`,
      message_type: 1,
    }));
    await withStore(async (store) => {
      expect(await sync(store, testSettings(), 1000)).toEqual(["done"]);
      expect(world.replies()).toEqual(world.messages.map((message) => message.content));
      const pages = world.sent("GET", "/messages").map((request) => request.url.searchParams.get("after"));
      expect(pages).toEqual(["0", "100"]);
    });
  });

  it("yields before the subrequest budget runs out and resumes without posting anything twice", async () => {
    const settings = testSettings();
    const world = new World();
    world.messages = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      content: `n${index + 1}`,
      message_type: 1,
    }));
    const limit = requestsPerMessage(settings.config.relay.maxChunks) + 10;
    await withStore(async (store) => {
      const outcomes = await sync(store, settings, limit);
      expect(outcomes.length).toBeGreaterThan(2);
      expect(outcomes.slice(0, -1).every((outcome) => outcome === "yield")).toBe(true);
      expect(world.replies()).toEqual(world.messages.map((message) => message.content));
    });
  });

  it("relays a message in its worst case within the smallest budget the configuration accepts", async () => {
    const settings = testSettings({ relay: { maxChunks: 10, subrequestBudget: minimumBudget(10) } });
    const world = new World();
    // The link attribute names a post deleted in Discord: checked, then a new post is opened.
    world.goneThreads.add("300000000000000009");
    world.conversation.custom_attributes = {
      discord_thread: `https://discord.com/channels/${GUILD}/300000000000000009`,
    };
    world.discordUsers = { [BOB]: { avatar: "a_bob", discriminator: "0" } };
    world.messages = [
      { id: 1, content: "x\n".repeat(15_000), message_type: 1, sender: { id: 43, type: "user", name: "Bob" } },
    ];
    await withStore(async (store) => {
      expect(await sync(store, settings)).toEqual(["done"]);
      const replies = world.replies();
      expect(replies).toHaveLength(11);
      expect(replies.at(-1)).toMatch(/^-# Message truncated/);
    });
  });

  it.each([
    [
      "a rate limit",
      () => json({ message: "You are being rate limited.", retry_after: 64.5, global: false }, { status: 429 }),
    ],
    ["missing permissions", () => json({ message: "Missing Permissions", code: 50013 }, { status: 403 })],
  ])("never skips a message because of %s, however often it fails", async (_name, failure) => {
    const settings = testSettings();
    const world = new World();
    world.messages = [
      { id: 1, content: "first", message_type: 1 },
      { id: 2, content: "second", message_type: 1 },
    ];
    world.threadFailure = failure;
    await withStore(async (store) => {
      // Every job attempt fails, far more often than relay.maxAttempts.
      for (let attempt = 0; attempt < settings.config.relay.maxAttempts * 2; attempt += 1) {
        await expect(processConversation(context(store, settings), 3, 12)).rejects.toThrow(/Discord HTTP/);
      }

      world.threadFailure = undefined;
      await sync(store, settings);
      // Each failed attempt was at the first message; "second" never went ahead of it.
      const attempts = settings.config.relay.maxAttempts * 2;
      expect(world.replies()).toEqual([...Array<string>(attempts + 1).fill("first"), "second"]);
    });
  });

  it("skips a message Discord keeps refusing as invalid, with a notice, after relay.maxAttempts", async () => {
    const settings = testSettings();
    const { maxAttempts } = settings.config.relay;
    const world = new World();
    world.messages = [{ id: 1, content: "first", message_type: 1 }];
    await withStore(async (store) => {
      await sync(store, settings);
      world.messages.push({ id: 2, content: "refused", message_type: 1 });
      // Refused on every attempt; the notice afterwards is accepted.
      let refusals = maxAttempts;
      world.threadFailure = () => {
        refusals -= 1;
        return refusals >= 0
          ? json({ message: "Invalid Form Body", code: 50035 }, { status: 400 })
          : json({ id: "notice", channel_id: "x" });
      };
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        await expect(processConversation(context(store, settings), 3, 12)).rejects.toThrow(/Discord HTTP 400/);
      }
      expect(await processConversation(context(store, settings), 3, 12)).toBe("done");

      expect(world.posts().at(-1)?.body.content).toBe(
        "⚠️ Chatwoot message 2 could not be relayed. Check it in Chatwoot.",
      );
    });
  });

  it("links the post from its conversation, failing the job for a retry when that fails", async () => {
    const world = new World();
    world.messages = [{ id: 1, content: "hello", message_type: 0 }];
    world.failLinks = 1;
    await withStore(async (store) => {
      const settings = testSettings();
      await expect(sync(store, settings)).rejects.toThrow();
      expect(world.conversation.custom_attributes).toEqual({});
      // The retry, with no new message, only links.
      await sync(store, settings);
      const link = `https://discord.com/channels/${GUILD}/${world.posts().find((post) => post.thread)?.thread}`;
      expect(world.conversation.custom_attributes).toEqual({ discord_thread: link });
      // Linked: later syncs do not write it again.
      await sync(store, settings);
      expect(world.sent("POST", "/custom_attributes")).toHaveLength(2);
      expect(world.replies()).toEqual([`hello\n-# <@${TRIAGE}>`]);
    });
  });

  it.each(["missing", "different thread", "different guild"])(
    "repairs a %s link after a concurrent custom attribute save",
    async (lost) => {
      const world = new World();
      world.messages = [{ id: 1, content: "hello", message_type: 0 }];
      await withStore(async (store) => {
        const settings = testSettings();
        await sync(store, settings);
        const thread = world.posts().find((post) => post.thread)?.thread;
        const link = `https://discord.com/channels/${GUILD}/${thread}`;
        world.conversation.custom_attributes = {
          unrelated: 1,
          ...(lost === "missing"
            ? {}
            : {
                discord_thread:
                  lost === "different thread"
                    ? `https://discord.com/channels/${GUILD}/100000000000000099`
                    : `https://discord.com/channels/100000000000000099/${thread}`,
              }),
        };
        await sync(store, settings);
        expect(world.conversation.custom_attributes).toEqual({ unrelated: 1, discord_thread: link });
        expect(world.sent("POST", "/custom_attributes")).toHaveLength(2);
        await sync(store, settings);
        expect(world.sent("POST", "/custom_attributes")).toHaveLength(2);
        expect(world.replies()).toEqual([`hello\n-# <@${TRIAGE}>`]);
      });
    },
  );

  it("relays only the account's allowed inboxes", async () => {
    const world = new World();
    world.messages = [{ id: 1, content: "hello", message_type: 0 }];
    const accounts = (inboxIds: number[]) =>
      testSettings({ accounts: [{ id: 3, name: "Acme", forumChannelId: "100000000000000055", inboxIds }] });
    await withStore(async (store) => {
      await sync(store, accounts([9]));
      expect(world.posts()).toEqual([]);
      await sync(store, accounts([2, 9]));
      expect(world.replies()).toEqual([`hello\n-# <@${TRIAGE}>`]);
    });
  });

  it("after two reassignments in one run, pings the latest assignee once, after both activity lines", async () => {
    const world = new World();
    world.messages = [{ id: 1, content: "hello", message_type: 0, created_at: now() - 60 }];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      world.conversation.meta = {
        ...Object(world.conversation.meta),
        // Linked by Chatwoot user id: an email changed in Chatwoot does not matter.
        assignee: { id: 43, name: "Bob", email: "robert@example.org" },
      };
      world.messages.push(
        { id: 2, content: "Assigned to Alice by Sam", message_type: 2, created_at: now() - 8 },
        { id: 3, content: "Assigned to Bob by Sam", message_type: 2, created_at: now() - 4 },
      );
      await sync(store, settings);
      const posted = world
        .posts()
        .slice(-3)
        .map((post) => [post.body.content, post.body.allowed_mentions]);
      expect(posted).toEqual([
        ["_Assigned to Alice by Sam_", { parse: [] }],
        ["_Assigned to Bob by Sam_", { parse: [] }],
        [`-# Assigned to <@${BOB}>`, { parse: [], users: [BOB] }],
      ]);
      // The new assignee is added to the post, once.
      expect(world.sent("PUT", `/thread-members/${BOB}`)).toHaveLength(1);
    });
  });

  it("retries a failed assignee announcement without new messages, so the assignee is still pinged", async () => {
    const world = new World();
    world.conversation.meta = { ...Object(world.conversation.meta), assignee: { id: 43, name: "Bob" } };
    world.messages = [{ id: 1, content: "hello", message_type: 0, created_at: now() - 5 }];
    world.failAnnouncements = 1;
    await withStore(async (store) => {
      const settings = testSettings();
      world.failAnnouncementsStatus = 429;
      await expect(sync(store, settings)).rejects.toThrow();
      await sync(store, settings);
      // The customer message was posted once; the announcement failed, then its retry succeeded.
      expect(world.replies()).toEqual([
        `hello\n-# <@${TRIAGE}>`,
        `-# Assigned to <@${BOB}>`,
        `-# Assigned to <@${BOB}>`,
      ]);
      expect(world.posts().at(-1)?.body.allowed_mentions).toEqual({ parse: [], users: [BOB] });
    });
  });

  it("relays an email reply without its quoted history, like Chatwoot does, and auto-replies without notifications", async () => {
    // As MailPresenter#serialized_data stores them at v4.18.0: `content` is the whole text.
    const history =
      "On Mon, Sep 21, 2026 at 10:02 AM Acme Support <support@acme.example> wrote:\n> Please restart the agent.\n> Kind regards";
    const email = (reply: string, extra: Record<string, unknown> = {}) => ({
      subject: "Re: Agent will not connect",
      from: ["jane@example.com"],
      multipart: true,
      auto_reply: false,
      text_content: { full: `${reply}\n\n${history}`, reply: `${reply}\n\n${history}`, quoted: reply },
      html_content: {
        full: `<div>${reply}</div><blockquote>Please restart the agent.</blockquote>`,
        reply: `${reply}\n\n> Please restart the agent.`,
        quoted: reply,
      },
      ...extra,
    });
    const world = new World();
    world.messages = [
      {
        id: 1,
        content: `Thanks, that worked!\n\n${history}`,
        message_type: 0,
        content_attributes: { email: email("Thanks, that worked!") },
      },
      // An HTML-only email has no text body: the HTML one, as text.
      {
        id: 2,
        content: "<div>Also this</div>",
        message_type: 0,
        content_attributes: { email: email("Also this", { text_content: {} }) },
      },
      {
        id: 3,
        content: `I am out of office until Monday.\n\n${history}`,
        message_type: 0,
        content_attributes: { email: email("I am out of office until Monday.", { auto_reply: true }) },
      },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      expect(world.replies()).toEqual([
        `Thanks, that worked!\n-# <@${TRIAGE}>`,
        `Also this\n-# <@${TRIAGE}>`,
        "I am out of office until Monday.",
      ]);
    });
  });

  it("shows what channels and bots send that is not plain text", async () => {
    const sticker = "https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker.png";
    const world = new World();
    world.messages = [
      // LINE stickers are stored as a markdown image.
      { id: 1, content: `![sticker-52002734](${sticker})`, content_type: "sticker", message_type: 0 },
      // A contact shared on Telegram.
      {
        id: 2,
        content: null,
        message_type: 0,
        attachments: [
          { file_type: "contact", fallback_title: "+15550100", meta: { first_name: "Ana", last_name: "Lima" } },
        ],
      },
      {
        id: 3,
        content: null,
        message_type: 0,
        attachments: [
          { file_type: "story_mention", data_url: "https://lookaside.example.com/story" },
          { file_type: "ig_reel", data_url: "https://lookaside.example.com/reel" },
          { file_type: "fallback", fallback_title: "Shared post", data_url: "https://example.com/p" },
        ],
      },
      {
        id: 4,
        content: "Pick a topic",
        content_type: "input_select",
        message_type: 1,
        content_attributes: {
          // An option without a title shows its value; a malformed field does not hide the rest.
          items: [
            { title: "Billing", value: "billing" },
            { title: "Technical", value: "tech" },
            { value: "other" },
            { title: 5, value: "five" },
          ],
        },
      },
      {
        id: 5,
        content: null,
        content_type: "cards",
        message_type: 1,
        content_attributes: {
          items: [
            {
              title: "Pro plan",
              description: "$10 a month",
              media_url: "https://example.com/pro.png",
              actions: [
                { type: "link", text: "Buy", uri: "https://example.com/buy" },
                { type: "postback", text: "More", payload: "more" },
              ],
            },
          ],
        },
      },
      {
        id: 6,
        content: null,
        content_type: "article",
        message_type: 1,
        content_attributes: {
          items: [{ title: "Reset your password", description: "Steps", link: "https://help.example.com/reset" }],
        },
      },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      expect(world.replies()).toEqual([
        `${sticker}\n-# Triage bot not called: handled automatically. Ask it here, if needed.`,
        `📇 Ana Lima: +15550100\n-# Triage bot not called: handled automatically. Ask it here, if needed.`,
        `📎 Story mention https://lookaside.example.com/story\n📎 Reel https://lookaside.example.com/reel\n📎 Shared post https://example.com/p\n-# Triage bot not called: handled automatically. Ask it here, if needed.`,
        "Pick a topic\n• Billing\n• Technical\n• other\n• five",
        "• [Pro plan](<https://example.com/pro.png>) — $10 a month · [Buy](<https://example.com/buy>)",
        "• [Reset your password](<https://help.example.com/reset>) — Steps",
      ]);
    });
  });

  it("pings linked agents mentioned in private notes by their Chatwoot user id", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "[@Bob](mention://user/43/Bob) can you check?", message_type: 1, private: true },
      {
        id: 2,
        content: "[@Dana](mention://user/44/Dana) and [@Bob](mention://user/43/Bob)",
        message_type: 1,
        private: true,
      },
      { id: 3, content: "[@Bob](mention://user/43/Bob) in a reply", message_type: 1 },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      const posted = world
        .posts()
        .filter((post) => post.thread)
        .map((post) => [post.body.content, post.body.allowed_mentions]);
      expect(posted).toEqual([
        [`🔒 **Internal note**\n<@${BOB}> can you check?`, { parse: [], users: [BOB] }],
        // Dana is not linked to a Discord user.
        [`🔒 **Internal note**\n@Dana and <@${BOB}>`, { parse: [], users: [BOB] }],
        // Chatwoot notifies mentions in private notes only.
        ["@Bob in a reply", { parse: [] }],
      ]);
      expect(world.sent("GET", "/agents")).toEqual([]);
    });
  });
});

describe("agent avatars", () => {
  const cdn = "https://cdn.discordapp.com";
  const agent = (id: number, userId: number, thumbnail = "") => ({
    id,
    content: `reply ${id}`,
    message_type: 1,
    sender: { id: userId, type: "user", thumbnail },
  });

  function avatars(world: World): unknown[] {
    return world
      .posts()
      .filter((post) => post.thread)
      .map((post) => post.body.avatar_url);
  }

  it("shows linked agents' Discord avatars, looked up once a day, else their Chatwoot avatar, and agent bots' own", async () => {
    const world = new World();
    world.discordUsers = {
      [BOB]: { avatar: "a_bob", discriminator: "0" },
      [ALICE]: { avatar: null, discriminator: "0" },
    };
    world.messages = [
      agent(1, 43, "https://chatwoot.example.com/bob.png"),
      agent(2, 42),
      agent(3, 44, "https://chatwoot.example.com/dana.png"), // Dana is not linked.
      agent(4, 44),
      {
        id: 5,
        content: "bot reply",
        message_type: 1,
        sender: { id: 7, type: "agent_bot", avatar_url: "https://x.example/b.png" },
      },
      {
        id: 6,
        content: "customer",
        message_type: 0,
        sender: { id: 9, type: "contact", thumbnail: "https://x.example/c.png" },
      },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      await refreshMetadata(context(store, settings), { accountId: 3, discordUserId: BOB });
      await refreshMetadata(context(store, settings), { accountId: 3, discordUserId: ALICE });
      await sync(store, settings);
      world.messages.push(agent(7, 43));
      await sync(store, settings);
      expect(avatars(world)).toEqual([
        `${cdn}/avatars/${BOB}/a_bob.png`,
        `${cdn}/embed/avatars/${(BigInt(ALICE) >> 22n) % 6n}.png`,
        "https://chatwoot.example.com/dana.png",
        "https://chatwoot.example.com/favicon-512x512.png",
        "https://x.example/b.png",
        "https://x.example/c.png",
        `${cdn}/avatars/${BOB}/a_bob.png`,
      ]);
      // Cached: one lookup per agent.
      expect(world.sent("GET", `/users/${BOB}`)).toHaveLength(1);
      expect(world.sent("GET", `/users/${ALICE}`)).toHaveLength(1);
    });
  });

  it("falls back to the Chatwoot avatar when Discord will not say, without asking again for a while", async () => {
    const world = new World();
    world.messages = [agent(1, 43, "https://chatwoot.example.com/bob.png"), agent(2, 43)];
    await withStore(async (store) => {
      const settings = testSettings();
      await refreshMetadata(context(store, settings), { accountId: 3, discordUserId: BOB });
      expect(await sync(store, settings)).toEqual(["done"]);
      expect(avatars(world)).toEqual([
        "https://chatwoot.example.com/bob.png",
        "https://chatwoot.example.com/favicon-512x512.png",
      ]);
      expect(world.sent("GET", `/users/${BOB}`)).toHaveLength(1);
    });
  });
});

describe("processMessageUpdate", () => {
  it("relays a failure and a response reported before their message was relayed, with the message", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "hello", message_type: 0 },
      { id: 2, content: "Here is your refund", message_type: 1, status: "failed", content_attributes: {} },
      {
        id: 3,
        content: "How did we do?",
        message_type: 3,
        content_type: "input_csat",
        content_attributes: { submitted_values: { csat_survey_response: { rating: 5 } } },
      },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      // The updates arrive first: there is no post yet, so the job relays them with the messages.
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      await processMessageUpdate(context(store, settings), 3, 12, 3);
      expect(world.posts()).toEqual([]);
      await sync(store, settings);
      expect(world.replies()).toEqual([
        `hello\n-# <@${TRIAGE}>`,
        "Here is your refund",
        "⚠️ A reply could not be delivered to the customer.",
        "How did we do?\n\n**CSAT:**\n• Rating: 5",
      ]);
    });
  });

  it("removes a deleted message with the response posted about it, and its text from the title", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "my password is hunter2", message_type: 0 },
      {
        id: 2,
        content: "How did we do?",
        message_type: 3,
        content_type: "input_csat",
        content_attributes: { submitted_values: { csat_survey_response: { rating: 1, feedback_message: "call me" } } },
      },
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      await sync(store, settings);
      expect(world.replies()).toHaveLength(2); // the message and the response
      for (const message of world.messages) Object.assign(message, { content_attributes: { deleted: true } });
      await processMessageUpdate(context(store, settings), 3, 12, 1);
      await processMessageUpdate(context(store, settings), 3, 12, 2);
      expect(world.sent("DELETE", "")).toHaveLength(2);
      const renamed = world
        .sent("PATCH", "")
        .map((request) => JSON.parse(request.body).name)
        .filter(Boolean);
      expect(renamed.at(-1)).toBe("[Acme #12] Jane Doe");
    });
  });
});

describe("agent bot lifecycle", () => {
  it.each(["open", "resolved", "snoozed"])(
    "holds pending customer messages and releases them on %s",
    async (status) => {
      const world = new World();
      world.bot = { id: 42, account_id: 3 };
      world.conversation.status = "pending";
      world.conversation.meta = { assignee: { id: 42, name: "Brand bot" }, assignee_type: "AgentBot" };
      world.messages = [{ id: 1, content: "Please help", message_type: 0, created_at: now() }];
      await withStore(async (store) => {
        const settings = testSettings();
        expect(await processConversation(context(store, settings), 3, 12)).toBe("pending");
        expect(world.posts()).toEqual([]);
        expect(world.cards()).toEqual([]);

        world.conversation.status = status;
        await sync(store, settings);
        expect(world.replies()[0]).toContain("Please help");
        expect(world.replies()[0]?.includes(`<@${TRIAGE}>`)).toBe(status === "open");
        expect(world.replies().join("\n")).not.toContain(`<@${ALICE}>`);
        expect(JSON.stringify(world.cards())).toContain("Unassigned");
      });
    },
  );

  it("releases a pending message when the inbox bot is disconnected", async () => {
    const world = new World();
    world.bot = { id: 1, account_id: 3 };
    world.conversation.status = "pending";
    world.messages = [{ id: 1, content: "Waiting greeting", message_type: 0 }];
    await withStore(async (store) => {
      const settings = testSettings();
      expect(await processConversation(context(store, settings), 3, 12)).toBe("pending");
      world.bot = null;
      await sync(store, settings);
      expect(world.replies().join("\n")).toContain("Waiting greeting");
      expect(world.replies().join("\n")).not.toContain(`<@${TRIAGE}>`);
    });
  });

  it.each([
    { reply: { message_type: 1, sender: { id: 42, type: "user" } }, answered: true },
    { reply: { message_type: 1, sender: { id: 42, type: "agent_bot" } }, answered: true },
    { reply: { message_type: 1, status: "delivered" }, answered: true },
    { reply: { message_type: 0 }, answered: false },
    { reply: { message_type: 1, private: true }, answered: false },
    { reply: { message_type: 1, status: "failed" }, answered: false },
    { reply: { message_type: 3 }, answered: false },
    { reply: { message_type: 2 }, answered: false },
    { reply: { message_type: 1, content_attributes: { deleted: true } }, answered: false },
    { reply: { message_type: 1, content_attributes: { email: { auto_reply: true } } }, answered: false },
  ])("posts the correct triage decision for a later $reply", async ({ reply, answered }) => {
    const world = new World();
    world.messages = [
      { id: 1, content: "A customer request", message_type: 0 },
      { id: 2, content: "A later message", ...reply },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      const customer = world.replies().find((text) => text.startsWith("A customer request"));
      expect(customer?.includes(`<@${TRIAGE}>`)).toBe(!answered);
      if (answered) expect(customer).toContain("handled automatically");
    });
  });

  it("finds an answer beyond the first forward page, then keeps a later real request despite automatic email", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "First request", message_type: 0 },
      ...Array.from({ length: 101 }, (_, i) => ({ id: i + 2, content: "Activity", message_type: 2 })),
      { id: 103, content: "The answer", message_type: 1 },
      { id: 104, content: "New request", message_type: 0 },
      { id: 105, content: "Automatic", message_type: 0, content_attributes: { email: { auto_reply: true } } },
    ];
    await withStore(async (store) => {
      await sync(store, testSettings());
      expect(world.replies().find((text) => text.startsWith("First request"))).toContain("handled automatically");
      expect(world.replies().find((text) => text.startsWith("New request"))).toContain(`<@${TRIAGE}>`);
      expect(world.replies().find((text) => text.startsWith("Automatic"))).not.toContain(`<@${TRIAGE}>`);
    });
  });

  it("does not restore a stale answer cursor when an update arrives during a page read", async () => {
    const world = new World();
    const reply = { id: 150, content: "The answer", message_type: 1, status: "failed" };
    world.messages = [
      { id: 1, content: "A customer request", message_type: 0 },
      ...Array.from({ length: 300 }, (_, index) =>
        index + 2 === reply.id ? reply : { id: index + 2, content: "Activity", message_type: 2 },
      ),
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      const services = context(store, settings);
      const read = services.chatwoot.listMessages;
      vi.spyOn(services.chatwoot, "listMessages").mockImplementation(async (...args) => {
        const page = await read(...args);
        if (args[2]?.after === 201) {
          reply.status = "sent";
          store.invalidateAnswerScans(3, 12); // The Hub invalidates on webhook receipt, during this read.
        }
        return page;
      });
      expect(await processConversation(services, 3, 12)).toBe("yield");
      expect(world.posts()).toEqual([]);

      await sync(store, settings);
      expect(world.replies().find((text) => text.startsWith("A customer request"))).toContain("handled automatically");
    });
  });

  it("completes a long answer scan across minimum-budget alarms without restarting each time", async () => {
    const world = new World();
    world.messages = [
      { id: 1, content: "A customer request", message_type: 0 },
      ...Array.from({ length: 6200 }, (_, index) => ({ id: index + 2, content: "Activity", message_type: 2 })),
    ];
    await withStore(async (store) => {
      const settings = testSettings();
      for (let alarm = 0; alarm < 5 && world.posts().length === 0; alarm += 1) {
        await processConversation(context(store, settings, minimumBudget(4)), 3, 12);
      }
      expect(world.replies().find((text) => text.startsWith("A customer request"))).toContain(`<@${TRIAGE}>`);
    });
  });

  it.each(["arrives", "fails"])(
    "rechecks an answer that %s across alarms before the first triage decision",
    async (change) => {
      const world = new World();
      const reply = { id: 302, content: "The answer", message_type: 1, status: "sent" };
      world.messages = [
        { id: 1, content: "A customer request", message_type: 0 },
        ...Array.from({ length: 300 }, (_, index) => ({ id: index + 2, content: "Activity", message_type: 2 })),
        ...(change === "fails" ? [reply] : []),
      ];
      await withStore(async (store) => {
        const settings = testSettings();
        expect(await processConversation(context(store, settings, minimumBudget(4)), 3, 12)).toBe("yield");
        expect(world.posts()).toEqual([]);

        if (change === "arrives") world.messages.push(reply);
        else reply.status = "failed";
        await sync(store, settings);
        const customer = world.replies().find((text) => text.startsWith("A customer request"));
        expect(customer?.includes(`<@${TRIAGE}>`)).toBe(change === "fails");
      });
    },
  );
});

it("continues after a time slice without replaying already posted messages", async () => {
  const world = new World();
  world.messages = [
    { id: 901, content: "first", message_type: 2 },
    { id: 902, content: "second", message_type: 2 },
  ];
  const settings = testSettings();
  await withStore(async (store) => {
    store.adoptThread(3, 12, "100000000000000901");
    store.setCursor(3, 12, 0);
    const services = context(store, settings);
    services.budget.startSlice(150);
    // The first post succeeds. Reading the next message's decoration is not needed for activities;
    // stop at the next GET after that post, then resume through a fresh invocation.
    const realFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    if (!realFetch) throw new Error("Missing world fetch");
    let firstPosted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const input = new Request(request, init);
      if (firstPosted && input.method === "GET") {
        await new Promise<void>((_resolve, reject) =>
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }),
        );
      }
      const response = await realFetch(input);
      if (input.method === "POST" && new URL(input.url).pathname === "/api/v10/webhooks/1/tok") firstPosted = true;
      return response;
    });
    await expect(processConversation(services, 3, 12)).rejects.toThrow(/time slice/);
    vi.mocked(globalThis.fetch).mockImplementation(realFetch);
    await sync(store, settings);
    expect(world.replies()).toEqual(["_first_", "_second_"]);
  });
});
