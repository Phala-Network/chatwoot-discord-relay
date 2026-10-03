// Worker entry: verifies and acknowledges Chatwoot webhooks and Discord interactions, and hands
// all slow work to the Hub Durable Object. Each request stays within a few milliseconds of CPU.

import type { APIInteraction } from "discord-api-types/v10";
import { verifyKey } from "discord-interactions";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { within } from "../../../shared/deadline.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { eventTarget, isFreshTimestamp, verifyChatwootSignature } from "./chatwoot/webhook.ts";
import { CONTENT_MAX } from "./commands/definitions.ts";
import { ConfigError } from "./config.ts";
import type { Env } from "./env.ts";
import { HUB_NAME } from "./hub.ts";
import { loadSettings } from "./settings.ts";

const INTERACTION_DEADLINE_MS = 2500;

const app = new Hono<{ Bindings: Env }>();

function hub(env: Env) {
  return env.HUB.getByName(HUB_NAME);
}

app.get("/healthz", async (c) => {
  try {
    await loadSettings(c.env);
    return c.json({ ok: true });
  } catch (error) {
    log.error(error instanceof ConfigError ? "configuration invalid" : "configuration unavailable", errorFields(error));
    return c.json({ ok: false }, 503);
  }
});

app.post("/chatwoot/webhook", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
  const settings = await loadSettings(c.env);
  const timestamp = c.req.header("x-chatwoot-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return c.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  const signature = c.req.header("x-chatwoot-signature");

  // The secret that verifies the request identifies the account it came from.
  let signedBy: number | undefined;
  for (const [accountId, secret] of Object.entries(settings.secrets.CHATWOOT_WEBHOOK_SECRETS)) {
    if (await verifyChatwootSignature(secret, timestamp, body, signature)) {
      signedBy = Number(accountId);
      break;
    }
  }
  if (signedBy === undefined) return c.text("invalid signature", 401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.text("bad request", 400);
  }
  const target = eventTarget(payload);
  if (!target) return c.json({ ok: true, ignored: true });
  if (target.accountId !== signedBy || !settings.account(target.accountId)) {
    return c.text("account does not match the webhook secret", 403);
  }

  const stub = hub(c.env);
  if (target.type === "message-updated") {
    await stub.enqueueMessageUpdate(target.accountId, target.conversationId, target.messageId);
  } else {
    await stub.enqueueConversation(target.accountId, target.conversationId, target.delayMs);
  }
  return c.json({ ok: true });
});

// The triage bot's hook, signed like Chatwoot's webhooks: its answer `answerId` to message
// `replyTo` is in the post `threadId`, with the reply `draft` it proposes (see Hub.triageAnswered).
const answerSchema = z.strictObject({
  threadId: z.string().regex(/^\d{17,20}$/),
  answerId: z.string().regex(/^\d{17,20}$/),
  replyTo: z.string().regex(/^\d{17,20}$/),
  draft: z.string().trim().min(1).max(CONTENT_MAX),
});

app.post("/triage/answered", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
  const secret = (await loadSettings(c.env)).secrets.TRIAGE_HOOK_SECRET;
  if (!secret) return c.text("not found", 404);
  const timestamp = c.req.header("x-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return c.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (!(await verifyChatwootSignature(secret, timestamp, body, c.req.header("x-signature")))) {
    return c.text("invalid signature", 401);
  }
  let answer: z.infer<typeof answerSchema>;
  try {
    answer = answerSchema.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return c.text("bad request", 400);
  }
  await hub(c.env).triageAnswered(answer.threadId, answer.answerId, answer.replyTo, answer.draft);
  return c.json({ ok: true });
});

app.post("/discord/interactions", async (c) => {
  const deadline = AbortSignal.timeout(INTERACTION_DEADLINE_MS);
  try {
    const response = await within(
      (async () => {
        const settings = await loadSettings(c.env);
        const signature = c.req.header("x-signature-ed25519");
        const timestamp = c.req.header("x-signature-timestamp");
        const body = await interactionBody(c.req.raw, deadline);
        if (!body) return c.text("payload too large", 413);
        if (
          !signature ||
          !timestamp ||
          !(await verifyKey(body, signature, timestamp, settings.secrets.DISCORD_PUBLIC_KEY))
        )
          return c.text("invalid request signature", 401);
        if (!isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) return c.text("stale request", 401);
        let interaction: APIInteraction;
        try {
          interaction = JSON.parse(new TextDecoder().decode(body));
        } catch {
          return c.text("bad request", 400);
        }
        deadline.throwIfAborted();
        return c.json(await hub(c.env).interaction(interaction));
      })(),
      deadline,
    );
    return response;
  } catch (error) {
    log.error("interaction initial response failed", errorFields(error));
    return c.text("The request could not be confirmed in time. Check in Chatwoot before trying again.", 503);
  }
});

app.notFound((c) => c.text("not found", 404));

app.onError((error, c) => {
  log.error("request failed", { path: c.req.path, ...errorFields(error) });
  return c.text("internal error", 500);
});

const handler = {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(hub(env).requestSweep());
    // The support queue is posted hourly, by the run at minute 0.
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) ctx.waitUntil(hub(env).requestQueue());
  },
} satisfies ExportedHandler<Env>;

export default handler;

export { Hub } from "./hub.ts";

async function interactionBody(request: Request, signal: AbortSignal): Promise<ArrayBuffer | undefined> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), signal);
      if (done) return await new Blob(chunks).arrayBuffer();
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
