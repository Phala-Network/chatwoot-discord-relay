// End to end through the Worker and the Hub Durable Object (alarms included), with Chatwoot and
// Discord faked at the fetch boundary.

import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Budget, JobDeadlineError } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { DiscordForum } from "../src/discord/forum.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import worker from "../src/index.ts";
import { minimumBudget } from "../src/relay/limits.ts";
import { processConversation, relayFor } from "../src/relay/processor.ts";
import { loadSettings } from "../src/settings.ts";
import { Store } from "../src/store.ts";
import { ALICE, json, mockFetch, on, type Recorded, type Route, TRIAGE } from "./helpers.ts";

const FORUM = "100000000000000055";
const GUILD = "100000000000000044";
const encoder = new TextEncoder();

// Thread ids stay unique across tests: the Durable Object's storage persists within this file.
let threadCounter = 10000;
function nextThreadId(): string {
  threadCounter += 1;
  return `1000000000000${threadCounter}`;
}

interface FakeConversation {
  id: number;
  status: string;
  /** Unix seconds; default: now. */
  lastActivityAt?: number;
  custom_attributes: Record<string, unknown>;
  messages: Array<{
    id: number;
    content: string;
    message_type: number;
    content_type?: string;
    private?: boolean;
    status?: string;
    sender?: Record<string, unknown>;
    content_attributes?: Record<string, unknown>;
  }>;
}

/** A tiny Chatwoot + Discord: enough state to exercise the relay end to end. */
class World {
  conversations = new Map<number, FakeConversation>();
  threads = new Map<string, string>(); // thread id -> parent forum
  bot: { id: number; account_id: number } | null = null;
  failReplies = 0;
  rateLimitReplies = 0;
  failPatches = 0;
  failConversations = 0;
  private replies = 0;
  readonly acceptedMessages: Array<{ id: string; body: Record<string, unknown> }> = [];
  readonly mock: ReturnType<typeof mockFetch>;

  constructor(extra: Route[] = []) {
    this.mock = mockFetch(...extra, ...this.routes());
  }

  conversation(
    id: number,
    messages: FakeConversation["messages"],
    custom_attributes: Record<string, unknown> = {},
    status = "open",
  ) {
    this.conversations.set(id, { id, status, custom_attributes, messages });
  }

  get requests(): Recorded[] {
    return this.mock.requests;
  }

  sent(method: string, path: RegExp): Recorded[] {
    return this.requests.filter((request) => request.method === method && path.test(request.url.pathname));
  }

  /** The messages the webhook posted, cards left out. */
  webhookPosts(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.executions().filter((post) => post.body.content !== undefined);
  }

  /** The cards the webhook posted. */
  cards(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.executions().filter((post) => post.body.content === undefined);
  }

  private executions(): Array<{ thread: string | null; body: Record<string, unknown> }> {
    return this.requests
      .filter((request) => request.method === "POST" && /^\/api\/v10\/webhooks\/1\/tok$/.test(request.url.pathname))
      .map((request) => ({ thread: request.url.searchParams.get("thread_id"), body: JSON.parse(request.body) }));
  }

  private conversationJson(conversation: FakeConversation) {
    return {
      id: conversation.id,
      status: conversation.status,
      inbox_id: 2,
      custom_attributes: conversation.custom_attributes,
      meta: { sender: { name: "Jane Doe", email: "jane@example.com" }, channel: "Channel::WebWidget" },
      messages: conversation.messages.slice(-1).map(({ id }) => ({ id })),
      last_activity_at: conversation.lastActivityAt ?? Math.floor(Date.now() / 1000),
    };
  }

  private routes(): Route[] {
    const cw = "chatwoot.example.com/api/v1/accounts/3";
    return [
      on("GET", new RegExp(`^${cw}/conversations/(\\d+)$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-1)));
        if (this.failConversations > 0) {
          this.failConversations -= 1;
          return json({ error: "unavailable" }, { status: 503 });
        }
        return conversation
          ? json(this.conversationJson(conversation))
          : json({ error: "Resource could not be found" }, { status: 404 });
      }),
      on("GET", new RegExp(`^${cw}/conversations/(\\d+)/messages$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-2)));
        const after = request.url.searchParams.get("after");
        const before = request.url.searchParams.get("before");
        const messages = (conversation?.messages ?? []).filter(
          (message) =>
            (after === null || message.id > Number(after)) && (before === null || message.id < Number(before)),
        );
        return json({ meta: {}, payload: after === null ? messages.slice(-20) : messages.slice(0, 100) });
      }),
      on("POST", new RegExp(`^${cw}/conversations/(\\d+)/custom_attributes$`), (request) => {
        const conversation = this.conversations.get(Number(request.url.pathname.split("/").at(-2)));
        const body = JSON.parse(request.body);
        // Chatwoot's merge semantics (ConversationCustomAttributesConcern at v4.18.0).
        if (conversation) {
          conversation.custom_attributes = body.merge
            ? { ...conversation.custom_attributes, ...body.custom_attributes }
            : body.custom_attributes;
        }
        return json({});
      }),
      on("GET", "chatwoot.example.com/api/v1/accounts/1/conversations", () =>
        json({ data: { meta: {}, payload: [] } }),
      ),
      on("GET", `${cw}/inboxes/2/agent_bot`, () => json({ agent_bot: this.bot })),
      on("GET", `${cw}/inboxes/2`, () => json({ id: 2, name: "Acme — Product App" })),
      on("GET", `${cw}/conversations`, (request) => {
        const all = [...this.conversations.values()].map((c) => this.conversationJson(c));
        return json({ data: { meta: {}, payload: request.url.searchParams.get("page") === "1" ? all : [] } });
      }),
      on("GET", "discord.com/api/v10/applications/@me", () => json({ id: "100000000000000001" })),
      on("GET", `discord.com/api/v10/channels/${FORUM}/webhooks`, () =>
        json([{ id: "1", token: "tok", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("GET", `discord.com/api/v10/channels/${FORUM}`, () =>
        json({
          id: FORUM,
          type: 15,
          guild_id: GUILD,
          available_tags: [
            { id: "100000000000000301", name: "Acme" },
            { id: "100000000000000302", name: "open" },
          ],
        }),
      ),
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+$/, (request) => {
        const id = request.url.pathname.split("/").at(-1) ?? "";
        const parent = this.threads.get(id);
        return parent
          ? json({ id, type: 11, parent_id: parent })
          : json({ message: "Unknown Channel", code: 10003 }, { status: 404 });
      }),
      on("PATCH", /^discord\.com\/api\/v10\/channels\/\d+$/, () => {
        if (this.failPatches === 0) return json({});
        this.failPatches -= 1;
        return json({ message: "Internal Server Error" }, { status: 500 });
      }),
      on(
        "DELETE",
        /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/[\w-]+$/,
        () => new Response(null, { status: 204 }),
      ),
      on("PATCH", /^discord\.com\/api\/v10\/webhooks\/1\/tok\/messages\/[\w-]+$/, () => json({})),
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+\/messages$/, () => json([])),
      // A message read (Reply with draft without a kept draft): Discord does not give it back.
      on("GET", /^discord\.com\/api\/v10\/channels\/\d+\/messages\/\d+$/, () =>
        json({ message: "Service Unavailable" }, { status: 503 }),
      ),
      on("POST", "discord.com/api/v10/webhooks/1/tok", (request) => {
        const thread = request.url.searchParams.get("thread_id");
        if (thread) {
          if (this.rateLimitReplies > 0) {
            this.rateLimitReplies -= 1;
            return json({ message: "You are being rate limited.", retry_after: 64.5, global: false }, { status: 429 });
          }
          if (this.failReplies > 0) {
            this.failReplies -= 1;
            return json({ message: "Internal Server Error" }, { status: 500 });
          }
          this.replies += 1;
          const id = String(100000000000001000n + BigInt(this.replies));
          this.acceptedMessages.push({ id, body: JSON.parse(request.body) });
          return json({ id, channel_id: thread });
        }
        const id = nextThreadId();
        this.threads.set(id, FORUM);
        return json({ id: "header", channel_id: id });
      }),
      on("PATCH", /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/[^/]+\/messages\/(@|%40)original$/, () =>
        json({}),
      ),
    ];
  }
}

function hub() {
  return env.HUB.getByName("global");
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request<unknown, IncomingRequestCfProperties>(request), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function chatwootWebhook(
  payload: unknown,
  { secret = "secret-acme", delivery = crypto.randomUUID(), timestamp = Math.floor(Date.now() / 1000) } = {},
) {
  const body = JSON.stringify(payload);
  const ts = String(timestamp);
  return call(
    new Request("https://relay.example.com/chatwoot/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-chatwoot-timestamp": ts,
        "x-chatwoot-signature": `sha256=${await hmac(secret, `${ts}.${body}`)}`,
        "x-chatwoot-delivery": delivery,
      },
    }),
  );
}

