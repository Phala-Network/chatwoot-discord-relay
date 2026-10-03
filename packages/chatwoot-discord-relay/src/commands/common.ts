// Messages, errors, and checks shared by the interaction handler (Worker) and the deferred
// command runner (Durable Object).

export const UNKNOWN_RESULT = "❌ The result is unknown. Check in Chatwoot before trying again.";
export const FAILED = "❌ That did not work. Please do it in Chatwoot.";
export const NOT_LINKED = "Your Discord account is not linked to a Chatwoot agent.";

const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** A problem the invoker should see. Other errors get a generic message. */
export class UserError extends Error {}

export function isDiscordAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ATTACHMENT_HOSTS.has(url.hostname) && url.port === "";
  } catch {
    return false;
  }
}

export function fileTooLarge(maxBytes: number): UserError {
  return new UserError(`Each attachment must be ${megabytes(maxBytes)} MB or smaller.`);
}

export function filesTooLarge(maxTotalBytes: number): UserError {
  return new UserError(`Attachments must add up to ${megabytes(maxTotalBytes)} MB or less.`);
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}
