import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, JobDeadlineError } from "../../../shared/budget.ts";
import manifest from "../package.json" with { type: "json" };
import { DiscordForum } from "../src/discord/forum.ts";
import { DiscordHttpError, DiscordRest } from "../src/discord/rest.ts";
import { avatarUrl } from "../src/discord/users.ts";
import { UnknownThreadError } from "../src/relay/relay.ts";
import { json, mockFetch, on } from "./helpers.ts";

class MemoryCache {
  values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  delete(key: string) {
    this.values.delete(key);
  }
}

const api = "discord.com/api/v10";
const forumChannel = on("GET", `${api}/channels/55`, () =>
  json({
    id: "55",
    type: 15,
    guild_id: "44",
    available_tags: [
      { id: "t-acme", name: "Acme" },
      { id: "t-open", name: "open" },
      { id: "t-resolved", name: "Resolved" },
    ],
  }),
);

const application = on("GET", `${api}/applications/@me`, () => json({ id: "100000000000000001" }));

it("identifies the relay with Discord's documented bot user agent", async () => {
  const { requests } = mockFetch(application);
  await new DiscordRest("bot-token", (request) => fetch(request)).get("/applications/@me");
  expect(requests[0]?.headers.get("user-agent")).toBe(
    `DiscordBot (https://github.com/Phala-Network/chatwoot-workers, ${manifest.version})`,
  );
});

function forum() {
  return new DiscordForum(new DiscordRest("bot-token", (request) => fetch(request)), new MemoryCache());
}

afterEach(() => vi.restoreAllMocks());

