import { afterEach, describe, expect, it, vi } from "vitest";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { DiscordRest } from "../src/discord/rest.ts";
import { postQueue, type QueueStore } from "../src/queue.ts";
import { ALICE, json, mockFetch, on, type Recorded, testSettings } from "./helpers.ts";

const CHANNEL = "100000000000000900";
const ROLE = "100000000000000901";
const HOUR = 3600;
const NOW = 1_800_000_000; // seconds

class MapStore implements QueueStore {
  values = new Map<string, string>();
  threads = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  conversation(accountId: number, conversationId: number) {
    const threadId = this.threads.get(`${accountId}:${conversationId}`);
    return threadId ? { threadId } : undefined;
  }
}

interface Open {
  id: number;
  waiting?: number; // hours
  assignee?: { id: number; name: string };
  snoozed?: boolean;
  pending?: boolean;
  assigneeType?: string;
}

/** Open or snoozed conversations of account 3 (25 per page, like Chatwoot), none in account 1, and Discord. */
function world(open: Open[], { failPost = 0, rateLimit = false }: { failPost?: number; rateLimit?: boolean } = {}) {
  let failures = failPost;
  let limited = rateLimit;
  let posts = 0;
  return mockFetch(
    on("GET", "chatwoot.example.com/api/v1/accounts/3/conversations", (request) => {
      const page = Number(request.url.searchParams.get("page"));
      const status = request.url.searchParams.get("status");
      const listed = open.filter((c) => (c.snoozed ? "snoozed" : c.pending ? "pending" : "open") === status);
      const payload = listed.slice((page - 1) * 25, page * 25).map((c) => ({
        id: c.id,
        inbox_id: 2,
        status,
        waiting_since: c.waiting === undefined ? 0 : NOW - c.waiting * HOUR,
        meta: { assignee: c.assignee ?? null, assignee_type: c.assigneeType },
      }));
      return json({ data: { meta: {}, payload } });
    }),
    on("GET", "chatwoot.example.com/api/v1/accounts/1/conversations", () => json({ data: { meta: {}, payload: [] } })),
    on("POST", `discord.com/api/v10/channels/${CHANNEL}/messages`, () => {
      posts += 1;
      if (limited) {
        limited = false;
        return json({ message: "You are being rate limited.", retry_after: 5, global: false }, { status: 429 });
      }
      if (posts > 1 && failures > 0) {
        failures -= 1;
        return json({ message: "Internal Server Error" }, { status: 500 });
      }
      return json({ id: `m-${posts}` });
    }),
  );
}

function context(store = new MapStore(), escalation: object = { escalationRoleId: ROLE }) {
  const settings = testSettings({ queue: { channelId: CHANNEL, ...escalation } });
  const fetch = (request: Request) => globalThis.fetch(request);
  return {
    settings,
    store,
    chatwoot: chatwootClient(settings.config.chatwoot.baseUrl, "relay-token", fetch),
    rest: new DiscordRest("bot", fetch),
  };
}

