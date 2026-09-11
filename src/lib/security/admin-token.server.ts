import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

/** Constant-time string compare (length mismatch still returns false safely). */
export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) {
    // Burn comparable work so length differences are not a free early-exit oracle.
    if (left.length > 0) timingSafeEqual(left, left);
    return false;
  }
  if (left.length === 0) return true;
  return timingSafeEqual(left, right);
}

/**
 * Admin / ops token for rich /ready and Superfeedr subscribe.
 * Prefers SUPERFEEDR_ADMIN_TOKEN, then READY_ADMIN_TOKEN, then SUPERFEEDR_SECRET.
 */
export function expectedAdminToken(): string {
  return (
    process.env.SUPERFEEDR_ADMIN_TOKEN ||
    process.env.READY_ADMIN_TOKEN ||
    process.env.SUPERFEEDR_SECRET ||
    ""
  ).trim();
}

/** Extract Bearer or ?token= from a request. */
export function extractPresentedToken(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (bearer) return bearer;
  try {
    return new URL(request.url).searchParams.get("token") || "";
  } catch {
    return "";
  }
}

/**
 * True when the request presents a matching admin token.
 * If no token is configured, returns `allowIfUnset` (default false for /ready rich;
 * subscribe may pass true for private single-tenant deploys).
 */
export function isAdminAuthorized(request: Request, allowIfUnset = false): boolean {
  const expected = expectedAdminToken();
  if (!expected) return allowIfUnset;
  const presented = extractPresentedToken(request);
  if (!presented) return false;
  return safeEqualString(presented, expected);
}
