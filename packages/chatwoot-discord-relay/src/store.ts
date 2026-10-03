// Durable Object SQLite storage: conversation <-> post mappings, the Discord messages posted
// for each Chatwoot message, responses posted for interactive messages, the job queue, hourly
// counters, and a small cache.

import { QueueStore } from "../../../shared/store.ts";
import type { Cache } from "./discord/forum.ts";
import type { PostFields, RelayStore } from "./relay/relay.ts";

const MIGRATIONS: string[] = [
  `CREATE TABLE conversations (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     thread_id TEXT,
     state TEXT,
     cursor INTEGER,
     fail_message_id INTEGER,
     fail_count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (account_id, conversation_id)
   );
   CREATE UNIQUE INDEX conversations_thread ON conversations (thread_id);
   CREATE TABLE jobs (
     key TEXT PRIMARY KEY,
     priority INTEGER NOT NULL,
     payload TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     attempts INTEGER NOT NULL DEFAULT 0,
     not_before INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX jobs_due ON jobs (not_before);
   CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
   CREATE TABLE counters (name TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);`,
  // posted_messages checkpoints relaying (a retry resumes after the parts already posted) and
  // finds the Discord messages to delete when a message is deleted in Chatwoot.
  // announced_assignee is seeded from the assignee in the stored state. deliveries (webhooks are
  // not deduplicated) is emptied here and dropped in migration 4.
  `CREATE TABLE posted_messages (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     part INTEGER NOT NULL,
     discord_message_id TEXT NOT NULL,
     PRIMARY KEY (account_id, conversation_id, message_id, part)
   );
   ALTER TABLE conversations ADD COLUMN announced_assignee TEXT;
   UPDATE conversations
     SET announced_assignee = substr(substr(state, instr(state, '|') + 1), 1, instr(substr(state, instr(state, '|') + 1), '|') - 1)
     WHERE state LIKE '%|%|%';
   DELETE FROM deliveries;`,
  // submitted_responses records the response to an interactive message last posted (a SHA-256
  // digest of its text), so an update that does not change it is not posted again.
  `CREATE TABLE submitted_responses (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     digest TEXT NOT NULL,
     PRIMARY KEY (account_id, conversation_id, message_id)
   );`,
  // title_subject and title keep what a post's title ends with and the title last applied, so
  // the title can follow the contact's name; older posts keep their title (NULL).
  `ALTER TABLE conversations ADD COLUMN title_subject TEXT;
   ALTER TABLE conversations ADD COLUMN title TEXT;
   DROP TABLE IF EXISTS deliveries;`,
  // announced_assignee holds a Chatwoot user id, not a name. Names cannot be turned into ids, so
  // every record is cleared: such a post records its assignee without pinging them
  // (see Notifier#newAssignee).
  `UPDATE conversations SET announced_assignee = NULL;`,
  // announce_pending keeps an owed assignee announcement across failed attempts.
  `ALTER TABLE conversations ADD COLUMN announce_pending INTEGER;`,
  // interactions records the Discord interactions whose command was accepted, so a repeated
  // request never queues its command again (see acceptInteraction).
  `CREATE TABLE interactions (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);`,
  // derived_messages holds the Discord messages posted about a Chatwoot message (a customer's
  // response to it, a delivery failure), removed with it. title_message_id is the message a
  // post's title quotes.
  `CREATE TABLE derived_messages (
     account_id INTEGER NOT NULL,
     conversation_id INTEGER NOT NULL,
     message_id INTEGER NOT NULL,
     discord_message_id TEXT NOT NULL,
     PRIMARY KEY (account_id, conversation_id, message_id, discord_message_id)
   );
   ALTER TABLE conversations ADD COLUMN title_message_id INTEGER;`,
  // A post's card: its message, whether messages were posted after it, the triage bot's latest
  // answer and the message it answers, and the customer's latest message (see Relay.sync).
  `ALTER TABLE conversations ADD COLUMN card_id TEXT;
   ALTER TABLE conversations ADD COLUMN card_covered INTEGER;
   ALTER TABLE conversations ADD COLUMN answer_id TEXT;
   ALTER TABLE conversations ADD COLUMN answer_source_id TEXT;
   ALTER TABLE conversations ADD COLUMN customer_message_id TEXT;`,
  `ALTER TABLE conversations ADD COLUMN assignee_notice_id TEXT;`,
];

