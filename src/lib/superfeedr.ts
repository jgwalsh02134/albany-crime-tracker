import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { locateSpoken, placeFromText } from "./geo";
import type { LiveWireItem } from "./sources";

const LOCAL =
  /\b(albany|colonie|bethlehem|guilderland|cohoes|watervliet|menands|latham|delmar|new scotland|westerlo|coeymans|loudonville|altamont|ravena|selkirk|glenmont|green island|capital region|troop g|clifton park|troy|schenectady|rensselaer|sand lake|schodack|east greenbush)\b/i;
const CRIME =
  /\b(crash|collision|shot|shooting|homicide|murder|stabbing|stab|robbery|arrests?|arrested|fire|blaze|killed|injured|fatal|burglary|assault|charg(?:e|ed|es|ing)|vandal|carjack|wanted|bomb|arson|hit-and-run|dwi|intoxicated|trooper|state police|sheriff|trooper|police|ems)\b/i;
const DROP =
  /\b(weather forecast|sports|football|baseball|soccer|high school|recipe|job posting|concert|festival|fitness)\b/i;
const NYC_NOT_OURS = /\b(brooklyn|queens|bronx|manhattan|nycha|albany houses)\b/i;

const MAX_ITEMS = 80;
const KEEP_MS = 72 * 60 * 60_000;

type PushState = {
  items: LiveWireItem[];
  notifications: number;
  lastAt: number;
  lastError: string;
};

const g = globalThis as unknown as { __actSuperfeedr?: PushState };

function state(): PushState {
  if (!g.__actSuperfeedr) {
    g.__actSuperfeedr = { items: [], notifications: 0, lastAt: 0, lastError: "" };
  }
  return g.__actSuperfeedr;
}

function decode(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : "";
}

function keepItem(title: string, summary: string): boolean {
  const hay = `${title} ${summary}`;
  if (!title.trim()) return false;
  if (DROP.test(hay) || NYC_NOT_OURS.test(hay)) return false;
  if (!LOCAL.test(hay)) return false;
  return CRIME.test(hay) || LOCAL.test(title);
}

function toWireItem(input: {
  id: string;
  title: string;
  url: string;
  outlet: string;
  summary: string;
  publishedAt: number;
}): LiveWireItem | null {
  if (!keepItem(input.title, input.summary)) return null;
  const hay = `${input.title} ${input.summary}`;
  const place = placeFromText(hay);
  const pin = locateSpoken(hay, place?.name || "");
  const now = Date.now();
  const publishedAt = Number.isFinite(input.publishedAt) ? input.publishedAt : now;
  return {
    id: input.id.startsWith("http") ? input.id : `sf-${input.id}`,
    title: input.title.replace(/\s+/g, " ").trim(),
    url: input.url || input.id,
    outlet: input.outlet || "Superfeedr",
    summary: (input.summary || input.title).replace(/\s+/g, " ").trim().slice(0, 280),
    publishedAt: new Date(publishedAt).toISOString(),
    minutesAgo: Math.max(0, Math.round((now - publishedAt) / 60_000)),
    kind: "news",
    municipality: place?.name,
    address: pin.road || place?.name,
    lat: pin.geo.lat,
    lng: pin.geo.lng,
    geoPrecision: pin.precision,
  };
}

