# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Bound Hub work with per-operation deadlines and persisted continuations. Persist rate-limit cooldowns without sleeping, page hourly digests, prioritize live messages with aging, and refresh decorative metadata outside the message path.
- Separate command execution from retryable feedback and card convergence; retain unknown send outcomes without replay. Use one bounded durable interaction RPC and only persisted drafts for modals. Keep the deployed Hub namespace, cursor and hold state intact; the attachment table and assignee-notice receipt column are added without moving existing state.
- Simplify the native-status design: inline the relay-only sweep continuation, remove its one-page loop and thin
  alarm, payload, escalation, panel and notice wrappers. Keep pending holding, answering-reply pagination, queue
  pings and Discord effects unchanged; log unavailable failure notices.
- Remove unused inbox-list API and custom-attribute wrapper from the shared client; message creation now exposes
  a validated Chatwoot receipt for the router while relay commands continue to use HTTP success.
- Document waiting for router disconnect handoff before stopping it and restoring the recorded rollback baseline.

## [0.30.0] - 2026-10-03

### Changed

- Works with chatwoot-router 0.2.0, which routes as each inbox's Chatwoot agent bot: Chatwoot's status replaces the
  `routing_*` attributes. A customer message of a `pending` conversation in a bot inbox is posted once the bot is done
  with it; the triage bot is called only if the conversation is then open and the message unanswered (a public reply
  answers it; a private note, a failed reply, a template, or an automatic email reply does not). A conversation the bot
  resolved or snoozed reaches no triage bot. The support queue lists `pending` tickets marked 🤖, without pings.
- A bot assignee is no person: no ping, no assignee tag, "Unassigned" in the card and the queue. `/pending` in a bot
  inbox hands the ticket back to the bot.
- `router.accounts` and `router.waitSeconds` are gone; `router.keepLabels` should list every kind label.

### Upgrade

- Remove `router.accounts` and `router.waitSeconds`, list every kind in `router.keepLabels`, and deploy this relay
  before chatwoot-router 0.2.0. Keep the Worker's name.
- `relay.subrequestBudget` must now be at least `relay.maxChunks` + 30 (was + 28), and with `queue` at least
  6 × accounts + 4 (was 5 × accounts + 4): a run reads more to tell a bot's turn. The default 45 fits up to 6 accounts
  with the queue; raise it otherwise, or startup fails (`/healthz` 503).
- A lost `message_updated` webhook can cause at most one extra triage call for the affected message (see the README).

## [0.29.0] - 2026-10-02

### Changed

