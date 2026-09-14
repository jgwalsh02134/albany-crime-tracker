import { locateSpoken, placeFromText } from "./geo";
import type { LiveWireItem } from "./sources";
import { recordPipeFail, recordPipeOk } from "./pipe-health";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const LIVE_MIN = 24 * 60;
const OFFICIAL_NEWS_MIN = 7 * 24 * 60;

const INCIDENT =
  /\b(crash|collision|shot|shooting|homicide|murder|stabbing|stab|robbery|arrests?|arrested|fire|blaze|killed|injured|fatal|burglary|assault|charg(?:e|ed|es|ing)|carjack|wanted|bomb|arson|hit-and-run|dwi|intoxicated|investigation|narcotics|gunfire|missing|head-on|vehicle)\b/i;
const DROP =
  /\b(help wanted|hiring|playground|rabies|no parking|sewer|assistant coordinator|records clerk|budget|fiscal|midyear|phishing scam|found dog|found pet)\b/i;
const SEVERE_WX =
  /\b(tornado warning|flash flood warning|severe thunderstorm warning|extreme wind warning|blizzard warning|ice storm warning|winter storm warning|civil emergency|amber alert|missing (?:child|person)|shelter.in.place|evacuation)\b/i;

type CivicFeed = { url: string; outlet: string; agency: string };

const CIVIC_FEEDS: CivicFeed[] = [
  {
    url: "https://www.townofbethlehem.org/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Bethlehem PD",
    agency: "Bethlehem PD",
  },
  {
    url: "https://www.townofbethlehem.org/RSSFeed.aspx?ModID=1&CID=Police-Press-Releases-5",
    outlet: "Civic · Bethlehem PD press",
    agency: "Bethlehem PD",
  },
  {
    url: "https://www.guilderlandpd.org/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Guilderland PD",
    agency: "Guilderland PD",
  },
  {
    url: "https://www.townofguilderland.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Guilderland",
    agency: "Town of Guilderland",
  },
  {
    url: "https://www.albanyny.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Albany",
    agency: "City of Albany",
  },
  {
    url: "https://www.cohoes-ny.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Cohoes",
    agency: "City of Cohoes",
  },
  {
    url: "https://menandsny.gov/feed/",
    outlet: "Civic · Menands",
    agency: "Village of Menands",
  },
  {
    url: "https://www.villageofvoorheesville.gov/RSSFeed.aspx?ModID=1&CID=All-news",
    outlet: "Civic · Voorheesville",
    agency: "Village of Voorheesville",
  },
];

function decode(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : "";
}

function pipeId(outlet: string): string {
  return `civic:${outlet.replace(/^Civic · /i, "").toLowerCase().replace(/\s+/g, "-")}`;
}

async function fetchCivicFeed(feed: CivicFeed, now: number): Promise<LiveWireItem[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      recordPipeFail(pipeId(feed.outlet), feed.outlet, `HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const out: LiveWireItem[] = [];
    for (const match of xml.matchAll(/<item[\s\S]*?<\/item>/gi)) {
      const block = match[0]!;
      const title = tag(block, "title");
      const url = tag(block, "link") || tag(block, "guid");
      const summary = tag(block, "description");
      if (!title || !url) continue;
      const hay = `${title} ${summary}`;
      if (DROP.test(hay) || !INCIDENT.test(hay)) continue;
      const published = Date.parse(tag(block, "pubDate")) || now;
      const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
      if (minutesAgo > OFFICIAL_NEWS_MIN) continue;
      const town = placeFromText(hay);
      const pin = locateSpoken(hay, town?.name || "");
      out.push({
        id: url,
        title,
        url,
        outlet: feed.outlet,
        summary: (summary || title).slice(0, 360),
        publishedAt: new Date(published).toISOString(),
        minutesAgo,
        kind: "news",
        municipality: town?.name,
        address: pin.road || town?.name,
        agency: feed.agency,
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        geoPrecision: pin.precision,
      });
    }
    recordPipeOk(pipeId(feed.outlet), feed.outlet, out.length);
    return out;
  } catch (err) {
    recordPipeFail(pipeId(feed.outlet), feed.outlet, err instanceof Error ? err.message : "civic-error");
    return [];
  }
}

export async function fetchCivic(now: number): Promise<LiveWireItem[]> {
  const batches = await Promise.all(CIVIC_FEEDS.map((f) => fetchCivicFeed(f, now)));
  const seen = new Set<string>();
  const out: LiveWireItem[] = [];
  for (const row of batches.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

type NwsFeature = {
  properties?: {
    id?: string;
    event?: string;
    headline?: string;
    description?: string;
    areaDesc?: string;
    sent?: string;
    effective?: string;
    severity?: string;
  };
};

export async function fetchNws(now: number): Promise<LiveWireItem[]> {
  try {
    const res = await fetch("https://api.weather.gov/alerts/active?point=42.6526,-73.7562", {
      headers: { "User-Agent": UA, Accept: "application/geo+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      recordPipeFail("nws", "NWS", `HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { features?: NwsFeature[] };
    const out: LiveWireItem[] = [];
    for (const f of body.features ?? []) {
      const p = f.properties ?? {};
      const event = p.event || "";
      const headline = p.headline || event;
      const hay = `${event} ${headline} ${p.description || ""}`;
      if (!SEVERE_WX.test(hay)) continue;
      const at = Date.parse(p.effective || p.sent || "") || now;
      const minutesAgo = Math.max(0, Math.round((now - at) / 60_000));
      if (minutesAgo > LIVE_MIN) continue;
      const place = placeFromText(p.areaDesc || hay);
      const pin = locateSpoken(`${p.areaDesc || ""} ${hay}`, place?.name || "");
      out.push({
        id: p.id || `nws-${event}-${at}`,
        title: headline.slice(0, 180),
        url: "https://alerts.weather.gov/",
        outlet: "NWS",
        summary: (p.description || headline).replace(/\s+/g, " ").trim().slice(0, 360),
        publishedAt: new Date(at).toISOString(),
        minutesAgo,
        kind: "traffic",
        municipality: place?.name || "Albany County",
        address: (p.areaDesc || "Capital District").split(";")[0]?.trim(),
        agency: "National Weather Service",
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        geoPrecision: pin.precision,
      });
    }
    recordPipeOk("nws", "NWS", out.length);
    return out;
  } catch (err) {
    recordPipeFail("nws", "NWS", err instanceof Error ? err.message : "nws-error");
    return [];
  }
}

export function civicLive(items: LiveWireItem[]): LiveWireItem[] {
  return items.filter((i) => i.minutesAgo <= LIVE_MIN);
}

export function civicNews(items: LiveWireItem[]): LiveWireItem[] {
  return items.filter((i) => i.minutesAgo > LIVE_MIN && i.minutesAgo <= OFFICIAL_NEWS_MIN);
}
