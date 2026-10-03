import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { scheduleAlarm } from "../../../shared/alarm.ts";
import { Budget } from "../../../shared/budget.ts";
import { chatwootClient } from "../../../shared/chatwoot/api.ts";
import { parseJson } from "../../../shared/json.ts";
import { errorFields, log } from "../../../shared/log.ts";
import { QueueStore, retryDelay } from "../../../shared/store.ts";
import type { Env } from "./env.ts";
import { conversationName } from "./router.ts";
import { loadSettings } from "./settings.ts";

export const COORDINATOR_NAME = "global";
const sweepSchema = z.object({ accountId: z.number().int().positive(), status: z.enum(["pending", "open"]) });

/** Lists one page per alarm. Conversation state belongs exclusively to the conversation's Router. */
export class Coordinator extends DurableObject<Env> {
  private readonly store: QueueStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new QueueStore(ctx.storage.sql);
    this.store.migrate();
  }

  async requestSweep(): Promise<void> {
    for (const accountId of Object.keys((await loadSettings(this.env)).config.routing.accounts)) {
      for (const status of ["pending", "open"] as const) {
        this.store.enqueue(`sweep:${accountId}:${status}`, 0, JSON.stringify({ accountId: Number(accountId), status }));
      }
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }

  override async alarm(): Promise<void> {
    const job = this.store.nextDueJob();
    if (!job) return;
    const parsed = sweepSchema.safeParse(parseJson(job.payload));
    if (!parsed.success) {
      this.store.deleteJob(job.key);
    } else {
      try {
        const settings = await loadSettings(this.env);
        const { accountId, status } = parsed.data;
        const budget = new Budget(settings.config.subrequestBudget);
        const chatwoot = chatwootClient(
          settings.config.chatwoot.baseUrl,
          settings.secrets.CHATWOOT_TOKEN,
          budget.fetch,
        );
        const saved = z
          .number()
          .int()
          .positive()
          .safeParse(parseJson(this.store.get(job.key)));
        const page = saved.success ? saved.data : 1;
        const conversations = await chatwoot.listConversations(accountId, page, status);
        const botId = settings.config.routing.botIds[String(accountId)];
        for (const conversation of conversations) {
          if (
            conversation.id === undefined ||
            (status !== "pending" &&
              !(conversation.meta?.assignee_type === "AgentBot" && conversation.meta.assignee?.id === botId))
          )
            continue;
          // Each RPC counts toward the invocation too; a page contains at most 25 conversations.
          budget.consume();
          await this.env.ROUTER.getByName(conversationName(accountId, conversation.id)).enqueueConversation(
            accountId,
            conversation.id,
          );
        }
        this.store.completeJob(job);
        if (conversations.length === 0) this.store.delete(job.key);
        else {
          this.store.set(job.key, String(page + 1));
          this.store.enqueue(job.key, 0, job.payload);
        }
      } catch (error) {
        this.store.retryJob(job, retryDelay(job.attempts));
        log.warn("sweep page failed; will retry", { job: job.key, ...errorFields(error) });
      }
    }
    await scheduleAlarm(this.ctx, this.store.nextWakeup());
  }
}