const posted = (requests: Recorded[]) =>
  requests
    .filter((request) => request.method === "POST" && request.url.pathname.endsWith(`/channels/${CHANNEL}/messages`))
    .map((request) => JSON.parse(request.body));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("support queue", () => {
  it("lists waiting and unassigned tickets, longest wait first, and allows only linked assignees and the escalation", async () => {
    const store = new MapStore();
    store.threads.set("3:1", "100000000000000777");
    const { requests } = world([
      { id: 1, waiting: 3 },
      { id: 2, waiting: 0.25, assignee: { id: 42, name: "Alice" } },
      { id: 3, assignee: { id: 43, name: "Bob" } },
      { id: 4 },
      { id: 5, waiting: 1, assignee: { id: 99, name: `<@&${ROLE}> Mallory` } },
    ]);

    await postQueue(context(store), NOW * 1000);

    const [message] = posted(requests);
    expect(message.content.split("\n")).toEqual([
      `📋 Support queue <t:${NOW}:t>`,
      `<@&${ROLE}> 🔔 tickets have waited with no assignee: please \`/assign\` one.`,
      "🔔 <#100000000000000777> | waiting 3 h | ❔ Unassigned",
      `[Acme #5](<https://chatwoot.example.com/app/accounts/3/conversations/5>) | waiting 1 h | <​@&${ROLE}> Mallory`,
      `[Acme #2](<https://chatwoot.example.com/app/accounts/3/conversations/2>) | waiting 15 min | <@${ALICE}>`,
      "[Acme #4](<https://chatwoot.example.com/app/accounts/3/conversations/4>) | replied | ❔ Unassigned",
    ]);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [ALICE], roles: [ROLE] });
  });

  it("lists pending bot turns as unassigned without pinging a same-id user or escalating", async () => {
    const { requests } = world([
      { id: 9, pending: true, waiting: 30, assignee: { id: 42, name: "Bot" }, assigneeType: "AgentBot" },
    ]);
    await postQueue(context(), NOW * 1000);
    const [message] = posted(requests);
    expect(message.content).toContain("🤖");
    expect(message.content).toContain("Unassigned");
    expect(message.allowed_mentions).toEqual({ parse: [], users: [], roles: [] });
  });

  it("lists snoozed tickets last, marked, without pinging anyone or escalating", async () => {
    const { requests } = world([
      { id: 1, waiting: 30, snoozed: true },
      { id: 2, waiting: 2, snoozed: true, assignee: { id: 42, name: "Alice" } },
      { id: 3, waiting: 1 },
    ]);

    await postQueue(context(), NOW * 1000);

    const [message] = posted(requests);
    expect(message.content.split("\n").slice(2)).toEqual([
      "🔔 [Acme #3](<https://chatwoot.example.com/app/accounts/3/conversations/3>) | waiting 1 h | ❔ Unassigned",
      "💤 [Acme #1](<https://chatwoot.example.com/app/accounts/3/conversations/1>) | waiting 30 h | ❔ Unassigned",
      "💤 [Acme #2](<https://chatwoot.example.com/app/accounts/3/conversations/2>) | waiting 2 h | Alice",
    ]);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [], roles: [ROLE] });
  });

  it("posts nothing once its deadline has passed, so a late retry cannot post it twice", async () => {
    const { requests } = world([{ id: 1, waiting: 3 }]);
    await postQueue(context(), NOW * 1000, Date.now() - 1);
    expect(posted(requests)).toEqual([]);
  });

  it("hands a rate limit back to its job instead of waiting it out, so the job checks the deadline first", async () => {
    const { requests } = world([{ id: 1, waiting: 3 }], { rateLimit: true });
    await expect(postQueue(context(), NOW * 1000)).rejects.toMatchObject({ status: 429 });
    expect(posted(requests)).toHaveLength(1);
  });

  it("escalates to a user instead of a role", async () => {
    const { requests } = world([{ id: 1, waiting: 3 }]);

    await postQueue(context(new MapStore(), { escalationUserId: ALICE }), NOW * 1000);

    const [message] = posted(requests);
    expect(message.content.split("\n")[1]).toBe(
      `<@${ALICE}> 🔔 tickets have waited with no assignee: please \`/assign\` one.`,
    );
    expect(message.allowed_mentions).toEqual({ parse: [], users: [ALICE], roles: [] });
  });

  it("escalates an unassigned ticket once per step of its wait", async () => {
    const store = new MapStore();
    const hours = [0.5, 3, 3.5, 4, 16, 40];
    const { requests } = world([{ id: 1, waiting: 3 }]);

    for (const [index, elapsed] of hours.entries()) {
      await postQueue(context(store), (NOW + (elapsed - 3) * HOUR) * 1000);
      expect(posted(requests)[index].allowed_mentions.roles).toEqual(elapsed === 0.5 || elapsed === 3.5 ? [] : [ROLE]);
    }
  });

  it("keeps every message within Discord's limit, with the note on what it could not list", async () => {
    for (const threads of [0, 25, 50, 75, 100]) {
      vi.restoreAllMocks();
      const store = new MapStore();
      const open = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        waiting: 2,
        ...(i % 2 ? { assignee: { id: 99, name: "x".repeat(300) } } : {}),
      }));
      for (let i = 1; i <= threads; i += 1) store.threads.set(`3:${i}`, `1000000000000${String(i).padStart(5, "0")}`);
      const { requests } = world(open);

      await postQueue(context(store), NOW * 1000);

      const messages = posted(requests);
      expect(messages.every((message) => message.content.length <= 2000)).toBe(true);
      expect(messages.at(-1).content).toMatch(/…and (\d+ )?more: see Chatwoot\.$/);
      expect(messages[0].content).not.toContain("x".repeat(61));
    }
  });

  it("does not ping again for a ticket that dropped out of the pages read and came back", async () => {
    const store = new MapStore();
    const others = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: 1000 + i, waiting: 1, assignee: { id: 43, name: "Bob" } }));
    const late = { id: 1, waiting: 3 };

    const runs = [
      [late, ...others(20)],
      [...others(100), late],
      [late, ...others(20)],
    ];
    const roles: string[][] = [];
    for (const [index, open] of runs.entries()) {
      vi.restoreAllMocks();
      const { requests } = world(open);
      await postQueue(context(store), NOW * 1000 + index * 1000);
      roles.push(posted(requests)[0].allowed_mentions.roles);
    }

    expect(roles).toEqual([[ROLE], [], []]);
  });

  it("posts nothing when the queue is empty", async () => {
    const { requests } = world([{ id: 3, assignee: { id: 43, name: "Bob" } }]);

    await postQueue(context(), NOW * 1000);

    expect(posted(requests)).toEqual([]);
  });

  it("splits a long queue, notes what it could not read, and does not ping again when a later part is retried", async () => {
    const store = new MapStore();
    const open = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, waiting: 2 }));
    const { requests } = world(open, { failPost: 1 });

    await expect(postQueue(context(store), NOW * 1000)).rejects.toThrow();
    await postQueue(context(store), NOW * 1000);

    const messages = posted(requests);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every((message) => message.content.length <= 2000)).toBe(true);
    expect(messages.at(-1).content).toMatch(/…and (\d+ )?more: see Chatwoot\.$/);
    expect(messages.filter((message) => message.allowed_mentions.roles.length > 0)).toHaveLength(1);
    // A retry sends the same nonces, so Discord creates no message twice.
    expect(messages.every((message) => message.enforce_nonce === true)).toBe(true);
    expect(messages[1].nonce).toBe(messages[2].nonce);
  });
});
