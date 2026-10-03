import { vi } from "vitest";

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  redirect: Request["redirect"];
  signal: AbortSignal;
  body: string;
  form: FormData | undefined;
}

export type Route = (request: Recorded) => Response | Promise<Response> | undefined;

/** Requests no route answered, as "<method> <url>", until the test ends (see setup.ts). */
const unmatched: string[] = [];

/** The requests no route answered since the last call. */
export function takeUnmatched(): string[] {
  return unmatched.splice(0);
}

/**
 * Replaces global fetch with a router. An unmatched request gets HTTP 599 instead of reaching the
 * network, and fails the test when it ends (application code may well handle the 599).
 */
export function mockFetch(...routes: Route[]) {
  const requests: Recorded[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const type = request.headers.get("content-type") ?? "";
    const form = type.startsWith("multipart/form-data") ? await request.clone().formData() : undefined;
    const recorded: Recorded = {
      signal: request.signal,
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      redirect: request.redirect,
      body: form ? "" : await request.text(),
      form,
    };
    requests.push(recorded);
    for (const route of routes) {
      const response = await route(recorded);
      if (response) return response;
    }
    unmatched.push(`${request.method} ${request.url}`);
    return new Response(JSON.stringify({ message: `unmocked ${request.method} ${request.url}` }), { status: 599 });
  });
  return { requests, spy };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function on(
  method: string,
  path: string | RegExp,
  respond: (request: Recorded) => Response | Promise<Response>,
): Route {
  return (request) => {
    const target = `${request.url.hostname}${request.url.pathname}`;
    const matches = typeof path === "string" ? target === path : path.test(target);
    return request.method === method && matches ? respond(request) : undefined;
  };
}
