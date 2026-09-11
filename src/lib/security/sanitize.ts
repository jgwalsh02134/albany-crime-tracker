/** Defense-in-depth input scrubbing — not a full HTML sanitizer. */

const TAG_RE = /<[^>]*>/g;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip tags and control chars; collapse whitespace. */
export function stripHtml(input: string, maxLen: number): string {
  return String(input ?? "")
    .replace(TAG_RE, " ")
    .replace(CTRL_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

const WEBHOOK_OK_TYPES = [
  "application/json",
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
  "text/plain",
];

/** True when Content-Type is empty (some hubs) or an expected feed/json type. */
export function isAllowedWebhookContentType(contentType: string | null): boolean {
  const raw = (contentType || "").trim().toLowerCase();
  if (!raw) return true;
  const base = raw.split(";", 1)[0]!.trim();
  return WEBHOOK_OK_TYPES.some((t) => base === t || base.endsWith("+json") || base.endsWith("+xml"));
}

export const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
