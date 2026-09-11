/**
 * Minimal Redis INCR/EXPIRE over TCP when REDIS_URL is set (e.g. Railway Redis).
 * RESP subset only — no extra dependency. Returns null on any failure.
 */
import net from "node:net";

function parseRedisUrl(raw: string): { host: string; port: number; password?: string; db?: number } | null {
  try {
    const u = new URL(raw);
    // Plain redis:// only — rediss:// needs TLS; callers fall back to memory/Upstash.
    if (u.protocol !== "redis:") return null;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    const dbPath = u.pathname?.replace(/^\//, "");
    const db = dbPath && /^\d+$/.test(dbPath) ? Number(dbPath) : undefined;
    return {
      host: u.hostname || "127.0.0.1",
      port: u.port ? Number(u.port) : 6379,
      password,
      db,
    };
  } catch {
    return null;
  }
}

function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a, "utf8");
    out += `$${b.length}\r\n${a}\r\n`;
  }
  return out;
}

function readRedisReply(buf: Buffer): { value: unknown; rest: Buffer } | null {
  if (buf.length < 3) return null;
  const kind = String.fromCharCode(buf[0]!);
  if (kind === "+" || kind === "-" || kind === ":") {
    const idx = buf.indexOf("\r\n");
    if (idx < 0) return null;
    const body = buf.subarray(1, idx).toString("utf8");
    const rest = buf.subarray(idx + 2);
    if (kind === "+") return { value: body, rest };
    if (kind === "-") return { value: new Error(body), rest };
    return { value: Number(body), rest };
  }
  if (kind === "$") {
    const idx = buf.indexOf("\r\n");
    if (idx < 0) return null;
    const len = Number(buf.subarray(1, idx).toString("utf8"));
    if (!Number.isFinite(len)) return null;
    if (len < 0) return { value: null, rest: buf.subarray(idx + 2) };
    const start = idx + 2;
    const end = start + len;
    if (buf.length < end + 2) return null;
    const value = buf.subarray(start, end).toString("utf8");
    return { value, rest: buf.subarray(end + 2) };
  }
  return null;
}

async function redisTxn(commands: string[][]): Promise<unknown[] | null> {
  const raw = (process.env.REDIS_URL || "").trim();
  if (!raw) return null;
  const parsed = parseRedisUrl(raw);
  if (!parsed) return null;

  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: parsed.host, port: parsed.port });
    let buf = Buffer.alloc(0);
    const replies: unknown[] = [];
    let expected = 0;
    let settled = false;

    const done = (value: unknown[] | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const timer = setTimeout(() => done(null), 800);

    const flushParse = () => {
      while (true) {
        const parsedReply = readRedisReply(buf);
        if (!parsedReply) break;
        buf = parsedReply.rest;
        if (parsedReply.value instanceof Error) {
          clearTimeout(timer);
          done(null);
          return;
        }
        replies.push(parsedReply.value);
        if (replies.length >= expected) {
          clearTimeout(timer);
          done(replies);
          return;
        }
      }
    };

    socket.on("connect", () => {
      const prelude: string[][] = [];
      if (parsed.password) prelude.push(["AUTH", parsed.password]);
      if (parsed.db != null) prelude.push(["SELECT", String(parsed.db)]);
      const all = [...prelude, ...commands];
      expected = all.length;
      socket.write(all.map(encodeCommand).join(""));
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      flushParse();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    socket.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        done(null);
      }
    });
  });
}

/** INCR key + EXPIRE NX windowSec. Returns new count or null on failure. */
export async function redisIncrExpire(key: string, windowSec: number): Promise<number | null> {
  const raw = (process.env.REDIS_URL || "").trim();
  const parsed = parseRedisUrl(raw);
  if (!parsed) return null;
  const replies = await redisTxn([
    ["INCR", key],
    ["EXPIRE", key, String(windowSec), "NX"],
  ]);
  if (!replies || replies.length < 1) return null;
  const offset = (parsed.password ? 1 : 0) + (parsed.db != null ? 1 : 0);
  const count = Number(replies[offset]);
  return Number.isFinite(count) ? count : null;
}