const COUNTER_TTL_MS = 2 * 60 * 60 * 1000;
/** Longer than a signed interaction is accepted (see isFreshTimestamp), so a replay is always recognized. */
const INTERACTION_TTL_MS = 60 * 60 * 1000;

interface ConversationFields extends PostFields {
  /** Id of the last message handled; unset for an adopted post until its first run. */
  cursor: number;
}

/** A conversation's row; a field is undefined until it is set. */
type ConversationRow = { [Field in keyof ConversationFields]: ConversationFields[Field] | undefined };

const COLUMNS: ReadonlyArray<readonly [keyof ConversationFields, string]> = [
  ["threadId", "thread_id"],
  ["state", "state"],
  ["cursor", "cursor"],
  ["announcedAssignee", "announced_assignee"],
  ["assigneeNoticeId", "assignee_notice_id"],
  ["announcePending", "announce_pending"],
  ["titleSubject", "title_subject"],
  ["title", "title"],
  ["titleMessageId", "title_message_id"],
  ["cardId", "card_id"],
  ["cardCovered", "card_covered"],
  ["answerId", "answer_id"],
  ["answerSourceId", "answer_source_id"],
  ["customerMessageId", "customer_message_id"],
];

export type { Job } from "../../../shared/store.ts";

export class Store extends QueueStore implements RelayStore, Cache {
  /** A changed reply can qualify even on an already-scanned page. No notification was decided yet. */
  invalidateAnswerScans(accountId: number, conversationId: number): boolean {
    const key = `answer-version:${accountId}:${conversationId}`;
    this.set(key, String(Number(this.get(key) ?? 0) + 1), 24 * 60 * 60 * 1000);
    return (
      this.sql.exec("DELETE FROM cache WHERE key LIKE ?", `answer-scan:${accountId}:${conversationId}:%`).rowsWritten >
      0
    );
  }

  commandFile(interactionId: string, part: number, type: string): Blob | undefined {
    if (
      this.sql
        .exec("SELECT 1 FROM command_files WHERE interaction_id = ? AND part = ? AND chunk = -1", interactionId, part)
        .toArray().length === 0
    )
      return;
    const chunks: Blob[] = [];
    for (const row of this.sql.exec<{ bytes: ArrayBuffer }>(
      "SELECT bytes FROM command_files WHERE interaction_id = ? AND part = ? AND chunk >= 0 ORDER BY chunk",
      interactionId,
      part,
    ))
      chunks.push(new Blob([row.bytes]));
    return new Blob(chunks, { type });
  }

  async saveCommandFile(interactionId: string, part: number, blob: Blob): Promise<void> {
    this.sql.exec("DELETE FROM command_files WHERE interaction_id = ? AND part = ?", interactionId, part);
    const size = 64 * 1024;
    for (let offset = 0; offset < blob.size; offset += size) {
      const bytes = await blob.slice(offset, offset + size).arrayBuffer();
      this.sql.exec(
        "INSERT INTO command_files VALUES (?, ?, ?, ?, ?)",
        interactionId,
        part,
        offset / size,
        bytes,
        this.now(),
      );
    }
    this.sql.exec(
      "INSERT INTO command_files VALUES (?, ?, -1, ?, ?)",
      interactionId,
      part,
      new ArrayBuffer(0),
      this.now(),
    );
  }

  clearCommandFiles(interactionId: string): void {
    this.sql.exec("DELETE FROM command_files WHERE interaction_id = ?", interactionId);
  }

