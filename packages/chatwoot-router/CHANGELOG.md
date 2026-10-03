# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- End a kind's turn with resolved/snoozed only after its canned reply is confirmed to exist in Chatwoot. Failed,
  unknown or malformed creation outcomes, incomplete history, and attempts without visible replies hand off to
  people without sending again. A reply seen as failed/deleted in the final fresh read also hands off.
- Recognize historical public outgoing messages from the account's exact brand bot, including the former relay's
  replies, without moving reply ledgers. Preserve the durable attempt/observed guard across turns and upgrades.
- Disconnecting an inbox hands its pending brand-bot leftovers to people with native bot `status=open`. The sweep
  reads pending/open account conversations, including old disconnected inboxes, and retries failed handoffs.
- Release the brand bot immediately after a kind's resolved/snoozed status using its standard unassignment API;
  durable retries finish failed releases. Preserve status, turn boundaries and other owners. The open sweep heals
  Chatwoot webhook-failure fallbacks without scanning resolved/snoozed history.

### Changed

- Reuse message pages only within one fresh phase, combine independent read-only preparation, and scope decisions to actual input/configuration without weakening side-effect checks.
- Partition routing by account and conversation, with a separate paged sweep coordinator. No state migration is needed: 0.2.x was never deployed. Preserve each conversation namespace and its reply/turn guards for future upgrades.
- Remove cached inbox discovery, obsolete lifecycle cleanup/coordination effects and the single-use decision reader.
  Keep bounded turn/history reads and the existing 45-request budget.
- Document relay-first bootstrap, disconnect-and-drain rollback to the recorded live 0.27 version/config, and the
  distinction between Chatwoot message creation and channel delivery. Preserve Router DO reply/turn guards during
  rollback and describe the independent relay 0.27 ledger and cross-version reply-once limit.

## [0.2.0] - 2026-10-03

### Changed

- The router is each routed inbox's Chatwoot agent bot (the account's brand bot). It works on `pending` conversations:
  it decides on the customer's first three messages of the bot's turn, adds the topic and kind labels, sends the kind's
  canned reply as the bot, and ends the turn with the kind's status, the owner's assignment, or a handoff to people.
  A person who takes, replies to, or reopens the ticket owns it; a resolved conversation the customer reopens comes
  back to the bot and is decided on its new messages (a snoozed one reopens for people). After three failed attempts,
  or when the kind's canned response does not exist, it hands the ticket to people. See "How it works" in the README.
- Replaces the `routing_*` conversation attributes, `startAfterConversationId`, the account webhook, `reconcile` (the
  sweep lists every `pending` conversation), and `routing.snoozeUnclear`: a greeting stays with the bot until the
  customer asks something or has sent three messages with text, then goes to people.

### Added

- `routing.endpoint`: the URL of TypeSafe's System One API (default `https://api.typesafe.ai/v1/systemone`), for
  example a proxy or gateway.

### Upgrade

- Deploy chatwoot-discord-relay 0.30.0 first. Raise `subrequestBudget` to at least 45 (was 20), remove `reconcile`
  and `routing.snoozeUnclear`, add `routing.botIds`, and replace `CHATWOOT_WEBHOOK_SECRETS` and
  `CHATWOOT_BOT_TOKENS` with `CHATWOOT_AGENT_BOT_SECRETS` and `CHATWOOT_AGENT_BOT_TOKENS`. Then set each bot's webhook
  URL to `/chatwoot/agent-bot` and connect it to the routed inboxes, one account at a time; existing `pending`
  conversations become the bot's. Roll back by disconnecting the bots ([Upgrade and rollback](https://github.com/Phala-Network/chatwoot-workers/blob/main/packages/chatwoot-router/README.md#upgrade-and-rollback)).

## [0.1.0] - 2026-10-02

### Added

- First release: the TypeSafe Jev routing of chatwoot-discord-relay 0.28.0 as its own Cloudflare Worker. A new ticket
  gets its owner, its topic label, and its kind (with a canned response and a status, if the kind has them), once per
  version of its first three customer messages; people own the ticket after that. See "How it works" in the README.
- Signed per-account Chatwoot webhooks and a five-minute sweep; per-account `startAfterConversationId` for a cutover.
- Coordination with chatwoot-discord-relay through the conversation attributes `routing_seen`, `routing_handled`, and
  `routing_kind`.
- The `chatwoot-router-store-config` command and `chatwoot-router/stored-config`, for a configuration in KV.

[Unreleased]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.2.0...HEAD
[0.2.0]: https://github.com/Phala-Network/chatwoot-workers/compare/chatwoot-router@0.1.0...chatwoot-router@0.2.0
[0.1.0]: https://github.com/Phala-Network/chatwoot-workers/releases/tag/chatwoot-router@0.1.0
