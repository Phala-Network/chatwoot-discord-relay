// Discord users' avatars, so a linked agent's messages show the picture their team knows.

import { type APIUser, type RESTGetAPIUserResult, RouteBases, Routes } from "discord-api-types/v10";
import type { DiscordRest } from "./rest.ts";

/**
 * A user's avatar on Discord's CDN, per https://discord.com/developers/docs/reference#image-formatting:
 * their own as PNG (every avatar, animated `a_` ones included, is served as PNG), else the
 * default avatar Discord shows for them.
 */
export function avatarUrl(user: Pick<APIUser, "id" | "avatar" | "discriminator">): string {
  if (user.avatar) return `${RouteBases.cdn}/avatars/${user.id}/${user.avatar}.png`;
  // New username system (discriminator "0"): (user_id >> 22) % 6. Legacy: discriminator % 5.
  const index = user.discriminator === "0" ? Number((BigInt(user.id) >> 22n) % 6n) : Number(user.discriminator) % 5;
  return `${RouteBases.cdn}/embed/avatars/${index}.png`;
}

/** Looks up a user (GET /users/{user.id}) and returns their avatar URL. */
export async function fetchAvatarUrl(rest: DiscordRest, userId: string, signal?: AbortSignal): Promise<string> {
  return avatarUrl(await rest.get<RESTGetAPIUserResult>(Routes.user(userId), signal ? { signal } : {}));
}
