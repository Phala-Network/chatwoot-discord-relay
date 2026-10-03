import {
  type APIInteraction,
  type APIInteractionResponse,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
} from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILED } from "../src/commands/common.ts";
import { COMMANDS, REPLY_WITH_THIS } from "../src/commands/definitions.ts";
import type { Draft } from "../src/commands/draft.ts";
import { type HandlerResult, handleInteraction } from "../src/commands/handler.ts";
import { ALICE, BOB, CAROL, TRIAGE, testSettings } from "./helpers.ts";

const THREAD = "100000000000001500";
const settings = testSettings();
const ANSWER = "100000000000009100";
let draft: Draft = { text: "Hi, restart the CVM from the dashboard." };
const deps = {
  settings,
  ticketForThread: async (threadId: string) => (threadId === THREAD ? { accountId: 3, conversationId: 15 } : undefined),
  draftOf: async (threadId: string, answerId: string) =>
    threadId === THREAD && answerId === ANSWER ? draft : { missing: "none" as const },
};

/** A ticket button pressed, or a panel menu changed, in the post. */
function press(customId: string, values?: string[], message: Record<string, unknown> = {}) {
  return handleInteraction(
    JSON.parse(
      JSON.stringify({
        id: "777001",
        application_id: "100000000000000001",
        token: "interaction-token",
        type: 3,
        channel_id: THREAD,
        channel: { id: THREAD, type: 11 },
        member: { user: { id: ALICE } },
        message: { id: "900", components: [], ...message },
        data: values ? { custom_id: customId, component_type: 3, values } : { custom_id: customId, component_type: 2 },
      }),
    ),
    deps,
  );
}

function interaction(fields: {
  type?: number;
  name?: string;
  options?: unknown[];
  user?: string;
  channel?: string;
  data?: Record<string, unknown>;
}): APIInteraction {
  const channel = fields.channel ?? THREAD;
  // Built as plain JSON, the way the Worker receives it after signature verification.
  return JSON.parse(
    JSON.stringify({
      id: "777001",
      application_id: "100000000000000001",
      token: "interaction-token",
      type: fields.type ?? 2,
      channel_id: channel,
      channel: { id: channel, type: 11 },
      member: { user: { id: fields.user ?? ALICE } },
      data: { type: 1, name: fields.name, options: fields.options ?? [], ...fields.data },
    }),
  );
}

function submission(kind: string, text = "", files: Record<string, unknown> = {}, fromMe?: boolean) {
  return interaction({
    type: 5,
    data: {
      custom_id: `${kind}:9001`,
      components: [
        { type: 18, component: { type: 4, custom_id: "content:9001", value: text } },
        { type: 18, component: { type: 19, custom_id: "files:9001", values: Object.keys(files) } },
        ...(fromMe === undefined ? [] : [{ type: 18, component: { type: 23, custom_id: "from:9001", value: fromMe } }]),
      ],
      resolved: { attachments: files },
    },
  });
}

function privateText(result: HandlerResult): string | undefined {
  const response = result.response;
  expect(response.type).toBe(InteractionResponseType.ChannelMessageWithSource);
  if (response.type !== InteractionResponseType.ChannelMessageWithSource) return undefined;
  expect(response.data.flags).toBe(MessageFlags.Ephemeral);
  expect(result.job).toBeUndefined();
  return response.data.content;
}

function editorField(response: APIInteractionResponse, prefix: string): Record<string, unknown> | undefined {
  if (response.type !== InteractionResponseType.Modal) return undefined;
  for (const label of response.data.components) {
    if (label.type !== ComponentType.Label) continue;
    const component: Record<string, unknown> = { ...label.component };
    if (String(component.custom_id).startsWith(`${prefix}:`)) return component;
  }
  return undefined;
}

function menu(content: string, author = TRIAGE) {
  return handleInteraction(
    interaction({
      name: REPLY_WITH_THIS,
      data: { type: 3, target_id: "77", resolved: { messages: { "77": { content, author: { id: author } } } } },
    }),
    deps,
  );
}