/** The triage bot's hook: signed like a Chatwoot webhook, with the shared secret. */
async function triageHook(payload: unknown, secret = "triage-hook-secret-0123456789abcdef") {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return call(
    new Request("https://relay.example.com/triage/answered", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-timestamp": ts,
        "x-signature": `sha256=${await hmac(secret, `${ts}.${body}`)}`,
      },
    }),
  );
}

/** The ticket buttons: the answering row, then who owns it, then its state. */
const OWNER = ["ticket:take", "ticket:assign"];
const STATE = ["ticket:resolve", "ticket:snooze", "ticket:block", "ticket:manage"];
const ALL_BUTTONS = [["ticket:reply"], OWNER, STATE];

/** The custom ids of a card's buttons, row by row, after its summary line. */
function buttons(body: Record<string, unknown> | undefined): string[][] | undefined {
  const card = z
    .object({
      components: z.tuple([
        z.object({
          components: z.array(z.object({ components: z.array(z.object({ custom_id: z.string() })).optional() })),
        }),
      ]),
    })
    .safeParse(body);
  return card.data?.components[0].components.flatMap((part) =>
    part.components ? [part.components.map((button) => button.custom_id)] : [],
  );
}

async function discordInteraction(payload: unknown, tamper = false) {
  const request = await signedInteraction(payload, Math.floor(Date.now() / 1000), tamper);
  return call(request());
}

/** A signed interaction request, which can be sent again unchanged (a replay). */
async function signedInteraction(payload: unknown, timestampSeconds: number, tamper = false) {
  const body = JSON.stringify(payload);
  const timestamp = String(timestampSeconds);
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.TEST_DISCORD_PRIVATE_JWK),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, encoder.encode(timestamp + body)));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return () =>
    new Request("https://relay.example.com/discord/interactions", {
      method: "POST",
      body: tamper ? body.replace("1", "2") : body,
      headers: { "content-type": "application/json", "x-signature-ed25519": hex, "x-signature-timestamp": timestamp },
    });
}

function dueJobs(): Promise<number> {
  return runInDurableObject(hub(), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE not_before <= ?", Date.now())
      .one();
    return row.n;
  });
}

/**
 * Waits until no job is due. Jobs run from the Durable Object's own alarm, which fires on its
 * own; running alarm() by hand as well would overlap it, which Cloudflare never does.
 */
async function drain(): Promise<void> {
  await vi.waitFor(
    async () => {
      if ((await dueJobs()) > 0) throw new Error("jobs still due");
    },
    { timeout: 5000, interval: 20 },
  );
}

