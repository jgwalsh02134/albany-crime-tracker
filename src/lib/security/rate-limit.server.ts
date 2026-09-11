import { getRequest } from "@tanstack/react-start/server";
import { redisIncrExpire } from "./redis-tcp.server";

type Bucket = { count: number; resetAt: number };
type MemoryState = { buckets: Map<string, Bucket> };

const g = globalThis as typeof globalThis & { __actRateLimit?: MemoryState };

function memory(): MemoryState {
  if (!g.__actRateLimit) g.__actRateLimit = { buckets: new Map() };
  return g.__actRateLimit;
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
  backend: "memory" | "redis";
};

export type RateLimitOpts = {
  name: string;
  limit: number;
  windowSec: number;
  key?: string;
};

export function clientIpFromRequest(request: Request | undefined): string {
  if (!request) return "unknown";
  const xf = request.headers.get("x-forwarded-for");
  if (xf) {
    const first = xf.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 128);
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 128);
  return "unknown";
}

function memoryConsume(bucketKey: string, limit: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  const st = memory();
  if (st.buckets.size > 5000) {
    for (const [k, v] of st.buckets) {
      if (v.resetAt <= now) st.buckets.delete(k);
    }
  }
  let b = st.buckets.get(bucketKey);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowSec * 1000 };
    st.buckets.set(bucketKey, b);
  }
  b.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  if (b.count > limit) {
    return { ok: false, remaining: 0, retryAfterSec, backend: "memory" };
  }
  return { ok: true, remaining: Math.max(0, limit - b.count), retryAfterSec, backend: "memory" };
}

async function upstashConsume(
  bucketKey: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult | null> {
  const base = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!base || !token) return null;
  try {
    const pipeline = [
      ["INCR", bucketKey],
      ["EXPIRE", bucketKey, String(windowSec), "NX"],
    ];
    const res = await fetch(`${base}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pipeline),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: unknown }[];
    const count = Number(data?.[0]?.result ?? 0);
    if (!Number.isFinite(count) || count <= 0) return null;
    if (count > limit) {
      return { ok: false, remaining: 0, retryAfterSec: windowSec, backend: "redis" };
    }
    return {
      ok: true,
      remaining: Math.max(0, limit - count),
      retryAfterSec: windowSec,
      backend: "redis",
    };
  } catch {
    return null;
  }
}

async function redisUrlConsume(
  bucketKey: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult | null> {
  if (!(process.env.REDIS_URL || "").trim()) return null;
  const count = await redisIncrExpire(bucketKey, windowSec);
  if (count == null) return null;
  if (count > limit) {
    return { ok: false, remaining: 0, retryAfterSec: windowSec, backend: "redis" };
  }
  return {
    ok: true,
    remaining: Math.max(0, limit - count),
    retryAfterSec: windowSec,
    backend: "redis",
  };
}

/**
 * IP-based fixed-window rate limit.
 * Prefer Upstash REST, then REDIS_URL TCP, else in-memory (per process).
 */
export async function rateLimit(opts: RateLimitOpts): Promise<RateLimitResult> {
  const request = getRequest();
  const ip = opts.key || clientIpFromRequest(request);
  const bucketKey = `rl:${opts.name}:${ip}`;
  return (
    (await upstashConsume(bucketKey, opts.limit, opts.windowSec)) ||
    (await redisUrlConsume(bucketKey, opts.limit, opts.windowSec)) ||
    memoryConsume(bucketKey, opts.limit, opts.windowSec)
  );
}

/** Rate-limit using an explicit Request (route handlers). */
export async function rateLimitRequest(
  request: Request,
  opts: Omit<RateLimitOpts, "key"> & { key?: string },
): Promise<RateLimitResult> {
  const ip = opts.key || clientIpFromRequest(request);
  const bucketKey = `rl:${opts.name}:${ip}`;
  return (
    (await upstashConsume(bucketKey, opts.limit, opts.windowSec)) ||
    (await redisUrlConsume(bucketKey, opts.limit, opts.windowSec)) ||
    memoryConsume(bucketKey, opts.limit, opts.windowSec)
  );
}

export function rateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    { ok: false, error: "rate limit exceeded" },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSec),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}
