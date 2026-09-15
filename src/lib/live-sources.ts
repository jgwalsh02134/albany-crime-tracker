import { locateSpoken, placeFromText } from "./geo";
import { createServerFn } from "@tanstack/react-start";
import type { LiveWireItem, WireHealth } from "./sources";
import { fetchNyspBlotter, parseNyWhen } from "./nysp-blotter";
import { scannerHealth, scannerItems, startScannerPoll } from "./scanner-poll";
import { collectSocial, socialLive, socialNews } from "./social-sources";
import { civicLive, civicNews, fetchCivic, fetchNws } from "./civic-sources";
import {
  fetchNixleAltamont,
  fetchNixleApd,
  fetchNixleColoniePd,
  fetchNixleGuilderlandPd,
  fetchNixleWatervliet,
} from "./nixle-sources";
import { fetchThruwayTincAlbany } from "./thruway-tinc";
import { NEWS_FEEDS } from "./news-feeds";
import { superfeedrItems } from "./superfeedr";
import { enrichStoryImages, pickBestImage } from "./news-thumbs";
import { pipeHealth, recordPipeFail, recordPipeOk } from "./pipe-health";
import { keepLiveNewsItem, keepNewsTabItem, rankNewsItems, OUT_OF_AREA } from "./live-keep";

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
const WIRE_SOFT_DEADLINE_MS = 4500;
const LIVE_SOCIAL_SOFT_MS = 2200;
const FULL_SOCIAL_SOFT_MS = 3400;
const LIVE_WITNESS_SOFT_MS = 150;
const FULL_WITNESS_SOFT_MS = 450;

type WireMode = "live" | "full";

type SoftResult<T> = {
  value: T;
  ms: number;
  timedOut: boolean;
};

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

async function softPipe<T>(opts: {
  id: string;
  label: string;
  ms: number;
  run: () => Promise<T>;
  fallback: T;
}): Promise<SoftResult<T>> {
  const started = nowMs();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      recordPipeFail(opts.id, opts.label, `timeout ${opts.ms}ms`);
      resolve(opts.fallback);
    }, Math.max(1, opts.ms));
  });
  try {
    const value = await Promise.race([
      (async () => {
        try {
          return await opts.run();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "pipe-error";
          recordPipeFail(opts.id, opts.label, msg);
          return opts.fallback;
        }
      })(),
      timeout,
    ]);
    return { value, ms: Math.round(nowMs() - started), timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  return pickBestImage(found);
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
    if (DROP.test(hay) || NYC_NOT_OURS.test(hay) || OUT_OF_AREA.test(hay) || !LOCAL.test(hay)) continue;
    if (crimeOnly && !CRIME.test(hay)) continue;
    seen.add(url);
    const published = Date.parse(tag(block, "pubDate") || tag(block, "dc:date")) || now;
    const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
    if (minutesAgo > NEWS_MIN) continue;
    const place = placeFromText(hay);
    const pin = locateSpoken(hay, place?.name || "");
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
      address: pin.road || place?.name,
      lat: pin.geo.lat,
      lng: pin.geo.lng,
      geoPrecision: pin.precision,
    });
  }
  return out;
}

async function collectNews(now: number) {
  const batches = await Promise.all(
    NEWS_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: {
            "User-Agent": UA,
            Accept: "application/rss+xml, application/xml, text/xml, */*",
          },
          signal: AbortSignal.timeout(3500),
        });
        if (!res.ok) {
          recordPipeFail(`news:${feed.outlet}`, feed.outlet, `HTTP ${res.status}`);
          return { outlet: feed.outlet, news: [] as LiveWireItem[], crime: [] as LiveWireItem[] };
        }
        const xml = await res.text();
        if (!xml.includes("<item")) {
          recordPipeOk(`news:${feed.outlet}`, feed.outlet, 0);
          return { outlet: feed.outlet, news: [] as LiveWireItem[], crime: [] as LiveWireItem[] };
        }
        const news = parseRss(xml, feed.outlet, now, Boolean(feed.crimeOnly));
        const crime = parseRss(xml, feed.outlet, now, true);
        recordPipeOk(`news:${feed.outlet}`, feed.outlet, news.length);
        return { outlet: feed.outlet, news, crime };
      } catch (err) {
        recordPipeFail(`news:${feed.outlet}`, feed.outlet, err instanceof Error ? err.message : "news-error");
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
  if (typeof lat === "number" && typeof lng === "number" && lat > 42.4 && lat < 43.25 && lng > -74.25 && lng < -73.5) {
    return true;
  }
  // Some 511 rows omit CountyName — keep Capital District crashes via roadway text + NY box.
  const hay = `${e.RoadwayName || ""} ${e.Description || ""}`;
  if (!/\b(?:albany|colonie|bethlehem|latham|guilderland|cohoes|watervliet|menands|delmar|northway|i-?87|i-?90|i-?787|thruway)\b/i.test(hay)) {
    return false;
  }
  if (typeof lat === "number" && typeof lng === "number") {
    // Reject obvious downstate pins even when the text mentions I-87.
    return lat > 42.35 && lat < 43.5 && lng > -74.5 && lng < -73.4;
  }
  return true;
}