const created = (id: number) => ({
  event: "message_created",
  id: 1,
  account: { id: 3, name: "Acme" },
  conversation: { id },
});

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await drain();
  await runInDurableObject(hub(), async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM jobs");
    state.storage.sql.exec("DELETE FROM interactions");
    state.storage.sql.exec("DELETE FROM cache WHERE key LIKE 'command:%'");
    state.storage.sql.exec("DELETE FROM command_files");
    state.storage.sql.exec(
      "DELETE FROM cache WHERE key LIKE 'discord:bucket:%' OR key LIKE 'discord:global:%' OR key LIKE 'chatwoot:limit:%'",
    );
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

describe("worker", () => {
  it("reports health", async () => {
    const response = await call(new Request("https://relay.example.com/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const incomplete = await worker.fetch(
      new Request<unknown, IncomingRequestCfProperties>("https://relay.example.com/healthz"),
      { ...env, CHATWOOT_WEBHOOK_SECRETS: '{"1":"test-secret"}' },
      createExecutionContext(),
    );
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).toEqual({ ok: false });
  });

  it("rejects unsigned, stale, and cross-account Chatwoot webhooks", async () => {
    expect((await chatwootWebhook(created(1), { secret: "wrong" })).status).toBe(401);
    expect((await chatwootWebhook(created(1), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    // Signed with account 1's secret but claims to be account 3.
    expect((await chatwootWebhook(created(1), { secret: "secret-globex" })).status).toBe(403);
    expect(await (await chatwootWebhook({ event: "contact_updated", account: { id: 3 } })).json()).toMatchObject({
      ignored: true,
    });
  });

  it("ignores events the relay does not use", async () => {
    const conversationCreated = { event: "conversation_created", id: 12, account: { id: 3 } };
    const ignoredUpdates = [
      { content_type: "text", content: "edited", content_attributes: {} },
      { content_type: "input_select", content_attributes: { items: [{ title: "A", value: "a" }] } },
      { content_type: "input_email", content_attributes: { submitted_email: "" } },
      { content_type: "cards", content_attributes: { submitted_values: [{ title: "A" }] } },
      { content_type: "input_csat", content_attributes: { submitted_values: {} } },
      { message_type: "incoming", content_attributes: { external_error: "Outside the 24 hour window" } },
    ].map((fields) => ({ ...created(12), event: "message_updated", ...fields }));
    for (const event of [conversationCreated, ...ignoredUpdates]) {
      expect(await (await chatwootWebhook(event)).json()).toEqual({ ok: true, ignored: true });
    }
    await drain();
    expect(world.requests).toEqual([]);
  });

  it("relays a conversation in order from the API, links the post, and only posts new messages later", async () => {
    world.conversation(
      12,
      [
        {
          id: 501,
          content: "My agent will not connect",
          message_type: 0,
          sender: { name: "Jane Doe", type: "contact" },
        },
      ],
      {
        topic: "Billing",
      },
    );
    await chatwootWebhook(created(12));
    await drain();

    const posts = world.webhookPosts();
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.body.components === undefined)).toBe(true);
    expect(posts[0]?.thread).toBeNull();
    expect(posts[0]?.body).toMatchObject({
      thread_name: "[Acme #12] Jane Doe — My agent will not connect",
      applied_tags: ["100000000000000301", "100000000000000302"],
      content:
        "-# via Live chat\n-# jane@example.com\n[Open in Chatwoot](<https://chatwoot.example.com/app/accounts/3/conversations/12>)",
    });
    const thread = posts[1]?.thread ?? "";
    expect(thread).toMatch(/^\d{18}$/);
    expect(posts[1]).toMatchObject({
      thread,
      body: {
        allowed_mentions: { parse: [] },
        content: `My agent will not connect\n-# <@100000000000000777>`,
        username: "Jane Doe",
        avatar_url: "https://gravatar.com/avatar/?d=mp&f=y&s=256",
      },
    });
    // The post ends with its card.
    const card = world.cards();
    expect(card).toMatchObject([{ thread, body: { flags: 1 << 15, username: "Chatwoot" } }]);
    expect(buttons(card[0]?.body)).toEqual(ALL_BUTTONS);

    // The post URL is merged into the conversation's attributes; other attributes survive.
    const link = world.requests.find((request) => request.url.pathname.endsWith("/custom_attributes"));
    expect(JSON.parse(link?.body ?? "")).toEqual({
      custom_attributes: { discord_thread: `https://discord.com/channels/${GUILD}/${thread}` },
      merge: true,
    });
    expect(world.conversations.get(12)?.custom_attributes).toEqual({
      topic: "Billing",
      discord_thread: `https://discord.com/channels/${GUILD}/${thread}`,
    });
    expect(await hub().ticketForThread(thread)).toEqual({ accountId: 3, conversationId: 12 });

    world.conversations
      .get(12)
      ?.messages.push({ id: 502, content: "Try again", message_type: 1, sender: { name: "Sam", type: "user" } });
    await chatwootWebhook(created(12));
    await drain();
    const later = world.webhookPosts().slice(2);
    expect(later).toMatchObject([
      {
        thread,
        body: {
          allowed_mentions: { parse: [] },
          avatar_url: "https://chatwoot.example.com/favicon-512x512.png",
          content: "Try again",
          username: "Sam · Acme",
        },
      },
    ]);
    // The card moved below the new message.
    expect(world.cards()).toHaveLength(2);
    expect(world.sent("DELETE", /^\/api\/v10\/webhooks\/1\/tok\/messages\//)).toHaveLength(1);
  });

  it("moves the card under the triage bot's answer, offering its draft, when its signed hook says the answer is in", async () => {
    world.conversation(24, [{ id: 701, content: "help", message_type: 0 }]);
    await chatwootWebhook(created(24));
    await drain();
    const thread = world.webhookPosts().at(-1)?.thread ?? "";
    const before = world.cards().length;
    const answerId = "100000000000009100";
    // The answer replies to the customer's message.
    const replyTo = world.acceptedMessages.find((post) => String(post.body.content).startsWith("help"))?.id ?? "";
    const answer = { threadId: thread, answerId, replyTo, draft: "Hi, restart the agent from the dashboard." };

    expect((await triageHook(answer, "wrong-secret-0123456789abcdef0123")).status).toBe(401);
    expect((await triageHook({ threadId: thread, answerId })).status).toBe(400);
    expect((await triageHook(null)).status).toBe(400);
    expect((await triageHook(answer)).status).toBe(200);
    await drain();
    // The same answer again (a replayed call) adds nothing.
    expect((await triageHook(answer)).status).toBe(200);
    await drain();

    const moved = world.cards().slice(before);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ thread, body: { username: "Chatwoot", allowed_mentions: { parse: [] } } });
    expect(buttons(moved[0]?.body)).toEqual([[`ticket:draft:${answerId}`, "ticket:reply"], OWNER, STATE]);

    // Reply with draft opens the editor with the draft the hook sent: no Discord read, no intent needed.
    const pressed = await discordInteraction({
      id: "900211",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 3,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      message: { id: "100000000000009101", components: [] },
      data: { custom_id: `ticket:draft:${answerId}`, component_type: 2 },
    });
    const modal = (await pressed.json()) as {
      type: number;
      data: { components: Array<{ component: { value?: string } }> };
    };
    expect(modal.type).toBe(9);
    expect(modal.data.components[0]?.component.value).toBe(answer.draft);

    // An answer whose draft is not kept, and that Discord will not give back: it is linked instead.
    const other = "100000000000009102";
    const unread = await discordInteraction({
      id: "900212",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 3,
      guild_id: GUILD,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      message: { id: "100000000000009103", components: [] },
      data: { custom_id: `ticket:draft:${other}`, component_type: 2 },
    });
    const link = (await unread.json()) as { type: number; data: { content: string; flags: number } };
    expect(link.type).toBe(4);
    expect(link.data.content).toContain(`(https://discord.com/channels/${GUILD}/${thread}/${other})`);
  });

  it("retries a failed message with backoff without skipping it", async () => {
    world.conversation(13, [{ id: 601, content: "hello", message_type: 0 }]);
    world.rateLimitReplies = 1;
    await chatwootWebhook(created(13));
    await drain();

    // Make the backed-off job due now instead of waiting.
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0");
      // Move persisted cooldowns forward with the job clock, rather than waiting in real time.
      state.storage.sql.exec(
        "UPDATE cache SET value = '0', expires_at = 0 WHERE key LIKE 'discord:bucket:%' OR key LIKE 'discord:global:%' OR key LIKE 'chatwoot:limit:%'",
      );
    });
    await setAlarmNow();
    await drain();
    const replies = world.webhookPosts().filter((post) => post.thread);
    expect(replies.map((post) => post.body.content)).toEqual([
      "hello\n-# <@100000000000000777>", // attempt deferred by Discord's 429
      "hello\n-# <@100000000000000777>",
    ]);
    await chatwootWebhook(created(13));
    await drain();
    expect(world.webhookPosts().filter((post) => post.thread)).toEqual(replies);
  });

  it("waits out a rate limit as long as Discord asks, without counting it as a failed attempt", async () => {
    world.conversation(40, [{ id: 4001, content: "hello", message_type: 0 }]);
    world.rateLimitReplies = 12; // more rounds than a job's attempt limit
    await chatwootWebhook(created(40));
    await drain();
    for (let round = 1; round < 12; round += 1) {
      expect(await jobDelay("conversation:3:40")).toBeGreaterThan(60_000);
      await makeJobsDue();
      await drain();
    }
    await makeJobsDue();
    await drain();
    const replies = world.webhookPosts().filter((post) => post.thread);
    expect(replies.at(-1)?.body.content).toBe("hello\n-# <@100000000000000777>");
    expect(replies).toHaveLength(13); // Twelve rate-limited requests and one successful post.
    await chatwootWebhook(created(40));
    await drain();
    expect(world.webhookPosts().filter((post) => post.thread)).toEqual(replies);
  });

  it("recovers a missing mapping from the conversation's link attribute instead of opening a second post", async () => {
    const thread = "100000000000020001";
    world.threads.set(thread, FORUM);
    world.conversation(
      14,
      [
        { id: 701, content: "old, relayed by the previous service", message_type: 0 },
        { id: 702, content: "also old", message_type: 1 },
      ],
      { discord_thread: `https://discord.com/channels/${GUILD}/${thread}` },
    );
    await chatwootWebhook(created(14));
    await drain();
    expect(world.webhookPosts()).toEqual([]); // history is not re-posted, no new post
    expect(await hub().ticketForThread(thread)).toEqual({ accountId: 3, conversationId: 14 });

    world.conversations.get(14)?.messages.push({ id: 703, content: "new", message_type: 0 });
    await chatwootWebhook(created(14));
    await drain();
    expect(world.webhookPosts().map((post) => post.thread)).toEqual([thread]);
    // The adopted post gets a card, then a new card is posted below the new message. Existing
    // messages are never read to guess which card a lost send created.
    expect(world.sent("GET", new RegExp(`^/api/v10/channels/${thread}/messages$`))).toHaveLength(0);
    expect(world.cards().map((card) => card.thread)).toEqual([thread, thread]);
    expect(world.sent("DELETE", /^\/api\/v10\/webhooks\/1\/tok\/messages\//)).toHaveLength(1);
  });

  it("opens a new post when the linked thread no longer exists", async () => {
    world.conversation(15, [{ id: 801, content: "hi", message_type: 0 }], {
      discord_thread: `https://discord.com/channels/${GUILD}/100000000000029999`,
    });
    await chatwootWebhook(created(15));
    await drain();
    expect(world.webhookPosts()[0]?.thread).toBeNull();
  });

  it("the cron sweep relays conversations whose webhooks never arrived", async () => {
    world.conversation(16, [{ id: 901, content: "missed", message_type: 0 }]);
    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    await drain();
    const pages = world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations$/);
    // Newest activity first; the empty second page ends the sweep.
    expect(pages.map((request) => Object.fromEntries(request.url.searchParams))).toEqual([
      { status: "all", assignee_type: "all", page: "1" },
      { status: "all", assignee_type: "all", page: "2" },
    ]);
    expect(world.webhookPosts().map((post) => post.body.content)).toContain("missed\n-# <@100000000000000777>");
  });

  it("the sweep stops at conversations without activity in its window", async () => {
    world.conversation(18, [{ id: 1001, content: "old", message_type: 0 }]);
    const old = on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", () =>
      json({
        data: {
          meta: {},
          payload: [{ id: 18, status: "open", last_activity_at: Math.floor(Date.now() / 1000) - 7200, messages: [] }],
        },
      }),
    );
    world.mock.spy.mockRestore();
    world = new World([old]);
    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    await drain();
    expect(world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations$/)).toHaveLength(1);
    expect(world.webhookPosts()).toEqual([]);
  });

  it("does not post a message twice when updating the post fails afterwards", async () => {
    world.conversation(19, [{ id: 1101, content: "thanks, solved", message_type: 0 }], {}, "resolved");
    world.failPatches = 1;
    await chatwootWebhook(created(19));
    await drain();
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0");
      // Move persisted cooldowns forward with the job clock, rather than waiting in real time.
      state.storage.sql.exec(
        "UPDATE cache SET value = '0', expires_at = 0 WHERE key LIKE 'discord:bucket:%' OR key LIKE 'discord:global:%' OR key LIKE 'chatwoot:limit:%'",
      );
    });
    await setAlarmNow();
    await drain();
    expect(world.webhookPosts().map((post) => post.body.content)).toEqual([
      expect.stringContaining("Open in Chatwoot"),
      "thanks, solved\n-# Triage bot not called: handled automatically. Ask it here, if needed.",
    ]);
    // The first update failed; the retry unarchives with the tags, then archives.
    expect(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).map((request) => JSON.parse(request.body))).toEqual([
      { archived: false, applied_tags: ["100000000000000301"] },
      { archived: false, applied_tags: ["100000000000000301"] },
      { archived: true },
    ]);
  });

  it("removes the Discord messages of a message deleted in Chatwoot", async () => {
    world.conversation(21, [
      { id: 1201, content: "first", message_type: 0 },
      { id: 1202, content: "wrong conversation, sorry", message_type: 1 },
    ]);
    await chatwootWebhook(created(21));
    await drain();
    const deleted = world.conversations.get(21)?.messages[1];
    if (deleted) Object.assign(deleted, { content: "This message was deleted", content_attributes: { deleted: true } });
    await chatwootWebhook({
      ...created(21),
      event: "message_updated",
      id: 1202,
      content_attributes: { deleted: true },
    });
    // A deletion reported for a message that was not deleted changes nothing.
    await chatwootWebhook({
      ...created(21),
      event: "message_updated",
      id: 1201,
      content_attributes: { deleted: true },
    });
    await drain();
    const deletes = world.sent("DELETE", /^\/api\/v10\/webhooks\/1\/tok\/messages\//);
    expect(deletes.map((request) => request.url.pathname.split("/").at(-1))).toEqual(["100000000000001002"]);
    expect(deletes[0]?.url.searchParams.get("thread_id")).toBe(world.webhookPosts()[1]?.thread);
  });

  it("posts a customer's response to an interactive message once, after Chatwoot's API confirms it", async () => {
    const question = { id: 1402, content: "How did we do?", message_type: 3, content_type: "input_csat" };
    world.conversation(23, [{ id: 1401, content: "thanks, all good", message_type: 0 }, question], {}, "resolved");
    await chatwootWebhook(created(23));
    await drain();
    const thread = world.webhookPosts()[1]?.thread;
    const posts = world.webhookPosts().length;
    const rated = (rating: number) => ({ submitted_values: { csat_survey_response: { rating } } });
    const updated = (rating: number) => ({
      ...created(23),
      event: "message_updated",
      id: 1402,
      content_type: "input_csat",
      content_attributes: rated(rating),
    });

    // The webhook claims a response the API does not have yet: nothing is posted.
    await chatwootWebhook(updated(5));
    await drain();
    expect(world.webhookPosts()).toHaveLength(posts);

    Object.assign(question, { content_attributes: rated(5) });
    await chatwootWebhook(updated(5));
    await drain();
    // Another update of the same response (e.g. its status) is not posted again.
    await chatwootWebhook(updated(5));
    await drain();
    expect(world.webhookPosts().slice(posts)).toEqual([
      {
        thread,
        body: {
          content: "How did we do?\n\n**CSAT:**\n• Rating: 5",
          username: "Jane Doe",
          avatar_url: "https://gravatar.com/avatar/?d=mp&f=y&s=256",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
    // Posting unarchived the resolved post; it is archived again.
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });

    // A changed response is posted again.
    Object.assign(question, { content_attributes: rated(4) });
    await chatwootWebhook(updated(4));
    await drain();
    expect(
      world
        .webhookPosts()
        .slice(posts)
        .map((post) => post.body.content),
    ).toEqual(["How did we do?\n\n**CSAT:**\n• Rating: 5", "How did we do?\n\n**CSAT:**\n• Rating: 4"]);
    // Returning to the original rating is a new response, despite having identical text.
    Object.assign(question, { content_attributes: rated(5) });
    await chatwootWebhook(updated(5));
    await drain();
    expect(
      world
        .webhookPosts()
        .slice(posts)
        .map((post) => post.body.content),
    ).toEqual([
      "How did we do?\n\n**CSAT:**\n• Rating: 5",
      "How did we do?\n\n**CSAT:**\n• Rating: 4",
      "How did we do?\n\n**CSAT:**\n• Rating: 5",
    ]);
  });

  it("posts each supported interactive response from a signed message update", async () => {
    const responses = [
      { type: "input_select", attributes: { submitted_values: [{ title: "A", value: "a" }] }, text: "**Response:** A" },
      {
        type: "form",
        attributes: { submitted_values: [{ name: "email", value: "a@example.com" }] },
        text: "**Responses:**\n• email: a@example.com",
      },
      {
        type: "input_csat",
        attributes: { submitted_values: { csat_survey_response: { rating: 4 } } },
        text: "**CSAT:**\n• Rating: 4",
      },
      { type: "input_email", attributes: { submitted_email: "user@example.com" }, text: "**Email:** user@example.com" },
    ];
    for (const [index, response] of responses.entries()) {
      const id = 70 + index;
      const question = { id: 5001, content: "Question", message_type: 3, content_type: response.type };
      world.conversation(id, [{ id: 5000, content: "Help", message_type: 0 }, question]);
      await chatwootWebhook(created(id));
      await drain();
      const posts = world.webhookPosts().length;
      Object.assign(question, { content_attributes: response.attributes });
      await chatwootWebhook({
        ...created(id),
        id: 5001,
        event: "message_updated",
        content_type: response.type,
        content_attributes: response.attributes,
      });
      await drain();
      expect(
        world
          .webhookPosts()
          .slice(posts)
          .map((post) => post.body.content),
      ).toEqual([`Question\n\n${response.text}`]);
    }
  });

  it("opens a kept draft directly and answers a missing draft without upstream reads", async () => {
    world.conversation(90, [{ id: 3201, content: "Help", message_type: 0 }]);
    await chatwootWebhook(created(90));
    await drain();
    const thread = world.webhookPosts().at(-1)?.thread ?? "";
    const answerId = "100000000000019100";
    await hub().triageAnswered(thread, answerId, "100000000000001001", "Hi, the refund is on its way.");
    for (const [index, id] of [answerId, "100000000000019101"].entries()) {
      const started = Date.now();
      const response = await discordInteraction({
        id: String(900300 + index),
        application_id: "100000000000000001",
        token: "interaction-token",
        type: 3,
        guild_id: GUILD,
        channel_id: thread,
        channel: { id: thread, type: 11 },
        member: { user: { id: ALICE } },
        message: { id: "100000000000009101", components: [] },
        data: { custom_id: `ticket:draft:${id}`, component_type: 2 },
      });
      const body = await response.json<{
        type: number;
        data: { content?: string; components?: Array<{ component: { value?: string } }> };
      }>();
      expect(Date.now() - started).toBeLessThan(2500);
      if (index === 0) {
        expect(body.type).toBe(9);
        expect(body.data.components?.[0]?.component.value).toBe("Hi, the refund is on its way.");
      } else {
        expect(body.type).toBe(4);
        expect(body.data.content).toContain("Reply with this");
      }
    }
    expect(world.sent("GET", /^\/api\/v10\/channels\/\d+\/messages\/\d+$/)).toHaveLength(0);
  });

  it("closes the post of a conversation deleted in Chatwoot", async () => {
    world.conversation(22, [{ id: 1301, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(22));
    await drain();
    const thread = world.webhookPosts()[1]?.thread ?? "";
    world.conversations.delete(22);
    await chatwootWebhook(created(22));
    await drain();
    expect(world.webhookPosts().at(-1)).toEqual({
      thread,
      body: {
        content: "This conversation no longer exists in Chatwoot.",
        username: "Chatwoot",
        avatar_url: "https://chatwoot.example.com/favicon-512x512.png",
        allowed_mentions: { parse: [] },
      },
    });
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });
    expect(await hub().ticketForThread(thread)).toBeNull();
  });

  it("drops unreadable and unknown jobs", async () => {
    await runInDurableObject(hub(), async (_instance, state) => {
      const insert = "INSERT INTO jobs (key, priority, payload, not_before, created_at) VALUES (?, 2, ?, 0, 0)";
      state.storage.sql.exec(insert, "garbage", "{not json");
      state.storage.sql.exec(insert, "unknown", JSON.stringify({ type: "reindex", accountId: 3 }));
      state.storage.sql.exec(insert, "partial", JSON.stringify({ type: "conversation", accountId: 3 }));
      await state.storage.setAlarm(Date.now());
    });
    await drain();
    await runInDurableObject(hub(), async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
    expect(world.requests).toEqual([]);
    world.conversation(99201, [{ id: 9920101, content: "Valid request", message_type: 0 }]);
    await chatwootWebhook(created(99201));
    await drain();
    expect(world.webhookPosts().at(-1)?.body.content).toBe(`Valid request\n-# <@${TRIAGE}>`);
  });

  it("verifies Discord signatures and answers pings", async () => {
    const pong = await discordInteraction({ type: 1 });
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ type: 1 });
    expect((await discordInteraction({ type: 1 }, true)).status).toBe(401);
  });

  it("runs a deferred command as the agent and edits the original response", async () => {
    const thread = "100000000000030001";
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id, conversation_id, thread_id, cursor) VALUES (3, 17, ?, 0)",
        thread,
      );
    });
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    const toggle = on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/17/toggle_status", () => json({}));
    world.mock.spy.mockRestore();
    world = new World([profile, toggle]);
    world.conversation(17, [], {}, "resolved"); // as Chatwoot has it after the command
    const response = await discordInteraction({
      id: "900001",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "resolve" },
    });
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    await drain();
    await vi.waitFor(() =>
      expect(world.requests.some((request) => request.url.pathname.endsWith("original"))).toBe(true),
    );
    const edit = world.requests.find((request) => request.url.pathname.endsWith("original"));
    expect(decodeURIComponent(edit?.url.pathname ?? "")).toBe(
      "/api/v10/webhooks/100000000000000001/interaction-token/messages/@original",
    );
    expect(JSON.parse(edit?.body ?? "")).toEqual({ content: "✅ Resolved.", allowed_mentions: { parse: [] } });
    const toggled = world.requests.find((request) => request.url.pathname.endsWith("/toggle_status"));
    expect(toggled?.headers.get("api_access_token")).toBe("token-alice");
    // The post shows the change at once, without waiting for Chatwoot's event.
    expect(buttons(world.cards().at(-1)?.body)?.at(-1)).toEqual(["ticket:reopen", "ticket:block", "ticket:manage"]);
    expect(JSON.parse(world.sent("PATCH", new RegExp(`^/api/v10/channels/${thread}$`)).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });
  });

  it("shows a failed change from the Manage panel as text in that panel (a Components V2 message)", async () => {
    const thread = "100000000000030009";
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id, conversation_id, thread_id, cursor) VALUES (3, 91, ?, 0)",
        thread,
      );
    });
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    const refused = on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/91/toggle_status", () =>
      json({ error: "forbidden" }, { status: 403 }),
    );
    world.mock.spy.mockRestore();
    world = new World([profile, refused]);
    const response = await discordInteraction({
      id: "900091",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 3,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      message: { id: "900", flags: 32768, components: [] },
      data: { custom_id: "panel:status:resolved", component_type: 2 },
    });
    expect(await response.json()).toEqual({ type: 6 });
    await drain();
    await vi.waitFor(() =>
      expect(world.requests.some((request) => request.url.pathname.endsWith("original"))).toBe(true),
    );
    const edit = world.requests.find((request) => request.url.pathname.endsWith("original"));
    expect(JSON.parse(edit?.body ?? "")).toEqual({
      flags: 32768,
      components: [{ type: 10, content: "❌ You do not have access to this conversation." }],
      allowed_mentions: { parse: [] },
    });
  });

  it("runs a replayed signed command once, and refuses an old signed request", async () => {
    const thread = "100000000000030002";
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id, conversation_id, thread_id, cursor) VALUES (3, 18, ?, 0)",
        thread,
      );
    });
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    const toggle = on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/18/toggle_status", () => json({}));
    world.mock.spy.mockRestore();
    world = new World([profile, toggle]);
    const resolve = (id: string) => ({
      id,
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "resolve" },
    });
    const now = Math.floor(Date.now() / 1000);
    const replayed = await signedInteraction(resolve("900003"), now);
    // Sent while the first is queued, and again after it ran.
    expect((await call(replayed())).status).toBe(200);
    expect((await call(replayed())).status).toBe(200);
    await drain();
    expect((await call(replayed())).status).toBe(200);
    await drain();
    expect(world.requests.filter((request) => request.url.pathname.endsWith("/toggle_status"))).toHaveLength(1);

    const old = await signedInteraction(resolve("900004"), now - 600);
    expect((await call(old())).status).toBe(401);
  });

  it("drops a command whose interaction token expires before it could report the result", async () => {
    const job = {
      interactionId: "900002",
      applicationId: "100000000000000001",
      token: "interaction-token",
      discordUserId: ALICE,
      accountId: 3,
      conversationId: 17,
      action: { type: "message", private: false, content: "Hello", files: [] },
    };
    const queuedAt = Date.now() - 13 * 60 * 1000;
    await runInDurableObject(hub(), async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO jobs (key, priority, payload, not_before, created_at) VALUES (?, 0, ?, ?, ?)",
        `command:${job.interactionId}`,
        JSON.stringify({ type: "command", job }),
        queuedAt,
        queuedAt,
      );
      await state.storage.setAlarm(Date.now());
    });
    await drain();
    // The token still works: the invoker learns that nothing was done.
    expect(world.requests.map((request) => [request.method, decodeURIComponent(request.url.pathname)])).toEqual([
      ["PATCH", "/api/v10/webhooks/100000000000000001/interaction-token/messages/@original"],
    ]);
    expect(JSON.parse(world.requests[0]?.body ?? "")).toEqual({
      content: "❌ This could not start in time, so nothing was done. Please try again.",
      allowed_mentions: { parse: [] },
    });
  });

  it("syncs a conversation event after a short wait, so the change's activity message is posted with it", async () => {
    world.conversation(30, [{ id: 3001, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(30));
    await drain();
    const conversation = world.conversations.get(30);
    if (conversation) conversation.status = "resolved";
    await chatwootWebhook({ event: "conversation_status_changed", id: 30, account: { id: 3 } });
    // Chatwoot creates "Resolved by …" afterwards, and sends no webhook for it.
    conversation?.messages.push({ id: 3002, content: "Resolved by Sam", message_type: 2 });
    expect(await jobDelay("conversation:3:30")).toBeGreaterThan(5000);

    await makeJobsDue();
    await drain();
    expect(world.webhookPosts().at(-1)?.body.content).toBe("_Resolved by Sam_");
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "{}")).toMatchObject({
      archived: true,
    });

    if (conversation) conversation.status = "open";
    await chatwootWebhook({ event: "conversation_updated", id: 30, account: { id: 3 } });
    await makeJobsDue();
    await drain();
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: false,
      applied_tags: ["100000000000000301", "100000000000000302"],
    });
  });

  it("keeps retrying a job that keeps failing, at most every 30 minutes, so an outage loses nothing", async () => {
    world.conversation(31, [{ id: 3101, content: "hello", message_type: 0 }]);
    world.failConversations = 100;
    await chatwootWebhook(created(31));
    await drain();
    expect(world.webhookPosts()).toEqual([]);

    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET attempts = 20, not_before = 0 WHERE key = 'conversation:3:31'");
    });
    await setAlarmNow();
    await drain();
    const due = await runInDurableObject(hub(), (_instance, state) =>
      state.storage.sql
        .exec<{ not_before: number }>("SELECT not_before FROM jobs WHERE key = 'conversation:3:31'")
        .one(),
    );
    expect(due.not_before - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);

    // Once Chatwoot answers again, the retry relays the message.
    world.failConversations = 0;
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET not_before = 0 WHERE key = 'conversation:3:31'");
    });
    await setAlarmNow();
    await drain();
    expect(world.webhookPosts().at(-1)?.body.content).toBe("hello\n-# <@100000000000000777>");
    const posts = world.webhookPosts();
    await chatwootWebhook(created(31));
    await drain();
    expect(world.webhookPosts()).toEqual(posts);
  });

  it("the sweep queues only conversations whose post is behind or out of date", async () => {
    world.conversation(32, [{ id: 3201, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(32));
    await drain();
    const reads = () => world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations\/32$/).length;
    const before = reads();

    await sweep();
    expect(reads()).toBe(before); // up to date: not queued

    // A cleared card row does not replay a send whose durable guard already has a receipt.
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE conversations SET card_id = NULL WHERE conversation_id = 32");
    });
    const cards = world.cards().length;
    await sweep();
    expect(reads()).toBe(before + 1);
    expect(world.cards()).toHaveLength(cards);

    // A card left covered (its move failed) is moved.
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE conversations SET card_covered = 1 WHERE conversation_id = 32");
    });
    await sweep();
    expect(reads()).toBe(before + 2);
    expect(world.cards()).toHaveLength(cards + 1);

    const conversation = world.conversations.get(32);
    if (conversation) conversation.status = "resolved"; // missed webhook
    await sweep();
    expect(reads()).toBe(before + 3);
    expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "")).toEqual({
      archived: true,
    });
  });

  it("does not replay a cleared card send, however long ago its ticket was active", async () => {
    world.conversation(34, [{ id: 3401, content: "hello", message_type: 0 }]);
    await chatwootWebhook(created(34));
    await drain();
    const quiet = world.conversations.get(34);
    if (quiet) quiet.lastActivityAt = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE conversations SET card_id = NULL WHERE conversation_id = 34");
    });
    const cards = world.cards().length;
    await sweep();
    expect(world.cards()).toHaveLength(cards);
    await sweep();
    expect(world.cards()).toHaveLength(cards);
  });

  it("runs a command that comes during a sweep before the sweep's next page", async () => {
    const thread = "100000000000030036";
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO conversations (account_id, conversation_id, thread_id, cursor) VALUES (3, 36, ?, 0)",
        thread,
      );
    });
    const start = Math.floor(Date.now() / 1000);
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Three pages of quiet conversations; the first answers only once released.
    const pages = on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", async (request) => {
      const page = Number(request.url.searchParams.get("page"));
      if (page === 1) await paused;
      const payload =
        page > 3
          ? []
          : Array.from({ length: 25 }, (_, index) => ({
              id: 70000 + (page - 1) * 25 + index,
              status: "open",
              last_activity_at: start,
              messages: [],
            }));
      return json({ data: { meta: {}, payload } });
    });
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    const toggle = on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/36/toggle_status", () => json({}));
    world.mock.spy.mockRestore();
    world = new World([pages, profile, toggle]);
    world.conversation(36, [], {}, "resolved");
    const isPage = (request: Recorded) => request.url.pathname === "/api/v1/accounts/3/conversations";

    const ctx = createExecutionContext();
    await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    await vi.waitFor(() => expect(world.requests.some(isPage)).toBe(true));
    await discordInteraction({
      id: "900018",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "resolve" },
    });
    release();
    await drain();

    const order = world.requests
      .filter((request) => isPage(request) || request.url.pathname.endsWith("/toggle_status"))
      .map((request) => (isPage(request) ? `page ${request.url.searchParams.get("page")}` : "command"));
    expect(order).toEqual(["page 1", "command", "page 2", "page 3", "page 4"]);
  });

  it("a sweep longer than a run's page limit continues where it stopped, down to its window's start", async () => {
    const start = Math.floor(Date.now() / 1000);
    // 11 pages of recent conversations; only the last one is behind (a message never relayed).
    const busy = on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", (request) => {
      const page = Number(request.url.searchParams.get("page"));
      const payload =
        page > 11
          ? []
          : Array.from({ length: 25 }, (_, index) => {
              const id = 50000 + (page - 1) * 25 + index;
              return {
                id,
                status: "open",
                last_activity_at: start - id + 50000,
                messages: id === 50274 ? [{ id: 1 }] : [],
              };
            });
      return json({ data: { meta: {}, payload } });
    });
    world.mock.spy.mockRestore();
    world = new World([busy]);
    await sweep();
    const pages = world
      .sent("GET", /^\/api\/v1\/accounts\/3\/conversations$/)
      .map((request) => Number(request.url.searchParams.get("page")));
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(world.sent("GET", /^\/api\/v1\/accounts\/3\/conversations\/50274$/).length).toBeGreaterThan(0);
  });

  it.each(["status", "sweep"])(
    "holds one pending conversation job without polling and releases it through %s",
    async (wake) => {
      const id = wake === "status" ? 77 : 78;
      world = new World();
      world.bot = { id: 42, account_id: 3 };
      world.conversation(id, [{ id: 770, content: "Pending request", message_type: 0 }], {}, "pending");
      await chatwootWebhook({ event: "message_created", id: 770, account: { id: 3 }, conversation: { id } });
      await vi.waitFor(
        async () => {
          await drain();
          await runInDurableObject(hub(), async (_instance, state) => {
            expect(await state.storage.getAlarm()).toBeNull();
          });
        },
        { timeout: 5000 },
      );
      expect(world.webhookPosts()).toEqual([]);
      await runInDurableObject(hub(), async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
      const conversation = world.conversations.get(id);
      if (!conversation) throw new Error("Test conversation missing");
      conversation.status = "open";
      if (wake === "status") {
        await chatwootWebhook({ event: "conversation_status_changed", id, account: { id: 3 } });
      } else {
        conversation.lastActivityAt = 1; // Far outside the relay's ordinary activity window.
        await sweep();
      }
      await vi.waitFor(
        () =>
          expect(world.webhookPosts().some((post) => String(post.body.content).includes("Pending request"))).toBe(true),
        { timeout: 5000 },
      );
      expect(world.webhookPosts().filter((post) => String(post.body.content).includes("Pending request"))).toHaveLength(
        1,
      );
    },
  );

  it.each(["failed status", "external error"])(
    "posts one delivery warning from a signed outgoing update with %s, after API confirmation",
    async (signal) => {
      const id = signal === "failed status" ? 80 : 81;
      const reply = {
        id: 8102,
        content: "Here is your refund",
        message_type: 1,
        status: "sent",
        content_attributes: {},
      };
      world.conversation(id, [{ id: 8101, content: "hello", message_type: 0 }, reply]);
      await chatwootWebhook(created(id));
      await drain();
      const thread = world.webhookPosts().at(-1)?.thread;
      const update = {
        ...created(id),
        event: "message_updated",
        id: reply.id,
        message_type: "outgoing",
        ...(signal === "failed status"
          ? { status: "failed" }
          : { content_attributes: { external_error: "Outside the 24 hour window" } }),
      };
      await chatwootWebhook(update); // The API still says sent: no premature warning.
      await drain();
      expect(world.webhookPosts().filter((post) => String(post.body.content).startsWith("⚠️"))).toEqual([]);
      reply.status = "failed";
      reply.content_attributes = { external_error: "Outside the 24 hour window" };
      await chatwootWebhook(update);
      await drain();
      await chatwootWebhook(update);
      await drain();
      expect(world.webhookPosts().filter((post) => String(post.body.content).startsWith("⚠️"))).toEqual([
        {
          thread,
          body: expect.objectContaining({
            content: "⚠️ A reply could not be delivered to the customer: Outside the 24 hour window",
            allowed_mentions: { parse: [] },
          }),
        },
      ]);
    },
  );

  it("rechecks a failed middle-page reply retried as sent before the first triage decision", async () => {
    const id = 79;
    const reply = { id: 150, content: "The answer", message_type: 1, status: "failed" };
    world.conversation(id, [
      { id: 1, content: "A customer request", message_type: 0 },
      ...Array.from({ length: 300 }, (_, index) =>
        index + 2 === reply.id ? reply : { id: index + 2, content: "Activity", message_type: 2 },
      ),
    ]);
    await runInDurableObject(hub(), async (_instance, state) => {
      const store = new Store(state.storage.sql);
      const settings = await loadSettings(env);
      const budget = new Budget(minimumBudget(4));
      const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, "relay-token", budget.fetch);
      const rest = new DiscordRest("test-bot-token", budget.fetch);
      const forum = new DiscordForum(rest, store);
      const services = {
        settings,
        store,
        budget,
        chatwoot,
        rest,
        forum,
        relay: relayFor(settings, forum, store),
        enqueueMetadata: () => undefined,
      };
      expect(await processConversation(services, 3, id)).toBe("yield");
    });
    expect(world.webhookPosts()).toEqual([]);
    expect(world.sent("GET", /\/messages$/).some((request) => request.url.searchParams.get("after") === "301")).toBe(
      true,
    );
    reply.status = "sent";
    // Chatwoot's native retry changes the same message and dispatches message_updated.
    await chatwootWebhook({
      ...created(id),
      event: "message_updated",
      id: reply.id,
      message_type: "outgoing",
      status: "sent",
    });
    await chatwootWebhook(created(id)); // Resume the yielded conversation as the next alarm would.
    await drain();
    const customer = world.webhookPosts().find((post) => String(post.body.content).startsWith("A customer request"));
    expect(customer?.body.content).toContain("handled automatically");
    expect(customer?.body.content).not.toContain("<@100000000000000777>");
  });

  it("relays a message a kind's reply answered after routing, without calling the triage bot", async () => {
    const globex = "chatwoot.example.com/api/v1/accounts/1";
    const conversation = {
      id: 8,
      status: "open",
      inbox_id: 2,
      custom_attributes: {},
      meta: { sender: { name: "Jane Doe" }, assignee: null, channel: "Channel::Email" },
      messages: [{ id: 80 }],
      last_activity_at: Math.floor(Date.now() / 1000),
    };
    const customer = {
      id: 80,
      content: "I would like to apply",
      message_type: 0,
      created_at: Math.floor(Date.now() / 1000),
    };
    world = new World([
      on("GET", `${globex}/conversations/8`, () => json(conversation)),
      on("GET", `${globex}/conversations/8/messages`, (request) =>
        json({
          payload: [
            customer,
            { id: 81, content: "Thanks for applying", message_type: 1, sender: { type: "agent_bot" } },
          ].filter((message) => message.id > Number(request.url.searchParams.get("after") ?? 0)),
        }),
      ),
      on("GET", `${globex}/inboxes/2`, () => json({ id: 2, name: "Globex — Email" })),
      on("POST", `${globex}/conversations/8/custom_attributes`, () => json({})),
    ]);

    await chatwootWebhook(
      { event: "message_created", id: 1, account: { id: 1, name: "Globex" }, conversation: { id: 8 } },
      {
        secret: "secret-globex",
      },
    );
    await vi.waitFor(() => expect(world.webhookPosts().length).toBeGreaterThan(1), { timeout: 5000, interval: 50 });

    const relayed = world.webhookPosts().map((post) => String(post.body.content ?? ""));
    const message = relayed.find((content) => content.startsWith("I would like to apply"));
    expect(message).toMatch(/not called: handled automatically/);
    expect(relayed.some((content) => content.includes("<@100000000000000777>"))).toBe(false);
  });

  it("closes the post when a command finds its conversation deleted", async () => {
    world.conversation(33, [{ id: 3301, content: "spam", message_type: 0 }]);
    await chatwootWebhook(created(33));
    await drain();
    const thread = world.webhookPosts()[1]?.thread ?? "";
    world.conversations.delete(33);
    const profile = on("GET", "chatwoot.example.com/api/v1/profile", () =>
      json({ id: 42, name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
    );
    world.mock.spy.mockRestore();
    const conversations = world.conversations;
    const threads = world.threads;
    world = new World([profile]);
    world.conversations = conversations;
    world.threads = threads;
    await discordInteraction({
      id: "900003",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: 2,
      channel_id: thread,
      channel: { id: thread, type: 11 },
      member: { user: { id: ALICE } },
      data: { type: 1, name: "block" },
    });
    await drain();
    await vi.waitFor(async () => expect(await hub().ticketForThread(thread)).toBeNull());
    expect(world.webhookPosts().at(-1)?.body.content).toBe("This conversation no longer exists in Chatwoot.");
  });
});

