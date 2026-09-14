import { recordPipeFail, recordPipeOk } from "./pipe-health";

const UA =
  "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch; reddit-api)";

type TokenState = {
  accessToken: string;
  expiresAt: number;
  lastError: string;
  blockedUntil: number;
};

const g = globalThis as unknown as { __actReddit?: TokenState };

function state(): TokenState {
  if (!g.__actReddit) g.__actReddit = { accessToken: "", expiresAt: 0, lastError: "", blockedUntil: 0 };
  return g.__actReddit;
}

function authConfigured(): boolean {
  const id = (process.env.REDDIT_CLIENT_ID || "").trim();
  const secret = (process.env.REDDIT_CLIENT_SECRET || "").trim();
  const refresh = (process.env.REDDIT_REFRESH_TOKEN || "").trim();
  return Boolean(id && secret && refresh);
}

async function refreshAccessToken(now = Date.now()): Promise<string | null> {
  const s = state();
  if (!authConfigured()) return null;
  if (s.accessToken && s.expiresAt - now > 60_000) return s.accessToken;

  const id = (process.env.REDDIT_CLIENT_ID || "").trim();
  const secret = (process.env.REDDIT_CLIENT_SECRET || "").trim();
  const refresh = (process.env.REDDIT_REFRESH_TOKEN || "").trim();
  try {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refresh);
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = (await res.text().catch(() => "")).slice(0, 160);
      s.lastError = `token HTTP ${res.status} ${txt}`.trim();
      recordPipeFail("social:reddit", "Reddit", s.lastError);
      return null;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    const token = (json.access_token || "").trim();
    if (!token) {
      s.lastError = "token missing access_token";
      recordPipeFail("social:reddit", "Reddit", s.lastError);
      return null;
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    s.accessToken = token;
    s.expiresAt = now + Math.max(300, expiresIn) * 1000;
    s.lastError = "";
    return token;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message.slice(0, 160) : "token-error";
    recordPipeFail("social:reddit", "Reddit", s.lastError);
    return null;
  }
}

export function redditApiHealth() {
  const s = state();
  return {
    authConfigured: authConfigured(),
    blockedSec: s.blockedUntil > Date.now() ? Math.round((s.blockedUntil - Date.now()) / 1000) : 0,
    lastError: s.lastError || undefined,
  };
}

type RedditPost = {
  id: string;
  title: string;
  permalink: string;
  url: string;
  created_utc: number;
  subreddit: string;
  selftext?: string;
};

function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 1500 * 2 ** Math.max(0, attempt));
  const jitter = Math.round(Math.random() * 600);
  return base + jitter;
}

async function redditFetchJson(url: string, now: number, attempt = 0): Promise<unknown | null> {
  const s = state();
  if (s.blockedUntil && now < s.blockedUntil) {
    const remain = Math.max(0, Math.round((s.blockedUntil - now) / 1000));
    recordPipeFail("social:reddit", "Reddit", `rate-limited backoff ${remain}s`);
    return null;
  }
  const token = await refreshAccessToken(now);
  if (!token) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const wait = 5 * 60_000 + backoffMs(attempt);
      s.blockedUntil = now + wait;
      s.lastError = "HTTP 429 rate-limited";
      recordPipeFail("social:reddit", "Reddit", `HTTP 429 (backoff ${Math.round(wait / 1000)}s)`);
      return null;
    }
    if (res.status === 401 && attempt < 1) {
      // Token may have been revoked; clear and retry once.
      s.accessToken = "";
      s.expiresAt = 0;
      return redditFetchJson(url, now, attempt + 1);
    }
    if (!res.ok) {
      const txt = (await res.text().catch(() => "")).slice(0, 160);
      s.lastError = `HTTP ${res.status} ${txt}`.trim();
      recordPipeFail("social:reddit", "Reddit", s.lastError);
      return null;
    }
    s.lastError = "";
    return (await res.json()) as unknown;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message.slice(0, 160) : "reddit-error";
    recordPipeFail("social:reddit", "Reddit", s.lastError);
    return null;
  }
}

function parseListing(json: unknown): RedditPost[] {
  const root = json as { data?: { children?: { data?: Record<string, unknown> }[] } };
  const children = root?.data?.children ?? [];
  const out: RedditPost[] = [];
  for (const c of children) {
    const d = c?.data ?? {};
    const id = String(d.id || "").trim();
    const title = String(d.title || "").trim();
    const permalink = String(d.permalink || "").trim();
    const url = String(d.url || "").trim();
    const createdUtc = Number(d.created_utc);
    const subreddit = String(d.subreddit || "").trim();
    const selftext = String(d.selftext || "").trim();
    if (!id || !title || !permalink || !Number.isFinite(createdUtc)) continue;
    out.push({
      id,
      title,
      permalink,
      url,
      created_utc: createdUtc,
      subreddit,
      selftext,
    });
  }
  return out;
}

export async function redditApiFetch(opts: { now: number; subreddit: string; q?: string; limit?: number }): Promise<RedditPost[]> {
  const now = opts.now;
  const limit = Math.max(10, Math.min(50, opts.limit ?? 30));
  const sub = encodeURIComponent(opts.subreddit);
  const q = (opts.q || "").trim();
  const url = q
    ? `https://oauth.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=${limit}&t=week`
    : `https://oauth.reddit.com/r/${sub}/new.json?limit=${limit}`;
  const json = await redditFetchJson(url, now);
  if (!json) return [];
  return parseListing(json);
}

export function recordRedditOk(count: number) {
  recordPipeOk("social:reddit", "Reddit", count);
}

