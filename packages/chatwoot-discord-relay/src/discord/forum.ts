// The forum channel as seen by the bot: the webhook used to post messages under each sender's
// name, and its guild (for post links).

import {
  type RESTDeleteAPIWebhookWithTokenMessageQuery,
  type RESTDeleteAPIWebhookWithTokenMessageResult,
  type RESTGetAPIChannelResult,
  type RESTGetAPIChannelWebhooksResult,
  type RESTGetCurrentApplicationResult,
  type RESTPatchAPIChannelJSONBody,
  type RESTPatchAPIChannelResult,
  type RESTPatchAPIWebhookWithTokenMessageJSONBody,
  type RESTPatchAPIWebhookWithTokenMessageQuery,
  type RESTPatchAPIWebhookWithTokenMessageResult,
  type RESTPostAPIChannelWebhookJSONBody,
  type RESTPostAPIChannelWebhookResult,
  type RESTPostAPIWebhookWithTokenJSONBody,
  type RESTPostAPIWebhookWithTokenQuery,
  type RESTPostAPIWebhookWithTokenWaitResult,
  type RESTPutAPIChannelThreadMembersResult,
  Routes,
  WebhookType,
} from "discord-api-types/v10";
import { BudgetExhaustedError, JobDeadlineError } from "../../../../shared/budget.ts";
import { parallel } from "../../../../shared/concurrent.ts";
import { isRecord, parseJson } from "../../../../shared/json.ts";
import { log } from "../../../../shared/log.ts";
import { type ForumClient, UnknownSendError, UnknownThreadError, type WebhookMessage } from "../relay/relay.ts";
import { DiscordHttpError, type DiscordRest } from "./rest.ts";

export { UnknownSendError } from "../relay/relay.ts";

const WEBHOOK_NAME = "Chatwoot";
/** Discord answers a request to a deleted post with this code, with HTTP 404 or, for a webhook, 400. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_WEBHOOK = 10015;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_TAG = 10087;
const APPLICATION_KEY = "discord:application";

export interface Cache {
  get(key: string): string | undefined;
  /** `ttlMs` undefined keeps the value until it is deleted. */
  set(key: string, value: string, ttlMs?: number): void;
  delete(key: string): void;
}

export class DiscordForum implements ForumClient {
  constructor(
    private readonly rest: DiscordRest,
    private readonly cache: Cache,
  ) {}