async function sweep(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
  await drain();
}

/** How long until a queued job is due. */
function jobDelay(key: string): Promise<number> {
  return runInDurableObject(hub(), (_instance, state) => {
    const row = state.storage.sql.exec<{ at: number }>("SELECT not_before AS at FROM jobs WHERE key = ?", key).one();
    return row.at - Date.now();
  });
}

async function makeJobsDue(): Promise<void> {
  await runInDurableObject(hub(), (_instance, state) => {
    state.storage.sql.exec("UPDATE jobs SET not_before = 0");
    // Move persisted cooldowns forward with the job clock, rather than waiting in real time.
    state.storage.sql.exec(
      "UPDATE cache SET value = '0', expires_at = 0 WHERE key LIKE 'discord:bucket:%' OR key LIKE 'discord:global:%' OR key LIKE 'chatwoot:limit:%'",
    );
  });
  await setAlarmNow();
}

async function setAlarmNow(): Promise<void> {
  await runInDurableObject(hub(), async (_instance, state) => {
    await state.storage.setAlarm(Date.now());
  });
}

it("measures command feedback behind a slow conversation", async () => {
  world.mock.spy.mockRestore();
  let startedSlow = false;
  let feedback = 0;
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/801", async (request) => {
      startedSlow = true;
      await new Promise<void>((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        slow.then(resolve);
      });
      return json({}, { status: 503 });
    }),
    on("GET", "chatwoot.example.com/api/v1/profile", () => {
      return json({ id: 42, accounts: [{ id: 3 }] });
    }),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/802/toggle_status", () => json({})),
    on(
      "PATCH",
      /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/latency-token\/messages\/(@|%40)original$/,
      () => {
        feedback += 1;
        return json({});
      },
    ),
  ]);
  await hub().enqueueConversation(3, 801);
  await vi.waitFor(() => expect(startedSlow).toBe(true));
  await hub().enqueueCommand({
    interactionId: "latency-command",
    applicationId: "100000000000000001",
    token: "latency-token",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 802,
    action: { type: "status", status: "resolved" },
  });
  await vi.waitFor(() => expect(feedback).toBe(1), { timeout: 5000 });
  releaseSlow();
  await drain();
});

