# chatwoot-router

A native Chatwoot agent bot that uses [TypeSafe's System One API](https://docs.typesafe.ai) to assign owners, add topic and
kind labels, send canned responses, and resolve or snooze tickets. Runs on Cloudflare Workers independently
of [chatwoot-discord-relay](https://github.com/Phala-Network/chatwoot-workers/tree/main/packages/chatwoot-discord-relay). The Workers coordinate through Chatwoot status.

## How it works

Chatwoot owns the lifecycle: a conversation is the bot's while pending, and people's otherwise.

System One is TypeSafe's class of decision models, and Jev is its first model. The router calls TypeSafe's
System One API (`/v1/systemone`) with the model in `routing.model` (Jev by default). `routing.endpoint`
may point to another deployment of that API, for example a proxy or gateway.

- Each routed account has a configured brand bot. Routing is limited to inboxes linked to that exact account's
  bot, discovered through `GET inboxes/{id}/agent_bot`. The wrapped `agent_bot.id` and `account_id` must match;
  `agent_bot: null` or `agent_bot: {}` means unlinked. Foreign-account and system bots are rejected. The user token
  must see every routed inbox. Disconnecting an inbox stops classification/replies and hands any pending ticket still assigned to this bot to people. The API does not expose whether the
  association is inactive; disconnect to disable it. `routing.botIds` and both bot credential maps require
  exactly the routed account keys (see [Configuration reference](#configuration-reference)).
- Each account+conversation has its own SQLite `Router` Durable Object: its queue, memo, reply records and turn
  guards have one writer. A slow conversation cannot occupy another conversation’s alarm. A separate `Coordinator`
  Durable Object pages the account lists and durably enqueues each conversation in its own object.
- Signed bot webhooks at `/chatwoot/agent-bot` enqueue a deduplicated conversation job. The five-minute sweep
  lists only **pending and open conversations in the account**, including disconnected inboxes, without an age
  cutoff. Pending tickets route or hand off; open tickets still assigned to the brand bot release that assignment
  with `POST assignments {assignee_id: null}`, preserving status after a fresh ownership read. Resolved/snoozed
  history is not scanned. Each status has its own persistent page cursor within the request budget. Failed pages
  retry. An empty page ends that status's pass; the next starts at page 1 and catches
  conversations skipped by changing pages. Neither event payloads nor sweep rows are decision inputs.
- Read messages newest-first, unfiltered (including activities), with `before` paging, at most five pages of 20.
  The latest `conversation_status_changed` activity begins the turn; without one or evidence it is missing, use
  the conversation's start. Take the first three usable customer texts after the boundary, oldest first. Include
  email subjects and reply text without quoted history; omit automatic email, deleted messages and private notes.
  Redact identifiers and contact names, then cap the input at 1,600 characters. Memoize Jev's decision by account, conversation, input ids, actual redacted input and routing configuration/model.
- Status activity is asynchronous. The queue's boundary guard remembers an observed/expected transition and the
  last boundary needed to reject stale handoff work. An activity read before its first status webhook can match
  that webhook's status and time only if no existing expectation requires a newer activity. Merging a webhook
  never lowers or removes an expected boundary id. Once matched, a different transition requires an activity
  **after that boundary id**, even when the old activity has the same status and second-level timestamp. Repeated
  delivery of the same transition timestamp does not start another expectation. Only a status webhook supplies a transition time;
  a read observing pending end requires a newer activity without inferring a time from `updated_at`. The last
  pending observation survives retries, so a retry confirming resolution after a lost response retains that boundary.
  Other non-pending snapshots only release a remaining brand-bot assignment: metadata updates change `updated_at` without creating a status activity.
  An expected activity not yet present retries normally; an incomplete read or a deleted known boundary hands off.
  Permanently missing activity uses the same three-attempt limit. A new boundary clears the previous turn's failure
  count and handoff. Chatwoot exposes no turn API: a lost webhook plus permanently removed, never-observed activity
  cannot be reconstructed. Chatwoot writes activity only for a changed status with activity content; no-op status
  changes create none. Activities use job execution time, and customer/scheduled reopen usually creates none.
  A late activity ordered after new text does not license reading old text across the boundary; empty input hands off.
- Jev chooses owner, topic, kind and whether there is a request. A confident kind takes precedence; otherwise a
  confident greeting/no-request stays pending while fewer than three texts exist. Empty or identifier-only input,
  three greetings, an unclear owner with an actual request, or a public human reply hands off. Blocked contacts
  and person-assigned conversations are untouched during routing; disconnect handoff also clears blocked bot leftovers.
  Bot and user assignees are distinguished by `assignee_type`.
- Before **each** action, re-read the inbox link, pending status, assignee, turn boundary, inputs and public human
  replies. A changed input defers the job to decide again. Apply topic/kind labels, then the kind's canned reply,
  then end the turn: set the kind's resolved/snoozed status and immediately release the bot, assign a confident
  owner, or use explicit bot `status=open` handoff. Chatwoot keeps the bot on resolve/snooze, so release is part of
  that same ending, with a fresh ownership/status read. A failed release keeps the durable job for retry, even
  though the sweep excludes closed history. Clearing only the bot creates no assignment/status activity and does
  not move the turn boundary; Chatwoot still dispatches assignment/update events. Preserve human topic labels and
  validate that an owner still belongs to the account.
  Successful person assignment ends the turn without a bot-handoff reporting event; nothing follows it.
  Reopened resolved conversations can lack a bot assignee, in which case assignment would not open
  pending: use native handoff instead. Chatwoot has no atomic compare-and-write API for a change racing a mutation.
- Only canned replies have an action record, `reply:<account>:<conversation>`, kept across turns and upgrades.
  Before sending, read up to five unfiltered history pages (100 messages), past turn boundaries, for a public outgoing
  message (`message_type=1`, `private=false`, `sender.type=agent_bot`) from this account's exact configured bot id.
  A confirmed, non-deleted, non-failed reply counts as replied, including replies the old relay sent; preserve an
  observed record so later removal cannot permit a resend. A complete read to the beginning with none permits the
  first attempt; an incomplete/failed/ambiguous read or an existing attempt without a visible reply hands off.
  Record the attempt **before sending**. A failed POST, lost response, malformed receipt or failed/deleted reply
  persists handoff and never resolves/snoozes or resends. Only a valid creation receipt for this conversation or
  confirmed history permits the kind's ending status. This confirms creation in Chatwoot, not channel delivery;
  a delivery failure seen in the final fresh read also hands off. Labels, assignment and status use
  current Chatwoot state, without an effects ledger or custom coordination attributes. A missing canned response
  hands off immediately. After three processing failures (initial, +5s, +10s), persist handoff mode. Further retries
  only revalidate the turn and hand off, with backoff capped at 30 minutes. Handoff failures keep the job; deleted
  conversations end it. Disconnected brand-bot pending tickets use native bot `status=open` handoff without Jev
  or a turn-history read; failures retry until the handoff succeeds. Other bots and people are untouched. Credentials/service failures need repair before handoff can succeed.
- A Worker 2xx means the job is durable, not that routing succeeded. Chatwoot's own webhook failure fallback cannot
  cover later alarm failures. Its fallback opens pending on failed `message_created`/`message_updated` delivery unless
  `keep_pending_on_bot_failure` is enabled; it may leave a bot assignee on open. The router releases that assignment on its next job or sweep.
  Chatwoot makes three delivery attempts for 429/500 responses. Irrelevant valid bot events are acknowledged.
  There is no router account-webhook endpoint.

After handoff, later customer messages belong to people. Resolved tickets reopen pending in an active bot inbox
and are decided on their **new turn's** messages. Snoozed tickets reopen open and go to people. A canned reply
following a customer message counts as answering it in the relay, even if that message was outside Jev's window.

The API contracts were checked against Chatwoot v4.18.0:
[assignment service](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/services/conversations/assignment_service.rb)
and [controller](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/api/v1/accounts/conversations/assignments_controller.rb),
[status changes](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/api/v1/accounts/conversations_controller.rb),
[activity creation](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/models/concerns/activity_message_handler.rb)
and its [job](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/jobs/conversations/activity_message_job.rb),
[message paging](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/finders/message_finder.rb),
[message creation](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/builders/messages/message_builder.rb),
[message JSON](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/views/api/v1/models/_message.json.jbuilder),
[bot sender](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/models/agent_bot.rb),
[account access](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/concerns/ensure_current_account_helper.rb),
[conversation access](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/policies/conversation_policy.rb),
[inbox bot response](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/views/api/v1/accounts/inboxes/agent_bot.json.jbuilder),
[assignees/timestamps](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/presenters/conversations/event_data_presenter.rb),
[token permissions](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/controllers/concerns/access_token_auth_helper.rb),
[bot events](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/app/listeners/agent_bot_listener.rb), and
[webhook fallback](https://raw.githubusercontent.com/chatwoot/chatwoot/v4.18.0/lib/webhooks/trigger.rb).

## Deploy

Use Node 24 (24.15 or newer), npm 12.1.0, and the Cloudflare CLI `cf`. From this repository, run inside Docker:

```sh
npm ci
cd packages/chatwoot-router
npm run typecheck
npm test
npm run build
npx cf deploy --prebuilt --dry-run
```

Edit `cloudflare.config.ts` with your non-secret settings. Keep required secrets out of source control;
`.dev.vars.example` lists placeholders. For local development copy it to `.dev.vars` and use `npm run dev`.
A maintainer deploys with `npx cf deploy --secrets-file <private-file>`.
The default Worker name is `chatwoot-router`; it exports SQLite Durable Objects `Router` (bound as `ROUTER`) and `Coordinator` (bound as `COORDINATOR`).
Keep the `*/5 * * * *` cron trigger for reconciliation. `GET /healthz` returns 200 for a valid, readable
configuration and 503 otherwise; it does not test upstream credentials or connectivity.

For a private deployment repository, depend on the public `chatwoot-router` npm package plus `cf`, Vite, and
`@cloudflare/vite-plugin`. Its Worker entry is:

```ts
export { default, Router, Coordinator } from "chatwoot-router";
```

Use the same `cloudflare.config.ts` and `vite.config.ts` structure as this package. Pin compatible tooling versions
from the workspace and root manifests. Declare `Router` and `Coordinator` with `exports.durableObject({ storage: "sqlite" })`, bind it as
`ROUTER` and `COORDINATOR` respectively, declare required secrets with `bindings.secret()`, and put `CONFIG` in `bindings.json(...)`.

For a configuration larger than a Worker JSON binding, use immutable KV configuration instead:

```sh
npx cf kv namespaces create --title chatwoot-router-config
npx chatwoot-router-store-config config.jsonc --namespace-id <namespace-id>
```

```ts
import { storedConfig } from "chatwoot-router/stored-config";
```

Set `CONFIG_STORE: bindings.kv({ id: "<namespace-id>" })` and
`CONFIG_KEY: bindings.text(storedConfig("config.jsonc").key)` in the Worker's `env`, removing `CONFIG`.
The CLI validates JSONC, uploads through the deployment project's `cf`, and prints the content-addressed key.
Keep older keys for rollbacks. The JavaScript and type declarations in each npm tarball are self-contained;
no unpublished shared package needs installing.

## Chatwoot setup

1. Give `CHATWOOT_TOKEN`'s user access to every routed inbox (membership or account administrator).
2. Create a brand agent bot in each account. Set its webhook URL to `https://<router>/chatwoot/agent-bot` and put its
   id in `routing.botIds`, access token in `CHATWOOT_AGENT_BOT_TOKENS`, and bot webhook secret in
   `CHATWOOT_AGENT_BOT_SECRETS`. All three maps must name exactly the routed accounts. Account webhook secrets
   are different credentials. Bot signatures use HMAC-SHA256 of `<timestamp>.<raw body>`, a ±5-minute window,
   and account matching. Valid irrelevant events are acknowledged without actions.
3. Create topic and kind labels and any canned responses in Chatwoot. Canned responses use their short codes and
   are read at send time; customers see the brand bot's name. Chatwoot expands its normal message variables.
4. After deploying both Workers, connect each bot to the inboxes it routes. No `routing_*` custom attributes or
   definitions are needed. For the relay's Manage card, list every kind name in `router.keepLabels`.

## Configuration reference

`CONFIG` accepts a JSON object or JSON string, or use `CONFIG_STORE` + `CONFIG_KEY` instead. Do not set both.

```json
{
  "chatwoot": { "baseUrl": "https://chatwoot.example.com" },
  "routing": {
    "botIds": { "1": 1 },
    "accounts": {
      "1": {
        "support": { "assignee": 6, "covers": "Product support, billing, and account access." },
        "sales": { "assignee": 7, "covers": "Sales questions and purchase enquiries." }
      }
    },
    "topics": { "billing": "Invoices and payments.", "technical": "Product troubleshooting." },
    "minConfidence": 0.7,
    "kinds": { "1": { "spam": { "covers": "Unsolicited advertising.", "status": "resolved" } } }
  }
}
```

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `chatwoot.baseUrl` | HTTP(S) URL | required | Final Chatwoot API URL; redirects are refused. |
| `subrequestBudget` | integer 45–1000 | `45` | Per-alarm outbound budget; reserve 45 for a bounded turn read and all actions. |
| `routing.endpoint` | HTTPS URL | `https://api.typesafe.ai/v1/systemone` | TypeSafe's System One API endpoint; may point to another deployment of that API, for example a proxy or gateway. Redirects are refused. |
| `routing.model` | non-empty string | `jev-1.13.0` | Model sent to TypeSafe's System One API; Jev by default. |
| `routing.minConfidence` | number 0.5–1 | `0.7` | Probability an answer needs before it is applied. |
| `routing.botIds` | object: account id → positive safe integer | required | Brand bot id for every routed account, and no others. |
| `routing.accounts` | object: account id → (owner name → owner) | required | Routed accounts and the owners Jev chooses from. Owner names are 1–40 lower-case letters, digits, or `_`; `unclear` is reserved. |
| `routing.accounts.<id>.<name>.assignee` | integer > 0 | required | Chatwoot user id to assign. |
| `routing.accounts.<id>.<name>.covers` | 1–1000 characters | required | What the owner handles: Jev's criterion for choosing them. |
| `routing.topics` | object: label → what it covers | unset | Topic labels (Chatwoot label names, lower case) Jev chooses from; one is added when a ticket has no label other than its kinds (an automation rule's label is kept alone). The separate relay can display them using its `forumTags` configuration. Unset: no topic. |
| `routing.kinds` | object: account id → (kind name → kind) | unset | Kinds of ticket Jev recognizes in routed accounts, added as labels beside the topic, and what is done once when it does ([How it works](#how-it-works)). Kind names are the account's label names (1–40 lower-case letters, digits, `_`, or `-`); `none` is reserved. Unset: none. |
| `routing.kinds.<id>.<name>.covers` | 1–1000 characters | required | What the kind is: Jev's criterion for recognizing it. |
| `routing.kinds.<id>.<name>.cannedResponse` | short code | unset | The account's Chatwoot canned response sent to the customer once, by the account's agent bot (`CHATWOOT_AGENT_BOT_TOKENS`); handoff if it is missing. |
| `routing.kinds.<id>.<name>.status` | `resolved` or `snoozed` | unset | Set instead of routing the ticket (`snoozed`: until the customer's next message), after the reply of a `cannedResponse`; a new customer message reopens it. |

### Secrets

| Secret | Required | Meaning |
| --- | --- | --- |
| `CHATWOOT_TOKEN` | Yes | User token for messages, canned responses, inbox discovery and sweep. Must see every routed inbox. |
| `CHATWOOT_AGENT_BOT_TOKENS` | Yes | JSON object of bot access tokens by account id, e.g. `{"1":"<token>"}`. All mutations use the bot token. |
| `CHATWOOT_AGENT_BOT_SECRETS` | Yes | JSON object of bot webhook secrets by account id, e.g. `{"1":"<secret>"}`. |
| `TYPESAFE_API_KEY` | Yes | TypeSafe API key for System One API requests. |

Both bot-secret maps require nonempty values and exactly the `routing.accounts` keys. Missing/invalid entries
fail startup; `/healthz` returns 503 without credentials in its response. All secrets use `bindings.secret()`.

## Upgrade and rollback

0.2.x was never deployed, so the conversation partition and coordinator require no state migration.

Keep Worker names, Durable Object namespaces/storage and old KV configuration keys. The Router DO holds
permanent reply attempts/observed records and turn guards as well as jobs and decisions. Message history cannot
rebuild an unknown attempt, an observed reply since deleted, or a missing turn boundary. Do not delete or recreate
any conversation’s Router DO during rollback. If its state is lost or restored to an older recovery point, keep bots disconnected
and isolate conversations with uncertain attempts/turns for owner review; a currently empty history does not
prove another send is safe. Existing pending conversations are reconciled; non-pending conversations stay with people. The user token must see all relevant inboxes.

For the first move from the relay's built-in routing (production baseline 0.27.0):

1. Record the live relay deployment/version id and CONFIG_KEY before rollout; retain its Hub and old secrets.
   Disconnect all brand bots and prevent competing old deployments. Verify bot identities, owner membership,
   labels, canned responses and inbox visibility. Historical confirmed brand-bot replies need no ledger migration.
2. Deploy and verify relay 0.30 first. Remove `routing`, `router.accounts` and `router.waitSeconds`; keep every kind
   in `router.keepLabels`. Verify the actual version and that built-in routing/in-flight old work stopped.
3. Bootstrap this Worker by hand with all four secrets in a protected secrets file while bots remain disconnected.
   Verify KV/domain, upstream permissions and test tickets; health/2xx alone do not prove routing success.
   If using an infra PR whose push deploys both Workers independently, merge only after both hand deployments pass.
4. Connect bots one account at a time and verify real routing, handoff, failed/unknown reply handling, historical
   reply deduplication and Discord/triage behavior, including at least a complete sweep.
5. To roll back, disconnect bots first and **keep this router running until no pending ticket remains assigned to
   a disconnected brand bot and no non-pending ticket remains assigned to that bot**. Complete pending/open
   account passes and let failed ending releases finish through their durable retries: pending uses native bot
   handoff, open leftovers use explicit unassignment, and kind endings release resolved/snoozed tickets in the
   same turn. Confirm cleared bot ownership across statuses; preserve human/other-bot owners. Then stop
   webhook entry, cron and queued/in-flight router work; stopping cron alone does not cancel DO alarms. Preserve DO
   namespace and storage, including reply and turn guards. Restore the recorded live 0.27 version **and its
   CONFIG_KEY**, without overlapping old/new routing. Relay 0.27 uses its original Hub's
   `kind-reply:<account>:<conversation>` records; the Router uses separate `reply:<account>:<conversation>`
   records. Restoring code/config does not copy Router attempts into the Hub or reset either ledger. Only replies
   already recorded by 0.27 retain its own reply-once protection; Router-only replies/unknown attempts can be
   attempted again by 0.27. Keep both DOs and review/isolate those tickets before restoring old routing. Rollback
   does not guarantee reply-once across this switch or undo sent messages or other mutations.

Current router upgrades need no custom coordination attributes, compatibility effects or one-time lifecycle
cleanup. Older unreadable job payloads are dropped; live snapshots and the account sweep reconstruct queued work, not durable reply/turn guards.
If handoff credentials fail, repair them or let a real owner take the tickets; do not bulk-open with the integration
user token, which can assign every ticket to that user. Keep old attributes through the owner's rollback window.

Redaction is best effort, not anonymization: other personal information can still reach TypeSafe. Logs contain
ids and outcomes, never message bodies or credentials. See [SECURITY.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/SECURITY.md),
[CONTRIBUTING.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/CONTRIBUTING.md) and [CHANGELOG.md](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/CHANGELOG.md). Licensed under [MIT](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/LICENSE).
