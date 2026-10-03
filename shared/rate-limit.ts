/** Cache-aside state shared by upstream clients' durable cooldown stores. */
export interface RateLimitStore {
  get(key: string): string | undefined;
  set(key: string, value: string, ttlMs?: number): void;
}