it("measures the first customer post with a slow decorative lookup", async () => {
  await runInDurableObject(hub(), (_instance, state) =>
    state.storage.sql.exec("DELETE FROM cache WHERE key = 'inbox:3:2'"),
  );
  world.mock.spy.mockRestore();
  let firstPost = 0;
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  world = new World([
    (request) => {
      if (
        request.method === "POST" &&
        request.url.pathname === "/api/v10/webhooks/1/tok" &&
        request.body.includes("latency-body")
      )
        firstPost += 1;
      return undefined;
    },
    on("GET", "chatwoot.example.com/api/v1/accounts/3/inboxes/2", async (_request) => {
      await slow;
      return json({ id: 2, name: "Slow inbox" });
    }),
  ]);
  world.conversation(881, [{ id: 88101, content: "latency-body", message_type: 0 }]);
  await hub().enqueueConversation(3, 881);
  await vi.waitFor(() => expect(firstPost).toBeGreaterThan(0));
  releaseSlow();
  await drain();
});

it("retries failed feedback while the card converges, without re-executing the action", async () => {
  world.mock.spy.mockRestore();
  let actions = 0;
  let reports = 0;
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/882/toggle_status", () => {
      actions += 1;
      const conversation = world.conversations.get(882);
      if (conversation) conversation.status = "resolved";
      return json({});
    }),
    on(
      "PATCH",
      /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/feedback-test\/messages\/(@|%40)original$/,
      () => {
        reports += 1;
        return reports === 1 ? json({}, { status: 500 }) : json({});
      },
    ),
  ]);
  world.conversation(882, [{ id: 88201, content: "Help", message_type: 0 }]);
  await hub().enqueueConversation(3, 882);
  await drain();
  await hub().enqueueCommand({
    interactionId: "feedback-recovery",
    applicationId: "100000000000000001",
    token: "feedback-test",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 882,
    action: { type: "status", status: "resolved" },
  });
  await drain();
  expect(actions).toBe(1);
  expect(reports).toBe(1);
  expect(JSON.parse(world.sent("PATCH", /^\/api\/v10\/channels\/\d+$/).at(-1)?.body ?? "{}")).toMatchObject({
    archived: true,
  });
  await makeJobsDue();
  await drain();
  expect(reports).toBe(2);
  expect(actions).toBe(1);
});