afterEach(() => vi.useRealTimers());

describe("interaction handler", () => {
  it("answers Discord's ping", async () => {
    expect((await handleInteraction(JSON.parse('{"type":1}'), deps)).response).toEqual({ type: 1 });
  });

  it("/reply opens an empty editor with ids unique to the interaction", async () => {
    const { response, job } = await handleInteraction(interaction({ name: "reply" }), deps);
    expect(job).toBeUndefined();
    expect(response.type).toBe(InteractionResponseType.Modal);
    if (response.type !== InteractionResponseType.Modal) return;
    expect(response.data.custom_id).toBe("reply:777001");
    expect(response.data.title).toBe("Reply · Acme #15");
    expect(editorField(response, "content")).toMatchObject({ custom_id: "content:777001", style: 2, max_length: 4000 });
    expect(editorField(response, "content")).not.toHaveProperty("value");
    // Sending from the agent's own address needs a Chatwoot build that can (chatwoot.sendAsAgent).
    expect(editorField(response, "from")).toBeUndefined();
    const sendingAsAgent = {
      ...deps,
      settings: testSettings({ chatwoot: { baseUrl: "https://chatwoot.example.com", sendAsAgent: true } }),
    };
    const offering = (await handleInteraction(interaction({ name: "reply" }), sendingAsAgent)).response;
    expect(offering.type).toBe(InteractionResponseType.Modal);
    if (offering.type !== InteractionResponseType.Modal) return;
    expect(editorField(offering, "from")).toEqual({ type: 23, custom_id: "from:777001" });
    expect(editorField(response, "files")).toEqual({
      type: 19,
      custom_id: "files:777001",
      min_values: 0,
      max_values: 10,
      required: false,
    });
  });

  it("/reply and /note send an inline message or attachment at once, without the editor", async () => {
    const file = {
      id: "900",
      filename: "log.txt",
      content_type: "text/plain",
      size: 64,
      url: "https://cdn.discordapp.com/l.txt",
    };
    const quick = (name: string, options: unknown[]) =>
      handleInteraction(interaction({ name, options, data: { resolved: { attachments: { "900": file } } } }), deps);
    const text = { name: "message", type: 3, value: " Thanks, fixed now! " };
    const attachment = { name: "attachment", type: 11, value: "900" };
    const ref = { url: file.url, filename: "log.txt", size: 64, contentType: "text/plain" };

    const reply = await quick("reply", [text]);
    expect(reply.response).toEqual({ type: 5, data: { flags: MessageFlags.Ephemeral } });
    expect(reply.job?.action).toEqual({ type: "message", private: false, content: "Thanks, fixed now!", files: [] });
    expect((await quick("note", [attachment])).job?.action).toEqual({
      type: "message",
      private: true,
      content: "",
      files: [ref],
    });
    expect((await quick("reply", [text, attachment])).job?.action).toEqual({
      type: "message",
      private: false,
      content: "Thanks, fixed now!",
      files: [ref],
    });
  });

  it("checks inline messages and attachments like the editor does", async () => {
    const quick = (options: unknown[], attachments: Record<string, unknown> = {}) =>
      handleInteraction(interaction({ name: "reply", options, data: { resolved: { attachments } } }), deps);
    expect(privateText(await quick([{ name: "message", type: 3, value: "  " }]))).toBe(
      "❌ Add a message or an attachment.",
    );
    const big = { id: "901", filename: "v.mp4", size: 26 * 1024 * 1024, url: "https://cdn.discordapp.com/v.mp4" };
    expect(privateText(await quick([{ name: "attachment", type: 11, value: "901" }], { "901": big }))).toMatch(
      /25 MB or smaller/,
    );
    const elsewhere = { id: "902", filename: "a.txt", size: 1, url: "https://files.example.com/a.txt" };
    expect(privateText(await quick([{ name: "attachment", type: 11, value: "902" }], { "902": elsewhere }))).toMatch(
      /uploaded in Discord/,
    );
    expect(privateText(await quick([{ name: "attachment", type: 11, value: "903" }]))).toMatch(/could not be read/);
  });

  it("/note opens the private-note editor", async () => {
    const { response } = await handleInteraction(interaction({ name: "note" }), deps);
    expect(response.type === InteractionResponseType.Modal && response.data.custom_id).toBe("note:777001");
    expect(editorField(response, "from")).toBeUndefined();
  });

  it("'Reply with this' takes the last code block of a triage bot message, whatever its headings", async () => {
    const triage =
      "**总结**: wants account deletion\n```\ncli conv 15\n```\n**回复**:\n```text\nHi, delete it in Settings.\n```\n**下一步**: /resolve";
    const { response } = await menu(triage);
    expect(response.type === InteractionResponseType.Modal && response.data.custom_id).toBe("reply:777001");
    expect(editorField(response, "content")?.value).toBe("Hi, delete it in Settings.");
  });

  it("'Reply with this' explains when a triage message has no draft (no code block)", async () => {
    expect(privateText(await menu("疑似垃圾：广告。建议 /block"))).toMatch(/no draft/);
  });

  it("'Reply with this' keeps blank lines in the draft editor", async () => {
    expect(editorField((await menu("**Draft**:\n\n```\nHi there,\n\nThanks!\n```")).response, "content")?.value).toBe(
      "Hi there,\n\nThanks!",
    );
  });

  it("'Reply with this' uses the last code block or the whole text from anyone else", async () => {
    const colleague = "Try this:\n```\nold\n```\nor\n```\nHi, please log in again.\n```";
    expect(editorField((await menu(colleague, BOB)).response, "content")?.value).toBe("Hi, please log in again.");
    expect(editorField((await menu(" Thanks for waiting! ", BOB)).response, "content")?.value).toBe(
      "Thanks for waiting!",
    );
  });

  it("keeps CommonMark fences, nested code and inline text intact in the draft editor", async () => {
    const draft = "Run this:\n```sh\nagent restart\n```\nThen try again.";
    const examples = [
      { source: `**Draft**:\n\`\`\`\`\n${draft}\n\`\`\`\`\n-# done`, expected: draft },
      { source: `Draft:\n~~~text\n${draft}\n~~~~\nafter`, expected: draft },
      { source: "   ```\n   Hi,\n    indented\n   ```", expected: "Hi,\n indented" },
      { source: "```\nHi there", expected: "Hi there" },
      { source: "Use ```this``` inline", expected: "Use ```this``` inline" },
    ];
    for (const example of examples) {
      expect(editorField((await menu(example.source, BOB)).response, "content")?.value).toBe(example.expected);
    }
  });

  it("registers the slash commands and the message command", () => {
    expect(COMMANDS.filter((command) => command.type === 1).map((command) => command.name)).toEqual([
      "reply",
      "note",
      "resolve",
      "reopen",
      "pending",
      "snooze",
      "priority",
      "assign",
      "unassign",
      "label",
      "block",
      "unblock",
    ]);
    for (const name of ["reply", "note"]) {
      const command = COMMANDS.find((candidate) => candidate.name === name);
      expect(command && "options" in command ? command.options : undefined).toEqual([
        expect.objectContaining({ type: 3, name: "message", max_length: 4000 }),
        expect.objectContaining({ type: 11, name: "attachment" }),
      ]);
    }
    const menuCommands = COMMANDS.filter((command) => command.type === 3);
    expect(menuCommands.map((command) => command.name)).toEqual([REPLY_WITH_THIS]);
    expect(menuCommands[0]).not.toHaveProperty("description");
  });

  it("submitting a reply defers a job that sends as the invoker", async () => {
    const { response, job } = await handleInteraction(submission("reply", " Thanks! "), deps);
    expect(response).toEqual({ type: 5, data: { flags: MessageFlags.Ephemeral } });
    expect(job).toMatchObject({
      discordUserId: ALICE,
      accountId: 3,
      conversationId: 15,
      token: "interaction-token",
      action: { type: "message", private: false, content: "Thanks!", files: [] },
    });
  });

  it("a reply can be sent from the agent's own address; unticked, it is not", async () => {
    expect((await handleInteraction(submission("reply", "Hi", {}, true), deps)).job?.action).toEqual({
      type: "message",
      private: false,
      content: "Hi",
      files: [],
      sendAsAgent: true,
    });
    expect((await handleInteraction(submission("reply", "Hi", {}, false), deps)).job?.action).not.toHaveProperty(
      "sendAsAgent",
    );
  });

  it("a note submission is private", async () => {
    const { job } = await handleInteraction(submission("note", "Refund approved"), deps);
    expect(job?.action).toEqual({ type: "message", private: true, content: "Refund approved", files: [] });
  });

  it("rejects an empty submission", async () => {
    expect(privateText(await handleInteraction(submission("reply", " "), deps))).toBe(
      "❌ Add a message or an attachment.",
    );
  });

  it("passes uploaded files to the job", async () => {
    const files = {
      "900": {
        id: "900",
        filename: "screenshot.png",
        content_type: "image/png",
        size: 1024,
        url: "https://cdn.discordapp.com/a.png",
      },
    };
    const { job } = await handleInteraction(submission("reply", "", files), deps);
    expect(job?.action).toEqual({
      type: "message",
      private: false,
      content: "",
      files: [
        { url: "https://cdn.discordapp.com/a.png", filename: "screenshot.png", size: 1024, contentType: "image/png" },
      ],
    });
  });

  it("rejects oversized attachments and non-Discord URLs up front", async () => {
    const big = { "902": { filename: "video.mp4", size: 26 * 1024 * 1024, url: "https://cdn.discordapp.com/v.mp4" } };
    expect(privateText(await handleInteraction(submission("reply", "see video", big), deps))).toMatch(
      /25 MB or smaller/,
    );
    const elsewhere = { "903": { filename: "a.txt", size: 10, url: "https://files.example.com/a.txt" } };
    expect(privateText(await handleInteraction(submission("reply", "x", elsewhere), deps))).toMatch(
      /uploaded in Discord/,
    );
  });

  it("status commands and /block are deferred jobs", async () => {
    expect((await handleInteraction(interaction({ name: "resolve" }), deps)).job?.action).toEqual({
      type: "status",
      status: "resolved",
    });
    expect((await handleInteraction(interaction({ name: "reopen" }), deps)).job?.action).toEqual({
      type: "status",
      status: "open",
    });
    expect((await handleInteraction(interaction({ name: "block" }), deps)).job?.action).toEqual({ type: "block" });
    expect((await handleInteraction(interaction({ name: "unblock" }), deps)).job?.action).toEqual({
      type: "unblock",
    });
    expect((await handleInteraction(interaction({ name: "pending" }), deps)).job?.action).toEqual({
      type: "status",
      status: "pending",
    });
    expect(privateText(await handleInteraction(interaction({ name: "labels" }), deps))).toBe("Unknown command.");
  });

  it("/snooze defaults to the next reply and computes 'an hour from now' when it is used", async () => {
    expect((await handleInteraction(interaction({ name: "snooze" }), deps)).job?.action).toEqual({
      type: "status",
      status: "snoozed",
    });
    const until = (value: string) =>
      handleInteraction(interaction({ name: "snooze", options: [{ name: "until", type: 3, value }] }), deps);
    expect((await until("until_next_reply")).job?.action).toEqual({ type: "status", status: "snoozed" });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T16:30:45.900Z"));
    expect((await until("an_hour_from_now")).job?.action).toEqual({
      type: "status",
      status: "snoozed",
      snoozedUntil: Date.parse("2026-09-27T17:30:45Z") / 1000,
    });
    expect(privateText(await until("until_tomorrow"))).toBe("❌ Choose a snooze option from the list.");
  });

  it("/priority maps each choice, and 'none' clears the priority", async () => {
    const level = (value: string) =>
      handleInteraction(interaction({ name: "priority", options: [{ name: "level", type: 3, value }] }), deps);
    for (const priority of ["urgent", "high", "medium", "low"]) {
      expect((await level(priority)).job?.action).toEqual({ type: "priority", priority });
    }
    expect((await level("none")).job?.action).toEqual({ type: "priority", priority: null });
    expect(privateText(await level("critical"))).toBe("❌ Choose a priority from the list.");
  });

  it("/assign defaults to the invoker and maps other Discord users", async () => {
    expect((await handleInteraction(interaction({ name: "assign" }), deps)).job?.action).toEqual({
      type: "assign",
      chatwootUserId: 42,
    });
    const other = interaction({ name: "assign", options: [{ name: "agent", type: 6, value: BOB }] });
    expect((await handleInteraction(other, deps)).job?.action).toEqual({ type: "assign", chatwootUserId: 43 });
    const stranger = interaction({
      name: "assign",
      options: [{ name: "agent", type: 6, value: "100000000000000042" }],
    });
    expect(privateText(await handleInteraction(stranger, deps))).toBe(
      "❌ That Discord user is not linked to a Chatwoot agent.",
    );
  });

  it("/unassign and /label are deferred jobs; a label is named in lower case", async () => {
    expect((await handleInteraction(interaction({ name: "unassign" }), deps)).job?.action).toEqual({
      type: "unassign",
    });
    const label = (change: string, value: string) =>
      interaction({
        name: "label",
        options: [{ type: 1, name: change, options: [{ type: 3, name: "label", value }] }],
      });
    expect((await handleInteraction(label("add", " VIP "), deps)).job?.action).toEqual({
      type: "label",
      change: "add",
      label: "vip",
    });
    expect((await handleInteraction(label("remove", "refund"), deps)).job?.action).toEqual({
      type: "label",
      change: "remove",
      label: "refund",
    });
    expect(privateText(await handleInteraction(label("add", "  "), deps))).toBe("❌ Name a label.");
  });

  it("refuses unlinked users and channels that are not mapped tickets", async () => {
    const notLinked = "Your Discord account is not linked to a Chatwoot agent.";
    expect(
      privateText(await handleInteraction(interaction({ name: "resolve", user: "100000000000000099" }), deps)),
    ).toBe(notLinked);
    // Linked but without a Chatwoot token secret.
    expect(privateText(await handleInteraction(interaction({ name: "resolve", user: CAROL }), deps))).toBe(notLinked);
    // The ticket comes from the relay's mapping, never from the post title.
    expect(
      privateText(await handleInteraction(interaction({ name: "resolve", channel: "100000000000009999" }), deps)),
    ).toMatch(/inside a ticket post/);
  });

  it("exposes a generic failure message", () => {
    expect(FAILED).toBe("❌ That did not work. Please do it in Chatwoot.");
  });
});

