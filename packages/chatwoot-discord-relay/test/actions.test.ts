import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../../../shared/budget.ts";
import { type CommandExecution, executeCommand } from "../src/commands/actions.ts";
import type { CommandAction, CommandJob } from "../src/commands/job.ts";
import { ALICE, BOB, json, mockFetch, on, type Route, testSettings } from "./helpers.ts";

const settings = testSettings();
const cw = "chatwoot.example.com/api/v1";
const conversation = `${cw}/accounts/3/conversations/15`;

function job(action: CommandAction, discordUserId = ALICE): CommandJob {
  return {
    interactionId: "1",
    applicationId: "100000000000000001",
    token: "tok",
    discordUserId,
    accountId: 3,
    conversationId: 15,
    action,
  };
}

const profile = on("GET", `${cw}/profile`, () =>
  json({ id: 42, name: "Alice Example", available_name: "Alice", email: "alice@example.com", accounts: [{ id: 3 }] }),
);
const ok = (method: string, path: string) => on(method, path, () => json({}));

function run(action: CommandAction, ...routes: Route[]) {
  return runWith(settings, action, ...routes);
}

function runWith(given: typeof settings, action: CommandAction, ...routes: Route[]) {
  return runWithPreparation(given, action, undefined, undefined, ...routes);
}

function runWithPreparation(
  given: typeof settings,
  action: CommandAction,
  retryable: CommandExecution["retryable"],
  confirmUnknown: CommandExecution["confirmUnknown"],
  ...routes: Route[]
) {
  const mock = mockFetch(profile, ...routes);
  const execution: CommandExecution = {
    settings: given,
    fetch: (request) => fetch(request),
  };
  if (retryable) execution.retryable = retryable;
  if (confirmUnknown) execution.confirmUnknown = confirmUnknown;
  const outcome = executeCommand(job(action), execution);
  return { outcome, result: outcome.then(({ content }) => content), requests: mock.requests };
}

afterEach(() => vi.restoreAllMocks());

