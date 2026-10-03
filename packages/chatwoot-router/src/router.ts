import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import { Budget, BudgetExhaustedError, JOB_SLICE_MS } from "../../../shared/budget.ts";
import { ChatwootError, chatwootClient } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import type { Env } from "./env.ts";
import { routeConversation, routesAccount } from "./routing.ts";
import { loadSettings } from "./settings.ts";
import { clearFailures, expectActivity, recordFailure } from "./turn.ts";
import type { Transition } from "./webhook.ts";

export function conversationName(accountId: number, conversationId: number): string {
  return `${accountId}:${conversationId}`;
}
const ROUTE_BUDGET = 45;
const RUN_WALL_MS = 5 * 60 * 1000;
const id = z.number().int().positive();
const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route"), accountId: id, conversationId: id }),
]);
type Payload = z.infer<typeof jobSchema>;

export class Router extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    this.store = new QueueStore(context.storage.sql);
    this.store.migrate();
  }

  async enqueueConversation(accountId: number, conversationId: number, transition?: Transition): Promise<void> {
    const settings = await loadSettings(this.env);
    if (!routesAccount(settings, accountId)) return;
    if (transition) expectActivity(this.store, accountId, conversationId, transition);
    this.enqueue({ type: "route", accountId, conversationId });
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  override async alarm(): Promise<void> {
    const settings = await loadSettings(this.env);
    const budget = new Budget(settings.config.subrequestBudget);
    const chatwoot = chatwootClient(settings.config.chatwoot.baseUrl, settings.secrets.CHATWOOT_TOKEN, budget.fetch);
    const started = Date.now();
    let yielded = false;
    this.store.prune();
    for (let job = this.store.nextDueJob(); job; job = this.store.nextDueJob()) {
      const parsed = jobSchema.safeParse(parseJson(job.payload));
      if (!parsed.success) {
        log.warn("unreadable job dropped", { job: job.key });
        this.store.deleteJob(job.key);
        continue;
      }
      const payload = parsed.data;
      if (budget.remaining < ROUTE_BUDGET || Date.now() - started > RUN_WALL_MS) {
        yielded = true;
        break;
      }
      try {
        const ctx = { settings, chatwoot, store: this.store, fetch: budget.fetchWith(JOB_SLICE_MS) };
        if ((await routeConversation(ctx, payload.accountId, payload.conversationId)) === "defer") {
          this.store.deferJob(job);
          yielded = true;
          break;
        }
        clearFailures(this.store, payload.accountId, payload.conversationId);
        this.store.completeJob(job);
      } catch (error) {
        if (error instanceof ChatwootError && error.conversationMissing) {
          log.info("conversation deleted; job dropped", { job: job.key });
          this.store.deleteJob(job.key);
          continue;
        }
        if (error instanceof BudgetExhaustedError) {
          this.store.deferJob(job);
          yielded = true;
          break;
        }
        const attempts = recordFailure(this.store, payload.accountId, payload.conversationId);
        const delay = retryDelay(attempts - 1);
        const logAt = attempts >= 3 ? log.error : log.warn;
        logAt("job failed; will retry", {
          job: job.key,
          attempts,
          delayMs: delay,
          ...errorFields(error),
        });
        this.store.retryJob(job, delay);
      }
    }
    await scheduleAlarm(this.ctx, yielded ? Date.now() : this.store.nextWakeup());
  }

  private enqueue(payload: Payload): void {
    this.store.enqueue(`route:${payload.accountId}:${payload.conversationId}`, 0, JSON.stringify(payload));
  }
}