async function fetch511(now: number): Promise<LiveWireItem[]> {
  try {
    const res = await fetch("https://511ny.org/api/getevents?format=json", {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      recordPipeFail("511ny", "511NY", `HTTP ${res.status}`);
      return [];
    }
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
      let lat = typeof e.Latitude === "number" ? e.Latitude : undefined;
      let lng = typeof e.Longitude === "number" ? e.Longitude : undefined;
      let geoPrecision: import("./geo").GeoPrecision | undefined =
        lat != null && lng != null ? "street" : undefined;
      let address = road;
      if (lat == null || lng == null) {
        const pin = locateSpoken(`${road} ${desc}`, placeFromText(desc)?.name || place.replace(/ County$/i, "") || "Albany");
        lat = pin.geo.lat;
        lng = pin.geo.lng;
        geoPrecision = pin.precision;
        if (pin.road) address = pin.road;
      }
      const stableId = e.ID ? `511-${e.ID}` : `511-${road}-${at}`;
      out.push({
        id: stableId,
        title: `${sev} — ${road}`,
        url: "https://511ny.org/region/Capital%20Region%20Albany%20Saratoga%20Area",
        outlet: "511NY",
        summary: (desc || `${sev} reported on ${road}.`).slice(0, 280),
        publishedAt: new Date(at).toISOString(),
        minutesAgo,
        kind: "traffic",
        municipality: place,
        address,
        agency: "NYSDOT 511",
        lat,
        lng,
        geoPrecision,
      });
    }
    recordPipeOk("511ny", "511NY", out.length);
    return out;
  } catch (err) {
    recordPipeFail("511ny", "511NY", err instanceof Error ? err.message : "511-error");
    return [];
  }
}