it("releases the alarm on a 429 so another person's command receives feedback", async () => {
  world.mock.spy.mockRestore();
  let limited = false;
  let feedback = 0;
  world = new World([
    (request) => {
      if (
        request.method !== "POST" ||
        request.url.pathname !== "/api/v10/webhooks/1/tok" ||
        !request.url.searchParams.has("thread_id")
      )
        return undefined;
      limited = true;
      return json({ retry_after: 60, global: true }, { status: 429 });
    },
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/884/toggle_status", () => json({})),
    on(
      "PATCH",
      /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/rate-feedback\/messages\/(@|%40)original$/,
      () => {
        feedback = Date.now();
        return json({});
      },
    ),
  ]);
  world.conversation(883, [{ id: 88301, content: "Rate limited", message_type: 0 }]);
  // First create the post with the ordinary mock, then apply the rate limit only to replies.
  const started = Date.now();
  await hub().enqueueConversation(3, 883);
  await vi.waitFor(() => expect(limited).toBe(true));
  await hub().enqueueCommand({
    interactionId: "rate-command",
    applicationId: "100000000000000001",
    token: "rate-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 884,
    action: { type: "status", status: "resolved" },
  });
  await vi.waitFor(() => expect(feedback).toBeGreaterThan(0));
  expect(feedback - started).toBeLessThan(500);
});

