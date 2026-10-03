export function retryDelay(attempts: number): number {
  return Math.min(5000 * 2 ** attempts, 30 * 60 * 1000);
}

export interface Job {
  key: string;
  payload: string;
  version: number;
  attempts: number;
  /** When the job was first queued (ms since the epoch). */
  createdAt: number;
}

export class QueueStore {
  constructor(
    protected readonly sql: SqlStorage,
    protected readonly now: () => number = Date.now,
  ) {}

  migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      key TEXT PRIMARY KEY, priority INTEGER NOT NULL, payload TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs (not_before);
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);`);
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(jobs)").toArray();
    if (!columns.some((column) => column.name === "suspended")) {
      this.sql.exec("ALTER TABLE jobs ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0");
    }
  }

  // Cache

  get(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string; expires_at: number | null }>("SELECT value, expires_at FROM cache WHERE key = ?", key)
      .toArray()[0];
    if (!row || (row.expires_at !== null && row.expires_at <= this.now())) return undefined;
    return row.value;
  }

  set(key: string, value: string, ttlMs?: number): void {
    this.sql.exec(
      "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      key,
      value,
      ttlMs === undefined ? null : this.now() + ttlMs,
    );
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM cache WHERE key = ?", key);
  }

  // Jobs

  /**
   * Adds a job, or marks an existing one as needing another run (its version changes). A job
   * that is backing off after failures keeps its schedule.
   */
  enqueue(key: string, priority: number, payload: string, notBefore = this.now()): void {
    this.sql.exec(
      `INSERT INTO jobs (key, priority, payload, not_before, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET version = version + 1, payload = excluded.payload, suspended = 0,
         not_before = CASE WHEN attempts > 0 THEN not_before ELSE MIN(not_before, excluded.not_before) END`,
      key,
      priority,
      payload,
      notBefore,
      this.now(),
    );
  }

  nextDueJob(): Job | undefined {
    const row = this.sql
      .exec<{ key: string; payload: string; version: number; attempts: number; created_at: number }>(
        `SELECT key, payload, version, attempts, created_at FROM jobs WHERE suspended != 2 AND not_before <= ?
         ORDER BY MAX(0, priority - CAST((? - created_at) / 30000 AS INTEGER)), not_before, created_at LIMIT 1`,
        this.now(),
        this.now(),
      )
      .toArray()[0];
    if (!row) return undefined;
    const { created_at: createdAt, ...job } = row;
    return { ...job, createdAt };
  }

  /** Earliest due time. */
  nextWakeup(): number | undefined {
    const row = this.sql
      .exec<{ at: number | null }>("SELECT MIN(not_before) AS at FROM jobs WHERE suspended != 2")
      .toArray()[0];
    return row?.at ?? undefined;
  }

  /** Removes a finished job unless it was enqueued again while running. */
  completeJob(job: Job): void {
    const removed = this.sql.exec("DELETE FROM jobs WHERE key = ? AND version = ?", job.key, job.version).rowsWritten;
    if (removed === 0) this.sql.exec("UPDATE jobs SET attempts = 0, not_before = ? WHERE key = ?", this.now(), job.key);
  }

  deleteJob(key: string): void {
    this.sql.exec("DELETE FROM jobs WHERE key = ?", key);
  }

  retryJob(job: Job, delayMs: number): void {
    this.sql.exec(
      "UPDATE jobs SET attempts = attempts + 1, not_before = ? WHERE key = ?",
      this.now() + delayMs,
      job.key,
    );
  }

  /**
   * Makes a job due after `delayMs` without counting an attempt: when an invocation runs out of
   * budget, or Discord rate limits it.
   */
  deferJob(job: Job, delayMs = 0): void {
    this.sql.exec("UPDATE jobs SET not_before = ? WHERE key = ?", this.now() + delayMs, job.key);
  }

  /** One short re-read for a racing status webhook, then wait for an event or a sweep. */
  holdJob(job: Job): void {
    this.sql.exec(
      `UPDATE jobs SET suspended = CASE WHEN suspended = 0 THEN 1 ELSE 2 END,
       not_before = ?, attempts = 0 WHERE key = ? AND version = ?`,
      this.now() + 1000,
      job.key,
      job.version,
    );
  }

  /** Suspended conversation jobs need reconciliation even outside the ordinary activity window. */
  wakeHeldJobs(): void {
    this.sql.exec("UPDATE jobs SET suspended = 0, not_before = ? WHERE suspended = 2", this.now());
  }

  prune(): void {
    this.sql.exec("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= ?", this.now());
  }
}
