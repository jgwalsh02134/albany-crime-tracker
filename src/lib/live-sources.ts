import { createServerFn } from "@tanstack/react-start";
import type { LiveWireItem } from "./sources";

const FEEDS: { url: string; outlet: string; official?: boolean }[] = [
  { url: "https://www.news10.com/feed/", outlet: "News10" },
  { url: "https://www.news10.com/news/crime/feed/", outlet: "News10" },
  { url: "https://cbs6albany.com/news/local.rss", outlet: "CBS6" },
  {
    url: "https://news.google.com/rss/search?q=Albany+County+NY+(police+OR+crash+OR+shooting+OR+fire+OR+arrest+OR+sheriff)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Google News",
  },
];

const LOCAL =
  /\b(albany|colonie|bethlehem|guilderland|cohoes|watervliet|menands|latham|delmar|new scotland|westerlo|coeymans|loudonville|altamont|ravena|selkirk|glenmont|capital region|troop g)\b/i;
const CRIME =
  /\b(police|sheriff|apd|crash|shot|shooting|robbery|arrest|stab|homicide|fire|killed|injured|burglary|assault|fatal|charged|vandal|blaze)\b/i;
const DROP =
  /\b(weather forecast|sports|football|baseball|soccer|high school|seasonably|rain chances|speedway|autism|op-ed|letter to the editor|stock|recipe|police chief position)\b/i;

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://albanypulse.com)";

function decode(raw: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ent: string) => {
      const key = ent.toLowerCase();
      if (key in named) return named[key]!;
      if (key.startsWith("#x")) {
        const n = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(n) ? String.fromCharCode(n) : match;
      }
      if (key.startsWith("#")) {
        const n = Number(key.slice(1));
        return Number.isFinite(n) ? String.fromCharCode(n) : match;
      }
      return match;
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : "";
}

function attrLink(block: string): string {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href?.[1]) return href[1];
  return tag(block, "link") || tag(block, "guid");
}

function outletFromTitle(title: string, fallback: string): { title: string; outlet: string } {
  const m = title.match(/^(.*)\s[-–—]\s([^–—-]{2,40})$/);
  if (!m) return { title, outlet: fallback };
  const source = m[2]!.trim();
  if (/NEWS10|WRGB|CBS ?6|WNYT|WAMC|Times Union|Spectrum/i.test(source)) {
    return { title: m[1]!.trim(), outlet: source.replace(/\s+/g, " ") };
  }
  return { title, outlet: fallback };
}

function parseRss(xml: string, outlet: string, now: number): LiveWireItem[] {
  const out: LiveWireItem[] = [];
  const seen = new Set<string>();
  const chunks = xml.matchAll(/<item[\s\S]*?<\/item>/gi);
  for (const match of chunks) {
    const block = match[0]!;
    const rawTitle = tag(block, "title");
    const parsed = outletFromTitle(rawTitle, outlet);
    const title = parsed.title;
    const url = attrLink(block);
    if (!title || !url || seen.has(url)) continue;
    const summary = tag(block, "description") || tag(block, "content:encoded");
    const hay = `${title} ${summary}`;
    if (DROP.test(hay) || !LOCAL.test(hay) || !CRIME.test(hay)) continue;
    seen.add(url);
    const published = Date.parse(tag(block, "pubDate") || tag(block, "dc:date")) || now;
    const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
    if (minutesAgo > 72 * 60) continue;
    out.push({
      id: url,
      title,
      url,
      outlet: parsed.outlet,
      summary: summary.slice(0, 220),
      publishedAt: new Date(published).toISOString(),
      minutesAgo,
    });
  }
  return out;
}

async function collectWire() {
  const now = Date.now();
  const batches = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: {
            "User-Agent": UA,
            Accept: "application/rss+xml, application/xml, text/xml, */*",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { outlet: feed.outlet, items: [] as LiveWireItem[] };
        const xml = await res.text();
        if (!xml.includes("<item")) return { outlet: feed.outlet, items: [] };
        return { outlet: feed.outlet, items: parseRss(xml, feed.outlet, now) };
      } catch {
        return { outlet: feed.outlet, items: [] as LiveWireItem[] };
      }
    }),
  );
  const seen = new Set<string>();
  const items: LiveWireItem[] = [];
  const liveOutlets: string[] = [];
  for (const batch of batches) {
    if (batch.items.length && !liveOutlets.includes(batch.outlet)) liveOutlets.push(batch.outlet);
    for (const row of batch.items) {
      const key = row.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seen.has(row.url) || seen.has(key)) continue;
      seen.add(row.url);
      seen.add(key);
      items.push(row);
    }
  }
  items.sort((a, b) => a.minutesAgo - b.minutesAgo);
  return { ok: true as const, at: now, items: items.slice(0, 16), outlets: liveOutlets };
}

export async function fetchLiveWire() {
  return collectWire();
}

export const getLiveWire = createServerFn({ method: "POST" }).handler(async () => collectWire());
