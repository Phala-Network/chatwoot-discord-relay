# Internals

How the service is built, and what its reliability rests on. See the [README](../README.md) for an
overview, and [How conversations are relayed](relay.md) for what it posts.

```
Chatwoot ──webhook──▶ Worker ──▶ Hub Durable Object ──▶ Discord forum post (via webhook)
Discord ─/command───▶ Worker ──▶ Hub Durable Object ──▶ Chatwoot REST API (as that agent)
Cron (every 5 min) ─▶ Worker ──▶ Hub Durable Object ──▶ sweep: repair anything missed
```

Chatwoot sends each account webhook once, with a short timeout and no retry
(`lib/webhooks/trigger.rb` at v4.18.0), so webhooks are only triggers. The Worker verifies and
queues the work durably in one Durable Object and answers at once; the Durable Object reads
Chatwoot's API, the source of truth, and retries failed work until it succeeds; a sweep every 5
minutes finds conversations whose new messages or state were missed (see [Sweep](#sweep) for what
it does not cover).

## Worker

`src/index.ts` verifies requests and hands work to the Hub Durable Object; each request uses a
few milliseconds of CPU. Commands that need no Chatwoot call (editors, validation, refusals) are
answered directly; the rest are deferred.

## Hub Durable Object

`src/hub.ts`, with SQLite. One object holds all state (conversation → post mapping and cursor, the
Discord message ids posted per Chatwoot message, posted responses, the job queue, triage
counters, a small cache) and does all work from its alarm. One object keeps work serialized per
conversation and keeps triage budgets and post lookups under one writer. Bounded operations and
persisted continuations allow other due jobs to run between time slices.

Confirmed command feedback runs first, then commands, live messages and immediate card updates, then sweep
pages and the hourly digest. Waiting jobs gain one priority level every 30 seconds, so background
reconciliation progresses under sustained live traffic. Every job has a 10-second time slice and
an invocation-wide subrequest budget. Metadata reads/writes time out after 1.5 seconds;
attachment transfers after 8 seconds, including response bodies. The operation, caller and job
signals are composed. A command reserves the full operation deadline before beginning a mutation.
Safe preparation and completed attachments continue durably; a started action with no confirmed
result stays unknown and is never replayed.

Discord bucket limits include their major resource and auth scope. Bot global, unauthenticated
global and interaction routes are distinct: interaction feedback is outside the bot global limit.
Discord and Chatwoot Retry-After become persisted not-before times, without sleeps or retries
inside an alarm. Confirmed failures back off (5 s … 30 min). New events preserve failure backoff.
The hourly digest reads at most two independent pages per job and persists progress and its hourly
snapshot. Its three-minute deadline is checked before each read and send; successful parts and
escalation commits survive retries with the original nonces.

## Relaying

`src/relay/`. Conversation events queue an immediate live status/card sync and a separate
conversation job delayed 10 seconds for Chatwoot's asynchronous activity message. Pending customer
messages retain their hold and one race re-read. Inbox names and avatars come from a display-only
cache; misses enqueue a low-priority refresh with a 300 ms deadline and fallback. The job
fetches the conversation and the messages after its cursor, posts them in order, then corrects
tags and the archived flag once. Each Discord message is recorded as soon as it is accepted and
the cursor moves past a Chatwoot message once all its parts are posted, so duplicate, reordered,
or lost webhooks resume after recorded parts. Before a message, notice, derived response or new post is sent,
a permanent attempt guard is written. Execute Webhook has no idempotency key: a lost receipt stays
unknown and cannot automatically replay that send. Known receipts are retained for recovery.
Derived responses use a revision per source message, so a customer changing a rating back is a
new response. Assignee notices commit before the best-effort member update. A deadline reached
before dispatch permits continuation; a timeout after dispatch preserves the unknown outcome.

## Sweep

The cron trigger queues a sweep per account that pages through conversations, most recent
activity first, back to the start of the previous sweep (at least `reconcile.lookbackSeconds`, at
most `reconcile.maxCatchUpSeconds`), one page per job (a command waiting runs between pages) and
continuing where it stopped, and queues any conversation whose post is behind or whose tags or
state differ. Activity means a new message. A change without one (for example only the topic
attribute) relies on its webhook, and so do deletions, responses, and delivery failures of
messages already relayed: the sweep does not re-read relayed messages, so a missed webhook for
one is not repaired. The sweep also retains unfinished answer-scan cursors: a lost update webhook for a failed
reply retried as sent on a skipped page is not recovered, even before the customer's first post. Chatwoot's
message API pages by ID without an update cursor; the retry keeps its ID. This can cause at most one extra
triage call per affected customer message, within notification budgets, without losing the message. See the
README's [How it works](../README.md#how-it-works) for the notification contract.
Neither does it read the post back from Discord: a title, tag, or archived
flag changed by hand in Discord stays until the conversation changes.

## Message order

A run reads the messages after its cursor, and the cursor moves to the highest id relayed.
Chatwoot's `after` filter selects by id but orders by creation time (`MessageFinder` at v4.18.0),
so an inbox the relay reads must not receive messages with earlier creation times than existing
ones (for example an import of history): keep such an import in an inbox the relay does not read
(`accounts[].inboxIds`, or one its agent is not a member of).

## Commands

`src/commands/`. A command separates safe preparation, an at-most-once action and a durable
result. Interaction feedback and live card convergence are independent retryable jobs; neither
can re-execute the Chatwoot action. Panel rendering is feedback preparation after a confirmed
result. A repeated interaction is refused (see the [security model](../README.md#security-model)).
One that cannot start within 12 minutes is dropped, because Discord's interaction token (valid 15
minutes) could soon no longer report its result, and the invoker is told that nothing was done.

## Clients

Discord calls use a small fetch-based client (`src/discord/rest.ts`), typed with
`discord-api-types`, that follows per-route and global rate limits (`@discordjs/rest` keeps
timers and queues across calls, which does not fit per-invocation subrequest accounting).
Chatwoot calls use only routes in Chatwoot's published OpenAPI spec, typed by `openapi-fetch` and
generated types; messages are validated with zod because the spec's `message` schema does not
describe the fields the API returns (see the repository's `shared/chatwoot/api.ts`).

## Separate routing Worker

AI routing lives in chatwoot-router as a native account agent bot, with its own queue and decision memo.
Hub queues no routing jobs and reads no router storage. A pending bot-inbox conversation holds its existing
conversation job; status webhooks and the sweep wake it, with only one short race re-read. The current status
and subsequent public answering replies decide triage. `assignee_type` prevents bot ids from matching human
agents. Manage keeps all labels in `router.keepLabels`. See the package README's "How it works" for the model
and its migration/rollback contract. Shared implementations live in the repository's `shared/` source tree
and are bundled independently into each published package.
