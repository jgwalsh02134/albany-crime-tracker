import { createServerFn } from "@tanstack/react-start";
import type { LiveWireItem } from "./sources";

const FEEDS = [
  { url: "https://www.news10.com/feed/", outlet: "News10" },
  { url: "https://www.news10.com/news/crime/feed/", outlet: "News10" },
];

const KEEP =
  /\b(albany|colonie|bethlehem|guilderland|cohoes|watervliet|menands|latham|delmar|nysp|troop g|sheriff|police|apd|crash|shot|shooting|robbery|arrest|stab|homicide|fire|crash|killed|injured|narcotic|burglary|assault)\b/i;
const DROP = /\b(weather|sports|football|baseball|soccer|seasonably|rain chances|high school)\b/i;

function decode(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : "";
}

function parseRss(xml: string, outlet: string, now: number): LiveWireItem[] {
  const out: LiveWireItem[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]!;
    const title = tag(block, "title");
    const url = tag(block, "link");
    if (!title || !url || seen.has(url)) continue;
    if (DROP.test(title) || !KEEP.test(`${title} ${tag(block, "description")}`)) continue;
    seen.add(url);
    const published = Date.parse(tag(block, "pubDate")) || now;
    const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
    out.push({
      id: url,
      title,
      url,
      outlet,
      summary: tag(block, "description").slice(0, 180),
      publishedAt: new Date(published).toISOString(),
      minutesAgo,
    });
  }
  return out;
}

export const getLiveWire = createServerFn({ method: "POST" }).handler(async () => {
  const now = Date.now();
  const batches = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "AlbanyCountyCrimeTracker/1.0", Accept: "application/rss+xml, text/xml, */*" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [] as LiveWireItem[];
        const xml = await res.text();
        if (!xml.includes("<item")) return [];
        return parseRss(xml, feed.outlet, now);
      } catch {
        return [] as LiveWireItem[];
      }
    }),
  );
  const seen = new Set<string>();
  const items: LiveWireItem[] = [];
  for (const row of batches.flat()) {
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    items.push(row);
  }
  items.sort((a, b) => a.minutesAgo - b.minutesAgo);
  return { ok: true as const, at: now, items: items.slice(0, 8) };
});