async function fetchNyspPress(now: number): Promise<LiveWireItem[]> {
  try {
    const res = await fetch("https://troopers.ny.gov/nysp-newsroom", {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      recordPipeFail("nysp-press", "NYSP press", `HTTP ${res.status}`);
      return [];
    }
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
      const pin = locateSpoken(title, place?.name || "");
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
        address: pin.road || place?.name,
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        geoPrecision: pin.precision,
      });
    }
    recordPipeOk("nysp-press", "NYSP press", out.length);
    return out;
  } catch (err) {
    recordPipeFail("nysp-press", "NYSP press", err instanceof Error ? err.message : "press-error");
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

async function collectWire(opts?: { mode?: WireMode }) {
  const now = Date.now();
  startScannerPoll();
  const pullMs: Record<string, number> = {};
  const timedOutPipes: string[] = [];

  const mode: WireMode = opts?.mode || "full";

  const newsJob =
    mode === "full"
      ? softPipe({
          id: "wire:news",
          label: "Wire · News feeds",
          ms: 2600,
          run: async () => collectNews(now),
          fallback: { crime: [] as LiveWireItem[], stories: [] as LiveWireItem[], liveOutlets: [] as string[] },
        })
      : Promise.resolve({
          value: { crime: [] as LiveWireItem[], stories: [] as LiveWireItem[], liveOutlets: [] as string[] },
          ms: 0,
          timedOut: false,
        });

  const [
    newsRes,
    witnessRes,
    blotterResRes,
    trafficRes,
    pressRes,
    socialRes,
    civicRes,
    nwsRes,
    nixleApdRes,
    nixleGpdRes,
    nixleWvlRes,
    nixleAltRes,
    nixleColonieRes,
    tincRes,
  ] = await Promise.all([
    newsJob,
    softPipe({
      id: "wire:witness",
      label: "Witness reports",
      ms: mode === "live" ? LIVE_WITNESS_SOFT_MS : FULL_WITNESS_SOFT_MS,
      run: async () => {
        // Witness reports require a real DB. When DATABASE_URL is missing (or mis-set to whitespace),
        // do NOT import the witness module (it can pull in PGLite bootstrap) — skip instantly.
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl || !dbUrl.trim()) return [] as LiveWireItem[];
        const { witnessReportsToWire } = await import("./witness-reports.server");
        return await witnessReportsToWire(now);
      },
      fallback: [] as LiveWireItem[],
    }),
    softPipe({
      id: "nysp-blotter",
      label: "NYSP blotter",
      ms: WIRE_SOFT_DEADLINE_MS,
      run: async () =>
        fetchNyspBlotter(now).catch((err) => {
          console.error("[nysp] blotter", err instanceof Error ? err.message : err);
          return { items: [] as LiveWireItem[], tried: 0, failed: 1, extractor: "none" as const };
        }),
      fallback: { items: [] as LiveWireItem[], tried: 0, failed: 1, extractor: "none" as const },
    }),
    softPipe({ id: "511ny", label: "511NY", ms: 3200, run: async () => fetch511(now), fallback: [] as LiveWireItem[] }),
    softPipe({
      id: "nysp-press",
      label: "NYSP press",
      ms: 3200,
      run: async () => fetchNyspPress(now).catch(() => [] as LiveWireItem[]),
      fallback: [] as LiveWireItem[],
    }),
    softPipe({
      id: "wire:social",
      label: "Wire · Social",
      ms: mode === "live" ? LIVE_SOCIAL_SOFT_MS : FULL_SOCIAL_SOFT_MS,
      run: async () =>
        collectSocial(now, { mode }).catch(() => ({
          items: [] as LiveWireItem[],
          facebook: 0,
          x: 0,
          reddit: 0,
          citizen: 0,
        })),
      fallback: { items: [] as LiveWireItem[], facebook: 0, x: 0, reddit: 0, citizen: 0 },
    }),
    softPipe({
      id: "wire:civic",
      label: "Wire · Civic",
      ms: 3800,
      run: async () => fetchCivic(now).catch(() => [] as LiveWireItem[]),
      fallback: [] as LiveWireItem[],
    }),
    softPipe({ id: "nws", label: "NWS", ms: 3200, run: async () => fetchNws(now).catch(() => [] as LiveWireItem[]), fallback: [] as LiveWireItem[] }),
    softPipe({ id: "nixle:apd", label: "Nixle · Albany PD", ms: 2800, run: async () => fetchNixleApd(now).catch(() => [] as LiveWireItem[]), fallback: [] as LiveWireItem[] }),
    softPipe({
      id: "nixle:guilderland-pd",
      label: "Nixle · Guilderland PD",
      ms: 2800,
      run: async () => fetchNixleGuilderlandPd(now).catch(() => [] as LiveWireItem[]),
      fallback: [] as LiveWireItem[],
    }),
    softPipe({ id: "nixle:watervliet", label: "Nixle · Watervliet", ms: 2800, run: async () => fetchNixleWatervliet(now).catch(() => [] as LiveWireItem[]), fallback: [] as LiveWireItem[] }),
    softPipe({ id: "nixle:altamont", label: "Nixle · Altamont", ms: 2800, run: async () => fetchNixleAltamont(now).catch(() => [] as LiveWireItem[]), fallback: [] as LiveWireItem[] }),
    softPipe({
      id: "nixle:colonie-pd",
      label: "Nixle · Colonie PD",
      ms: 2800,
      run: async () => fetchNixleColoniePd(now).catch(() => [] as LiveWireItem[]),
      fallback: [] as LiveWireItem[],
    }),
    softPipe({
      id: "tinc:albany",
      label: "NYSTA TINC · Albany",
      ms: 2800,
      run: async () => fetchThruwayTincAlbany(now).catch(() => [] as LiveWireItem[]),
      fallback: [] as LiveWireItem[],
    }),
  ]);

  const record = <T>(k: string, r: SoftResult<T>) => {
    pullMs[k] = r.ms;
    if (r.timedOut) timedOutPipes.push(k);
    return r.value;
  };

  const news = record("wire:news", newsRes);
  const witness = record("wire:witness", witnessRes);
  const blotterRes = record("nysp-blotter", blotterResRes);
  const traffic = record("511ny", trafficRes);
  const press = record("nysp-press", pressRes);
  const social = record("wire:social", socialRes);
  const civic = record("wire:civic", civicRes);
  const nws = record("nws", nwsRes);
  const nixleApd = record("nixle:apd", nixleApdRes);
  const nixleGpd = record("nixle:guilderland-pd", nixleGpdRes);
  const nixleWvl = record("nixle:watervliet", nixleWvlRes);
  const nixleAlt = record("nixle:altamont", nixleAltRes);
  const nixleColonie = record("nixle:colonie-pd", nixleColonieRes);
  const tinc = record("tinc:albany", tincRes);

  const nixle = [...nixleApd, ...nixleGpd, ...nixleWvl, ...nixleAlt, ...nixleColonie].sort((a, b) => a.minutesAgo - b.minutesAgo);
  const blotter = blotterRes.items;
  if (blotterRes.failed && !blotter.length) {
    recordPipeFail("nysp-blotter", "NYSP blotter", `failed ${blotterRes.failed}/${blotterRes.tried}`);
  } else {
    recordPipeOk("nysp-blotter", "NYSP blotter", blotter.length);
  }
  const scan = scannerItems(now);
  const scanStats = scannerHealth();
  recordPipeOk("scanner", "Scanner", scan.length);
  if (scanStats.lastError) recordPipeFail("scanner", "Scanner", scanStats.lastError);
  const pushed = superfeedrItems(now);
  const socialNow = socialLive(social.items);
  const socialOlder = socialNews(social.items);
  const civicNow = civicLive(civic);
  const civicOlder = civicNews(civic);
  const blotterLive = blotter.filter((r) => r.minutesAgo <= BLOTTER_LIVE_MIN);
  const blotterNews = blotter.filter((r) => r.minutesAgo > BLOTTER_LIVE_MIN && r.minutesAgo <= NEWS_MIN && notable(r));
  // Daytime push: prefer Superfeedr-pushed rows first so hub.notify lands on Live quickly.
  // Prefer a larger share of Capital Region public-safety from pipes (not CRIME-only).
  const liveNews = [...pushed, ...news.crime, ...news.stories, ...press].filter((r) =>
    keepLiveNewsItem({
      title: r.title,
      summary: r.summary,
      minutesAgo: r.minutesAgo,
      local: LOCAL.test(`${r.title} ${r.summary}`),
    }),
  );
  // Prefer radio / 511 / civic / fresh newsrooms ahead of overnight blotter.
  const items = mergeActivity([witness, scan, traffic, tinc, nws, nixle, liveNews, socialNow, civicNow, blotterLive]);
  // News tab: newsrooms first; cap blotter so overnight dumps do not drown headlines.
  const blotterAsNews = blotterNews.map((r) => ({ ...r, kind: "news" as const })).slice(0, 6);
  const storiesRaw = mergeActivity([
    news.stories,
    press.filter((r) => r.minutesAgo <= NEWS_MIN),
    pushed.filter((r) => r.minutesAgo <= NEWS_MIN),
    socialOlder.filter((r) => r.minutesAgo <= NEWS_MIN),
    civicOlder.filter((r) => r.minutesAgo <= NEWS_MIN),
    blotterAsNews,
  ]);
  const seenStories = new Set<string>();
  const storiesDeduped: LiveWireItem[] = [];
  for (const row of storiesRaw) {
    if (seenStories.has(row.id)) continue;
    if (!keepNewsTabItem({ title: row.title, summary: row.summary, outlet: row.outlet, minutesAgo: row.minutesAgo, kind: row.kind })) {
      continue;
    }
    seenStories.add(row.id);
    storiesDeduped.push(row);
  }
  const stories = rankNewsItems(storiesDeduped).slice(0, 48);
  const outlets = [
    blotterLive.length ? "NYSP blotter" : "",
    scan.length ? "Scanner" : "",
    traffic.length ? "511NY" : "",
    tinc.length ? "NYSTA TINC" : "",
    nws.length ? "NWS" : "",
    nixle.length ? "Nixle" : "",
    witness.length ? "Witness" : "",
    press.length ? "NYSP press" : "",
    pushed.length ? "Superfeedr" : "",
    civic.length ? "Civic" : "",
    social.facebook ? "Facebook" : "",
    social.x ? "X" : "",
    social.reddit || social.citizen ? "Citizens" : "",
    ...news.liveOutlets,
  ].filter(Boolean);
  const pipes = pipeHealth();
  const coreDaytime = pipes.filter((p) => p.id === "511ny" || p.id === "nws");
  const civicDaytime = pipes.filter((p) => p.id.startsWith("civic:"));
  const pipeHardFail = (p: (typeof pipes)[number]) =>
    Boolean(p.lastError) && p.fail >= p.ok && p.fail > 0;
  // One civic 403 (e.g. Menands) must not claim the whole Live feed is erroring.
  // Empty-but-ok 511/NWS stay daytimePipesDry only.
  const civicFailing = civicDaytime.filter(pipeHardFail).length;
  const daytimeFailing =
    coreDaytime.some(pipeHardFail) || (civicDaytime.length > 0 && civicFailing >= Math.max(3, Math.ceil(civicDaytime.length * 0.5)));
  const daytimePipesDry = traffic.length === 0 && civic.length === 0 && nws.length === 0;
  const health: WireHealth = {
    blotter: blotterLive.length,
    blotterFailed: blotterRes.failed,
    scanner: scan.length,
    traffic: traffic.length,
    news: liveNews.length,
    stories: stories.length,
    wireMode: mode,
    pullMs,
    timedOutPipes: timedOutPipes.length ? timedOutPipes : undefined,
    captions: Boolean(process.env.XAI_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY),
    extractor: blotterRes.extractor,
    scannerTicks: scanStats.ticks,
    scannerError: scanStats.lastError || undefined,
    scannerHeard: scanStats.lastSpoken || undefined,
    scannerCaptioned: scanStats.captions,
    scannerSttState: scanStats.sttState,
    scannerSttBlockedSec: scanStats.sttBlockedSec,
    scannerHlsState: scanStats.hlsState,
    scannerHlsAgeSec: scanStats.hlsAgeSec,
    scannerHlsError: scanStats.hlsLastError || undefined,
    scannerHlsErrorAt: scanStats.hlsLastErrorAt || undefined,
    scannerHlsFeed: scanStats.hlsLastFeed || undefined,
    // Counts that match Live lens (≤24h), not full pipe harvest.
    facebook: socialNow.filter((i) => i.outlet.startsWith("Facebook")).length,
    x: socialNow.filter((i) => i.outlet.startsWith("X ·")).length,
    reddit: socialNow.filter((i) => i.outlet.startsWith("Reddit")).length,
    citizen: (social.citizen ?? 0) + witness.length,
    civic: civic.length,
    nws: nws.length,
    daytimePipesDry,
    daytimePipesFailing: daytimeFailing,
    pipes: pipes.map((p) => ({
      id: p.id,
      label: p.label,
      lastCount: p.lastCount,
      ageSec: p.ageSec,
      lastError: p.lastError,
      ok: p.ok,
      fail: p.fail,
    })),
  };
  const enrichedStories =
    mode === "full"
      ? (
          await softPipe({
            id: "news:thumbs",
            label: "News thumbs",
            ms: 2400,
            run: async () => enrichStoryImages(stories, { max: 12 }),
            fallback: stories,
          })
        ).value
      : stories;
  // Propagate enriched thumbs onto matching live wire items (same id/url) for consistency.
  const thumbById = new Map(
    enrichedStories.filter((s) => s.image).map((s) => [s.id, s.image!] as const),
  );
  const itemsOut = items.slice(0, 200).map((row) => {
    if (row.image || !thumbById.has(row.id)) return row;
    return { ...row, image: thumbById.get(row.id) };
  });
  return {
    ok: true as const,
    at: now,
    items: itemsOut,
    stories: mode === "full" ? enrichedStories : undefined,
    outlets,
    health,
  };
}

export async function fetchLiveWire(opts?: { mode?: WireMode }) {
  return collectWire(opts);
}

export const getLiveWire = createServerFn({ method: "POST" }).handler(async () => collectWire({ mode: "full" }));
