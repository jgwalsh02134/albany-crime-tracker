/** Defense-in-depth input scrubbing — not a full HTML sanitizer. */

const TAG_RE = /<[^>]*>/g;

function stripControlChars(input: string): string {
  // Avoid control-char regexes (lint no-control-regex) while keeping behavior explicit.
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // 0x00-0x1F and DEL 0x7F
    if (c < 0x20 || c === 0x7f) continue;
    out += input[i]!;
  }
  return out;
}

/** Strip tags and control chars; collapse whitespace. */
export function stripHtml(input: string, maxLen: number): string {
  const withoutTags = String(input ?? "").replace(TAG_RE, " ");
  const clean = stripControlChars(withoutTags);
  return clean.replace(/\s+/g, " ").trim().slice(0, maxLen);
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