it("returns before Discord's deadline without acknowledging an unconfirmed durable enqueue", async () => {
  vi.useFakeTimers();
  const namespace = new Proxy(env.HUB, {
    get(target, property, receiver) {
      if (property === "getByName")
        return () =>
          new Proxy(hub(), {
            get(object, key, objectReceiver) {
              if (key === "interaction") return async () => new Promise<never>(() => {});
              return Reflect.get(object, key, objectReceiver);
            },
          });
      return Reflect.get(target, property, receiver);
    },
  });
  const signed = await signedInteraction({ id: "initial-deadline", type: 1 }, Math.floor(Date.now() / 1000));
  const pending = worker.fetch(signed(), { ...env, HUB: namespace }, createExecutionContext());
  await vi.advanceTimersByTimeAsync(2501);
  const response = await pending;
  expect(response.status).toBe(503);
  vi.useRealTimers();
});

it("does not replay a customer reply whose creation response was lost", async () => {
  world.mock.spy.mockRestore();
  let sends = 0;
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/885/messages", () => {
      sends += 1;
      throw new TypeError("Connection lost after commit");
    }),
  ]);
  await hub().enqueueCommand({
    interactionId: "unknown-customer-reply",
    applicationId: "100000000000000001",
    token: "unknown-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 885,
    action: { type: "message", private: true, content: "Reply once", files: [] },
  });
  await drain();
  await makeJobsDue();
  await drain();
  expect(sends).toBe(1);
  const feedback = world.requests.find(
    (request) => request.method === "PATCH" && request.url.pathname.includes("unknown-feedback"),
  );
  expect(JSON.parse(feedback?.body ?? "{}").content).toContain("result is unknown");
});