describe("executeCommand", () => {
  it("acts with the invoking agent's own token", async () => {
    const { result, requests } = run(
      { type: "status", status: "resolved" },
      ok("POST", `${conversation}/toggle_status`),
    );
    expect(await result).toBe("✅ Resolved.");
    expect(requests.every((request) => request.headers.get("api_access_token") === "token-alice")).toBe(true);
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ status: "resolved" });
  });

  it("confirms a Chatwoot mutation accepted before a 500 response", async () => {
    let status = "open";
    const { result } = runWithPreparation(
      settings,
      { type: "status", status: "resolved" },
      () => false,
      async (chatwoot) => {
        const conversation = await chatwoot.getConversation(3, 15);
        return conversation?.status === "resolved" ? "Resolved." : undefined;
      },
      on("POST", `${conversation}/toggle_status`, () => {
        status = "resolved";
        return json({ error: "proxy lost the response" }, { status: 502 });
      }),
      on("GET", conversation, () => json({ id: 15, status })),
    );
    const outcome = await result;
    expect(outcome).toBe("✅ Resolved.");
  });

  it("reopens", async () => {
    const { result } = run({ type: "status", status: "open" }, ok("POST", `${conversation}/toggle_status`));
    expect(await result).toBe("✅ Reopened.");
  });

  it("marks as pending", async () => {
    const { result, requests } = run(
      { type: "status", status: "pending" },
      on("GET", conversation, () => json({ id: 15, inbox_id: 2 })),
      on("GET", `${cw}/accounts/3/inboxes/2/agent_bot`, () => json({ agent_bot: null })),
      ok("POST", `${conversation}/toggle_status`),
    );
    expect(await result).toBe("✅ Marked as pending.");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ status: "pending" });
  });

  it("hands pending back to the inbox bot with a typed assignment using the invoking user token", async () => {
    const { result, requests } = run(
      { type: "status", status: "pending" },
      on("GET", conversation, () =>
        json({ id: 15, inbox_id: 2, meta: { assignee: { id: 42 }, assignee_type: "User" } }),
      ),
      on("GET", `${cw}/accounts/3/inboxes/2/agent_bot`, () =>
        json({ agent_bot: { id: 42, account_id: 3, secret: "ignored", access_token: "ignored" } }),
      ),
      ok("POST", `${conversation}/assignments`),
    );
    expect(await result).toBe("✅ Handed back to the inbox bot.");
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toEqual({ assignee_id: 42, assignee_type: "AgentBot" });
    expect(requests.every((request) => request.headers.get("api_access_token") === "token-alice")).toBe(true);
    expect(requests.some((request) => request.url.pathname.endsWith("toggle_status"))).toBe(false);
  });

  it("refuses handback to a bot from another account", async () => {
    const { result, requests } = run(
      { type: "status", status: "pending" },
      on("GET", conversation, () => json({ id: 15, inbox_id: 2 })),
      on("GET", `${cw}/accounts/3/inboxes/2/agent_bot`, () => json({ agent_bot: { id: 42, account_id: 1 } })),
    );
    expect(await result).toBe("❌ That did not work. Please do it in Chatwoot.");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("snoozes until the next reply without a time, or until the given time", async () => {
    const untilReply = run({ type: "status", status: "snoozed" }, ok("POST", `${conversation}/toggle_status`));
    expect(await untilReply.result).toBe("✅ Snoozed until the next reply.");
    expect(JSON.parse(untilReply.requests.at(-1)?.body ?? "")).toEqual({ status: "snoozed" });

    const timed = run(
      { type: "status", status: "snoozed", snoozedUntil: 1790530245 },
      ok("POST", `${conversation}/toggle_status`),
    );
    expect(await timed.result).toBe("✅ Snoozed until <t:1790530245:f>.");
    expect(JSON.parse(timed.requests.at(-1)?.body ?? "")).toEqual({ status: "snoozed", snoozed_until: 1790530245 });
  });

  it("sets and clears the priority", async () => {
    const set = run({ type: "priority", priority: "urgent" }, ok("POST", `${conversation}/toggle_priority`));
    expect(await set.result).toBe("✅ Priority set to Urgent.");
    expect(JSON.parse(set.requests.at(-1)?.body ?? "")).toEqual({ priority: "urgent" });

    const clear = run({ type: "priority", priority: null }, ok("POST", `${conversation}/toggle_priority`));
    expect(await clear.result).toBe("✅ Priority removed.");
    expect(JSON.parse(clear.requests.at(-1)?.body ?? "")).toEqual({ priority: null });
  });

  it("blocks by resolving the conversation and blocking its contact", async () => {
    const { result, requests } = run(
      { type: "block" },
      on("GET", conversation, () => json({ id: 15, status: "open", meta: { sender: { id: 88 } } })),
      ok("POST", `${conversation}/toggle_status`),
      ok("PUT", `${cw}/accounts/3/contacts/88`),
    );
    expect(await result).toMatch(/^✅ Contact blocked and conversation resolved/);
    expect(requests.slice(1).map((request) => [`${request.method} ${request.url.pathname}`, request.body])).toEqual([
      ["GET /api/v1/accounts/3/conversations/15", ""],
      ["POST /api/v1/accounts/3/conversations/15/toggle_status", JSON.stringify({ status: "resolved" })],
      ["PUT /api/v1/accounts/3/contacts/88", JSON.stringify({ blocked: true })],
    ]);
  });

  it("unblocks the contact without changing the conversation", async () => {
    const { result, requests } = run(
      { type: "unblock" },
      on("GET", conversation, () => json({ id: 15, status: "resolved", meta: { sender: { id: 88 } } })),
      ok("PUT", `${cw}/accounts/3/contacts/88`),
    );
    expect(await result).toBe("✅ Contact unblocked. Their new messages will be posted here again.");
    expect(requests.slice(1).map((request) => [`${request.method} ${request.url.pathname}`, request.body])).toEqual([
      ["GET /api/v1/accounts/3/conversations/15", ""],
      ["PUT /api/v1/accounts/3/contacts/88", JSON.stringify({ blocked: false })],
    ]);
  });

  it("assigns by the target agent's Chatwoot user id, whatever their email", async () => {
    const { result, requests } = run(
      { type: "assign", chatwootUserId: 43 },
      on("GET", `${cw}/accounts/3/agents`, () =>
        json([
          { id: 42, name: "Alice Example", available_name: "Alice", email: "alice@example.com" },
          { id: 43, name: "Bob Example", available_name: "Bob", email: "robert@example.org" },
        ]),
      ),
      ok("POST", `${conversation}/assignments`),
    );
    // Chatwoot shows the assignee's `name`, which is also the post's assignee tag.
    expect(await result).toBe("✅ Assigned to Bob Example.");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({ assignee_id: 43, assignee_type: "User" });
  });

  it("refuses to assign an agent outside the account, which Chatwoot would treat as unassigning", async () => {
    const { result, requests } = run(
      { type: "assign", chatwootUserId: 43 },
      on("GET", `${cw}/accounts/3/agents`, () => json([{ id: 42, name: "Alice Example" }])),
    );
    expect(await result).toBe("❌ That agent is not in this Chatwoot account.");
    expect(requests.some((request) => request.url.pathname.endsWith("/assignments"))).toBe(false);
  });

  it("a public reply to an unassigned conversation assigns it to the sender first", async () => {
    const { result, requests } = run(
      { type: "message", private: false, content: "Thanks!", files: [] },
      on("GET", conversation, () => json({ id: 15, status: "open", meta: {} })),
      ok("POST", `${conversation}/assignments`),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Sent to the customer as Alice.");
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`).slice(1)).toEqual([
      "GET /api/v1/accounts/3/conversations/15",
      "POST /api/v1/accounts/3/conversations/15/assignments",
      "POST /api/v1/accounts/3/conversations/15/messages",
    ]);
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({
      content: "Thanks!",
      message_type: "outgoing",
      private: false,
    });
  });

  it("asks a Chatwoot build that can to send a reply from the agent's own address, with or without files", async () => {
    const sendingAsAgent = testSettings({ chatwoot: { baseUrl: "https://chatwoot.example.com", sendAsAgent: true } });
    const stock = run(
      { type: "message", private: false, content: "Hi", files: [], sendAsAgent: true },
      on("GET", conversation, () =>
        json({ id: 15, status: "open", meta: { channel: "Channel::Email", assignee: { id: 42 } } }),
      ),
      ok("POST", `${conversation}/messages`),
    );
    await stock.result;
    expect(JSON.parse(stock.requests.at(-1)?.body ?? "")).not.toHaveProperty("content_attributes");
    vi.restoreAllMocks();

    const { result, requests } = runWith(
      sendingAsAgent,
      { type: "message", private: false, content: "Hi", files: [], sendAsAgent: true },
      on("GET", conversation, () =>
        json({ id: 15, status: "open", meta: { channel: "Channel::Email", assignee: { id: 42 } } }),
      ),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Sent to the customer as Alice.");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toMatchObject({ content_attributes: { send_as_agent: true } });

    const withFile = runWith(
      sendingAsAgent,
      {
        type: "message",
        private: false,
        content: "",
        files: [{ url: "https://cdn.discordapp.com/a/q.pdf", filename: "q.pdf", size: 1 }],
        sendAsAgent: true,
      },
      on("GET", conversation, () =>
        json({ id: 15, status: "open", meta: { channel: "Channel::Email", assignee: { id: 42 } } }),
      ),
      on("GET", "cdn.discordapp.com/a/q.pdf", () => new Response(new Uint8Array([1]))),
      ok("POST", `${conversation}/messages`),
    );
    await withFile.result;
    expect(withFile.requests.at(-1)?.form?.get("content_attributes")).toBe('{"send_as_agent":true}');
  });

  it("a note does not touch the assignee", async () => {
    const { result, requests } = run(
      { type: "message", private: true, content: "Refund approved", files: [] },
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Note added.");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toMatchObject({ private: true });
  });

  it("downloads attachments from Discord's CDN and sends them as multipart", async () => {
    const { result, requests } = run(
      {
        type: "message",
        private: true,
        content: "",
        files: [
          {
            url: "https://cdn.discordapp.com/a/screenshot.png",
            filename: "screenshot.png",
            contentType: "image/png",
            size: 4,
          },
        ],
      },
      on("GET", "cdn.discordapp.com/a/screenshot.png", () => new Response(new Uint8Array([1, 2, 3, 4]))),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toBe("✅ Note added.");
    const form = requests.at(-1)?.form;
    expect(form?.get("private")).toBe("true");
    expect(form?.get("content")).toBeNull();
    const file = form?.get("attachments[]");
    expect(file instanceof File && [file.name, file.type, file.size]).toEqual(["screenshot.png", "image/png", 4]);
  });

  it("stops a download that exceeds the size cap", async () => {
    const { result, requests } = run(
      {
        type: "message",
        private: true,
        content: "",
        files: [{ url: "https://cdn.discordapp.com/big", filename: "big", size: 1 }],
      },
      on("GET", "cdn.discordapp.com/big", () => new Response(new Uint8Array(26 * 1024 * 1024))),
    );
    expect(await result).toMatch(/must be 25 MB or smaller/);
    expect(requests.some((request) => request.url.pathname.endsWith("/messages"))).toBe(false);
  });

  it("says when the agent is no longer in the account, rather than not linked", async () => {
    mockFetch(
      on("GET", `${cw}/profile`, () => json({ id: 42, name: "A", email: "a@example.com", accounts: [{ id: 99 }] })),
    );
    expect(
      (await executeCommand(job({ type: "block" }), { settings, fetch: (request) => fetch(request) })).content,
    ).toBe(
      "❌ Your Chatwoot user is no longer an agent in this Chatwoot account. Ask an admin to add you back, or to unlink your Discord account.",
    );
  });

  it("refuses a token that belongs to another Chatwoot user than the one the invoker is linked to", async () => {
    const { requests } = mockFetch(
      on("GET", `${cw}/profile`, () =>
        json({ id: 999, name: "Admin", email: "admin@example.com", accounts: [{ id: 3 }] }),
      ),
      ok("POST", `${conversation}/messages`),
    );
    const { content } = await executeCommand(job({ type: "message", private: true, content: "hi", files: [] }), {
      settings,
      fetch: (request) => fetch(request),
    });
    expect(content).toBe(
      "❌ Your Chatwoot access token belongs to another Chatwoot user, so nothing was done. Ask an admin to fix your link.",
    );
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/v1/profile"]);
  });

  it("fails on a redirect from Chatwoot instead of following it with the agent's token", async () => {
    const { requests } = mockFetch(
      on(
        "GET",
        `${cw}/profile`,
        () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } }),
      ),
    );
    const { content } = await executeCommand(job({ type: "block" }), { settings, fetch: (request) => fetch(request) });
    expect(content).toBe("❌ That did not work. Please do it in Chatwoot.");
    expect(requests.map((request) => [request.url.hostname, request.redirect])).toEqual([
      ["chatwoot.example.com", "manual"],
    ]);
  });

  it("refuses a queued command once its invoker is no longer linked", async () => {
    const unlinked = testSettings({ agents: [{ discordUserId: BOB, chatwootUserId: 43 }] });
    const { requests } = mockFetch(profile);
    const { content } = await executeCommand(job({ type: "block" }), {
      settings: unlinked,
      fetch: (request) => fetch(request),
    });
    expect(content).toBe("❌ Your Discord account is not linked to a Chatwoot agent.");
    expect(requests).toEqual([]);
  });

  it("unassigns the way Chatwoot's dashboard does", async () => {
    const { result, requests } = run({ type: "unassign" }, ok("POST", `${conversation}/assignments`));
    expect(await result).toBe("✅ Unassigned.");
    const request = requests.at(-1);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({ assignee_id: null });
  });

  describe("/label", () => {
    const accountLabels = on("GET", `${cw}/accounts/3/labels`, () =>
      json({
        payload: [
          { id: 1, title: "vip" },
          { id: 2, title: "refund" },
        ],
      }),
    );
    const conversationLabels = on("GET", `${conversation}/labels`, () => json({ payload: ["refund"] }));
    const setLabels = ok("POST", `${conversation}/labels`);
    const sent = (requests: Array<{ method: string; body: string }>) =>
      requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));

    it("adds one of the account's labels, keeping the others", async () => {
      const { result, requests } = run(
        { type: "label", change: "add", label: "vip" },
        accountLabels,
        conversationLabels,
        setLabels,
      );
      expect(await result).toBe("✅ Label vip added.");
      expect(sent(requests)).toEqual([{ labels: ["refund", "vip"] }]);
    });

    it("refuses a label the account does not have", async () => {
      const { result, requests } = run(
        { type: "label", change: "add", label: "urgentt" },
        accountLabels,
        conversationLabels,
        setLabels,
      );
      expect(await result).toBe('❌ There is no label "urgentt" in this Chatwoot account.');
      expect(sent(requests)).toEqual([]);
    });

    it("removes a label the conversation has, keeping the others", async () => {
      const { result, requests } = run(
        { type: "label", change: "remove", label: "refund" },
        conversationLabels,
        setLabels,
      );
      expect(await result).toBe("✅ Label refund removed.");
      expect(sent(requests)).toEqual([{ labels: [] }]);
      const missing = run({ type: "label", change: "remove", label: "vip" }, conversationLabels, setLabels);
      expect(await missing.result).toBe('❌ This conversation has no label "vip".');
    });

    it("sets the ticket's one label, or removes them all", async () => {
      const ticket = on("GET", conversation, () => json({ id: 15, labels: ["refund"], custom_attributes: {} }));
      const set = run({ type: "labels", labels: ["vip"] }, accountLabels, setLabels, ticket);
      expect(await set.result).toBe("✅ Label set to vip.");
      expect(sent(set.requests)).toEqual([{ labels: ["vip"] }]);
      const cleared = run({ type: "labels", labels: [] }, accountLabels, setLabels, ticket);
      expect(await cleared.result).toBe("✅ Labels removed.");
      expect(sent(cleared.requests)).toEqual([{ labels: [] }]);
    });

    it.each([undefined, "security"])(
      "keeps configured kind labels %s when replacing or clearing a topic",
      async (kind) => {
        const settings = testSettings({ router: { keepLabels: ["spam", "beg-bounty", ...(kind ? [kind] : [])] } });
        const ticket = on("GET", conversation, () =>
          json({
            id: 15,
            labels: ["vip", "spam", "security"],
            custom_attributes: {},
          }),
        );
        for (const labels of [["refund"], []]) {
          const changed = runWith(settings, { type: "labels", labels }, accountLabels, setLabels, ticket);
          await changed.result;
          expect(sent(changed.requests)).toEqual([{ labels: [...labels, "spam", ...(kind ? [kind] : [])] }]);
        }
      },
    );
  });

  describe("Manage panel", () => {
    const state = on("GET", conversation, () =>
      json({
        id: 15,
        status: "open",
        labels: ["vip"],
        meta: { assignee: { id: 43 }, sender: { name: "Jane <@123>" } },
      }),
    );
    const agents = on("GET", `${cw}/accounts/3/agents`, () =>
      json([
        { id: 42, name: "Alice Example" },
        { id: 43, name: "Bob Example" },
      ]),
    );
    const labels = on("GET", `${cw}/accounts/3/labels`, () =>
      json({
        payload: [
          { id: 1, title: "vip" },
          { id: 2, title: "refund" },
        ],
      }),
    );
    type Item = { custom_id: string; style?: number; options?: Array<{ value: string; default: boolean }> };
    type Card = {
      accent_color: number | null;
      components: Array<{ type: number; content?: string; components?: Item[] }>;
    };
    // The card's text, each menu's selected values, and each button's id (the highlighted one marked "*").
    const card = (components: unknown) => {
      const [{ accent_color, components: parts }] = components as [Card];
      return {
        accent: accent_color,
        parts: parts.map((part) =>
          part.type === 10
            ? part.content
            : (part.components ?? []).map((item) =>
                item.options
                  ? item.options.filter((option) => option.default).map((option) => option.value)
                  : `${item.custom_id}${item.style === 1 ? "*" : ""}`,
              ),
        ),
      };
    };

    it("draws the ticket as it is: a card coloured by status, its assignee and labels selected", async () => {
      const { outcome } = run({ type: "panel" }, state, agents, labels);
      const { components } = await outcome;
      expect(card(components)).toEqual({
        accent: 0x3ba55c,
        parts: [
          "### Acme #15 · Jane <\u200b@123>",
          [["43"]],
          [["vip"]],
          ["panel:status:open*", "panel:status:resolved", "panel:status:until_next_reply"],
        ],
      });
    });

    it("excludes configured kind labels from the Manage topic menu", async () => {
      const settings = testSettings({ router: { keepLabels: ["spam", "security"] } });
      const ticket = on("GET", conversation, () =>
        json({
          id: 15,
          status: "open",
          labels: ["spam", "security", "vip"],
          custom_attributes: {},
        }),
      );
      const allLabels = on("GET", `${cw}/accounts/3/labels`, () =>
        json({ payload: ["spam", "security", "vip", "refund"].map((title, index) => ({ id: index + 1, title })) }),
      );
      const { components } = await runWith(settings, { type: "panel" }, ticket, agents, allLabels).outcome;
      const rendered = JSON.stringify(components);
      expect(rendered).not.toContain('"value":"spam"');
      expect(rendered).not.toContain('"value":"security"');
      expect(rendered).toContain('"value":"vip"');
    });

    it("draws it again after a change from the panel, with what was done", async () => {
      const mock = mockFetch(profile, agents, ok("POST", `${conversation}/assignments`), state, labels);
      const { content, components } = await executeCommand(
        { ...job({ type: "assign", chatwootUserId: 43 }), panel: true },
        { settings, fetch: (request) => fetch(request) },
      );
      expect(content).toBe("✅ Assigned to Bob Example.");
      expect(card(components).parts[0]).toBe("### Acme #15 · Jane <\u200b@123>\n✅ Assigned to Bob Example.");
      expect(mock.requests.some((request) => request.url.pathname.endsWith("/assignments"))).toBe(true);
    });

    it("Assign to's menu lists the account's agents, the assignee selected", async () => {
      const { content, components } = await run({ type: "pick-assignee" }, state, agents).outcome;
      expect(content).toBe("👤 Assign **Acme #15** to:");
      const [row] = components as Array<{
        type: number;
        components: Array<{ custom_id: string; options: Array<{ value: string; default?: boolean }> }>;
      }>;
      expect(row?.type).toBe(1);
      expect(row?.components[0]?.custom_id).toBe("ticket:assignee");
      // The current assignee first, so a long list of agents never hides it.
      expect(row?.components[0]?.options.map((option) => `${option.value}${option.default ? "*" : ""}`)).toEqual([
        ":none",
        "43*",
        "42",
      ]);
    });
  });

  it("maps Chatwoot permission errors to a clear message", async () => {
    const { result } = run(
      { type: "status", status: "resolved" },
      on("POST", `${conversation}/toggle_status`, () => json({ error: "x" }, { status: 403 })),
    );
    expect(await result).toBe("❌ You do not have access to this conversation.");
  });

  it("says when the conversation no longer exists, so its post can be closed", async () => {
    const { outcome } = run(
      { type: "block" },
      on("GET", conversation, () => json({ error: "Resource could not be found" }, { status: 404 })),
    );
    expect(await outcome).toEqual({
      content: "❌ This conversation no longer exists in Chatwoot.",
      conversationGone: true,
    });
    const other = run({ type: "status", status: "resolved" }, ok("POST", `${conversation}/toggle_status`));
    expect((await other.outcome).conversationGone).toBe(false);
  });

  it("does not send a reply the channel cannot deliver", async () => {
    const { result, requests } = run(
      { type: "message", private: false, content: "Hello again", files: [] },
      on("GET", conversation, () => json({ id: 15, status: "open", can_reply: false, meta: { assignee: { id: 42 } } })),
      ok("POST", `${conversation}/messages`),
    );
    expect(await result).toMatch(/^❌ This conversation's channel does not accept a reply right now/);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("does not leak unexpected errors", async () => {
    const { result } = run(
      { type: "status", status: "resolved" },
      on("POST", `${conversation}/toggle_status`, () =>
        json({ error: "PG::ConnectionBad secret details" }, { status: 500 }),
      ),
    );
    expect(await result).toBe("❌ That did not work. Please do it in Chatwoot.");
  });

  it("gives up on a request that does not answer in time, saying it may have been done", async () => {
    // Answers the profile, then never answers until the request is aborted.
    const hanging = (request: Request) =>
      request.url.endsWith("/profile")
        ? Promise.resolve(json({ id: 42, accounts: [{ id: 3 }] }))
        : new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason));
          });
    const { content } = await executeCommand(job({ type: "status", status: "resolved" }), {
      settings,
      fetch: new Budget(20, hanging).fetchWith(20),
    });
    expect(content).toMatch(/^❌ Chatwoot or Discord did not answer in time\. Check in Chatwoot whether it was done/);
  });
});
