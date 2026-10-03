import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isFreshTimestamp, verifyChatwootSignature } from "../../../shared/chatwoot/signature.ts";
import { ConfigError } from "../../../shared/config.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { COORDINATOR_NAME } from "./coordinator.ts";
import type { Env } from "./env.ts";
import { conversationName } from "./router.ts";
import { routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";
import { eventTarget } from "./webhook.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", async (context) => {
  try {
    await loadSettings(context.env);
    return context.json({ ok: true });
  } catch (error) {
    log.error(error instanceof ConfigError ? "configuration invalid" : "configuration unavailable", errorFields(error));
    return context.json({ ok: false }, 503);
  }
});

app.post("/chatwoot/agent-bot", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (context) => {
  const settings = await loadSettings(context.env);
  const timestamp = context.req.header("x-chatwoot-timestamp");
  if (!timestamp || !isFreshTimestamp(timestamp, Math.floor(Date.now() / 1000))) {
    return context.text("invalid or stale timestamp", 401);
  }
  const body = new Uint8Array(await context.req.arrayBuffer());
  const signature = context.req.header("x-chatwoot-signature");
  let signedBy: number | undefined;
  for (const [accountId, secret] of Object.entries(settings.secrets.CHATWOOT_AGENT_BOT_SECRETS)) {
    if (await verifyChatwootSignature(secret, timestamp, body, signature)) {
      signedBy = Number(accountId);
      break;
    }
  }
  if (signedBy === undefined) return context.text("invalid signature", 401);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return context.text("bad request", 400);
  }
  const target = eventTarget(payload);
  if (!target) return context.json({ ok: true, ignored: true });
  if (target.accountId !== signedBy || !routesAccount(settings, target.accountId)) {
    return context.text("account does not match the webhook secret", 403);
  }
  await context.env.ROUTER.getByName(conversationName(target.accountId, target.conversationId)).enqueueConversation(
    target.accountId,
    target.conversationId,
    target.transition,
  );
  return context.json({ ok: true });
});

app.notFound((context) => context.text("not found", 404));
app.onError((error, context) => {
  log.error("request failed", { path: context.req.path, ...errorFields(error) });
  return context.text("internal error", 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, context) {
    context.waitUntil(env.COORDINATOR.getByName(COORDINATOR_NAME).requestSweep());
  },
} satisfies ExportedHandler<Env>;

export { Coordinator } from "./coordinator.ts";
export { Router } from "./router.ts";
