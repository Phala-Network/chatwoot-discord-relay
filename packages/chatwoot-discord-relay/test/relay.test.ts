import { ComponentType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it } from "vitest";
import type { LinkedAgent, RelayAssignee, RelayMessage } from "../../../shared/types.ts";
import { ticketCard } from "../src/commands/components.ts";
import { CONTENT_LIMIT } from "../src/relay/format.ts";
import { Relay, type RelayOptions, type WebhookMessage } from "../src/relay/relay.ts";
import { FakeForum, FORUM, MemoryStore, message, snowflake, TAGS, TRIAGE } from "./helpers.ts";

function relayWith(options: Partial<RelayOptions> = {}, tags: Record<string, string> = TAGS) {
  const forum = options.forum instanceof FakeForum ? options.forum : new FakeForum();
  const store = new MemoryStore();
  const relay = new Relay({
    forum,
    store,
    frontendUrl: "https://chatwoot.example.com/",
    avatars: AVATARS,
    target: (accountId) => ({ forumChannelId: FORUM, name: accountId === 3 ? "Acme" : "Globex", tags }),
    topicAttribute: "topic",
    maxChunks: 4,
    liveSeconds: 3600,
    now: () => NOW,
    ...options,
  });
  return { relay, forum, store };
}

const NOW = new Date("2026-09-27T20:00:00Z");
const NOW_SECONDS = NOW.getTime() / 1000;

const AVATARS = {
  chatwoot: "https://chatwoot.example.com/favicon-512x512.png",
  contact: "https://avatars.example.com/person.png",
};

const triage = { userId: TRIAGE, name: "Triage bot", perConversationPerHour: 5, perHour: 30 };
const resolved = { status: "resolved" };
const tagsFor = (status: string) => ({ archived: false, applied_tags: ["t-acme", `t-${status}`] });