describe("ticket buttons and the Manage panel", () => {
  it("Write reply opens the editor; Reply with draft opens it with the draft of the answer it is under", async () => {
    const { response } = await press("ticket:reply");
    expect(response.type === InteractionResponseType.Modal && response.data.custom_id).toBe("reply:777001");
    expect(editorField(response, "content")).not.toHaveProperty("value");
    expect(editorField((await press(`ticket:draft:${ANSWER}`)).response, "content")?.value).toBe(
      "Hi, restart the CVM from the dashboard.",
    );
  });

  it("Reply with draft says when the answer has no draft, and links one it cannot read for Reply with this", async () => {
    draft = { missing: "none" };
    expect(privateText(await press(`ticket:draft:${ANSWER}`))).toMatch(/has no draft/);
    draft = { missing: "unreadable" };
    expect(privateText(await press(`ticket:draft:${ANSWER}`))).toMatch(
      new RegExp(
        `no longer stored here.*\\(https://discord\\.com/channels/[^/]+/${THREAD}/${ANSWER}\\).*Reply with this`,
      ),
    );
    draft = { text: "Hi, restart the CVM from the dashboard." };
    expect(privateText(await press("ticket:draft:not-an-id"))).toMatch(/Unknown button/);
  });

  it("Take assigns the invoker, Resolve resolves, Manage draws the panel, each answered privately", async () => {
    const deferred = {
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    };
    const take = await press("ticket:take");
    expect(take.response).toEqual(deferred);
    expect(take.job?.action).toEqual({ type: "assign", chatwootUserId: 42 });
    expect((await press("ticket:resolve")).job?.action).toEqual({ type: "status", status: "resolved" });
    expect((await press("ticket:reopen")).job?.action).toEqual({ type: "status", status: "open" });
    const manage = await press("ticket:manage");
    expect(manage.job?.action).toEqual({ type: "panel" });
    expect(manage.job).not.toHaveProperty("panel");
    expect((await press("ticket:snooze")).job?.action).toEqual({ type: "status", status: "snoozed" });
  });

  it("Assign to shows a menu of agents; choosing one turns the menu into the result", async () => {
    expect((await press("ticket:assign")).job?.action).toEqual({ type: "pick-assignee" });
    const chosen = await press("ticket:assignee", ["43"]);
    expect(chosen.response).toEqual({
      type: InteractionResponseType.UpdateMessage,
      data: { content: "⏳ Assigning…", components: [] },
    });
    expect(chosen.job?.action).toEqual({ type: "assign", chatwootUserId: 43 });
    expect(chosen.job).not.toHaveProperty("panel");
    expect((await press("ticket:assignee", [":none"])).job?.action).toEqual({ type: "unassign" });
  });

  it("Block asks first; confirming turns the question into the result", async () => {
    const asked = await press("ticket:block");
    expect(asked.job).toBeUndefined();
    expect(asked.response).toMatchObject({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral, components: [{ components: [{ custom_id: "ticket:block-confirmed" }] }] },
    });
    const confirmed = await press("ticket:block-confirmed");
    expect(confirmed.response).toEqual({
      type: InteractionResponseType.UpdateMessage,
      data: { content: "⏳ Blocking…", components: [] },
    });
    expect(confirmed.job?.action).toEqual({ type: "block" });
  });

  it("a panel change updates the panel in place", async () => {
    const assign = await press("panel:assignee", ["43"]);
    expect(assign.response).toEqual({ type: InteractionResponseType.DeferredMessageUpdate });
    expect(assign.job).toMatchObject({ action: { type: "assign", chatwootUserId: 43 }, panel: true });
    expect((await press("panel:assignee", [":none"])).job?.action).toEqual({ type: "unassign" });
    const resolve = await press("panel:status:resolved");
    expect(resolve.response).toEqual({ type: InteractionResponseType.DeferredMessageUpdate });
    expect(resolve.job).toMatchObject({ action: { type: "status", status: "resolved" }, panel: true });
    expect((await press("panel:status:until_next_reply")).job?.action).toEqual({ type: "status", status: "snoozed" });
  });

  it("the label menu gives the ticket one label, or none", async () => {
    expect((await press("panel:labels", ["billing"])).job?.action).toEqual({ type: "labels", labels: ["billing"] });
    expect((await press("panel:labels", [":none"])).job?.action).toEqual({ type: "labels", labels: [] });
    // A label may be called "none": it is a label, not "no label".
    expect((await press("panel:labels", ["none"])).job?.action).toEqual({ type: "labels", labels: ["none"] });
  });

  it("refuses a menu value that is not in it", async () => {
    expect(privateText(await press("panel:assignee", ["everyone"]))).toMatch(/Choose an agent/);
    expect(privateText(await press("panel:status:forever"))).toMatch(/snooze option/);
  });
});