- Routing moves to
  [`chatwoot-router`](https://github.com/Phala-Network/chatwoot-workers/tree/main/packages/chatwoot-router), a Worker
  of its own in the same repository, now `chatwoot-workers`. The relay no longer accepts `routing`,
  `TYPESAFE_API_KEY`, or `CHATWOOT_BOT_TOKENS`; with `router.accounts` (and `router.waitSeconds`, default 30), a new
  customer message waits for the router's decision (`routing_seen`) before calling the triage bot, and one a kind
  handled (`routing_handled`) does not call it. The Manage card keeps the kind label (`routing_kind`) and the labels
  in `router.keepLabels`. To upgrade, deploy this relay first, so the two never both route; then deploy
  chatwoot-router with your old `routing` configuration and secrets (the relay's `CHATWOOT_RELAY_TOKEN` value as its
  `CHATWOOT_TOKEN`; the relay keeps its own), `startAfterConversationId` set to each routed account's newest
  conversation id, its Chatwoot webhook, and the conversation attributes `routing_seen` and `routing_handled` (Number)
  and `routing_kind` (Text) (see its README).
- New deployments name the Worker `chatwoot-discord-relay`. An existing deployment keeps its Worker `name`: a new
  name is a new Worker, without the Hub's state. A checkout deploys from `packages/chatwoot-discord-relay`, after
  `npm ci` at the repository root.
- Every configured account needs a webhook secret (`/healthz` answers 503 otherwise), and `relay.linkAttribute` may
  not be one of the routing attributes.

### Fixed

- A sync rewrites the post link attribute when it is missing or wrong (another Worker's concurrent save of the
  conversation's attributes can drop it).

## [0.28.0] - 2026-10-02

### Changed

- Built and deployed with the [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`cf`) and Vite instead of
  the legacy Cloudflare CLI: `cloudflare.config.ts` replaces the legacy JSON configuration, `npm run dev`, `build`, and `deploy` run `cf`, and
  secrets are uploaded with `npx cf deploy --secrets-file <file>`. To upgrade a deployment from a checkout, move your
  `CONFIG` from the legacy JSON configuration into `cloudflare.config.ts` and deploy with `npx cf deploy`: the Worker keeps its
  secrets and its Hub Durable Object. A deploy now fails while a required secret is not set. The Deploy to Cloudflare
  button is gone, as it needs a legacy CLI configuration: deploy a copy made with it from a checkout or from CI (see
  [Use cf in CI](https://developers.cloudflare.com/cf/ci/)). A deployment from a repository of your own can build with
  Vite instead of the legacy Cloudflare CLI with `vite`, `@cloudflare/vite-plugin`, and a `vite.config.ts` (see the README).

### Fixed

- Routing redacts IPv6 addresses too (with [`ip-regex`](https://github.com/sindresorhus/ip-regex), which also
  matches IPv4) before the text goes to TypeSafe.
- The package's `bin` path has no leading `./`: `npm publish` rewrote it with a warning that it was
  "invalid and removed", though the command was published. CI now fails when `npm pkg fix` would change
  `package.json`, and runs the installed command.

## [0.27.0] - 2026-10-01

### Added

- Published to npm as [`chatwoot-discord-relay`](https://www.npmjs.com/package/chatwoot-discord-relay) from
  each GitHub release, with trusted publishing and provenance, so a deployment can live in a repository
  of its own: the package exports the Worker (`default`, `Hub`), `storedConfig`
  (`chatwoot-discord-relay/stored-config`), and the `chatwoot-discord-store-config` command.

## [0.26.0] - 2026-10-01

### Changed

- `routing.snoozeUnclear` snoozes only a ticket in which the customer asked for nothing yet (Jev is
  also asked whether there is a request): a real question that no owner covers stays open for a
  person instead of waiting, snoozed, for a message the customer will not send.

## [0.25.0] - 2026-10-01

### Changed

- A customer message a routing kind set aside (spam) does not call the triage bot either; the note
  says "handled automatically", and every account whose kinds act waits for routing before relaying.
- An agent bot's messages (a routing kind's reply) show the bot's https avatar in Chatwoot (set it
  in Settings → Bots) instead of the Chatwoot avatar.

## [0.24.0] - 2026-09-30

### Changed

- A routing kind may have both `cannedResponse` and `status`: it replies, then sets the ticket aside
  (for example a templated security report: acknowledged, then resolved).

## [0.23.0] - 2026-09-30

### Changed

- A customer message a routing kind's reply answered does not call the triage bot; a note says so,
  and the customer's next message calls it as usual. In an account whose kinds reply, a ticket's new
  customer message waits while the ticket's routing is queued (and has not failed), up to 30 seconds
  after it was queued; otherwise it is relayed with the mention as before.

## [0.22.0] - 2026-09-30

### Added

- A configuration larger than the 5 KB a Worker var holds can live in a KV namespace bound as
  `CONFIG_STORE`, under the key in the `CONFIG_KEY` var. `storedConfig` (scripts/stored-config.ts)
  validates a configuration file (JSON with comments) and derives its key from its content, for a
  deployment's `cloudflare.config.ts`; `npm run store-config` stores it with the Cloudflare CLI
  (`cf`, now a dev dependency).

### Changed

- **Breaking:** a routing kind replies with a Chatwoot canned response, `cannedResponse: "<short
  code>"`, instead of a fixed `reply` text: it is edited in Chatwoot, can use Chatwoot's variables,
  and nothing is sent while it does not exist.

## [0.21.0] - 2026-09-30

### Added

- `routing.kinds`: per account, kinds of ticket Jev recognizes along with the owner and topic,
  added as labels of a second family beside the one topic label (the Manage card's label menu
  sets the topic and keeps them), and what is done once when it is confident: `reply` sends a fixed text to the customer as the
  account's Chatwoot agent bot, under its name (new secret `CHATWOOT_BOT_TOKENS`; at most once per
  ticket), and `status` sets the ticket aside (resolved, or
  snoozed until the customer's next message) instead of routing it, without blocking its contact.

## [0.20.1] - 2026-09-30

### Changed

- The card's answering buttons say what they do: **Reply with draft** (was Use draft) and
  **Write reply** (was Reply), alongside the message command **Reply with this**.

### Changed

- The README describes the sweep's one page per job.
- Tests fail on any request no mocked route answers, and cover a command that comes during a
  sweep running before the sweep's next page.

## [0.20.0] - 2026-09-30

### Changed

- **Breaking:** the reply editor's **Send from my email address** is offered only with the new
  `chatwoot.sendAsAgent` (default `false`), for a Chatwoot build that reads
  `content_attributes.send_as_agent`; standard Chatwoot ignores it.
- A sweep job reads one page of conversations, so a command waiting runs between pages instead
  of after the whole pass; the card backfill runs once per pass. Jobs taking over five seconds,
  and commands that waited as long, are logged.
- Opening Manage or the assignee menu no longer syncs the post (they change nothing).
- A label too long for the Manage menu is to be changed in Chatwoot (the placeholder said
  `/label`, which takes at most 100 characters).
- Documentation: Use draft needs no Message Content intent; commands run at most once (only
  background jobs retry until they succeed); the AI agent guide describes the hook.

## [0.19.1] - 2026-09-30

### Fixed

- A change made with a button or command shows on the post's card and tags at once, instead of
  with Chatwoot's event for it, which waits ten seconds for the change's activity line.
- A post deleted in Discord is recognized when Discord answers with Unknown Channel (HTTP 400
  for a webhook), so its jobs no longer retry forever.

## [0.19.0] - 2026-09-30

### Changed

- **One card per post, at its bottom, showing the ticket as it is.** Instead of buttons under
  every message, a post ends with the ticket's card, coloured by its status: an overview (the
  ticket and its customer, the channel, the customer's email or phone number, a link to
  Chatwoot, the status, the assignee, and the labels), and the buttons, which follow the ticket: **Assign to…**
  is named after the assignee, and **Reopen** replaces **Snooze** while the ticket is snoozed and
  both **Resolve** and **Snooze** once it is resolved. The card is edited when the ticket changes
  and moves to the bottom when the relay posts messages. After a triage bot's answer with a
  draft, it moves under the answer and is led by **Use draft** until the customer writes again;
  a receipt for an earlier answer, or for an answer to an earlier message, changes nothing. When
  Discord's answer to posting a card is lost, or a post is adopted, the post's cards are looked
  for (after the moment of posting, or from the post's start) and deleted before one is posted. The sweep gives posts from
  before cards theirs, a few at a time, while their ticket is not resolved; buttons under older
  messages keep working.
- **Breaking:** the triage bot hook (`POST /triage/answered`) also takes `replyTo`, the message
  the answer replies to.
- The post's opening message is called the ticket header in the documentation.
- Webhook messages are sent with `with_components=true`, as Discord documents for components.

### Added

- **Reopen** button.

## [0.18.1] - 2026-09-30

### Changed

- Only the first ticket button (**Reply**, or **Use draft**) is coloured; the others are grey, so
  their emoji stay visible. **Assign to…** shows 👉 and **Snooze** 😴 (instead of emoji too dark
  to see on grey).

## [0.18.0] - 2026-09-30

### Changed

- The ticket buttons are three rows: answering (**Reply**), who owns the ticket (**Take**,
  **Assign to…**), and its state (**Resolve**, **Snooze**, **Block**, **Manage**), under every
  message again, the customer's included.
- **Breaking:** the triage bot hook (`POST /triage/answered`) takes
  `{"threadId", "answerId", "draft"}` and is called once the answer is in the post: the Worker
  keeps the draft and posts the ticket buttons, led by **Use draft** (highlighted), right under
  that answer, at once and once per answer. **Use draft** takes the draft the hook sent, else reads the answer
  (Message Content intent), else links to it for **Reply with this**.
- Routing does not snooze a ticket the customer has written to since the messages Jev was given,
  and asks Jev again instead of applying a decision made before them. It reads past pages of
  notes and activity lines to find the customer's messages, and does not snooze a ticket
  when it cannot read far enough to tell.
- **Use draft** links to the answer when Discord cannot give it back in time, and the Manage
  card keeps its label menu when the ticket's only label is too long for it.
- The Manage card's menus keep the current assignee and label among their 25 choices, a label may
  be called `none`, and a current label too long for a menu is named in its placeholder.
- A failed change from the Manage card shows in the card, which is a Components V2 message.
- The support queue posts nothing after its first three minutes, however it is retried or
  deferred, so it cannot be posted twice; a run keeps the queue's due time for its nonces.
- The buttons of a very long message are on the part the triage bot is called on, not on the
  truncation note.

### Added

- **Assign to…**, **Snooze** (until the next reply), and **Block** buttons. **Assign to…** shows
  a menu of the account's agents; **Block** asks to confirm first. Both turn into the result.

## [0.17.0] - 2026-09-30

### Added

- The ticket buttons follow the triage bot's answer: a customer message that calls the bot has no
  buttons of its own, and the bot's hook (`POST /triage/answered`, signed with the new
  `TRIAGE_HOOK_SECRET`) makes the Worker post them under the answer.

### Changed

- Routing adds its topic label only to a ticket without any label, so a ticket has one label.

## [0.16.0] - 2026-09-30

### Added

- **Use draft** is back on the ticket buttons (with a triage bot): it opens the reply editor with
  the triage bot's latest draft in the post. It needs the bot's Message Content intent; until the
  bot has it, the button says so and points to **Reply with this**.

### Changed

- The Manage card's label menu picks one label, replacing the ticket's labels (`/label` still
  adds and removes single labels). It is a single-select menu, as tall as the assignee menu.

## [0.15.0] - 2026-09-30

### Changed

- The Manage panel is a card coloured by the ticket's status, titled with the ticket and the
  customer's name: menus for the assignee and labels, and **Open**, **Resolve**, and **Snooze**
  buttons with the current status highlighted. Priority and "pending" left the panel (the
  `/priority` and `/pending` commands remain).

## [0.14.0] - 2026-09-30

### Changed

- The ticket buttons (**Reply**, **Take**, **Resolve**, **Manage**) are under every message, not
  only customer messages; activity lines have none.
- The Manage panel shows a heading above each menu (Assignee, Labels, Priority, Status). It is a
  Components V2 message.

## [0.13.1] - 2026-09-30

### Removed

- The **Reply with draft** button. Reading the triage bot's message needs the privileged Message
  Content intent, which Discord grants a bot in large servers only after a review; without it the
  button found no draft. Use **Reply with this** on the triage bot's message instead.

## [0.13.0] - 2026-09-30

### Added

- Ticket buttons: the ticket card has **Reply**, **Reply with draft**, **Take**, **Resolve**, and
  **Manage**; each customer message has **Reply**, **Reply with draft**, and **Manage**.
- **Reply with draft** opens the reply editor with the triage bot's latest draft in the post. It
  reads the post's messages: turn on the bot's **Message Content** intent, and give it *Read
  Message History* in the forum.
- **Manage** opens a private panel with the ticket's assignee, labels, priority, and status as
  menus. Each change applies at once and redraws the panel with the ticket's state.

## [0.12.0] - 2026-09-30

### Added

- `routing.snoozeUnclear`: a ticket without a clear owner is snoozed until the customer's next
  message, which reopens it and routes it again.
- The support queue also lists snoozed tickets, last and marked 💤, without pinging or escalating.
  It reads one more page per account: `relay.subrequestBudget` must be at least 5 × accounts + 4.

## [0.11.0] - 2026-09-30

### Added

- `queue.escalationUserId`: the support queue can escalate to one user instead of a role.

## [0.10.0] - 2026-09-30

### Added

- **Send from my email address** in the `/reply` editor: an email reply goes out from the agent's
  own mailbox name on the inbox's domain. It needs a Chatwoot build that reads
  `content_attributes.send_as_agent`; standard Chatwoot ignores it.

## [0.9.0] - 2026-09-30

### Changed

- **Breaking:** `triage.draftLabels` is removed; delete it from `CONFIG`. **Reply with this** on a
  triage bot message takes its last code block, whatever the headings, so the bot's prompt no
  longer has to write a fixed label; a triage message without a code block has no draft.

## [0.8.1] - 2026-09-30

### Fixed

- The support queue could post a message over Discord's 2,000-character limit when its note did
  not fit an earlier message; the note now gets its own message, and assignee names are capped.
- A retried queue post could appear twice: each part now carries a nonce Discord enforces.
- A ticket that fell out of the pages the queue reads lost its escalation record, so Core Team was
  pinged again for the same step when it came back.
- A ticket closed while Jev was answering was marked routed; the decision now waits until the
  ticket opens again.

## [0.8.0] - 2026-09-30

### Changed

- **Breaking for `routing.topics`:** routing adds the topic as a Chatwoot label (the keys are now
  label names, lower case) instead of setting the `relay.topicAttribute` attribute, so topics
  show in Chatwoot's conversation list and label reports. A ticket that already has one of the
  topic labels gets none. Map the labels to forum tags with `label:<label>` keys in `forumTags`.

## [0.7.1] - 2026-09-30

### Changed

- Routing no longer reads decisions in 0.5.0's format (0.5.0 ran briefly before 0.6.0); a ticket
  with such a record would be routed again. Internal cleanup of routing and the support queue.

## [0.7.0] - 2026-09-30

### Added

- Support queue: with the new `queue` setting, an hourly message lists the tickets waiting for a
  reply or without an assignee, pings their linked assignees, and pings a role when an unassigned
  ticket has waited 1, 2, 4, 8, and 16 hours, then daily. See
  [support queue](README.md#support-queue).

## [0.6.1] - 2026-09-30

### Fixed

- Routing sent Jev the first customer messages of the latest page, not of the conversation, so a
  ticket with more than 20 messages was judged on recent ones.
- Routing decisions expired after 30 days, after which a ticket could be routed again.
- An assignee or topic set while Jev was answering could be overwritten; the decision is now
  applied to the conversation as it is after Jev answered.

## [0.6.0] - 2026-09-29

### Changed

- Routing asks Jev again when the customer adds a message to a ticket without a clear owner, up to
  the first three customer messages, instead of leaving it after the first answer. Decisions
  recorded by 0.5.0 stay final.

## [0.5.0] - 2026-09-29

### Added

- Routing: with the new `routing` setting and the `TYPESAFE_API_KEY` secret, each new ticket of a
  routed account is assigned to its owner and given a topic by TypeSafe Jev when Jev is confident
  enough, once, with identifiers removed from the text it sees. See
  [routing](README.md#routing).

### Fixed

- The example the legacy JSON configuration no longer has the `tag` keys that 0.4.0 removed, which made its
  `CONFIG` invalid.

## [0.4.0] - 2026-09-28

### Upgrading

- **Breaking:** forum tags are bound by id. Remove `accounts[].tag` and `agents[].tag`, and map
  each forum's tags in `forumTags` by what they stand for, for example
  `{"<forum channel id>": {"account:1": "<tag id>", "status:open": "<tag id>", "assignee:42": "<tag id>"}}`
  (see the [configuration reference](README.md#configuration-reference)). List a forum's tag ids
  with `DISCORD_BOT_TOKEN=... npm run forum-tags -- --forum <forum channel id>`. Tags without an
  entry are no longer applied; renaming a tag in Discord no longer matters. Active posts get their
  tags again on their next sync.

- `relay.subrequestBudget` must be at least `relay.maxChunks` + 26 (was + 24); the default 45
  still fits `maxChunks` up to 10.
- On deploy the database migrates once: it adds a pending-announcement column, interaction
  receipts, the Discord ids of responses and notices, and the message a title quotes.

### Fixed

- A customer message over the triage budget no longer calls the triage bot when its post is
  retried.
- A failed assignee announcement is retried until it is posted, even without new messages.
- A sweep longer than 10 pages continues where it stopped instead of rereading the first 10.
- A failing job is no longer dropped after 10 attempts; it keeps retrying at most every 30
  minutes, so a long outage loses no work.
- A failed write of the post URL to the conversation is retried.
- Deleting a message in Chatwoot also removes the response and notice posted about it, and its
  text from the post's title when the title quotes it.
- A response or delivery failure reported before its message was relayed is posted with the
  message instead of being lost.

### Changed

- The assignee tag is bound to the Chatwoot user id, for linked and unlinked agents alike.

### Security

- Discord interactions signed more than 5 minutes ago are refused, and a command is queued once
  per interaction id, so a replayed request never runs it again.
- A command runs only with a token that belongs to the Chatwoot user the invoker is linked to.
- Chatwoot and Discord API requests no longer follow redirects, which could carry a token to
  another host.
- The forum's webhook is recognized by the application that created it, not by its name.

## [0.3.0] - 2026-09-28

### Upgrading

- **Breaking:** link agents by Chatwoot user id. Replace each `agents[]` entry's `email` with
  `chatwootUserId`: the `id` from `GET /api/v1/profile` with the agent's own token, or from an
  administrator's `GET /api/v1/accounts/<account id>/agents`. `CONFIG` with `email` is invalid.
- `CONFIG` is validated strictly: remove any key the
  [configuration reference](README.md#configuration-reference) does not list, including
  `discord.applicationId`. `relay.subrequestBudget` must be at least `relay.maxChunks` + 24 (the
  default 45 fits `maxChunks` up to 10), and `triage.name` at most 100 characters.
- Re-register the commands after deploying (`npm run register-commands`) for the new `/reply` and
  `/note` options and the new `/unassign` and `/label` commands.
- On deploy the database migrates once: posts gain title columns (existing posts keep their
  titles), the unused `deliveries` table is dropped (versions before 0.2.0 can no longer run on
  it), and each post's announced assignee is cleared (it held a name, now a Chatwoot user id), so
  each post records its current assignee on its next live message without pinging them. Each
  post's tags are updated once on its next sync. An `/assign` queued before the deploy is dropped
  as unreadable (its invoker sees no result); other queued jobs keep working.

### Added

- `/reply` and `/note` take optional `message` and `attachment` options that send at once; without
  options they open the editor.
- `/unassign` removes the assignee; `/label add|remove <label>` changes one label.
- Priority and Chatwoot labels become forum tags when a tag of that name exists.
- `accounts[].inboxIds` limits an account to some of its inboxes.
- `agents[].tag` sets a linked agent's assignee tag, independent of their Chatwoot name.
- An agent's replies and notes show the linked Discord user's avatar (looked up at most once a
  day), else the agent's Chatwoot avatar.
- A newly assigned, linked agent is added to the post.
- A reply the channel could not deliver gets one ⚠️ notice in its post; `/reply` refuses when the
  channel does not accept a reply (`can_reply`).
- The post title follows the contact's name (posts created from this version on).
- Chatwoot @mentions show as `@name`; a linked agent mentioned in a private note is pinged.
- Shared contacts and locations, Instagram story mentions and reels, `fallback` attachments, LINE
  stickers, and bots' options, cards, and articles are shown instead of dropped.
- The ticket card names every Chatwoot channel type and shows the phone number on SMS, Twilio,
  and WhatsApp.
- A command dropped because it could not start in time tells the invoker.
- README: purpose, design, illustrations, a Deploy to Cloudflare button, installing on an
  existing Chatwoot, and forum tag limits; `docs/ai-agent.md` for connecting an AI agent.

### Changed

- Notifications are live-only: messages created more than `reconcile.lookbackSeconds` ago
  (history of an older conversation, a catch-up after downtime) and automatic email replies
  notify nobody and do not use the triage budget.
- The triage mention and pings go on the last line of the last Discord message of a split
  message, so a bot sees the whole message.
- A new assignee is pinged in a notice of its own after the run's messages, and assignees are
  told apart by Chatwoot user id, so a rename does not ping again.
- An email is relayed without the earlier emails it quotes, as Chatwoot forwards it.
- Conversation events sync after 10 seconds, so the change's activity message comes with them.
- Only a request Discord refuses as invalid (a 4xx other than 401, 403, 404, 408, 429) counts
  towards skipping a message after `relay.maxAttempts`; rate limits, server errors, timeouts, and
  missing permissions retry until they succeed. A rate limited job waits as long as Discord asks
  without counting an attempt, and a job that fails 10 times is dropped (the sweep and the next
  event pick its conversation up again). Every outbound request times out after 60 seconds.
- Customer text cannot mention anyone or look like a relay line (mention tokens, `@everyone`,
  `@here`, and a leading `-#` get a zero-width space).
- Drafts are read with CommonMark's code fence rules, so a draft may contain a code block.
- A linked agent whose Chatwoot user left the account is told so instead of "not linked".
- the legacy JSON configuration is committed with placeholder `CONFIG` (replacing the previous example configuration),
  and `package.json` describes each secret for the Cloudflare dashboard.
- npm replaces Bun (npm 12 pinned in `packageManager`; `allowScripts` limits install scripts to
  esbuild and workerd); `register-commands` runs with Node's type stripping and takes its options
  after `--`.
- TypeScript 7; runtime types come from the legacy type generator; compatibility date 2026-08-15; the legacy CLI
  4.142.0. `gen:chatwoot` runs openapi-typescript through `npx`.

### Fixed

- A forum tag deleted in Discord since it was cached no longer fails posts: the request is sent
  once more with the tags read again.
- A sweep that stops at its page limit continues from the oldest activity it read.
- A link attribute that could not be written is retried on a later sync.
- A command that finds its conversation deleted closes its post.
- Budgets that could never relay a message are rejected at startup.

### Removed

- `agents[].email` (use `chatwootUserId`) and the ignored `discord.applicationId` key.
- The unused `deliveries` table.
- The `deleted-message` job type of unreleased builds; such a job is dropped with a warning.

## [0.2.0] - 2026-09-27

### Added

- Avatars: customers show their Chatwoot avatar or a generic person image (`avatars.contact`,
  Gravatar's "mystery person" by default); everything Chatwoot posts shows the Chatwoot icon
  (`avatars.chatwoot`, the instance's `/favicon-512x512.png` by default).
- `/pending` marks the conversation pending, `/snooze [until]` snoozes it until the next reply or
  for an hour (the dashboard's options that do not depend on the agent's time zone), and
  `/priority <level>` sets or clears its priority, and `/unblock` unblocks the contact.
  Re-register the commands after deploying.
- Customer messages ping the conversation's linked assignee (on the same line as the triage
  mention); agent replies, notes, activity lines, and unassigned conversations ping nobody.
- A message deleted in Chatwoot is deleted from its post once Chatwoot's API confirms it.
- A customer's response to an interactive message (option pick, form, CSAT rating, or email
  request) is posted into the conversation's post under the customer's name, formatted like
  Chatwoot's Slack integration, once Chatwoot's API confirms it (from `message_updated`). A
  response is posted once; a changed response is posted again.
- A conversation that no longer exists in Chatwoot gets a notice in its post, which is archived
  and forgotten.

### Changed

- Bun replaces pnpm as the package manager and script runner (`bun install`, `bun run <script>`,
  lockfile `bun.lock`); `register-commands` runs with Bun instead of tsx. Vitest and the legacy CLI still
  run on Node 24.
- The status tag is the conversation's Chatwoot status (`open`, `pending`, `snoozed`, or
  `resolved`); only resolved posts are archived.
- Every Chatwoot call uses a route listed in the published OpenAPI spec: `/block` resolves the
  conversation and blocks its contact, and the sweep pages through the conversation list, most
  recent activity first, instead of using `updated_within`. Responses use the generated types,
  except messages.
- Discord calls are typed with `discord-api-types` and follow per-bucket and global rate limits.
- `/assign` confirms with the agent's Chatwoot `name`, which is also the assignee tag.
- The `conversation_created` webhook event is ignored; it is no longer needed.

### Fixed

- A post deleted in Discord no longer makes a tags-only update retry forever; the mapping is
  forgotten and the next message starts a new post.
- Tags of an archived post (resolved, or archived by Discord for inactivity) are updated:
  the post is unarchived with the new tags, then archived again if resolved.
- A retry no longer posts a message twice: each Discord message is recorded when it is sent, the
  cursor advances as soon as a message is fully posted, and tags are updated once per run.
- The first message in a post adopted from another relay no longer pings the assignee again:
  without a recorded state, an unchanged assignee cannot be told apart from a new one.
- Queued jobs and cached forum data are validated when read; unreadable jobs are dropped.

### Removed

- `discord.applicationId` from `CONFIG` (unused; an existing value is ignored).
- Webhook delivery deduplication by `X-Chatwoot-Delivery`: Chatwoot sends account webhooks
  once, and relaying is idempotent.

## [0.1.0] - 2026-09-27

### Added

- Relay from Chatwoot to a Discord forum: one post per conversation with a ticket card, every
  message as a reply under its sender's name and avatar, private notes and activity lines, and
  splitting of long messages with a truncation note.
- Forum tags for the account, `open`/`resolved`, the assignee, and a topic attribute; resolved
  posts are archived and reopened ones unarchived.
- A one-time ping for a newly assigned, linked agent, and an optional triage bot mention with
  per-conversation and hourly budgets.
- The post URL is stored in the conversation's `discord_thread` custom attribute, and existing
  posts are adopted from that attribute during a cutover.
- Discord commands that act in Chatwoot as the invoking agent: `/reply` (with attachments),
  `/note`, `/resolve`, `/reopen`, `/assign`, `/block`, and the "Reply with this" message command.
  A command that cannot start within 12 minutes is dropped, because Discord's interaction token
  (valid 15 minutes) could no longer report its result.
- A single SQLite-backed Durable Object with a job queue, alarms, retries with backoff, a
  per-invocation subrequest budget, and a cron reconciliation sweep for missed webhooks.
- Verification of Chatwoot webhook HMAC signatures and Discord Ed25519 interaction signatures.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-discord-relay@0.30.0...HEAD
[0.30.0]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-discord-relay@0.29.0...chatwoot-discord-relay@0.30.0
[0.29.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.28.0...chatwoot-discord-relay@0.29.0
[0.28.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.18.1...v0.19.0
[0.18.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Phala-Network/chatwoot-workers/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Phala-Network/chatwoot-workers/releases/tag/v0.1.0
