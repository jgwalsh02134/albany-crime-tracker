import { createServerFn } from "@tanstack/react-start";
import type { LiveWireItem, WireHealth } from "./sources";
import { fetchNyspBlotter, parseNyWhen } from "./nysp-blotter";
import { scannerHealth, scannerItems, startScannerPoll } from "./scanner-poll";
import { placeFromText } from "./geo";
import { collectSocial, socialLive, socialNews } from "./social-sources";
import { civicLive, civicNews, fetchCivic, fetchNws } from "./civic-sources";

const FEEDS: { url: string; outlet: string; crimeOnly?: boolean }[] = [
  { url: "https://www.news10.com/feed/", outlet: "News10" },
  { url: "https://www.news10.com/news/crime/feed/", outlet: "News10" },
  { url: "https://cbs6albany.com/news/local.rss", outlet: "CBS6" },
  { url: "https://wnyt.com/feed/", outlet: "WNYT" },
  { url: "https://www.wamc.org/news.rss", outlet: "WAMC" },
  { url: "https://patch.com/new-york/albany/rss", outlet: "Patch Albany" },
  {
    url: "https://news.google.com/rss/search?q=Albany+NY+(police+OR+crash+OR+shooting+OR+fire+OR+arrest+OR+sheriff+OR+DWI+OR+trooper)+when:1d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Google News",
  },
  {
    url: "https://news.google.com/rss/search?q=site:timesunion.com+(crash+OR+shooting+OR+arrest+OR+DWI+OR+homicide+OR+stabbing)+(albany+OR+colonie+OR+delmar+OR+latham+OR+bethlehem+OR+guilderland)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Times Union",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:spotlightnews.com+(arrest+OR+crash+OR+blotter+OR+DWI+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Spotlight",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:patch.com/new-york+(colonie+OR+bethlehem+OR+latham)+(police+OR+crash+OR+arrest)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Patch",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:dailygazette.com+(albany+OR+colonie+OR+schenectady)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Daily Gazette",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:fox23news.com+(albany+OR+colonie+OR+troy)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "FOX23",
    crimeOnly: true,
  },
];

const LOCAL =
  /\b(albany|colonie|bethlehem|guilderland|cohoes|watervliet|menands|latham|delmar|new scotland|westerlo|coeymans|loudonville|altamont|ravena|selkirk|glenmont|green island|capital region|troop g|clifton park|troy|schenectady|rensselaer|sand lake|schodack|east greenbush)\b/i;
const CRIME =
  /\b(crash|collision|shot|shooting|homicide|murder|stabbing|stab|robbery|arrests?|arrested|fire|blaze|killed|injured|fatal|burglary|assault|charg(?:e|ed|es|ing)|vandal|carjack|wanted|bomb|arson|hit-and-run|dwi|intoxicated|trooper|state police|sheriff|trooper)\b/i;
const DROP =
  /\b(weather forecast|sports|football|baseball|soccer|high school|seasonably|rain chances|speedway|autism|op-ed|letter to the editor|stock|recipe|job posting|retired before|common council|initiative|camera expansion|suspended without pay|hiring|season preview|concert|festival|fitness|telehealth|auction|tropical storm|superintendent|retirement plans|holiday tour|drive-in|pokémon|pokemon|travers|we salute|settlement|beautiful weather|lanternfl|patroons|nightlife)\b/i;
const NOTABLE_BLOTTER =
  /fatal|personal injury|dwi|burglary|robbery|assault|homicide|shoot|stab|domestic|gun|weapon|arrest|hit & run|hit-and-run|fire|larceny|fraud|harassment|trespass|menacing|stolen/i;
const COURT_ONLY =
  /\b(sentenced|years in prison|plea|convicted|verdict|gets \d+ years|indictment for)\b/i;
const NOT_LIVE_NEWS =
  /\b(lawsuit|file suit|sues |weekly|notable dwi|week in review)\b/i;
const NYC_NOT_OURS = /\b(brooklyn|queens|bronx|manhattan|nycha|albany houses)\b/i;

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const CAP_COUNTIES = new Set(["albany", "rensselaer", "schenectady", "saratoga"]);
const LIVE_MIN = 24 * 60;
const BLOTTER_LIVE_MIN = 36 * 60;
const NEWS_MIN = 72 * 60;

function decode(raw: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
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
  const m = title.match(/^(.*)\s[-–—]\s([^–—-]{2,60})$/);
  if (!m) return { title, outlet: fallback };
  const source = m[2]!.trim();
  if (
    /NEWS10|WRGB|CBS ?6|WNYT|WAMC|Times Union|Spectrum|Daily Gazette|Patch|Dispatch|\.com|\.net/i.test(
      source,
    ) ||
    source.length <= 28
  ) {
    return { title: m[1]!.trim(), outlet: source.replace(/\s+/g, " ") };
  }
  return { title, outlet: fallback };
}

function tidySummary(title: string, summary: string, outlet: string): string {
  let s = summary.replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  if (s.startsWith(title)) s = s.slice(title.length).replace(/^[\s\-–—]+/, "").trim();
  s = s.replace(new RegExp(`${outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim();
  if (s.length < 28) return title;
  return s.slice(0, 360);
}

function parseImage(block: string): string | undefined {
  const found: string[] = [];
  for (const m of block.matchAll(/<enclosure[^>]*url=["']([^"']+)["'][^>]*>/gi)) {
    found.push(m[1]!);
  }
  for (const m of block.matchAll(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/gi)) {
    found.push(m[1]!);
  }
  const img = block.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img?.[1]) found.push(img[1]);
  for (const raw of found) {
    const url = raw.replace(/&/g, "&");
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\.(m3u8|mp4|mp3)(\?|$)/i.test(url) || /fuel-streaming|\/video/i.test(url)) continue;
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) && !/\/media2\/|wp-content\/uploads|resources\/media/i.test(url)) {
      continue;
    }
    return url;
  }
  return undefined;
}

function parseRss(xml: string, outlet: string, now: number, crimeOnly: boolean): LiveWireItem[] {
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
    if (DROP.test(hay) || NYC_NOT_OURS.test(hay) || !LOCAL.test(hay)) continue;
    if (crimeOnly && !CRIME.test(hay)) continue;
    seen.add(url);
    const published = Date.parse(tag(block, "pubDate") || tag(block, "dc:date")) || now;
    const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
    if (minutesAgo > NEWS_MIN) continue;
    const place = placeFromText(`${title} ${summary}`);
    out.push({
      id: url,
      title,
      url,
      outlet: parsed.outlet,
      summary: tidySummary(title, summary, parsed.outlet),
      publishedAt: new Date(published).toISOString(),
      minutesAgo,
      image: parseImage(block),
      kind: "news",
      municipality: place?.name,
      address: place?.name,
      lat: place?.lat,
      lng: place?.lng,
    });
  }
  return out;
}

async function collectNews(now: number) {
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
        if (!res.ok) return { outlet: feed.outlet, news: [] as LiveWireItem[], crime: [] as LiveWireItem[] };
        const xml = await res.text();
        if (!xml.includes("<item")) return { outlet: feed.outlet, news: [] as LiveWireItem[], crime: [] as LiveWireItem[] };
        return {
          outlet: feed.outlet,
          news: parseRss(xml, feed.outlet, now, Boolean(feed.crimeOnly)),
          crime: parseRss(xml, feed.outlet, now, true),
        };
      } catch {
        return { outlet: feed.outlet, news: [] as LiveWireItem[], crime: [] as LiveWireItem[] };
      }
    }),
  );
  const seenNews = new Set<string>();
  const seenCrime = new Set<string>();
  const stories: LiveWireItem[] = [];
  const crime: LiveWireItem[] = [];
  const liveOutlets: string[] = [];
  for (const batch of batches) {
    if ((batch.news.length || batch.crime.length) && !liveOutlets.includes(batch.outlet)) {
      liveOutlets.push(batch.outlet);
    }
    for (const row of batch.crime) {
      const key = row.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenCrime.has(row.url) || seenCrime.has(key)) continue;
      seenCrime.add(row.url);
      seenCrime.add(key);
      crime.push(row);
    }
    for (const row of batch.news) {
      const key = row.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenNews.has(row.url) || seenNews.has(key)) continue;
      seenNews.add(row.url);
      seenNews.add(key);
      stories.push(row);
    }
  }
  return { crime, stories, liveOutlets };
}

type DotEvent = {
  ID?: string;
  CountyName?: string;
  EventType?: string;
  Description?: string;
  RoadwayName?: string;
  Severity?: string;
  Reported?: string;
  Latitude?: number;
  Longitude?: number;
};

function parse511When(raw: string | undefined, now: number): number {
  if (!raw) return now;
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : now;
  }
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : now;
}

function inCapital511(e: DotEvent): boolean {
  const county = (e.CountyName || "").toLowerCase();
  if (CAP_COUNTIES.has(county)) return true;
  const lat = e.Latitude;
  const lng = e.Longitude;
  return typeof lat === "number" && typeof lng === "number" && lat > 42.4 && lat < 43.25 && lng > -74.25 && lng < -73.5;
}

async function fetch511(now: number): Promise<LiveWireItem[]> {
  try {
    const res = await fetch("https://511ny.org/api/getevents?format=json", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const events = (await res.json()) as DotEvent[];
    const out: LiveWireItem[] = [];
    for (const e of events) {
      if ((e.EventType || "") !== "accidentsAndIncidents") continue;
      if (!inCapital511(e)) continue;
      const desc = e.Description || "";
      const at = parse511When(e.Reported, now);
      const minutesAgo = Math.max(0, Math.round((now - at) / 60_000));
      if (minutesAgo > LIVE_MIN) continue;
      const road = e.RoadwayName || "Roadway";
      const county = (e.CountyName || "").toLowerCase();
      const place = county
        ? county.replace(/\b\w/g, (c) => c.toUpperCase())
        : LOCAL.test(desc)
          ? "Capital District"
          : "Capital District";
      const sev = e.Severity && e.Severity !== "Unknown" ? `${e.Severity} crash` : "Crash";
      out.push({
        id: `511-${e.ID || road}-${at}`,
        title: `${sev} — ${road}`,
        url: "https://511ny.org/region/Capital%20Region%20Albany%20Saratoga%20Area",
        outlet: "511NY",
        summary: (desc || `${sev} reported on ${road}.`).slice(0, 280),
        publishedAt: new Date(at).toISOString(),
        minutesAgo,
        kind: "traffic",
        municipality: place,
        address: road,
        agency: "NYSDOT 511",
        lat: typeof e.Latitude === "number" ? e.Latitude : undefined,
        lng: typeof e.Longitude === "number" ? e.Longitude : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchNyspPress(now: number): Promise<LiveWireItem[]> {
  try {
    const res = await fetch("https://troopers.ny.gov/nysp-newsroom", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out: LiveWireItem[] = [];
    const seen = new Set<string>();
    const re =
      /href="(\/news\/[^"]+)"[^>]*>\s*([^<]{10,200})[\s\S]{0,1200}?news-listing-date">\s*([^<]+?)\s*<\/div>[\s\S]{0,240}?news-listing-time">\s*([^<]+?)\s*</gi;
    for (const m of html.matchAll(re)) {
      const path = m[1]!;
      if (seen.has(path)) continue;
      seen.add(path);
      const title = decode(m[2]!).replace(/\s+/g, " ").trim();
      const hay = `${title} ${path}`;
      if (!LOCAL.test(hay)) continue;
      const published = parseNyWhen(`${m[3]!.trim()} ${m[4]!.replace(/ET/i, "").trim()}`) ?? now;
      const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
      if (minutesAgo > NEWS_MIN) continue;
      const url = `https://troopers.ny.gov${path}`;
      const place = placeFromText(title);
      out.push({
        id: url,
        title,
        url,
        outlet: "NYSP press",
        summary: title,
        publishedAt: new Date(published).toISOString(),
        minutesAgo,
        kind: "news",
        agency: "NYSP",
        municipality: place?.name,
        address: place?.name,
        lat: place?.lat,
        lng: place?.lng,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function mergeActivity(parts: LiveWireItem[][]): LiveWireItem[] {
  const seen = new Set<string>();
  const out: LiveWireItem[] = [];
  for (const part of parts) {
    for (const row of part) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  out.sort((a, b) => a.minutesAgo - b.minutesAgo);
  return out;
}

function notable(row: LiveWireItem): boolean {
  return NOTABLE_BLOTTER.test(`${row.title} ${row.category ?? ""} ${row.summary}`);
}

async function collectWire() {
  const now = Date.now();
  startScannerPoll();
  const [news, blotterRes, traffic, press, social, civic, nws] = await Promise.all([
    collectNews(now),
    fetchNyspBlotter(now).catch((err) => {
      console.error("[nysp] blotter", err instanceof Error ? err.message : err);
      return { items: [] as LiveWireItem[], tried: 0, failed: 1, extractor: "none" as const };
    }),
    fetch511(now),
    fetchNyspPress(now).catch(() => [] as LiveWireItem[]),
    collectSocial(now).catch(() => ({
      items: [] as LiveWireItem[],
      facebook: 0,
      x: 0,
      reddit: 0,
      citizen: 0,
    })),
    fetchCivic(now).catch(() => [] as LiveWireItem[]),
    fetchNws(now).catch(() => [] as LiveWireItem[]),
  ]);
  const blotter = blotterRes.items;
  const scan = scannerItems(now);
  const socialNow = socialLive(social.items);
  const socialOlder = socialNews(social.items);
  const civicNow = civicLive(civic);
  const civicOlder = civicNews(civic);
  const blotterLive = blotter.filter((r) => r.minutesAgo <= BLOTTER_LIVE_MIN);
  const blotterNews = blotter.filter((r) => r.minutesAgo > BLOTTER_LIVE_MIN && r.minutesAgo <= NEWS_MIN && notable(r));
  const liveNews = [...news.crime, ...news.stories, ...press].filter((r) => {
    const hay = `${r.title} ${r.summary}`;
    return r.minutesAgo <= LIVE_MIN && CRIME.test(hay) && !COURT_ONLY.test(hay) && !NOT_LIVE_NEWS.test(hay) && !NYC_NOT_OURS.test(hay);
  });
  const items = mergeActivity([blotterLive, scan, traffic, nws, liveNews, socialNow, civicNow]);
  const storiesCore = mergeActivity([
    news.stories,
    press.filter((r) => r.minutesAgo <= NEWS_MIN),
    blotterNews.map((r) => ({ ...r, kind: "news" as const })),
    socialOlder.filter((r) => r.minutesAgo <= NEWS_MIN),
    civicOlder.filter((r) => r.minutesAgo <= NEWS_MIN),
  ]).slice(0, 40);
  const seenStories = new Set(storiesCore.map((s) => s.id));
  const extraSocial = [...socialOlder, ...civicOlder].filter((r) => !seenStories.has(r.id)).slice(0, 12);
  const stories = [...storiesCore, ...extraSocial];
  const outlets = [
    blotterLive.length ? "NYSP blotter" : "",
    scan.length ? "Scanner" : "",
    traffic.length ? "511NY" : "",
    nws.length ? "NWS" : "",
    press.length ? "NYSP press" : "",
    civic.length ? "Civic" : "",
    social.facebook ? "Facebook" : "",
    social.x ? "X" : "",
    social.reddit || social.citizen ? "Citizens" : "",
    ...news.liveOutlets,
  ].filter(Boolean);
  const scanStats = scannerHealth();
  const health: WireHealth = {
    blotter: blotterLive.length,
    blotterFailed: blotterRes.failed,
    scanner: scan.length,
    traffic: traffic.length,
    news: liveNews.length,
    captions: Boolean(process.env.XAI_API_KEY),
    extractor: blotterRes.extractor,
    scannerTicks: scanStats.ticks,
    scannerError: scanStats.lastError || undefined,
    scannerHeard: scanStats.lastSpoken || undefined,
    scannerCaptioned: scanStats.captions,
    facebook: social.facebook,
    x: social.x,
    reddit: social.reddit,
    citizen: social.citizen,
    civic: civic.length,
    nws: nws.length,
  };
  return {
    ok: true as const,
    at: now,
    items: items.slice(0, 200),
    stories: stories.slice(0, 52),
    outlets,
    health,
  };
}

export async function fetchLiveWire() {
  return collectWire();
}

export const getLiveWire = createServerFn({ method: "POST" }).handler(async () => collectWire());