describe("DiscordForum", () => {
  it("resumes a send when its time slice ended before dispatch", async () => {
    const cache = new MemoryCache();
    cache.set("forum:55:webhook", "1:abc");
    const { requests } = mockFetch(
      on("POST", `${api}/webhooks/1/abc`, () => json({ id: "m1", channel_id: "thread-9" })),
    );
    const budget = new Budget(5);
    budget.startSlice(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      new DiscordForum(new DiscordRest("bot-token", budget.fetch), cache).execute(
        "55",
        { content: "hi" },
        "thread-9",
        "send-1",
      ),
    ).rejects.toBeInstanceOf(JobDeadlineError);
    expect(
      await new DiscordForum(new DiscordRest("bot-token", new Budget(5).fetch), cache).execute(
        "55",
        { content: "hi" },
        "thread-9",
        "send-1",
      ),
    ).toEqual({ channelId: "thread-9", messageId: "m1" });
    expect(requests).toHaveLength(1);
  });

  it("never replays an in-flight send after its time slice expires", async () => {
    const cache = new MemoryCache();
    cache.set("forum:55:webhook", "1:abc");
    const { requests } = mockFetch(
      on("POST", `${api}/webhooks/1/abc`, async (request) => {
        await new Promise<void>((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
        );
        return json({ id: "m1", channel_id: "thread-9" });
      }),
      on("GET", `${api}/channels/thread-9/messages`, () => json([])),
    );
    const budget = new Budget(5);
    budget.startSlice(30);
    await expect(
      new DiscordForum(new DiscordRest("bot-token", budget.fetch), cache).execute(
        "55",
        { content: "hi" },
        "thread-9",
        "send-2",
      ),
    ).rejects.toBeInstanceOf(JobDeadlineError);
    await expect(
      new DiscordForum(new DiscordRest("bot-token", new Budget(5).fetch), cache).execute(
        "55",
        { content: "hi" },
        "thread-9",
        "send-2",
      ),
    ).rejects.toThrow("outcome is unknown");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("keeps the send guard after a 500 that may have accepted the webhook", async () => {
    const cache = new MemoryCache();
    cache.set("forum:55:webhook", "1:abc");
    let posts = 0;
    const { requests } = mockFetch(
      on("POST", `${api}/webhooks/1/abc`, () => {
        posts += 1;
        return posts === 1
          ? json({ message: "accepted, response lost" }, { status: 500 })
          : json({ id: "m2", channel_id: "thread-9" });
      }),
      on("GET", `${api}/channels/thread-9/messages`, () => json([])),
    );
    const first = new DiscordForum(new DiscordRest("bot-token", new Budget(5).fetch), cache);
    await expect(first.execute("55", { content: "hi" }, "thread-9", "send-500")).rejects.toMatchObject({ status: 500 });
    await expect(
      new DiscordForum(new DiscordRest("bot-token", new Budget(5).fetch), cache).execute(
        "55",
        { content: "hi" },
        "thread-9",
        "send-500",
      ),
    ).rejects.toThrow("outcome is unknown");
    expect(posts).toBe(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(0);
  });

  it("keeps an accepted unknown send unknown without reading or posting again", async () => {
    const cache = new MemoryCache();
    cache.set("forum:55:webhook", "1:abc");
    const { requests } = mockFetch(
      on("POST", `${api}/webhooks/1/abc`, () => json({ message: "accepted, response lost" }, { status: 500 })),
    );
    const client = new DiscordForum(new DiscordRest("bot-token", new Budget(5).fetch), cache);
    await expect(client.execute("55", { content: "hi" }, "thread-9", "send-recover")).rejects.toMatchObject({
      status: 500,
    });
    await expect(client.execute("55", { content: "hi" }, "thread-9", "send-recover")).rejects.toThrow(
      "outcome is unknown",
    );
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(0);
  });

  it("does not mistake a clock-skewed identical message for an unknown send", async () => {
    const cache = new MemoryCache();
    cache.set("forum:55:webhook", "1:abc");
    const oldMessage = String(((BigInt(Date.now() + 5 * 60 * 1000) - 1_420_070_400_000n) << 22n) + 1n);
    const { requests } = mockFetch(
      on("POST", `${api}/webhooks/1/abc`, () => json({ message: "accepted, response lost" }, { status: 500 })),
      on("GET", `${api}/channels/thread-9/messages`, () =>
        json([{ id: oldMessage, webhook_id: "1", content: "hi", flags: 0 }]),
      ),
    );
    const client = new DiscordForum(new DiscordRest("bot-token", new Budget(5).fetch), cache);
    await expect(client.execute("55", { content: "hi" }, "thread-9", "send-old-match")).rejects.toMatchObject({
      status: 500,
    });
    await expect(client.execute("55", { content: "hi" }, "thread-9", "send-old-match")).rejects.toThrow(
      "outcome is unknown",
    );
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(0);
  });

  it("retries a refused tag send after the recovery read fails", async () => {
    const cache = new MemoryCache();
    cache.set("forum:55:webhook", "1:abc");
    let reads = 0;
    let accepted = 0;
    mockFetch(
      on("POST", `${api}/webhooks/1/abc`, (request) => {
        if (JSON.parse(request.body).applied_tags?.length) return json({ code: 10087 }, { status: 400 });
        accepted += 1;
        return json({ id: "m1", channel_id: "thread-9" });
      }),
      on("GET", `${api}/channels/55`, () => (++reads === 1 ? json({}, { status: 500 }) : json({ available_tags: [] }))),
    );
    const client = new DiscordForum(new DiscordRest("bot-token", new Budget(10).fetch), cache);
    await expect(
      client.execute("55", { content: "hi", applied_tags: ["deleted"] }, "thread-9", "send-3"),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      client.execute("55", { content: "hi", applied_tags: ["deleted"] }, "thread-9", "send-3"),
    ).resolves.toEqual({ channelId: "thread-9", messageId: "m1" });
    expect(accepted).toBe(1);
  });

  it("takes Discord's Unknown Channel for a post that no longer exists", async () => {
    mockFetch(
      application,
      on("GET", `${api}/channels/55/webhooks`, () =>
        json([{ id: "1", token: "abc", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      // Discord answers a webhook's request into a deleted post with 400.
      on("POST", `${api}/webhooks/1/abc`, () => json({ message: "Unknown Channel", code: 10003 }, { status: 400 })),
      on("DELETE", `${api}/webhooks/1/abc/messages/m1`, () =>
        json({ message: "Unknown Channel", code: 10003 }, { status: 400 }),
      ),
    );
    const client = forum();
    await expect(client.execute("55", { content: "hi" }, "thread-9")).rejects.toBeInstanceOf(UnknownThreadError);
    await expect(client.deleteMessage("55", "thread-9", "m1")).resolves.toBeUndefined();
  });

  it("reuses the existing Chatwoot webhook and posts without the bot token", async () => {
    const { requests } = mockFetch(
      application,
      on("GET", `${api}/channels/55/webhooks`, () =>
        json([{ id: "1", token: "abc", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("POST", `${api}/webhooks/1/abc`, () => json({ id: "m1", channel_id: "thread-9" })),
    );
    const client = forum();
    expect(await client.execute("55", { content: "hi", thread_name: "Ticket" })).toEqual({
      channelId: "thread-9",
      messageId: "m1",
    });
    await client.execute("55", { content: "again" }, "thread-9");
    // The application id and the webhook are looked up once, then cached.
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
    const posts = requests.filter((request) => request.url.pathname.startsWith("/api/v10/webhooks/"));
    expect(posts.map((request) => request.url.search)).toEqual([
      "?wait=true&with_components=true",
      "?wait=true&with_components=true&thread_id=thread-9",
    ]);
    expect(posts.every((request) => request.headers.get("authorization") === null)).toBe(true);
    expect(requests[1]?.headers.get("authorization")).toBe("Bot bot-token");
  });

  it("creates the webhook when the forum has none of this application's, even one of the same name", async () => {
    const { requests } = mockFetch(
      application,
      on("GET", `${api}/channels/55/webhooks`, () =>
        json([{ id: "2", token: "x", type: 1, name: "Chatwoot", application_id: "999999999999999999" }]),
      ),
      on("POST", `${api}/channels/55/webhooks`, () =>
        json({ id: "900", token: "new-token", type: 1, name: "Chatwoot", application_id: "100000000000000001" }),
      ),
      on("POST", `${api}/webhooks/900/new-token`, () => json({ id: "m1", channel_id: "thread-1" })),
    );
    await forum().execute("55", { content: "hi", thread_name: "Ticket" });
    expect(
      requests.find((request) => request.url.pathname === "/api/v10/channels/55/webhooks" && request.method === "POST")
        ?.body,
    ).toBe(JSON.stringify({ name: "Chatwoot" }));
  });

  it("links a post in its forum's guild, looking the guild up once", async () => {
    const { requests } = mockFetch(forumChannel);
    const client = forum();
    expect(await client.postUrl("55", "123")).toBe("https://discord.com/channels/44/123");
    expect(await client.postUrl("55", "124")).toBe("https://discord.com/channels/44/124");
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["an invalid form body", 400, 50035],
    ["an unknown tag", 404, 10087],
  ])("sends a refused update again without the tags the forum no longer has (%s)", async (_name, status, code) => {
    const { requests } = mockFetch(
      // "t-open" was deleted in Discord.
      on("GET", `${api}/channels/55`, () =>
        json({ id: "55", guild_id: "44", available_tags: [{ id: "t-acme", name: "Acme" }] }),
      ),
      on("PATCH", `${api}/channels/111`, (request) =>
        JSON.parse(request.body).applied_tags.includes("t-open")
          ? json({ message: "refused", code }, { status })
          : json({}),
      ),
      on("PATCH", `${api}/channels/222`, () => json({ message: "Invalid Form Body", code: 50035 }, { status: 400 })),
    );
    const client = forum();
    await client.updateThread("55", "111", { archived: false, applied_tags: ["t-acme", "t-open"] });
    const patches = requests.filter((request) => request.method === "PATCH").map((request) => JSON.parse(request.body));
    expect(patches).toEqual([
      { archived: false, applied_tags: ["t-acme", "t-open"] },
      { archived: false, applied_tags: ["t-acme"] },
    ]);
    // A refused request whose tags all exist, or without tags, is not sent again.
    await expect(client.updateThread("55", "222", { archived: false, applied_tags: ["t-acme"] })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(client.updateThread("55", "222", { archived: false, name: "x" })).rejects.toMatchObject({
      status: 400,
    });
    expect(requests.filter((request) => request.url.pathname.endsWith("/222"))).toHaveLength(2);
  });

  it("opens a post without a tag the forum no longer has when Discord refuses it", async () => {
    const { requests } = mockFetch(
      application,
      on("GET", `${api}/channels/55/webhooks`, () =>
        json([{ id: "1", token: "abc", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("GET", `${api}/channels/55`, () => json({ id: "55", guild_id: "44", available_tags: [] })),
      on("POST", `${api}/webhooks/1/abc`, (request) =>
        JSON.parse(request.body).applied_tags?.length
          ? json({ message: "Invalid Form Body", code: 50035 }, { status: 400 })
          : json({ id: "m1", channel_id: "thread-9" }),
      ),
    );
    expect(await forum().execute("55", { content: "card", thread_name: "Ticket", applied_tags: ["t-gone"] })).toEqual({
      channelId: "thread-9",
      messageId: "m1",
    });
    const posts = requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
    expect(posts.map((post) => post.applied_tags)).toEqual([["t-gone"], []]);
  });

  it("reports a deleted thread as UnknownThreadError", async () => {
    mockFetch(
      application,
      on("GET", `${api}/channels/55/webhooks`, () =>
        json([{ id: "1", token: "abc", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("POST", `${api}/webhooks/1/abc`, () => json({ message: "Unknown Channel", code: 10003 }, { status: 404 })),
    );
    await expect(forum().execute("55", { content: "hi" }, "thread-1")).rejects.toBeInstanceOf(UnknownThreadError);
  });

  it("deletes a webhook message in its thread, treating an already deleted one as done", async () => {
    const { requests } = mockFetch(
      application,
      on("GET", `${api}/channels/55/webhooks`, () =>
        json([{ id: "1", token: "abc", type: 1, name: "Chatwoot", application_id: "100000000000000001" }]),
      ),
      on("DELETE", `${api}/webhooks/1/abc/messages/m1`, () => new Response(null, { status: 204 })),
      on("DELETE", `${api}/webhooks/1/abc/messages/m2`, () =>
        json({ message: "Unknown Message", code: 10008 }, { status: 404 }),
      ),
    );
    const client = forum();
    await client.deleteMessage("55", "thread-1", "m1");
    await client.deleteMessage("55", "thread-1", "m2");
    const deletes = requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => request.url.search)).toEqual(["?thread_id=thread-1", "?thread_id=thread-1"]);
    expect(deletes.every((request) => request.headers.get("authorization") === null)).toBe(true);
  });

  it("checks that a thread still exists in the forum", async () => {
    mockFetch(
      on("GET", `${api}/channels/111`, () => json({ id: "111", type: 11, parent_id: "55" })),
      on("GET", `${api}/channels/222`, () => json({ id: "222", type: 11, parent_id: "99" })),
      on("GET", `${api}/channels/333`, () => json({ message: "Unknown Channel", code: 10003 }, { status: 404 })),
    );
    const client = forum();
    expect(await client.threadExists("55", "111")).toBe(true);
    expect(await client.threadExists("55", "222")).toBe(false);
    expect(await client.threadExists("55", "333")).toBe(false);
  });
});

describe("DiscordRest", () => {
  it("fails on a redirect instead of following it with the bot token", async () => {
    const { requests } = mockFetch(
      on(
        "GET",
        `${api}/channels/55`,
        () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
      ),
    );
    const rest = new DiscordRest("bot-token", (request) => fetch(request));
    await expect(rest.get("/channels/55")).rejects.toBeInstanceOf(DiscordHttpError);
    expect(requests.map((request) => [request.url.hostname, request.redirect])).toEqual([["discord.com", "manual"]]);
  });

  it("returns 429 immediately and retains Retry-After across client recreation", async () => {
    const cache = new MemoryCache();
    const { requests } = mockFetch(on("GET", `${api}/channels/1`, () => json({ retry_after: 60 }, { status: 429 })));
    const started = Date.now();
    const limited = await new DiscordRest("t", (request) => fetch(request), cache)
      .get("/channels/1")
      .catch((error: unknown) => error);
    if (!(limited instanceof DiscordHttpError)) throw new Error("Expected a rate-limit response");
    expect(limited.status).toBe(429);
    expect(limited.retryAfterMs).toBeGreaterThanOrEqual(59_500);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(60_000);
    await expect(new DiscordRest("t", (request) => fetch(request), cache).get("/channels/1")).rejects.toMatchObject({
      status: 429,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(requests).toHaveLength(1);
  });

  it("shares bucket limits across routes, but keeps major resources separate", async () => {
    const cache = new MemoryCache();
    let limited = false;
    const headers = () => ({
      "x-ratelimit-bucket": "b1",
      ...(limited ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "60" } : {}),
    });
    mockFetch(
      on("GET", /^discord\.com\/api\/v10\/channels\/[12]$/, () => json({}, { headers: headers() })),
      on("PATCH", /^discord\.com\/api\/v10\/channels\/[12]$/, () => json({}, { headers: headers() })),
    );
    const rest = new DiscordRest("t", (request) => fetch(request), cache);
    await rest.get("/channels/1");
    await rest.patch("/channels/1", {});
    limited = true;
    await rest.get("/channels/1");
    await expect(
      new DiscordRest("t", (request) => fetch(request), cache).patch("/channels/1", {}),
    ).rejects.toMatchObject({ status: 429 });
    await expect(rest.get("/channels/2")).resolves.toEqual({});
  });

  it("keeps bot, unauthenticated and interaction global limits in their documented scopes", async () => {
    const cache = new MemoryCache();
    const { requests } = mockFetch(
      on("GET", `${api}/channels/1`, () => json({ retry_after: 60, global: true }, { status: 429 })),
      on("GET", `${api}/channels/2`, () => json({})),
      on("POST", `${api}/webhooks/1/tok`, () => json({ retry_after: 60, global: true }, { status: 429 })),
      on("PATCH", `${api}/webhooks/2/interaction/messages/@original`, () => json({})),
    );
    const rest = new DiscordRest("t", (request) => fetch(request), cache);
    await expect(rest.get("/channels/1")).rejects.toMatchObject({ status: 429 });
    await expect(rest.get("/channels/2")).rejects.toMatchObject({ status: 429 });
    await expect(rest.post("/webhooks/1/tok", { auth: false })).rejects.toMatchObject({ status: 429 });
    await expect(
      rest.patch("/webhooks/2/interaction/messages/@original", { auth: false, interaction: true }),
    ).resolves.toEqual({});
    expect(requests).toHaveLength(3);
  });

  it("gives up on long rate limits and surfaces Discord's error code", async () => {
    mockFetch(
      on("GET", `${api}/channels/1`, () => json({ message: "slow down", retry_after: 60 }, { status: 429 })),
      on("GET", `${api}/channels/2`, () => json({ message: "Missing Access", code: 50001 }, { status: 403 })),
    );
    const rest = new DiscordRest("t", (request) => fetch(request));
    // The error says how long Discord asked to wait, so the job can wait that long.
    await expect(rest.get("/channels/1")).rejects.toMatchObject({
      status: 429,
      retryAfterMs: expect.closeTo(60_000, -3),
    });
    // The route stays limited: the next call fails at once, with the time left.
    await expect(rest.get("/channels/1")).rejects.toMatchObject({
      status: 429,
      retryAfterMs: expect.closeTo(60_000, -3),
    });
    const error = await rest.get("/channels/2").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordHttpError);
    expect(error).toMatchObject({ status: 403, code: 50001 });
  });
});

describe("avatarUrl", () => {
  it("builds a user's own avatar, or their default avatar, on Discord's CDN", () => {
    const id = "80351110224678912";
    expect(avatarUrl({ id, avatar: "8342729096ea3675442027381ff50dfe", discriminator: "0" })).toBe(
      `https://cdn.discordapp.com/avatars/${id}/8342729096ea3675442027381ff50dfe.png`,
    );
    expect(avatarUrl({ id, avatar: "a_1269e74af4df7417b13759eae50c83dc", discriminator: "0" })).toBe(
      `https://cdn.discordapp.com/avatars/${id}/a_1269e74af4df7417b13759eae50c83dc.png`,
    );
    // New username system: (user_id >> 22) % 6. Legacy: discriminator % 5.
    expect(avatarUrl({ id, avatar: null, discriminator: "0" })).toBe("https://cdn.discordapp.com/embed/avatars/5.png");
    expect(avatarUrl({ id, avatar: null, discriminator: "1337" })).toBe(
      "https://cdn.discordapp.com/embed/avatars/2.png",
    );
  });
});