  async execute(
    forumChannelId: string,
    message: WebhookMessage,
    threadId?: string,
    sendKey?: string,
  ): Promise<{ channelId: string; messageId: string }> {
    const key = sendKey ? `send:${sendKey}` : undefined;
    const saved = key ? this.cache.get(key) : undefined;
    if (saved !== undefined) {
      const receipt = parseJson(saved);
      if (isRecord(receipt) && typeof receipt.channelId === "string" && typeof receipt.messageId === "string")
        return { channelId: receipt.channelId, messageId: receipt.messageId };
      throw new UnknownSendError();
    }
    const webhook = await this.webhook(forumChannelId);
    try {
      const sent = await this.withTags(forumChannelId, message.applied_tags, async (tags) => {
        if (key) this.cache.set(key, "unknown");
        try {
          return await this.rest.post<
            RESTPostAPIWebhookWithTokenWaitResult,
            RESTPostAPIWebhookWithTokenJSONBody,
            RESTPostAPIWebhookWithTokenQuery
          >(Routes.webhook(webhook.id, webhook.token), {
            body: tags ? { ...message, applied_tags: tags } : message,
            query: { wait: true, with_components: true, ...(threadId ? { thread_id: threadId } : {}) },
            auth: false,
          });
        } catch (error) {
          if (isUnknownWrite(error)) throw new UnknownSendError(error);
          if (
            key &&
            ((error instanceof DiscordHttpError && error.status >= 400 && error.status < 500) ||
              error instanceof BudgetExhaustedError ||
              (error instanceof JobDeadlineError && !error.requestStarted))
          )
            this.cache.delete(key);
          throw error;
        }
      });
      if (!sent?.channel_id || !sent.id) throw new UnknownSendError();
      const receipt = { channelId: sent.channel_id, messageId: sent.id };
      if (key) this.cache.set(key, JSON.stringify(receipt));
      return receipt;
    } catch (error) {
      if (threadId && isUnknownChannel(error)) throw new UnknownThreadError(threadId);
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_WEBHOOK) {
          // Someone deleted the webhook: forget it so the next attempt creates a new one.
          this.cache.delete(webhookKey(forumChannelId));
        } else if (threadId) {
          throw new UnknownThreadError(threadId);
        }
      }
      throw error;
    }
  }

  async updateThread(
    forumChannelId: string,
    threadId: string,
    patch: { archived: boolean; applied_tags?: string[]; name?: string },
  ): Promise<void> {
    try {
      await this.withTags(forumChannelId, patch.applied_tags, (tags) =>
        this.rest.patch<RESTPatchAPIChannelResult, RESTPatchAPIChannelJSONBody>(Routes.channel(threadId), {
          body: tags ? { ...patch, applied_tags: tags } : patch,
        }),
      );
    } catch (error) {
      if (error instanceof DiscordHttpError && error.status === 404 && error.code !== UNKNOWN_TAG) {
        throw new UnknownThreadError(threadId);
      }
      throw error;
    }
  }

  async editMessage(
    forumChannelId: string,
    threadId: string,
    messageId: string,
    message: WebhookMessage,
  ): Promise<boolean> {
    const webhook = await this.webhook(forumChannelId);
    try {
      await this.rest.patch<
        RESTPatchAPIWebhookWithTokenMessageResult,
        RESTPatchAPIWebhookWithTokenMessageJSONBody,
        RESTPatchAPIWebhookWithTokenMessageQuery
      >(Routes.webhookMessage(webhook.id, webhook.token, messageId), {
        body: message,
        query: { thread_id: threadId, with_components: true },
        auth: false,
      });
      return true;
    } catch (error) {
      if (isUnknownChannel(error)) throw new UnknownThreadError(threadId);
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_MESSAGE) return false;
        if (error.code === UNKNOWN_WEBHOOK) this.cache.delete(webhookKey(forumChannelId));
        else throw new UnknownThreadError(threadId);
      }
      throw error;
    }
  }

  async deleteMessage(forumChannelId: string, threadId: string, messageId: string): Promise<void> {
    const webhook = await this.webhook(forumChannelId);
    try {
      await this.rest.delete<RESTDeleteAPIWebhookWithTokenMessageResult, RESTDeleteAPIWebhookWithTokenMessageQuery>(
        Routes.webhookMessage(webhook.id, webhook.token, messageId),
        { query: { thread_id: threadId }, auth: false },
      );
    } catch (error) {
      // Gone with its post, or by itself.
      if (isUnknownChannel(error)) return;
      if (error instanceof DiscordHttpError && error.status === 404) {
        if (error.code === UNKNOWN_MESSAGE) return;
        if (error.code === UNKNOWN_WEBHOOK) this.cache.delete(webhookKey(forumChannelId));
      }
      throw error;
    }
  }

  async threadExists(forumChannelId: string, threadId: string): Promise<boolean> {
    try {
      const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(threadId));
      return "parent_id" in channel && channel.parent_id === forumChannelId;
    } catch (error) {
      if (error instanceof DiscordHttpError && (error.status === 404 || error.status === 403)) return false;
      throw error;
    }
  }

  async postUrl(forumChannelId: string, threadId: string): Promise<string> {
    const key = `forum:${forumChannelId}:guild`;
    let guildId = this.cache.get(key);
    if (!guildId) {
      const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(forumChannelId));
      guildId = "guild_id" in channel ? (channel.guild_id ?? "") : "";
      if (guildId) this.cache.set(key, guildId); // A channel never changes its guild.
    }
    return `https://discord.com/channels/${guildId}/${threadId}`;
  }

  async addMember(threadId: string, userId: string): Promise<void> {
    await this.rest.put<RESTPutAPIChannelThreadMembersResult, never>(Routes.threadMembers(threadId, userId), {});
  }

  /**
   * Reuses the forum's incoming webhook this application created, or creates it. A webhook is
   * recognized by its creator's application id, not its name: another integration's webhook of
   * the same name is never used.
   */
  private async webhook(forumChannelId: string): Promise<{ id: string; token: string }> {
    const key = webhookKey(forumChannelId);
    const [id, token] = this.cache.get(key)?.split(":") ?? [];
    if (id && token) return { id, token };
    const [applicationId, hooks] = await parallel(
      this.applicationId(),
      this.rest.get<RESTGetAPIChannelWebhooksResult>(Routes.channelWebhooks(forumChannelId)),
    );
    const existing = hooks.find(
      (hook) => hook.type === WebhookType.Incoming && hook.application_id === applicationId && hook.token,
    );
    const hook =
      existing ??
      (await this.rest.post<RESTPostAPIChannelWebhookResult, RESTPostAPIChannelWebhookJSONBody>(
        Routes.channelWebhooks(forumChannelId),
        { body: { name: WEBHOOK_NAME } },
      ));
    if (!hook.token) throw new Error("Discord returned a webhook without a token");
    this.cache.set(key, `${hook.id}:${hook.token}`);
    return { id: hook.id, token: hook.token };
  }

  /** This bot's application id, which never changes. */
  private async applicationId(): Promise<string> {
    const cached = this.cache.get(APPLICATION_KEY);
    if (cached) return cached;
    const { id } = await this.rest.get<RESTGetCurrentApplicationResult>(Routes.currentApplication());
    this.cache.set(APPLICATION_KEY, id);
    return id;
  }

  /**
   * Sends a request that applies configured forum tags. A tag deleted in Discord makes Discord
   * refuse the request: Discord documents JSON code 10087 (Unknown Tag) but not its HTTP status,
   * and refuses an invalid form body with 400. On either, the request is sent once more with only
   * the tags the forum still has, and the missing ones are logged: `forumTags` needs updating.
   */
  private async withTags<T>(
    forumChannelId: string,
    tags: string[] | undefined,
    send: (tags: string[] | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(tags);
    } catch (error) {
      const refused = error instanceof DiscordHttpError && (error.status === 400 || error.code === UNKNOWN_TAG);
      if (!refused || !tags?.length) throw error;
      const channel = await this.rest.get<RESTGetAPIChannelResult>(Routes.channel(forumChannelId));
      const existing = new Set("available_tags" in channel ? channel.available_tags.map((tag) => tag.id) : []);
      const missing = tags.filter((id) => !existing.has(id));
      if (missing.length === 0) throw error;
      log.warn("forumTags has tags the forum no longer has", { forumChannelId, missing: missing.join(",") });
      return send(tags.filter((id) => existing.has(id)));
    }
  }
}

function isUnknownChannel(error: unknown): boolean {
  return error instanceof DiscordHttpError && error.code === UNKNOWN_CHANNEL;
}

function webhookKey(forumChannelId: string): string {
  return `forum:${forumChannelId}:webhook`;
}

function isUnknownWrite(error: unknown): boolean {
  return (
    (error instanceof DiscordHttpError && error.status >= 500) ||
    error instanceof TypeError ||
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
  );
}