it("does not confirm a concurrent identical note after an unknown mutation", async () => {
  world.mock.spy.mockRestore();
  let concurrent = false;
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/886", () =>
      json({ id: 886, status: "open", inbox_id: 2, messages: [{ id: 99601 }] }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/886/messages", () =>
      json({
        payload: concurrent
          ? [{ id: 99602, content: "Same note", message_type: 1, private: true, sender: { id: 42 } }]
          : [],
      }),
    ),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/886/messages", () => {
      concurrent = true;
      return json({ error: "response lost" }, { status: 502 });
    }),
  ]);
  await hub().enqueueCommand({
    interactionId: "concurrent-note",
    applicationId: "100000000000000001",
    token: "concurrent-note-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 886,
    action: { type: "message", private: true, content: "Same note", files: [] },
  });
  await drain();
  const feedback = world.requests.find(
    (request) => request.method === "PATCH" && request.url.pathname.includes("concurrent-note-feedback"),
  );
  expect(JSON.parse(feedback?.body ?? "{}").content).toContain("result is unknown");
});

it("confirms an unknown inbox handoff from the resulting bot assignment", async () => {
  world.mock.spy.mockRestore();
  let assigned = false;
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/890", () =>
      json({
        id: 890,
        status: "open",
        inbox_id: 2,
        meta: {
          assignee: assigned ? { id: 77 } : { id: 42 },
          assignee_type: assigned ? "AgentBot" : "User",
        },
        messages: [],
      }),
    ),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/inboxes/2/agent_bot", () =>
      json({ agent_bot: { id: 77, account_id: 3 } }),
    ),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/890/assignments", () => {
      assigned = true;
      return json({ error: "response lost" }, { status: 502 });
    }),
  ]);
  await hub().enqueueCommand({
    interactionId: "handoff-unknown",
    applicationId: "100000000000000001",
    token: "handoff-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 890,
    action: { type: "status", status: "pending" },
  });
  await drain();
  const feedback = world.requests.find(
    (request) => request.method === "PATCH" && request.url.pathname.includes("handoff-feedback"),
  );
  expect(JSON.parse(feedback?.body ?? "{}").content).toContain("Handed back to the inbox bot");
});

it("continues attachments after a bounded slice while another command gets feedback", async () => {
  world.mock.spy.mockRestore();
  const downloads = [0, 0];
  let sends = 0;
  let feedbackAt = 0;
  const sizes = [2 * 1024 * 1024 + 1, 3];
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("GET", /^cdn\.discordapp\.com\/attachments\/slow-[01]$/, (request) => {
      const index = request.url.pathname.endsWith("0") ? 0 : 1;
      downloads[index] = (downloads[index] ?? 0) + 1;
      if (index === 1 && downloads[index] === 1) throw new JobDeadlineError();
      return Promise.resolve(new Response(new Uint8Array(sizes[index] ?? 0)));
    }),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/888/messages", (request) => {
      sends += 1;
      const files = request.form?.getAll("attachments[]") ?? [];
      expect(files.map((file) => (file instanceof File ? [file.name, file.size] : file))).toEqual([
        ["first.bin", sizes[0]],
        ["second.bin", sizes[1]],
      ]);
      return json({ id: 88801 });
    }),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/889/toggle_status", () => json({})),
    on(
      "PATCH",
      /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/slice-feedback\/messages\/(@|%40)original$/,
      () => {
        feedbackAt = Date.now();
        return json({});
      },
    ),
  ]);
  world.conversation(888, [{ id: 88801, content: "Files", message_type: 0 }]);
  world.conversation(889, [{ id: 88901, content: "Status", message_type: 0 }]);
  const queued = Date.now();
  await hub().enqueueCommand({
    interactionId: "slow-attachments",
    applicationId: "100000000000000001",
    token: "attachment-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 888,
    action: {
      type: "message",
      private: true,
      content: "Files",
      files: sizes.map((size, index) => ({
        url: `https://cdn.discordapp.com/attachments/slow-${index}`,
        filename: index === 0 ? "first.bin" : "second.bin",
        size,
      })),
    },
  });
  await vi.waitFor(() => expect(downloads[1]).toBe(1));
  await hub().enqueueCommand({
    interactionId: "command-during-attachments",
    applicationId: "100000000000000001",
    token: "slice-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 889,
    action: { type: "status", status: "resolved" },
  });
  await drain();
  expect(feedbackAt).toBeGreaterThan(0);
  expect(feedbackAt - queued).toBeLessThan(1000);
  expect(downloads).toEqual([1, 2]);
  expect(sends).toBe(1);
});

it("does not confirm labels unless the complete resulting set matches", async () => {
  world.mock.spy.mockRestore();
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/labels", () => json({ payload: [] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/887/labels", () => json({ payload: ["billing"] })),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/887/labels", () =>
      json({ error: "response lost" }, { status: 502 }),
    ),
  ]);
  world.conversation(887, []);
  await hub().enqueueCommand({
    interactionId: "labels-unknown",
    applicationId: "100000000000000001",
    token: "labels-unknown-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 887,
    action: { type: "labels", labels: [] },
  });
  await drain();
  const feedback = world.requests.find(
    (request) => request.method === "PATCH" && request.url.pathname.includes("labels-unknown-feedback"),
  );
  expect(JSON.parse(feedback?.body ?? "{}").content).toContain("result is unknown");
});

it("does not confirm a snooze without its target time", async () => {
  world.mock.spy.mockRestore();
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => json({ id: 42, accounts: [{ id: 3 }] })),
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations/888", () =>
      json({ id: 888, status: "snoozed", snoozed_until: 123, inbox_id: 2, messages: [] }),
    ),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/888/toggle_status", () =>
      json({ error: "response lost" }, { status: 502 }),
    ),
  ]);
  await hub().enqueueCommand({
    interactionId: "snooze-unknown",
    applicationId: "100000000000000001",
    token: "snooze-unknown-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 888,
    action: { type: "status", status: "snoozed", snoozedUntil: 456 },
  });
  await drain();
  const feedback = world.requests.find(
    (request) => request.method === "PATCH" && request.url.pathname.includes("snooze-unknown-feedback"),
  );
  expect(JSON.parse(feedback?.body ?? "{}").content).toContain("result is unknown");
});

it("delivers confirmed feedback before an optional panel read", async () => {
  world.mock.spy.mockRestore();
  let profileReads = 0;
  let feedback = 0;
  world = new World([
    on("GET", "chatwoot.example.com/api/v1/profile", () => {
      profileReads += 1;
      return profileReads === 1
        ? json({ id: 42, accounts: [{ id: 3 }] })
        : json({ error: "panel unavailable" }, { status: 503 });
    }),
    on("POST", "chatwoot.example.com/api/v1/accounts/3/conversations/889/toggle_status", () => json({})),
    on(
      "PATCH",
      /^discord\.com\/api\/v10\/webhooks\/100000000000000001\/panel-feedback\/messages\/(@|%40)original$/,
      () => {
        feedback += 1;
        return json({});
      },
    ),
  ]);
  await hub().enqueueCommand({
    interactionId: "panel-feedback",
    applicationId: "100000000000000001",
    token: "panel-feedback",
    discordUserId: ALICE,
    accountId: 3,
    conversationId: 889,
    panel: true,
    action: { type: "status", status: "resolved" },
  });
  await drain();
  expect(feedback).toBe(1);
});

it("does not replay a derived response whose Discord receipt was lost", async () => {
  world.mock.spy.mockRestore();
  let sends = 0;
  world = new World([
    (request) => {
      if (
        request.method !== "POST" ||
        request.url.pathname !== "/api/v10/webhooks/1/tok" ||
        !request.body.includes("Rating: 5")
      )
        return undefined;
      sends += 1;
      throw new TypeError("Connection lost after Discord accepted the response");
    },
  ]);
  const question = { id: 88702, content: "How did we do?", message_type: 3, content_type: "input_csat" };
  world.conversation(887, [{ id: 88701, content: "Thank you", message_type: 0 }, question]);
  await hub().enqueueConversation(3, 887);
  await drain();
  Object.assign(question, { content_attributes: { submitted_values: { csat_survey_response: { rating: 5 } } } });
  await hub().enqueueMessageUpdate(3, 887, question.id);
  await drain();
  await makeJobsDue();
  await drain();
  expect(sends).toBe(1);
});
