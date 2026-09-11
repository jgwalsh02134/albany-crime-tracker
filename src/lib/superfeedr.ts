import { createHmac, timingSafeEqual } from "node:crypto";
import { placeFromText } from "./geo";
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
  const place = placeFromText(`${input.title} ${input.summary}`);
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
    address: place?.name,
    lat: place?.lat,
    lng: place?.lng,
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