/** Verify X-Hub-Signature (sha1=… / sha256=…) against SUPERFEEDR_SECRET. */
export function verifySuperfeedrSignature(body: Uint8Array | Buffer, signatureHeader: string, secret: string): boolean {
  if (!secret) return true;
  const header = (signatureHeader || "").trim();
  if (!header) return false;
  const [method, provided] = header.includes("=") ? header.split("=", 2) : ["sha1", header];
  const algo = method.toLowerCase() === "sha256" ? "sha256" : "sha1";
  if (!provided) return false;
  const expected = createHmac(algo, secret).update(body).digest("hex");
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided.trim().toLowerCase(), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseJsonNotification(payload: Record<string, unknown>): LiveWireItem[] {
  const status = (payload.status as Record<string, unknown> | undefined) || {};
  const feedUrl = String(status.feed || "");
  const feedTitle = String(payload.title || "Superfeedr");
  const items = Array.isArray(payload.items) ? payload.items : [];
  const out: LiveWireItem[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = String(item.title || "").trim();
    if (!title) continue;

    let permalink = String(item.permalinkUrl || "");
    if (!permalink) {
      const links = item.links as Record<string, unknown> | undefined;
      const standard = item.standardLinks as Record<string, unknown> | undefined;
      const alt =
        (standard?.alternate as Array<Record<string, unknown>> | undefined) ||
        (Array.isArray(links) ? null : null);
      if (Array.isArray(alt) && alt[0]) permalink = String(alt[0].href || "");
      if (!permalink && links && typeof links === "object") {
        for (const v of Object.values(links)) {
          if (v && typeof v === "object" && "href" in (v as object)) {
            permalink = String((v as { href?: string }).href || "");
            if (permalink) break;
          }
        }
      }
    }

    const summary = String(item.summary || item.content || "").trim();
    const publishedTs = item.published ?? item.updated;
    let publishedAt = Date.now();
    if (typeof publishedTs === "number") {
      publishedAt = publishedTs > 1e12 ? publishedTs : publishedTs * 1000;
    } else if (typeof publishedTs === "string") {
      const t = Date.parse(publishedTs);
      if (Number.isFinite(t)) publishedAt = t;
    }

    const actor = (item.actor as Record<string, unknown> | undefined) || {};
    const outlet = String(actor.displayName || feedTitle || "Superfeedr");
    const id = String(item.id || permalink || title);
    const row = toWireItem({
      id,
      title,
      url: permalink || feedUrl || id,
      outlet,
      summary,
      publishedAt,
    });
    if (row) out.push(row);
  }
  return out;
}

function parseXmlNotification(xml: string): LiveWireItem[] {
  const out: LiveWireItem[] = [];
  const feedTitle = xmlTag(xml, "title") || "Superfeedr";
  const chunks = [
    ...xml.matchAll(/<item[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi),
  ];
  for (const match of chunks) {
    const block = match[0]!;
    const title = xmlTag(block, "title");
    const link =
      block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ||
      xmlTag(block, "link") ||
      xmlTag(block, "guid") ||
      xmlTag(block, "id");
    const summary = xmlTag(block, "description") || xmlTag(block, "summary") || xmlTag(block, "content");
    const published =
      Date.parse(xmlTag(block, "pubDate") || xmlTag(block, "published") || xmlTag(block, "updated")) || Date.now();
    const row = toWireItem({
      id: link || title,
      title,
      url: link || "",
      outlet: feedTitle,
      summary,
      publishedAt: published,
    });
    if (row) out.push(row);
  }
  return out;
}

export function parseSuperfeedrBody(raw: string, contentType: string): LiveWireItem[] {
  const ct = contentType.toLowerCase();
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      return parseJsonNotification(payload);
    } catch {
      return [];
    }
  }
  if (trimmed.includes("<item") || trimmed.includes("<entry") || ct.includes("xml") || ct.includes("atom") || ct.includes("rss")) {
    return parseXmlNotification(trimmed);
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    return parseJsonNotification(payload);
  } catch {
    return parseXmlNotification(trimmed);
  }
}

export function ingestSuperfeedrItems(items: LiveWireItem[]): number {
  const s = state();
  s.notifications += 1;
  s.lastAt = Date.now();
  s.lastError = "";
  if (!items.length) return 0;

  const seen = new Set(s.items.map((i) => i.id));
  let added = 0;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    s.items.unshift(item);
    added += 1;
  }
  const cutoff = Date.now() - KEEP_MS;
  s.items = s.items
    .filter((i) => Date.parse(i.publishedAt) >= cutoff)
    .slice(0, MAX_ITEMS);
  return added;
}