describe("Relay", () => {
  let forum: FakeForum;
  let relay: Relay;

  beforeEach(() => {
    ({ relay, forum } = relayWith());
  });

  it("opens a tagged post with a ticket card, then posts the message as a reply", async () => {
    await relay.relay(message());
    const [[cardThread, card], [messageThread, first]] = forum.calls as [
      [string | undefined, Record<string, unknown>],
      [string | undefined, Record<string, unknown>],
    ];
    expect(cardThread).toBeUndefined();
    expect(card).toMatchObject({
      thread_name: "[Acme #12] Jane Doe — My agent will not connect",
      applied_tags: ["t-acme", "t-open"],
      username: "Chatwoot",
      content:
        "-# via Live chat · Acme — Product App\n-# jane@example.com\n[Open in Chatwoot](<https://chatwoot.example.com/app/accounts/3/conversations/12>)",
      allowed_mentions: { parse: [] },
    });
    expect(messageThread).toBe("thread-1");
    expect(first).toEqual({
      content: "My agent will not connect",
      username: "Jane Doe",
      avatar_url: AVATARS.contact,
      allowed_mentions: { parse: [] },
    });
    expect(forum.patches).toEqual([]);
  });

  it("gives customers their own avatar or the contact default, and Chatwoot's messages the Chatwoot avatar", async () => {
    await relay.relay(message());
    await relay.relay(
      message({
        id: 102,
        sender: { name: "Jane Doe", type: "contact", avatarUrl: "https://files.example.com/jane.png" },
      }),
    );
    await relay.relay(message({ id: 103, messageType: "activity", content: "Assigned to Sam" }));
    expect(forum.calls.map(([, payload]) => payload.avatar_url)).toEqual([
      AVATARS.chatwoot,
      AVATARS.contact,
      "https://files.example.com/jane.png",
      AVATARS.chatwoot,
    ]);
  });

  it("posts follow-ups into the same post under the sender's name and avatar", async () => {
    await relay.relay(message());
    await relay.relay(
      message({
        id: 102,
        messageType: "outgoing",
        content: "Run the login command",
        sender: { name: "Sam", type: "user", avatarUrl: "https://files.example.com/sam.png" },
      }),
    );
    const [thread, payload] = forum.calls.at(-1) ?? [];
    expect(thread).toBe("thread-1");
    expect(payload).toMatchObject({ username: "Sam · Acme", avatar_url: "https://files.example.com/sam.png" });
    expect(forum.patches).toEqual([]);
  });

  it("gives agents their linked Discord avatar, else their https Chatwoot avatar, else the Chatwoot avatar; agent bots theirs", async () => {
    const discord = "https://cdn.discordapp.com/avatars/100000000000000012/abc.png";
    const agent = (id: number, avatarUrl: string, extra: { discordAvatarUrl?: string; private?: boolean } = {}) =>
      message({ id, messageType: "outgoing", sender: { name: "Sam", type: "user", avatarUrl }, ...extra });
    await relay.relay(agent(101, "https://files.example.com/sam.png", { discordAvatarUrl: discord }));
    await relay.relay(agent(102, "https://files.example.com/sam.png", { private: true }));
    await relay.relay(agent(103, ""));
    await relay.relay(agent(104, "http://files.example.com/sam.png"));
    await relay.relay(
      message({
        id: 105,
        messageType: "outgoing",
        sender: { name: "Helper", type: "agent_bot", avatarUrl: "https://files.example.com/bot.png" },
      }),
    );
    expect(forum.calls.slice(1).map(([, payload]) => payload.avatar_url)).toEqual([
      discord,
      "https://files.example.com/sam.png",
      AVATARS.chatwoot,
      AVATARS.chatwoot,
      "https://files.example.com/bot.png",
    ]);
  });

  it("resolving posts the activity, then retags and archives; a new message reopens", async () => {
    await relay.relay(message());
    await relay.sync(3, message().conversation, "thread-1");
    expect(forum.patches).toEqual([]);

    const resolving = message({ id: 103, messageType: "activity", content: "Resolved by Sam", conversation: resolved });
    await relay.relay(resolving);
    await relay.sync(3, resolving.conversation, "thread-1");
    expect(forum.calls.at(-1)?.[1].content).toBe("_Resolved by Sam_");
    // Tags change while unarchiving; archiving is a separate update.
    expect(forum.patches).toEqual([
      ["thread-1", tagsFor("resolved")],
      ["thread-1", { archived: true }],
    ]);

    const reopened = message({ id: 104, content: "Still broken" });
    await relay.relay(reopened);
    await relay.sync(3, reopened.conversation, "thread-1");
    expect(forum.patches.at(-1)).toEqual(["thread-1", tagsFor("open")]);
    expect(forum.archived.has("thread-1")).toBe(false);
  });

  it("archives a resolved post again after any message", async () => {
    const note = message({ id: 105, messageType: "outgoing", private: true, content: "note", conversation: resolved });
    await relay.relay(message({ conversation: resolved }));
    await relay.sync(3, note.conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);

    await relay.relay(note); // Posting unarchives the post.
    await relay.sync(3, note.conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);
    expect(forum.patches.map(([, patch]) => patch)).toEqual([
      tagsFor("resolved"),
      { archived: true },
      tagsFor("resolved"),
      { archived: true },
    ]);
  });

  it("sync without a new message only updates the post when the state changed", async () => {
    await relay.relay(message());
    const conversation = message().conversation;
    await relay.sync(3, conversation, "thread-1");
    expect(forum.patches).toEqual([]);
    await relay.sync(3, { ...conversation, status: "resolved" }, "thread-1");
    await relay.sync(3, { ...conversation, status: "resolved" }, "thread-1");
    expect(forum.patches).toEqual([
      ["thread-1", tagsFor("resolved")],
      ["thread-1", { archived: true }],
    ]);
  });

  it("changes the tags of an archived post by unarchiving it in the same update", async () => {
    ({ relay, forum } = relayWith({}, { ...TAGS, "topic:Billing": "t-billing" }));
    await relay.relay(message({ conversation: resolved }));
    await relay.sync(3, message({ conversation: resolved }).conversation, "thread-1");
    // The topic changes after the post was archived, without a new message.
    const retopic = message({ conversation: { ...resolved, customAttributes: { topic: "Billing" } } }).conversation;
    await relay.sync(3, retopic, "thread-1");
    expect(forum.patches.slice(2)).toEqual([
      ["thread-1", { archived: false, applied_tags: ["t-acme", "t-resolved", "t-billing"] }],
      ["thread-1", { archived: true }],
    ]);
    expect(forum.archived.has("thread-1")).toBe(true);

    // An open post that Discord archived for inactivity gets its new tags too.
    await relay.relay(message({ id: 102, conversation: { id: 13 } }));
    forum.archived.add("thread-4");
    await relay.sync(3, message({ conversation: { id: 13, status: "pending" } }).conversation, "thread-4");
    expect(forum.patches.at(-1)).toEqual(["thread-4", { archived: false, applied_tags: ["t-acme", "t-pending"] }]);
  });

  it("tags the conversation's status as it is in Chatwoot and archives only resolved posts", async () => {
    await relay.relay(message({ conversation: { status: "pending" } }));
    expect(forum.calls[0]?.[1].applied_tags).toEqual(["t-acme", "t-pending"]);
    await relay.sync(3, message({ conversation: { status: "snoozed" } }).conversation, "thread-1");
    expect(forum.patches).toEqual([["thread-1", { archived: false, applied_tags: ["t-acme"] }]]);
  });

  it("orders account, status, assignee, topic, priority and labels within Discord's five tag slots", async () => {
    const tags = {
      "label:vip": "t-vip",
      "priority:urgent": "t-urgent",
      "label:refund": "t-refund",
      "topic:Billing": "t-billing",
      "assignee:8": "t-sam",
      "assignee:none": "t-none",
      ...TAGS,
    };
    ({ relay, forum } = relayWith({}, tags));
    const attributes = { customAttributes: { topic: "Billing" }, priority: "urgent", labels: ["refund", "vip"] };
    await relay.relay(message({ conversation: attributes }));
    expect(forum.calls[0]?.[1].applied_tags).toEqual(["t-acme", "t-open", "t-none", "t-billing", "t-urgent"]);
    const assigned = { ...attributes, assignee: { id: 8, name: "Sam" } };
    await relay.sync(3, message({ conversation: assigned }).conversation, "thread-1");
    const withoutPriority = { ...assigned, priority: null };
    await relay.sync(3, message({ conversation: withoutPriority }).conversation, "thread-1");
    const withoutTopic = { ...withoutPriority, customAttributes: {} };
    await relay.sync(3, message({ conversation: withoutTopic }).conversation, "thread-1");
    await relay.sync(3, message({ conversation: withoutTopic }).conversation, "thread-1");
    expect(forum.patches.map(([, patch]) => patch)).toEqual([
      { archived: false, applied_tags: ["t-acme", "t-open", "t-sam", "t-billing", "t-urgent"] },
      { archived: false, applied_tags: ["t-acme", "t-open", "t-sam", "t-billing", "t-refund"] },
      { archived: false, applied_tags: ["t-acme", "t-open", "t-sam", "t-refund", "t-vip"] },
    ]);
  });

  it("tags the assignee by Chatwoot user id, linked or not, whatever their name", async () => {
    const agents: Record<number, LinkedAgent> = { 7: { discordUserId: "592" } };
    const tagged = { ...TAGS, "assignee:7": "t-kingsley", "assignee:8": "t-sam", "assignee:9": "t-dana" };
    ({ relay, forum } = relayWith({ linkedAgent: (id) => agents[id] }, tagged));
    const assignedTo = (assignee: RelayAssignee) => message({ conversation: { assignee } }).conversation;
    const tags = async (assignee: RelayAssignee) => {
      await relay.sync(3, assignedTo(assignee), "thread-1");
      return forum.patches.at(-1)?.[1].applied_tags;
    };
    await relay.relay(message());
    expect(await tags({ id: 7, name: "Kingsley" })).toEqual(["t-acme", "t-open", "t-kingsley"]);
    // Renamed in Chatwoot: the tag stays (the post is synced again for its card, which names them).
    expect(await tags({ id: 7, name: "Kingsley Don" })).toEqual(["t-acme", "t-open", "t-kingsley"]);
    // An agent who is not linked is tagged by id too; one without a tag in the forum gets none.
    expect(await tags({ id: 8, name: "Sam Lee" })).toEqual(["t-acme", "t-open", "t-sam"]);
    expect(await tags({ id: 10, name: "Lee" })).toEqual(["t-acme", "t-open"]);
  });

  it("skips templates, empty messages, and deleted messages", async () => {
    await relay.relay(message({ messageType: "template" }));
    await relay.relay(message({ content: "  " }));
    await relay.relay(message({ deleted: true, content: "This message was deleted" }));
    expect(forum.calls).toEqual([]);
  });

  it("recreates the post when the Discord thread was deleted", async () => {
    await relay.relay(message());
    forum.failThreadWith = "gone";
    await relay.relay(message({ id: 102, content: "still broken" }));
    expect(forum.calls.map(([thread]) => thread)).toEqual([undefined, "thread-1", undefined, "thread-3"]);
    expect(forum.calls.at(-1)?.[1].content).toBe("still broken");
  });

  it("forgets a post deleted in Discord when only its tags change", async () => {
    await relay.relay(message());
    forum.failThreadWith = "gone";
    await relay.sync(3, message({ conversation: { status: "resolved" } }).conversation, "thread-1");
    await relay.relay(message({ id: 102, content: "New request" }));
    expect(forum.calls.map(([thread]) => thread)).toEqual([undefined, "thread-1", undefined, "thread-3"]);
    expect(forum.contents().at(-1)).toBe("New request");
  });

  it("lets other Discord errors propagate for a retry", async () => {
    await relay.relay(message());
    forum.failThreadWith = "error";
    await expect(relay.relay(message({ id: 102 }))).rejects.toThrow("Discord HTTP 500");
  });

  it("gives separate accounts separate posts and tags", async () => {
    await relay.relay(message());
    await relay.relay(message({ id: 300, account: { id: 1, name: "Globex" } }));
    expect(forum.calls.map(([thread]) => thread)).toEqual([undefined, "thread-1", undefined, "thread-3"]);
    expect(forum.calls[2]?.[1].thread_name).toMatch(/^\[Globex #12\]/);
    expect(forum.calls[2]?.[1].applied_tags).toEqual(["t-globex", "t-open"]);
  });

  it("mentions the triage bot on customer messages only", async () => {
    ({ relay, forum } = relayWith({ triage }));
    await relay.relay(message());
    await relay.relay(message({ id: 102, content: "x ".repeat(1500) }));
    await relay.relay(
      message({ id: 103, messageType: "outgoing", content: "Try again", sender: { name: "Sam", type: "user" } }),
    );
    await relay.relay(message({ id: 104, messageType: "outgoing", private: true, content: "Known issue" }));
    await relay.relay(message({ id: 105, messageType: "activity", content: "Assigned to Sam" }));
    const contents = forum.contents();
    expect(contents[0]).not.toContain(`<@${TRIAGE}>`); // ticket card
    expect(contents[1]).toBe(`My agent will not connect\n-# <@${TRIAGE}>`);
    // A split message carries the mention on its last part, so the bot sees all of it.
    expect(contents[2]).not.toContain(`<@${TRIAGE}>`);
    expect(contents[3]?.endsWith(`\n-# <@${TRIAGE}>`)).toBe(true);
    expect(contents.slice(2, 4).every((content) => content.length <= CONTENT_LIMIT)).toBe(true);
    expect(contents.filter((content) => content.includes(`<@${TRIAGE}>`))).toHaveLength(2);
    // Mentions never ping: the webhook message allows none.
    expect(forum.calls.every(([, payload]) => payload.allowed_mentions?.parse?.length === 0)).toBe(true);
  });

  it("does not call the triage bot for a message a routing kind's reply answered", async () => {
    ({ relay, forum } = relayWith({ triage }));
    await relay.relay(message({ answered: true }));
    await relay.relay(message({ id: 102, content: "One more thing" }));
    const [answered, later] = forum.contents().slice(1);
    expect(answered).toBe(
      "My agent will not connect\n-# Triage bot not called: handled automatically. Ask it here, if needed.",
    );
    expect(later).toBe(`One more thing\n-# <@${TRIAGE}>`);
  });

  it("calls the triage bot within its hourly budgets", async () => {
    ({ relay, forum } = relayWith({ triage }));
    for (let i = 0; i < 7; i += 1) await relay.relay(message({ id: 200 + i, content: `msg ${i}` }));
    const tagged = forum.contents().filter((content) => content.startsWith("msg"));
    expect(tagged.filter((content) => content.endsWith(`<@${TRIAGE}>`))).toHaveLength(5);
    expect(tagged.at(-1)).toMatch(/Triage bot not called: more than 5 customer messages in this conversation/);

    for (let i = 0; i < 30; i += 1) {
      await relay.relay(message({ id: 300 + i, conversation: { id: 1000 + i } }));
    }
    expect(forum.contents().at(-1)).toMatch(/Triage bot not called: more than 30 customer messages this hour/);
  });

  it("does not use up the triage budget when a message is retried", async () => {
    ({ relay, forum } = relayWith({ triage }));
    await relay.relay(message());
    for (let i = 0; i < 5; i += 1) {
      forum.failThreadWith = "error";
      await expect(relay.relay(message({ id: 102, content: "retried" }))).rejects.toThrow();
    }
    await relay.relay(message({ id: 102, content: "retried" }));
    await relay.relay(message({ id: 103, content: "next" }));
    expect(forum.contents().at(-1)?.endsWith(`<@${TRIAGE}>`)).toBe(true);
  });

  it.each(["pending", "resolved", "snoozed"])(
    "preserves both triage allowances after %s messages, for later open requests",
    async (status) => {
      ({ relay, forum } = relayWith({ triage: { ...triage, perConversationPerHour: 2, perHour: 3 } }));
      for (const id of [101, 102])
        await relay.relay(message({ id, createdAt: NOW_SECONDS, content: `closed ${id}`, conversation: { status } }));
      expect(
        forum
          .contents()
          .filter((content) => content.startsWith("closed"))
          .some((content) => content.includes(`<@${TRIAGE}>`)),
      ).toBe(false);
      for (const id of [103, 104]) await relay.relay(message({ id, createdAt: NOW_SECONDS, content: `open ${id}` }));
      await relay.relay(
        message({ id: 201, createdAt: NOW_SECONDS, content: "open elsewhere", conversation: { id: 13 } }),
      );
      await relay.relay(
        message({ id: 202, createdAt: NOW_SECONDS, content: "over global budget", conversation: { id: 14 } }),
      );
      const open = forum.contents().filter((content) => content.startsWith("open"));
      expect(open).toHaveLength(3);
      expect(open.every((content) => content.endsWith(`<@${TRIAGE}>`))).toBe(true);
      expect(forum.contents().at(-1)).toContain("more than 3 customer messages this hour");
    },
  );

  it("keeps an answer or mention decision in the posted message through retries", async () => {
    ({ relay, forum } = relayWith({ triage }));
    for (const [id, answered] of [
      [201, true],
      [202, false],
    ] as const) {
      const customer = message({ id, answered, content: "x".repeat(3000) });
      forum.failAfter = 1;
      await expect(relay.relay(customer)).rejects.toThrow("Discord HTTP 500");
      customer.answered = !answered;
      await relay.relay(customer);
      const last = forum.contents().at(-1);
      expect(last?.includes("handled automatically")).toBe(answered);
      expect(last?.includes(`<@${TRIAGE}>`)).toBe(!answered);
    }
  });

  it("keeps a message over the triage budget uncalled when its post is retried", async () => {
    ({ relay, forum } = relayWith({ triage: { ...triage, perConversationPerHour: 1 } }));
    await relay.relay(message({ id: 201, content: "first" }));
    forum.failThreadWith = "error";
    await expect(relay.relay(message({ id: 202, content: "second" }))).rejects.toThrow();
    await relay.relay(message({ id: 202, content: "second" }));
    const second = forum.contents().filter((content) => content.startsWith("second"));
    expect(second).toHaveLength(1);
    expect(second[0]).not.toContain(`<@${TRIAGE}>`);
    expect(second[0]).toMatch(/Triage bot not called: more than 1 customer messages in this conversation/);
  });

  it("caps very long messages with a link to the full text", async () => {
    const text = `${"x".repeat(1900)}\n`.repeat(10);
    await relay.relay(message({ content: text }));
    const replies = forum.contents().slice(1);
    expect(replies).toHaveLength(5);
    expect(replies.every((content) => content.length <= CONTENT_LIMIT)).toBe(true);
    expect(replies.at(-1)).toBe(
      `-# Message truncated (${text.trim().length} characters). Full text: <https://chatwoot.example.com/app/accounts/3/conversations/12>`,
    );
  });

  it("mutes blocked contacts but still posts activity", async () => {
    const blocked = { status: "resolved", contact: { name: "Spammer", blocked: true } };
    await relay.relay(message({ conversation: blocked }));
    expect(forum.calls).toEqual([]);
    await relay.relay(
      message({ messageType: "activity", content: "Sam muted the conversation", conversation: blocked }),
    );
    expect(forum.contents().at(-1)).toBe("_Sam muted the conversation_");
  });

  it("pings a newly assigned, linked agent once, in a notice after the run's live messages", async () => {
    ({ relay, forum } = relayWith({ linkedAgent: (id) => (id === 7 ? { discordUserId: "592" } : undefined) }));
    // What the processor does in each run: relay the messages, then announce while one is pending.
    const run = async (relayed: RelayMessage) => {
      await relay.relay(relayed);
      await relay.announceAssignee(3, relayed.conversation);
    };
    await run(message());
    expect(forum.calls.some(([, payload]) => payload.allowed_mentions?.users)).toBe(false);

    const assigned = { assignee: { id: 7, name: "Kim" } };
    await run(message({ id: 110, messageType: "activity", content: "Assigned to Kim by Sam", conversation: assigned }));
    expect(forum.calls.slice(-2).map(([, payload]) => payload)).toEqual([
      {
        content: "_Assigned to Kim by Sam_",
        username: "Chatwoot",
        avatar_url: AVATARS.chatwoot,
        allowed_mentions: { parse: [] },
      },
      {
        content: "-# Assigned to <@592>",
        username: "Chatwoot",
        avatar_url: AVATARS.chatwoot,
        allowed_mentions: { parse: [], users: ["592"] },
      },
    ]);

    const posted = forum.calls.length;
    await run(message({ id: 111, messageType: "outgoing", content: "On it", conversation: assigned }));
    const unlinked = { assignee: { id: 9, name: "Bot" } };
    await run(message({ id: 112, messageType: "activity", content: "Assigned to Bot", conversation: unlinked }));
    expect(forum.contents().slice(posted)).toEqual(["On it", "_Assigned to Bot_"]);
  });

  it("announces the assignee after the first message when a conversation is assigned at creation", async () => {
    ({ relay, forum } = relayWith({ triage, linkedAgent: () => ({ discordUserId: "592" }) }));
    const first = message({ conversation: { assignee: { id: 7, name: "Kim" } } });
    await relay.relay(first);
    await relay.announceAssignee(3, first.conversation);
    const [card, reply, notice] = forum.calls.map(([, payload]) => payload);
    expect(card?.allowed_mentions).toEqual({ parse: [] });
    // The announcement pings the assignee, so the customer message does not as well.
    expect(reply).toMatchObject({
      content: `My agent will not connect\n-# <@${TRIAGE}>`,
      allowed_mentions: { parse: [] },
    });
    expect(notice).toMatchObject({ content: "-# Assigned to <@592>", allowed_mentions: { parse: [], users: ["592"] } });
  });

  it("does not announce the assignee of an adopted post, but records them", async () => {
    const adopted = relayWith({ linkedAgent: () => ({ discordUserId: "592" }) });
    adopted.store.updateConversation(3, 12, { threadId: "adopted-thread" });
    const reply = message({
      messageType: "outgoing",
      content: "On it",
      sender: { name: "Sam", type: "user" },
      conversation: { assignee: { id: 7, name: "Kim" } },
    });
    await adopted.relay.relay(reply);
    await adopted.relay.announceAssignee(3, reply.conversation);
    expect(adopted.forum.calls).toEqual([
      [
        "adopted-thread",
        { content: "On it", username: "Sam · Acme", avatar_url: AVATARS.chatwoot, allowed_mentions: { parse: [] } },
      ],
    ]);
  });

  it("tells assignees apart by Chatwoot user id: a rename does not ping, a reassignment does", async () => {
    const agents: Record<number, LinkedAgent> = { 7: { discordUserId: "592" }, 8: { discordUserId: "593" } };
    ({ relay, forum } = relayWith({ linkedAgent: (id) => agents[id] }));
    const run = async (relayed: RelayMessage) => {
      await relay.relay(relayed);
      await relay.announceAssignee(3, relayed.conversation);
    };
    const kim = { assignee: { id: 7, name: "Kim" } };
    await run(message({ messageType: "activity", content: "Assigned to Kim", conversation: kim }));
    const posted = forum.calls.length;
    const renamed = { assignee: { id: 7, name: "Kim Lee" } };
    await run(message({ id: 102, messageType: "outgoing", content: "On it", conversation: renamed }));
    const lee = { assignee: { id: 8, name: "Kim" } };
    await run(message({ id: 103, messageType: "activity", content: "Assigned to Kim", conversation: lee }));
    expect(forum.contents().slice(posted)).toEqual(["On it", "_Assigned to Kim_", "-# Assigned to <@593>"]);
    // Each new assignee is added to the post once; a rename adds no one.
    expect(forum.members).toEqual([
      ["thread-1", "592"],
      ["thread-1", "593"],
    ]);
  });

  it("adds a new assignee to a resolved post only after the announcement unarchived it", async () => {
    ({ relay, forum } = relayWith({ linkedAgent: () => ({ discordUserId: "592" }) }));
    const resolved = { status: "resolved", assignee: null };
    await relay.relay(message({ conversation: resolved }));
    await relay.sync(3, message({ conversation: resolved }).conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);
    const assigned = message({ id: 102, conversation: { status: "resolved", assignee: { id: 7, name: "Kim" } } });
    await relay.relay(assigned);
    forum.archived.add("thread-1"); // Archived again between the run's messages and its announcement.
    await relay.announceAssignee(3, assigned.conversation);
    expect(forum.contents().at(-1)).toBe("-# Assigned to <@592>");
    expect(forum.members).toEqual([["thread-1", "592"]]);
  });

  it("still records the announcement when the assignee cannot be added to the post", async () => {
    ({ relay, forum } = relayWith({ linkedAgent: () => ({ discordUserId: "592" }) }));
    forum.failAddMember = true;
    const assigned = message({ conversation: { assignee: { id: 7, name: "Kim" } } });
    await relay.relay(assigned);
    await expect(relay.announceAssignee(3, assigned.conversation)).resolves.toBeUndefined();
    expect(forum.contents().at(-1)).toBe("-# Assigned to <@592>");
    await relay.announceAssignee(3, assigned.conversation);
    expect(forum.contents().filter((text) => text === "-# Assigned to <@592>")).toHaveLength(1);
    expect(forum.members).toEqual([]);
  });

  it("pings the linked assignee on every customer message", async () => {
    ({ relay, forum } = relayWith({ triage, linkedAgent: (id) => (id === 7 ? { discordUserId: "592" } : undefined) }));
    const assigned = { assignee: { id: 7, name: "Kim" } };
    await relay.relay(message({ conversation: assigned }));
    await relay.announceAssignee(3, message({ conversation: assigned }).conversation);
    await relay.relay(message({ id: 102, content: "Hello?", conversation: assigned }));
    await relay.relay(message({ id: 103, content: "Anyone?", conversation: assigned }));
    await relay.relay(message({ id: 104, messageType: "outgoing", content: "Here", conversation: assigned }));
    await relay.relay(
      message({ id: 105, messageType: "outgoing", private: true, content: "Note", conversation: assigned }),
    );
    await relay.relay(message({ id: 106, messageType: "activity", content: "Snoozed", conversation: assigned }));
    await relay.relay(message({ id: 107, content: "Other agent", conversation: { assignee: { id: 9, name: "Lee" } } }));
    await relay.relay(message({ id: 108, content: "Nobody", conversation: { assignee: null } }));

    const replies = forum.calls.slice(1).map(([, payload]) => [payload.content, payload.allowed_mentions]);
    const users = { parse: [], users: ["592"] };
    expect(replies).toEqual([
      [`My agent will not connect\n-# <@${TRIAGE}>`, { parse: [] }],
      ["-# Assigned to <@592>", users],
      [`Hello?\n-# <@${TRIAGE}> <@592>`, users],
      [`Anyone?\n-# <@${TRIAGE}> <@592>`, users],
      ["Here", { parse: [] }],
      ["🔒 **Internal note**\nNote", { parse: [] }],
      ["_Snoozed_", { parse: [] }],
      [`Other agent\n-# <@${TRIAGE}>`, { parse: [] }],
      [`Nobody\n-# <@${TRIAGE}>`, { parse: [] }],
    ]);
  });

  it("resumes a long message after the parts already posted", async () => {
    ({ relay, forum } = relayWith({ triage }));
    // The historical 1,674-character chunk boundary must remain stable on retry across upgrades.
    const text = `${"a".repeat(1674)}${"b".repeat(1674)}${"c".repeat(100)}`;
    await relay.relay(message());
    forum.failAfter = 1;
    await expect(relay.relay(message({ id: 102, content: text }))).rejects.toThrow("Discord HTTP 500");
    await relay.relay(message({ id: 102, content: text }));
    expect(forum.contents().slice(2)).toEqual([
      "a".repeat(1674),
      "b".repeat(1674),
      `${"c".repeat(100)}\n-# <@${TRIAGE}>`,
    ]);
  });

  it("says so, archives, and forgets a post whose conversation was deleted", async () => {
    await relay.relay(message());
    await relay.closeDeleted(3, 12);
    expect(forum.calls.at(-1)).toEqual([
      "thread-1",
      {
        content: "This conversation no longer exists in Chatwoot.",
        username: "Chatwoot",
        avatar_url: AVATARS.chatwoot,
        allowed_mentions: { parse: [] },
      },
    ]);
    expect(forum.archived.has("thread-1")).toBe(true);
  });

  it("does not mention anyone without a configured triage bot", async () => {
    await relay.relay(message());
    expect(forum.contents().some((content) => content.includes("<@"))).toBe(false);
  });

  it("posts a notice into the existing post, and archives a resolved post again afterwards", async () => {
    expect(await relay.notify(3, message().conversation, "⚠️ Notice", "notice-1")).toBeUndefined(); // no post yet
    await relay.relay(message({ conversation: resolved }));
    await relay.sync(3, message({ conversation: resolved }).conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);

    expect(await relay.notify(3, message({ conversation: resolved }).conversation, "⚠️ Notice", "notice-2")).toBeTypeOf(
      "string",
    );
    expect(forum.calls.at(-1)).toEqual([
      "thread-1",
      { content: "⚠️ Notice", username: "Chatwoot", avatar_url: AVATARS.chatwoot, allowed_mentions: { parse: [] } },
    ]);
    expect(forum.archived.has("thread-1")).toBe(false); // posting unarchived it
    await relay.sync(3, message({ conversation: resolved }).conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);
  });

  it("posts a response under the contact's name and avatar, capped with a link to the full text", async () => {
    await relay.relay(message());
    const contact = { name: "Jane Doe", avatarUrl: "https://cdn.example.com/jane.png" };
    const conversation = message({ conversation: { contact } }).conversation;
    expect(await relay.postResponse(3, conversation, "Pick one\n\n**Response:** A", "response-1")).toBeTypeOf("string");
    expect(forum.calls.at(-1)).toEqual([
      "thread-1",
      {
        content: "Pick one\n\n**Response:** A",
        username: "Jane Doe",
        avatar_url: "https://cdn.example.com/jane.png",
        allowed_mentions: { parse: [] },
      },
    ]);

    const long = `Question\n\n**Responses:**\n${"• Notes: text\n".repeat(300)}`;
    await relay.postResponse(3, conversation, long, "response-2");
    const content = forum.contents().at(-1) ?? "";
    expect(content.length).toBeLessThanOrEqual(CONTENT_LIMIT);
    expect(content.startsWith("Question\n\n**Responses:**\n• Notes: text\n")).toBe(true);
    expect(content.split("\n").at(-1)).toBe(
      `-# Response truncated (${long.length} characters). Full text: <https://chatwoot.example.com/app/accounts/3/conversations/12>`,
    );
  });

  it("defuses mentions and subtext in a customer's response", async () => {
    await relay.relay(message());
    await relay.postResponse(
      3,
      message().conversation,
      "Pick one\n\n**Response:** <@100000000000000777>\n-# x",
      "response-3",
    );
    expect(forum.contents().at(-1)).toBe("Pick one\n\n**Response:** <\u200b@100000000000000777>\n\u200b-# x");
  });

  it("forgets a post deleted in Discord instead of posting a response", async () => {
    await relay.relay(message());
    forum.failThreadWith = "gone";
    expect(
      await relay.postResponse(3, message().conversation, "**Email:** a@example.com", "response-4"),
    ).toBeUndefined();
    await relay.relay(message({ id: 102, content: "New request" }));
    expect(forum.calls.map(([thread]) => thread)).toEqual([undefined, "thread-1", undefined, "thread-3"]);
    expect(forum.contents().at(-1)).toBe("New request");
  });

  it("relays history without notifications, reporting only live messages for the announcement", async () => {
    ({ relay, forum } = relayWith({ triage, linkedAgent: () => ({ discordUserId: "592" }) }));
    const assigned = { assignee: { id: 7, name: "Kim" } };
    const hourAgo = NOW_SECONDS - 3601;
    const history = [
      message({ createdAt: hourAgo - 86400, content: "old question", conversation: assigned }),
      message({ id: 102, createdAt: hourAgo, content: "old follow-up", conversation: assigned }),
    ];
    for (const old of history) await relay.relay(old);
    await relay.relay(
      message({ id: 103, createdAt: NOW_SECONDS - 60, content: "still there?", conversation: assigned }),
    );
    const replies = forum.calls.slice(1).map(([, payload]) => [payload.content, payload.allowed_mentions]);
    expect(replies).toEqual([
      ["old question", { parse: [] }],
      ["old follow-up", { parse: [] }],
      [`still there?\n-# <@${TRIAGE}>`, { parse: [] }],
    ]);
    await relay.announceAssignee(3, message({ conversation: assigned }).conversation);
    expect(forum.contents().at(-1)).toBe("-# Assigned to <@592>");
    expect(forum.members).toEqual([["thread-1", "592"]]);
    // The full five-message allowance remains after history; the sixth live message is over budget.
    for (let id = 104; id <= 108; id += 1)
      await relay.relay(message({ id, createdAt: NOW_SECONDS, content: `live ${id}`, conversation: assigned }));
    const live = forum
      .contents()
      .filter((content) => content.startsWith("still there?") || content.startsWith("live "));
    expect(live.filter((content) => content.includes(`<@${TRIAGE}>`))).toHaveLength(5);
    expect(live.at(-1)).toContain("more than 5 customer messages in this conversation");
  });

  it("pings on the last part of a split message only", async () => {
    ({ relay, forum } = relayWith({ triage, linkedAgent: () => ({ discordUserId: "592" }) }));
    const assigned = message({ conversation: { assignee: { id: 7, name: "Kim" } } });
    await relay.relay(assigned);
    await relay.announceAssignee(3, assigned.conversation);
    const text = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
    await relay.relay(message({ id: 102, content: text, conversation: assigned.conversation }));
    const [first, last] = forum.calls.slice(3).map(([, payload]) => payload);
    expect(first).toMatchObject({ content: "a".repeat(1500), allowed_mentions: { parse: [] } });
    expect(last).toMatchObject({
      content: `${"b".repeat(1500)}\n-# <@${TRIAGE}> <@592>`,
      allowed_mentions: { parse: [], users: ["592"] },
    });
  });

  it("keeps the notification lines before the truncation note of a very long message", async () => {
    ({ relay, forum } = relayWith({ triage, maxChunks: 2 }));
    const text = `${"x".repeat(1900)}\n`.repeat(4);
    await relay.relay(message({ content: text }));
    const replies = forum.contents().slice(1);
    expect(replies).toHaveLength(3);
    expect(replies[1]?.endsWith(`\n-# <@${TRIAGE}>`)).toBe(true);
    expect(replies[2]).toMatch(/^-# Message truncated/);
  });

  it("pings linked agents mentioned in a private note, where they are mentioned", async () => {
    const note = message({
      messageType: "outgoing",
      private: true,
      content: "[@Kim](mention://user/7/Kim) please check, cc [@Lee](mention://user/9/Lee)",
      sender: { name: "Sam", type: "user" },
      mentionedAgents: new Map([[7, "592"]]),
    });
    await relay.relay(note);
    expect(forum.calls.at(-1)?.[1]).toMatchObject({
      content: "🔒 **Internal note**\n<@592> please check, cc @Lee",
      allowed_mentions: { parse: [], users: ["592"] },
    });
  });

  it("renames the post when the contact's name changes, keeping the subject", async () => {
    await relay.relay(message());
    const renamed = message({ conversation: { contact: { name: "Jane Roe", email: "jane@example.com" } } });
    await relay.sync(3, renamed.conversation, "thread-1");
    await relay.sync(3, { ...renamed.conversation, status: "pending" }, "thread-1");
    expect(forum.patches).toEqual([
      ["thread-1", { ...tagsFor("open"), name: "[Acme #12] Jane Roe — My agent will not connect" }],
      ["thread-1", tagsFor("pending")], // the name is only sent when it changes
    ]);

    // A post this service did not title (adopted) keeps its title.
    const adopted = relayWith();
    adopted.store.updateConversation(3, 12, { threadId: "adopted-thread" });
    await adopted.relay.sync(3, renamed.conversation, "adopted-thread");
    expect(adopted.forum.patches).toEqual([["adopted-thread", tagsFor("open")]]);
  });
});

describe("the card", () => {
  /** The card's status line, and its buttons' custom ids by row. */
  const shown = (payload: WebhookMessage | undefined) => {
    const container = payload?.components?.[0];
    if (container?.type !== ComponentType.Container) return [];
    return container.components.map((part) => {
      if (part.type === ComponentType.TextDisplay) return part.content.split("\n").at(-1);
      if (part.type !== ComponentType.ActionRow) return undefined;
      return part.components.map((button) => ("custom_id" in button ? button.custom_id : undefined));
    });
  };

  it("is the post's last message: posted after the run's messages, edited on a change, and moved down after new messages", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = message().conversation;
    await relay.relay(message());
    await relay.sync(3, conversation, "thread-1");
    const [thread, card] = forum.calls.at(-1) ?? [];
    expect(thread).toBe("thread-1");
    expect(card).toMatchObject({ flags: 1 << 15, username: "Chatwoot", allowed_mentions: { parse: [] } });
    expect(card).not.toHaveProperty("content");
    // An overview of the ticket: it and its customer, how to reach them, and a link to Chatwoot.
    const container = card?.components?.[0];
    const text = container?.type === ComponentType.Container ? container.components[0] : undefined;
    expect(text?.type === ComponentType.TextDisplay && text.content).toBe(
      [
        "### Acme #12 · Jane Doe",
        "-# Live chat · jane@example.com · [Open in Chatwoot](<https://chatwoot.example.com/app/accounts/3/conversations/12>)",
        "🟢 **Open** · 👉 Unassigned",
      ].join("\n"),
    );
    expect(shown(card)).toEqual([
      "🟢 **Open** · 👉 Unassigned",
      ["ticket:reply"],
      ["ticket:take", "ticket:assign"],
      ["ticket:resolve", "ticket:snooze", "ticket:block", "ticket:manage"],
    ]);
    const cardId = forum.ids.at(-1);

    // Nothing changed: nothing is sent.
    const sent = forum.calls.length;
    await relay.sync(3, conversation, "thread-1");
    expect(forum.calls).toHaveLength(sent);
    expect(forum.edits).toEqual([]);

    // Snoozed and assigned: the card is edited in place.
    const snoozed = { ...conversation, status: "snoozed", assignee: { id: 7, name: "Kim" }, labels: ["billing"] };
    await relay.sync(3, snoozed, "thread-1");
    expect(forum.calls).toHaveLength(sent);
    expect(forum.edits.map(([id]) => id)).toEqual([cardId]);
    expect(shown(forum.edits[0]?.[1])).toEqual([
      "😴 **Snoozed** · 👉 **Kim** · 🏷️ billing",
      ["ticket:reply"],
      ["ticket:take", "ticket:assign"],
      ["ticket:reopen", "ticket:resolve", "ticket:block", "ticket:manage"],
    ]);

    // A new message: the card moves below it.
    await relay.relay(message({ id: 2, conversation: snoozed }));
    await relay.sync(3, snoozed, "thread-1");
    expect(forum.deleted).toEqual([cardId]);
    expect(forum.calls.at(-1)?.[1].flags).toBe(1 << 15);
    expect(forum.ids.at(-1)).not.toBe(cardId);
  });

  it("offers the triage bot's draft under its answer, until the customer writes again", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = message().conversation;
    await relay.relay(message());
    await relay.sync(3, conversation, "thread-1");
    const first = forum.ids.at(-1);

    const answer = snowflake();
    relay.answered(
      3,
      12,
      answer,
      forum.ids[forum.calls.findLastIndex(([, payload]) => payload.username === "Jane Doe")] ?? "",
    );
    await relay.sync(3, conversation, "thread-1");
    expect(forum.deleted).toEqual([first]);
    expect(shown(forum.calls.at(-1)?.[1])[1]).toEqual([`ticket:draft:${answer}`, "ticket:reply"]);

    await relay.relay(message({ id: 2 }));
    await relay.sync(3, conversation, "thread-1");
    expect(shown(forum.calls.at(-1)?.[1])[1]).toEqual(["ticket:reply"]);
  });

  it("is posted again when someone deleted it, and changed in a resolved post before it is archived again", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = message().conversation;
    await relay.relay(message());
    await relay.sync(3, conversation, "thread-1");
    const cardId = forum.ids.at(-1) ?? "";
    forum.deleted.push(cardId);

    await relay.sync(3, { ...conversation, status: "resolved" }, "thread-1");
    expect(shown(forum.calls.at(-1)?.[1])).toEqual([
      "✅ **Resolved** · 👉 Unassigned",
      ["ticket:reply"],
      ["ticket:take", "ticket:assign"],
      ["ticket:reopen", "ticket:block", "ticket:manage"],
    ]);
    expect(forum.archived.has("thread-1")).toBe(true);

    await relay.sync(3, { ...conversation, status: "open" }, "thread-1");
    expect(forum.edits).toHaveLength(1);
    expect(forum.archived.has("thread-1")).toBe(false);
  });

  it("does not replay a card when its creation response was lost", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = message().conversation;
    await relay.relay(message());
    forum.loseAnswer = true;
    await relay.sync(3, conversation, "thread-1");
    await relay.sync(3, conversation, "thread-1");
    expect(forum.calls.filter(([, payload]) => payload.flags === 1 << 15)).toHaveLength(1);
  });

  it("archives a resolved post again when that failed after its card moved", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = { ...message().conversation, status: "resolved" };
    await relay.relay(message({ conversation }));
    await relay.sync(3, conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);

    relay.answered(
      3,
      12,
      snowflake(),
      forum.ids[forum.calls.findLastIndex(([, payload]) => payload.username === "Jane Doe")] ?? "",
    );
    forum.failArchive = true;
    await expect(relay.sync(3, conversation, "thread-1")).rejects.toThrow();
    expect(forum.archived.has("thread-1")).toBe(false);
    await relay.sync(3, conversation, "thread-1");
    expect(forum.archived.has("thread-1")).toBe(true);
  });

  it("offers only the latest draft that answers the customer's latest message, however receipts come", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = message().conversation;
    const draftOffered = () => shown(forum.calls.at(-1)?.[1])[1]?.[0];
    const latest = () => forum.ids[forum.calls.findLastIndex(([, payload]) => payload.username === "Jane Doe")] ?? "";
    await relay.relay(message());
    const first = latest();
    const older = snowflake();
    const newer = snowflake();
    relay.answered(3, 12, newer, first);
    relay.answered(3, 12, older, first); // out of order: ignored
    await relay.sync(3, conversation, "thread-1");
    expect(draftOffered()).toBe(`ticket:draft:${newer}`);

    // The customer writes again, then an answer to their first message comes: it is behind them.
    await relay.relay(message({ id: 2 }));
    relay.answered(3, 12, snowflake(), first);
    await relay.sync(3, conversation, "thread-1");
    expect(draftOffered()).toBe("ticket:reply");

    // A retry of the first message posts nothing, and does not take the customer's latest back.
    const second = latest();
    await relay.relay(message());
    expect(latest()).toBe(second);

    // An answer to the latest message is offered; a response to a form puts it behind them again.
    const answer = snowflake();
    relay.answered(3, 12, answer, second);
    await relay.sync(3, conversation, "thread-1");
    expect(draftOffered()).toBe(`ticket:draft:${answer}`);
    await relay.postResponse(3, conversation, "• Rating: 5", "response-5");
    await relay.sync(3, conversation, "thread-1");
    expect(draftOffered()).toBe("ticket:reply");
  });

  it("keeps drafts to a customer message's parts right when a part fails", async () => {
    const { relay, forum } = relayWith({ card: ticketCard });
    const conversation = message().conversation;
    const draftOffered = () => shown(forum.calls.at(-1)?.[1])[1]?.[0];
    const long = `${"x".repeat(1900)}\n`.repeat(2);
    await relay.relay(message());
    const first = forum.ids[forum.calls.findLastIndex(([, payload]) => payload.username === "Jane Doe")] ?? "";
    relay.answered(3, 12, snowflake(), first);
    await relay.sync(3, conversation, "thread-1");

    // C2's first part is posted, its second fails: the answer to C1 is behind the customer now.
    forum.failAfter = 1;
    await expect(relay.relay(message({ id: 2, content: long }))).rejects.toThrow();
    await relay.sync(3, conversation, "thread-1");
    expect(draftOffered()).toBe("ticket:reply");

    // A response comes, then C2's last part: an answer to that part answers C2, before the response.
    await relay.postResponse(3, conversation, "• Rating: 5", "response-5");
    await relay.relay(message({ id: 2, content: long }));
    const lastPart = forum.ids.at(-1) ?? "";
    relay.answered(3, 12, snowflake(), lastPart);
    await relay.sync(3, conversation, "thread-1");
    expect(draftOffered()).toBe("ticket:reply");
  });
});