  override migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0];
    let version = row?.version ?? 0;
    if (!row) this.sql.exec("INSERT INTO schema_version (version) VALUES (0)");
    for (; version < MIGRATIONS.length; version += 1) {
      this.sql.exec(MIGRATIONS[version] ?? "");
      this.sql.exec("UPDATE schema_version SET version = ?", version + 1);
    }
    super.migrate();
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS command_files (interaction_id TEXT NOT NULL, part INTEGER NOT NULL, chunk INTEGER NOT NULL, bytes BLOB NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (interaction_id, part, chunk))",
    );
  }

  // Conversations

  conversation(accountId: number, conversationId: number): ConversationRow | undefined {
    const row = this.sql
      .exec<{
        thread_id: string | null;
        state: string | null;
        cursor: number | null;
        announced_assignee: string | null;
        assignee_notice_id: string | null;
        announce_pending: number | null;
        title_subject: string | null;
        title: string | null;
        title_message_id: number | null;
        card_id: string | null;
        card_covered: number | null;
        answer_id: string | null;
        answer_source_id: string | null;
        customer_message_id: string | null;
      }>(
        `SELECT ${COLUMNS.map(([, column]) => column).join(", ")} FROM conversations
         WHERE account_id = ? AND conversation_id = ?`,
        accountId,
        conversationId,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      threadId: row.thread_id ?? undefined,
      state: row.state ?? undefined,
      cursor: row.cursor ?? undefined,
      announcedAssignee: row.announced_assignee ?? undefined,
      assigneeNoticeId: row.assignee_notice_id ?? undefined,
      announcePending: row.announce_pending ?? undefined,
      titleSubject: row.title_subject ?? undefined,
      title: row.title ?? undefined,
      titleMessageId: row.title_message_id ?? undefined,
      cardId: row.card_id ?? undefined,
      cardCovered: row.card_covered ?? undefined,
      answerId: row.answer_id ?? undefined,
      answerSourceId: row.answer_source_id ?? undefined,
      customerMessageId: row.customer_message_id ?? undefined,
    };
  }

  /** Sets the given fields of a conversation's row. */
  updateConversation(accountId: number, conversationId: number, patch: Partial<ConversationFields>): void {
    const set = COLUMNS.filter(([field]) => patch[field] !== undefined);
    if (set.length === 0) return;
    this.ensureRow(accountId, conversationId);
    this.sql.exec(
      `UPDATE conversations SET ${set.map(([, column]) => `${column} = ?`).join(", ")}
       WHERE account_id = ? AND conversation_id = ?`,
      ...set.map(([field]) => patch[field] ?? null),
      accountId,
      conversationId,
    );
  }

  ticketForThread(threadId: string): { accountId: number; conversationId: number } | undefined {
    const row = this.sql
      .exec<{ account_id: number; conversation_id: number }>(
        "SELECT account_id, conversation_id FROM conversations WHERE thread_id = ?",
        threadId,
      )
      .toArray()[0];
    return row ? { accountId: row.account_id, conversationId: row.conversation_id } : undefined;
  }

  /**
   * Up to `limit` of the account's posts that have no card, whose ticket was not resolved when
   * last synced (`state` is Relay.stateOf, which starts with the status), and that were not taken
   * in the last `retryMs`; each is taken (see backfillCards in hub.ts).
   */
  takePostsWithoutCard(accountId: number, limit: number, retryMs: number): number[] {
    const ids = this.sql
      .exec<{ conversation_id: number }>(
        `SELECT c.conversation_id FROM conversations c
         LEFT JOIN cache taken ON taken.key = 'card-backfill:' || c.account_id || ':' || c.conversation_id
           AND (taken.expires_at IS NULL OR taken.expires_at > ?)
         WHERE c.account_id = ? AND c.thread_id IS NOT NULL AND c.card_id IS NULL AND taken.key IS NULL
           AND (c.state IS NULL OR c.state NOT LIKE '["resolved"%')
         ORDER BY c.conversation_id DESC LIMIT ?`,
        this.now(),
        accountId,
        limit,
      )
      .toArray()
      .map((row) => row.conversation_id);
    for (const id of ids) this.set(`card-backfill:${accountId}:${id}`, "1", retryMs);
    return ids;
  }

  setCursor(accountId: number, conversationId: number, cursor: number): void {
    this.ensureRow(accountId, conversationId);
    this.sql.exec(
      "UPDATE conversations SET cursor = ?, fail_message_id = NULL, fail_count = 0 WHERE account_id = ? AND conversation_id = ?",
      cursor,
      accountId,
      conversationId,
    );
  }

  /** Records a failed attempt at relaying `messageId` and returns the attempt count. */
  recordFailure(accountId: number, conversationId: number, messageId: number): number {
    this.ensureRow(accountId, conversationId);
    const row = this.sql
      .exec<{ fail_count: number }>(
        `UPDATE conversations
           SET fail_count = CASE WHEN fail_message_id = ?1 THEN fail_count + 1 ELSE 1 END, fail_message_id = ?1
         WHERE account_id = ?2 AND conversation_id = ?3 RETURNING fail_count`,
        messageId,
        accountId,
        conversationId,
      )
      .toArray()[0];
    return row?.fail_count ?? 1;
  }

  /** Maps a conversation to an existing post that no other conversation is mapped to. */
  adoptThread(accountId: number, conversationId: number, threadId: string): void {
    this.sql.exec(
      `INSERT INTO conversations (account_id, conversation_id, thread_id) VALUES (?, ?, ?)
       ON CONFLICT (account_id, conversation_id) DO UPDATE SET thread_id = excluded.thread_id, state = NULL,
         announced_assignee = NULL, assignee_notice_id = NULL, announce_pending = NULL, title_subject = NULL, title = NULL, title_message_id = NULL,
         card_id = NULL, card_covered = NULL, answer_id = NULL, answer_source_id = NULL,
         customer_message_id = NULL`,
      accountId,
      conversationId,
      threadId,
    );
  }

  // RelayStore

  postedParts(accountId: number, conversationId: number, messageId: number): string[] {
    return this.sql
      .exec<{ discord_message_id: string }>(
        "SELECT discord_message_id FROM posted_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ? ORDER BY part",
        accountId,
        conversationId,
        messageId,
      )
      .toArray()
      .map((row) => row.discord_message_id);
  }

  firstPart(accountId: number, conversationId: number, discordId: string): string | undefined {
    return this.sql
      .exec<{ discord_message_id: string }>(
        `SELECT first.discord_message_id FROM posted_messages part
           JOIN posted_messages first ON first.account_id = part.account_id
             AND first.conversation_id = part.conversation_id AND first.message_id = part.message_id AND first.part = 0
           WHERE part.account_id = ? AND part.conversation_id = ? AND part.discord_message_id = ?`,
        accountId,
        conversationId,
        discordId,
      )
      .toArray()[0]?.discord_message_id;
  }

  savePostedPart(accountId: number, conversationId: number, messageId: number, part: number, discordId: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO posted_messages (account_id, conversation_id, message_id, part, discord_message_id) VALUES (?, ?, ?, ?, ?)",
      accountId,
      conversationId,
      messageId,
      part,
      discordId,
    );
  }

  deletePostedPart(accountId: number, conversationId: number, messageId: number, discordId: string): void {
    this.sql.exec(
      "DELETE FROM posted_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ? AND discord_message_id = ?",
      accountId,
      conversationId,
      messageId,
      discordId,
    );
  }

  /** Digest of the response to an interactive message last posted (see processMessageUpdate). */
  postedResponse(accountId: number, conversationId: number, messageId: number): string | undefined {
    const row = this.sql
      .exec<{ digest: string }>(
        "SELECT digest FROM submitted_responses WHERE account_id = ? AND conversation_id = ? AND message_id = ?",
        accountId,
        conversationId,
        messageId,
      )
      .toArray()[0];
    return row?.digest;
  }

  savePostedResponse(accountId: number, conversationId: number, messageId: number, digest: string): void {
    this.sql.exec(
      `INSERT INTO submitted_responses (account_id, conversation_id, message_id, digest) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, conversation_id, message_id) DO UPDATE SET digest = excluded.digest`,
      accountId,
      conversationId,
      messageId,
      digest,
    );
  }

  forgetThread(accountId: number, conversationId: number): void {
    const key = `send:post:${accountId}:${conversationId}`;
    if (this.get(key) !== "unknown") this.delete(key);
    this.sql.exec(
      `UPDATE conversations SET thread_id = NULL, state = NULL, announced_assignee = NULL, assignee_notice_id = NULL, announce_pending = NULL,
         title_subject = NULL, title = NULL, title_message_id = NULL, card_id = NULL, card_covered = NULL, answer_id = NULL,
         answer_source_id = NULL, customer_message_id = NULL
       WHERE account_id = ? AND conversation_id = ?`,
      accountId,
      conversationId,
    );
    this.sql.exec(
      "DELETE FROM posted_messages WHERE account_id = ? AND conversation_id = ?",
      accountId,
      conversationId,
    );
    this.sql.exec(
      "DELETE FROM submitted_responses WHERE account_id = ? AND conversation_id = ?",
      accountId,
      conversationId,
    );
    this.sql.exec(
      "DELETE FROM derived_messages WHERE account_id = ? AND conversation_id = ?",
      accountId,
      conversationId,
    );
  }

  /** Ids of the Discord messages posted about a Chatwoot message (see derived_messages). */
  derivedMessages(accountId: number, conversationId: number, messageId: number): string[] {
    return this.sql
      .exec<{ discord_message_id: string }>(
        "SELECT discord_message_id FROM derived_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ?",
        accountId,
        conversationId,
        messageId,
      )
      .toArray()
      .map((row) => row.discord_message_id);
  }

  saveDerivedMessage(accountId: number, conversationId: number, messageId: number, discordId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO derived_messages (account_id, conversation_id, message_id, discord_message_id) VALUES (?, ?, ?, ?)",
      accountId,
      conversationId,
      messageId,
      discordId,
    );
  }

  deleteDerivedMessage(accountId: number, conversationId: number, messageId: number, discordId: string): void {
    this.sql.exec(
      "DELETE FROM derived_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ? AND discord_message_id = ?",
      accountId,
      conversationId,
      messageId,
      discordId,
    );
  }

  once(name: string, decide: () => string): string {
    const recorded = this.get(name);
    if (recorded !== undefined) return recorded;
    const value = decide();
    this.set(name, value, COUNTER_TTL_MS);
    return value;
  }

  increment(name: string): number {
    const row = this.sql
      .exec<{ count: number }>(
        `INSERT INTO counters (name, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT (name) DO UPDATE SET count = count + 1 RETURNING count`,
        name,
        this.now() + COUNTER_TTL_MS,
      )
      .toArray()[0];
    return row?.count ?? 1;
  }

  // Interactions

  /** True the first time a Discord interaction is accepted; a repeat of it is refused. */
  acceptInteraction(interactionId: string): boolean {
    return (
      this.sql.exec(
        "INSERT INTO interactions (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
        interactionId,
        this.now(),
      ).rowsWritten > 0
    );
  }

  override prune(): void {
    super.prune();
    const now = this.now();
    this.sql.exec("DELETE FROM command_files WHERE received_at <= ?", now - INTERACTION_TTL_MS);
    this.sql.exec("DELETE FROM counters WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM interactions WHERE received_at <= ?", now - INTERACTION_TTL_MS);
  }

  private ensureRow(accountId: number, conversationId: number): void {
    this.sql.exec(
      "INSERT INTO conversations (account_id, conversation_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      accountId,
      conversationId,
    );
  }
}
