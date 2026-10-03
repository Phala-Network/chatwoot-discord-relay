import type { Fetch } from "../../../../shared/chatwoot/api.ts";
import { isRecord, parseJson } from "../../../../shared/json.ts";
import type { RateLimitStore } from "../../../../shared/rate-limit.ts";
import manifest from "../../package.json" with { type: "json" };

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = `DiscordBot (https://github.com/Phala-Network/chatwoot-workers, ${manifest.version})`;

/**
 * A non-2xx answer from Discord. `code` is Discord's JSON error code when present; a rate limit
 * (429) carries how long to wait before trying again.
 */
export class DiscordHttpError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: number | undefined, discordMessage: string, retryAfterMs?: number) {
    super(`Discord HTTP ${status}${code === undefined ? "" : ` (code ${code})`}: ${discordMessage}`);
    this.name = "DiscordHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A request Discord refused as invalid, which fails the same way however often it is sent: a 4xx
 * other than 401 (token), 403 (permissions), 404 (a missing resource, which the relay recreates
 * or forgets), 408 (timeout), and 429 (rate limit), per
 * https://discord.com/developers/docs/topics/opcodes-and-status-codes#http. Anything else may
 * succeed later.
 */
export function isInvalidRequest(error: unknown): boolean {
  return (
    error instanceof DiscordHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 404, 408, 429].includes(error.status)
  );
}

interface DiscordRequest<Body = never, Query extends object = never> {
  body?: Body;
  query?: Query;
  /** Webhook and interaction-token routes authenticate by URL; send no bot token. */
  auth?: boolean;
  interaction?: boolean;
  signal?: AbortSignal;
}

export class DiscordRest {
  private readonly token: string;
  private readonly fetch: Fetch;
  private readonly limits: RateLimitStore;

  constructor(token: string, fetch: Fetch, limits?: RateLimitStore) {
    this.token = token;
    this.fetch = fetch;
    const memory = new Map<string, string>();
    this.limits = limits ?? {
      get: (key) => memory.get(key),
      set: (key, value) => {
        memory.set(key, value);
      },
    };
  }

  get<Result, Query extends object = never>(path: string, request?: DiscordRequest<never, Query>): Promise<Result> {
    return this.request("GET", path, request);
  }

  post<Result, Body, Query extends object = never>(
    path: string,
    request: DiscordRequest<Body, Query>,
  ): Promise<Result> {
    return this.request("POST", path, request);
  }

  patch<Result, Body, Query extends object = never>(
    path: string,
    request: DiscordRequest<Body, Query>,
  ): Promise<Result> {
    return this.request("PATCH", path, request);
  }

  put<Result, Body>(path: string, request: DiscordRequest<Body>): Promise<Result> {
    return this.request("PUT", path, request);
  }

  delete<Result, Query extends object = never>(path: string, request?: DiscordRequest<never, Query>): Promise<Result> {
    return this.request("DELETE", path, request);
  }

  private async request<Result, Body, Query extends object>(
    method: string,
    path: string,
    request: DiscordRequest<Body, Query> = {},
  ): Promise<Result> {
    const scope = request.interaction ? "interaction" : request.auth === false ? "unauthenticated" : "bot";
    const majorPath = /^\/(?:channels|guilds)\/[^/]+|^\/webhooks\/[^/]+(?:\/[^/]+)?/.exec(path)?.[0] ?? "";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(majorPath));
    const major = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const route = `${scope}:${method}:${path.replace(majorPath, majorPath ? "/:major" : "").replace(/\/messages\/[^/]+/, "/messages/:id")}`;
    const routeKey = `discord:route:${route}`;
    const bucketKey = () => `discord:bucket:${scope}:${this.limits.get(routeKey) ?? route}:${major}`;
    const globalKey = `discord:global:${scope}`;
    const wait =
      Math.max(
        request.interaction ? 0 : Number(this.limits.get(globalKey) ?? 0),
        Number(this.limits.get(bucketKey()) ?? 0),
      ) - Date.now();
    if (wait > 0) throw new DiscordHttpError(429, undefined, "rate limited", wait);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const url = `${API_BASE}${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const headers = new Headers({ "user-agent": USER_AGENT });
    if (request.auth !== false) headers.set("authorization", `Bot ${this.token}`);
    if (request.body !== undefined) headers.set("content-type", "application/json");

    const response = await this.fetch(
      new Request(url, {
        method,
        headers,
        redirect: "manual",
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }),
    );
    const text = await response.text();
    const bucket = response.headers.get("x-ratelimit-bucket");
    if (bucket) this.limits.set(routeKey, bucket);
    const key = bucketKey();
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      this.reset(key, Date.now() + seconds(response.headers.get("x-ratelimit-reset-after")) * 1000);
    }

    if (response.ok) return result(text);

    const data = parseJson(text);
    if (response.status === 429) {
      const retryAt = Date.now() + seconds(field(data, "retry_after") ?? response.headers.get("retry-after")) * 1000;
      if (field(data, "global") === true || response.headers.get("x-ratelimit-global") === "true") {
        this.reset(request.interaction ? key : globalKey, retryAt);
      } else {
        this.reset(key, retryAt);
      }
      const wait = Math.max(0, retryAt - Date.now());
      throw new DiscordHttpError(429, errorCode(data), errorMessage(data, response.statusText), wait);
    }
    throw new DiscordHttpError(response.status, errorCode(data), errorMessage(data, response.statusText));
  }

  private reset(key: string, at: number): void {
    const until = Math.max(Number(this.limits.get(key) ?? 0), at);
    this.limits.set(key, String(until), Math.max(1, until - Date.now()));
  }
}

/**
 * A successful response's JSON (undefined for an empty body), typed by the caller's
 * discord-api-types result type. Discord's responses are trusted, not validated at runtime.
 */
function result(text: string) {
  return text === "" ? undefined : JSON.parse(text);
}

function field(data: unknown, key: string): unknown {
  return isRecord(data) ? data[key] : undefined;
}

function seconds(value: unknown): number {
  const number = Number(value ?? 1);
  return Number.isFinite(number) ? number : 1;
}

function errorCode(data: unknown): number | undefined {
  const code = field(data, "code");
  return typeof code === "number" ? code : undefined;
}

function errorMessage(data: unknown, fallback: string): string {
  const message = field(data, "message");
  return typeof message === "string" ? message.slice(0, 200) : fallback;
}