export function recordSuperfeedrError(msg: string) {
  const s = state();
  s.lastError = msg.slice(0, 160);
  s.lastAt = Date.now();
}

export function superfeedrItems(now = Date.now()): LiveWireItem[] {
  const s = state();
  return s.items
    .map((row) => ({
      ...row,
      minutesAgo: Math.max(0, Math.round((now - Date.parse(row.publishedAt)) / 60_000)),
    }))
    .filter((row) => row.minutesAgo <= 72 * 60);
}

export function superfeedrHealth() {
  const s = state();
  return {
    notifications: s.notifications,
    buffered: s.items.length,
    lastAt: s.lastAt,
    lastError: s.lastError,
  };
}

/** Feeds the app already intends (newsroom + civic). Idempotent hub.subscribe. */
export const SUPERFEEDR_TOPICS: { topic: string; outlet: string }[] = [
  { topic: "https://www.news10.com/feed/", outlet: "News10" },
  { topic: "https://www.news10.com/news/crime/feed/", outlet: "News10 Crime" },
  { topic: "https://cbs6albany.com/news/local.rss", outlet: "CBS6" },
  { topic: "https://wnyt.com/feed/", outlet: "WNYT" },
  { topic: "https://www.wamc.org/news.rss", outlet: "WAMC" },
  {
    topic:
      "https://news.google.com/rss/search?q=site:patch.com/new-york/albany-ny+(police+OR+crash+OR+shooting+OR+fire+OR+arrest+OR+dwi+OR+trooper+OR+sheriff)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Patch Albany",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=Albany+NY+(police+OR+crash+OR+shooting+OR+fire+OR+arrest+OR+sheriff+OR+DWI+OR+trooper+OR+stabbing+OR+homicide+OR+wanted)+when:1d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Google News",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:patch.com/new-york+(colonie+OR+bethlehem+OR+latham)+(police+OR+crash+OR+arrest)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Patch",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:timesunion.com+(crash+OR+shooting+OR+arrest+OR+DWI+OR+homicide+OR+stabbing)+(albany+OR+colonie+OR+delmar+OR+latham+OR+bethlehem+OR+guilderland)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Times Union",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:spotlightnews.com+(arrest+OR+crash+OR+blotter+OR+DWI+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Spotlight",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:dailygazette.com+(albany+OR+colonie+OR+schenectady)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Daily Gazette",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:fox23news.com+(albany+OR+colonie+OR+troy)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "FOX23",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=(%22Central+Avenue%22+OR+%22Western+Avenue%22+OR+%22Wolf+Road%22)+(Albany+OR+Colonie)+(crash+OR+arrest+OR+fire+OR+shooting+OR+police)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Corridor news",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=(Bethlehem+OR+Delmar+OR+Latham)+(police+OR+crash+OR+arrest+OR+fire+OR+DWI)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Town news",
  },
  // Social (Google News RSS) — only high-signal official accounts and curated newsroom queries.
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/AlbanyNYPolice+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Albany PD" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/FDAlbanyny+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Albany Fire" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/ColoniePD+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Colonie PD" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/CohoesPD+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Cohoes PD" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/cohoesfire+when:14d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Cohoes Fire" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/WatervlietPolice+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Watervliet PD" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/guilderlandpolice+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Guilderland PD" },
  { topic: "https://news.google.com/rss/search?q=site:facebook.com/SchenectadyPD+when:14d&hl=en-US&gl=US&ceid=US:en", outlet: "Facebook · Schenectady PD" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/nyspolice+(albany+OR+colonie+OR+latham+OR+guilderland+OR+bethlehem+OR+delmar+OR+cohoes)+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "X · NYSP" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/troynypolice+(arrest+OR+shooting+OR+fire+OR+crash+OR+road+closed)+when:14d&hl=en-US&gl=US&ceid=US:en", outlet: "X · Troy PD" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/schdypolice+(arrest+OR+shooting+OR+fire+OR+crash+OR+road+closed)+when:14d&hl=en-US&gl=US&ceid=US:en", outlet: "X · Schdy Police" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/cohoesfire+(fire+OR+ems+OR+crash+OR+road+closed)+when:14d&hl=en-US&gl=US&ceid=US:en", outlet: "X · Cohoes Fire" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/FD_AlbanyNY+when:7d&hl=en-US&gl=US&ceid=US:en", outlet: "X · Albany Fire" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/CBS6Albany+(crash+OR+shooting+OR+fire+OR+arrest+OR+police)+when:2d&hl=en-US&gl=US&ceid=US:en", outlet: "X · CBS6" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/wten+(crash+OR+shooting+OR+fire+OR+arrest)+when:2d&hl=en-US&gl=US&ceid=US:en", outlet: "X · NEWS10" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/timesunion+(crash+OR+shooting+OR+arrest+OR+DWI)+when:2d&hl=en-US&gl=US&ceid=US:en", outlet: "X · Times Union" },
  { topic: "https://news.google.com/rss/search?q=site:x.com/wnyt+(police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:2d&hl=en-US&gl=US&ceid=US:en", outlet: "X · WNYT" },
  {
    topic: "https://www.townofbethlehem.org/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Bethlehem",
  },
  {
    topic: "https://www.guilderlandpd.org/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Guilderland PD",
  },
  {
    topic: "https://www.albanyny.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Albany",
  },
  {
    topic: "https://www.townofguilderland.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Guilderland",
  },
  {
    topic: "https://www.cohoes-ny.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Cohoes",
  },
  {
    topic: "https://menandsny.gov/feed/",
    outlet: "Civic · Menands",
  },
  {
    topic: "https://www.villageofvoorheesville.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Voorheesville",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=(Cohoes+OR+Watervliet+OR+Menands+OR+%22Green+Island%22)+(police+OR+crash+OR+arrest+OR+fire+OR+DWI)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "North cities",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=(Guilderland+OR+Altamont+OR+Voorheesville)+(police+OR+crash+OR+arrest+OR+fire+OR+DWI+OR+blotter)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Guilderland news",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:spectrumlocalnews.com+(albany+OR+colonie+OR+troy)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Spectrum",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=%22Albany+County+Sheriff%22+(arrest+OR+crash+OR+shooting+OR+DWI)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "ACSO",
  },
  {
    topic:
      "https://news.google.com/rss/search?q=site:troyrecord.com+(albany+OR+troy+OR+rensselaer)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Troy Record",
  },
];

type SubState = {
  lastRunAt: number;
  running: boolean;
  results: { topic: string; outlet: string; ok: boolean; status: number; detail: string }[];
};

const gSub = globalThis as unknown as { __actSuperfeedrSubs?: SubState };

function subState(): SubState {
  if (!gSub.__actSuperfeedrSubs) {
    gSub.__actSuperfeedrSubs = { lastRunAt: 0, running: false, results: [] };
  }
  return gSub.__actSuperfeedrSubs;
}

export function superfeedrAuth(): { user: string; token: string } | null {
  const user = (process.env.SUPERFEEDR_USER || process.env.SUPERFEEDR_LOGIN || "").trim();
  const token = (
    process.env.SUPERFEEDR_TOKEN ||
    process.env.SUPERFEEDR_PASSWORD ||
    process.env.SUPERFEEDR_PASS ||
    ""
  ).trim();
  if (!user || !token) return null;
  return { user, token };
}

export function superfeedrCallbackUrl(requestUrl?: string): string | null {
  const explicit = (process.env.SUPERFEEDR_CALLBACK_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const base = (
    process.env.SUPERFEEDR_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
  if (base) {
    const origin = base.startsWith("http") ? base : `https://${base}`;
    return `${origin}/api/superfeedr/webhook`;
  }
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      return `${u.origin}/api/superfeedr/webhook`;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export type SubscribeReport = {
  ok: boolean;
  skipped?: string;
  callback?: string;
  subscribed: number;
  failed: number;
  results: SubState["results"];
};

/** Idempotent PubSubHubbub subscribe for all intended feeds. */
export async function ensureSuperfeedrSubscriptions(opts?: {
  force?: boolean;
  requestUrl?: string;
}): Promise<SubscribeReport> {
  const s = subState();
  const auth = superfeedrAuth();
  if (!auth) {
    return { ok: false, skipped: "missing-SUPERFEEDR_USER/TOKEN", subscribed: 0, failed: 0, results: [] };
  }
  const callback = superfeedrCallbackUrl(opts?.requestUrl);
  if (!callback) {
    return { ok: false, skipped: "missing-SUPERFEEDR_CALLBACK_URL", subscribed: 0, failed: 0, results: [] };
  }
  if (s.running) {
    return { ok: true, skipped: "in-flight", callback, subscribed: 0, failed: 0, results: s.results };
  }
  if (!opts?.force && s.lastRunAt && Date.now() - s.lastRunAt < 10 * 60_000) {
    return {
      ok: true,
      skipped: "recent",
      callback,
      subscribed: s.results.filter((r) => r.ok).length,
      failed: s.results.filter((r) => !r.ok).length,
      results: s.results,
    };
  }

  s.running = true;
  const secret = (process.env.SUPERFEEDR_SECRET || "").trim();
  const results: SubState["results"] = [];
  let subscribed = 0;
  let failed = 0;

  try {
    for (const feed of SUPERFEEDR_TOPICS) {
      try {
        const body = new URLSearchParams();
        body.set("hub.mode", "subscribe");
        body.set("hub.topic", feed.topic);
        body.set("hub.callback", callback);
        body.set("hub.verify", "async");
        body.set("format", "json");
        if (secret) body.set("hub.secret", secret);

        const res = await fetch("https://push.superfeedr.com/", {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.token}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(15000),
        });
        const detail = (await res.text().catch(() => "")).slice(0, 160);
        // 204 = subscribed, 202 = pending verify, 200 = ok/retrieve — all fine for idempotent resubscribe
        const ok = res.status === 204 || res.status === 202 || res.status === 200;
        results.push({ topic: feed.topic, outlet: feed.outlet, ok, status: res.status, detail });
        if (ok) subscribed += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        results.push({
          topic: feed.topic,
          outlet: feed.outlet,
          ok: false,
          status: 0,
          detail: err instanceof Error ? err.message.slice(0, 160) : "subscribe-error",
        });
      }
    }
    s.results = results;
    s.lastRunAt = Date.now();
    console.info("[superfeedr] subscribe", { callback, subscribed, failed });
    return { ok: failed === 0, callback, subscribed, failed, results };
  } finally {
    s.running = false;
  }
}

export function superfeedrSubscribeHealth() {
  const s = subState();
  const auth = Boolean(superfeedrAuth());
  const callback = superfeedrCallbackUrl();
  return {
    authConfigured: auth,
    callbackConfigured: Boolean(callback),
    callback: callback || undefined,
    lastRunAt: s.lastRunAt,
    topics: SUPERFEEDR_TOPICS.length,
    subscribed: s.results.filter((r) => r.ok).length,
    failed: s.results.filter((r) => !r.ok).length,
  };
}

/** Fire-and-forget boot subscribe when credentials exist. */
export function startSuperfeedrSubscriptions() {
  if (!superfeedrAuth() || !superfeedrCallbackUrl()) return;
  void ensureSuperfeedrSubscriptions().catch((err) => {
    console.error("[superfeedr] boot-subscribe", err instanceof Error ? err.message : err);
  });
}

startSuperfeedrSubscriptions();
