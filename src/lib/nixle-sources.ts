import type { LiveWireItem } from "./sources";
import { locateSpoken, placeFromText } from "./geo";
import { recordPipeFail, recordPipeOk } from "./pipe-health";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const MAX_MIN = 7 * 24 * 60;

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nyHour(now: number): number {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return Number(parts.hour) || 0;
}

function nixleCacheMs(now: number, agencyId: string): number {
  const h = nyHour(now);
  // Daytime cadence: quicker refresh so advisories surface faster.
  const base = h >= 6 && h < 22 ? 60_000 : 4 * 60_000;
  // Stable jitter to avoid stampedes when many clients refresh simultaneously.
  let j = 0;
  for (let i = 0; i < agencyId.length; i++) j = (j * 31 + agencyId.charCodeAt(i)) | 0;
  const spread = Math.round(base * 0.1);
  return base + ((Math.abs(j) % (spread * 2 + 1)) - spread);
}

type NixleAgency = {
  id: string;
  label: string;
  url: string;
  agency: string;
  /** Fallback municipality when alert text is generic (helps filtering/ranking). */
  municipalityHint?: string;
};

function decodeJsString(raw: string): string {
  const s = raw.trim();
  const quoted =
    (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
  return quoted
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(raw: string): string {
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function prop(obj: string, key: string): string {
  const re = new RegExp(`\\b${key}\\b\\s*:\\s*("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|\\d+|true|false|null)`, "i");
  const m = obj.match(re);
  return m?.[1] ?? "";
}

function extractAlertsArray(html: string): string {
  const m = html.match(/var\s+alerts\s*=\s*\[([\s\S]*?)\]\s*;/i);
  return (m?.[1] ?? "").trim();
}

function toAbsolute(link: string): string {
  if (!link) return "";
  if (link.startsWith("http://") || link.startsWith("https://")) return link;
  if (link.startsWith("/")) return `https://nixle.us${link}`;
  return `https://nixle.us/${link.replace(/^\/+/, "")}`;
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `nixle-${Math.abs(h).toString(36)}`;
}

type CacheEntry = { at: number; items: LiveWireItem[] } | null;
const g = globalThis as unknown as { __actNixleCache?: Map<string, CacheEntry> };
function cacheMap(): Map<string, CacheEntry> {
  if (!g.__actNixleCache) g.__actNixleCache = new Map();
  return g.__actNixleCache;
}

async function fetchNixleAgency(agency: NixleAgency, now = Date.now()): Promise<LiveWireItem[]> {
  const cache = cacheMap();
  const hit = cache.get(agency.id);
  const ttl = nixleCacheMs(now, agency.id);
  if (hit && now - hit.at < ttl) return hit.items;
  try {
    const res = await fetch(agency.url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) {
      recordPipeFail(agency.id, agency.label, `HTTP ${res.status}`);
      // Keep last known items on transient errors so alerts don't "blink" out of the UI.
      if (hit && hit.items.length && now - hit.at < 30 * 60_000) return hit.items;
      cache.set(agency.id, { at: now, items: [] });
      return [];
    }
    const html = await res.text();
    const inner = extractAlertsArray(html);
    if (!inner) {
      recordPipeOk(agency.id, agency.label, 0);
      cache.set(agency.id, { at: now, items: [] });
      return [];
    }

    const out: LiveWireItem[] = [];
    const seen = new Set<string>();
    for (const m of inner.matchAll(/\{[\s\S]*?\}(?:\s*,\s*|$)/g)) {
      const obj = m[0]!;
      const idRaw = prop(obj, "id");
      const headlineRaw = prop(obj, "headline") || prop(obj, "title");
      const linkRaw = prop(obj, "link") || prop(obj, "url");
      const modifiedRaw = prop(obj, "modified") || prop(obj, "created") || prop(obj, "sent");
      const bodyRaw = prop(obj, "message") || prop(obj, "body") || prop(obj, "text") || prop(obj, "alert_text");

      const url = toAbsolute(decodeJsString(linkRaw));
      const headline = stripHtml(decodeJsString(headlineRaw));
      if (!headline || !url) continue;
      const stableId = idRaw && /^\d+$/.test(idRaw.trim()) ? `nixle-${idRaw.trim()}` : hashId(url);
      if (seen.has(stableId) || seen.has(url)) continue;
      seen.add(stableId);
      seen.add(url);

      const at = Date.parse(decodeJsString(modifiedRaw)) || now;
      const minutesAgo = Math.max(0, Math.round((now - at) / 60_000));
      if (minutesAgo > MAX_MIN) continue;

      const body = stripHtml(decodeJsString(bodyRaw));
      const summary = (body && body.length >= 24 ? body : headline).slice(0, 260);
      const place = placeFromText(`${headline} ${summary}`);
      const muni = place?.name || agency.municipalityHint;
      const pin = locateSpoken(`${headline} ${summary}`, muni || "Albany");

      out.push({
        id: stableId,
        title: headline.slice(0, 180),
        url,
        outlet: agency.label,
        summary,
        publishedAt: new Date(at).toISOString(),
        minutesAgo,
        kind: "news",
        agency: agency.agency,
        municipality: muni,
        address: pin.road || muni,
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        geoPrecision: pin.precision,
      });
    }

    out.sort((a, b) => a.minutesAgo - b.minutesAgo);
    recordPipeOk(agency.id, agency.label, out.length);
    cache.set(agency.id, { at: now, items: out });
    return out;
  } catch (err) {
    recordPipeFail(agency.id, agency.label, err instanceof Error ? err.message : "nixle-error");
    if (hit && hit.items.length && now - hit.at < 30 * 60_000) return hit.items;
    cache.set(agency.id, { at: now, items: [] });
    return [];
  }
}

export async function fetchNixleApd(now = Date.now()): Promise<LiveWireItem[]> {
  return fetchNixleAgency(
    {
      id: "nixle:apd",
      label: "Nixle · Albany PD",
      url: "https://nixle.us/albany-police-department",
      agency: "Albany Police Department",
      municipalityHint: "Albany",
    },
    now,
  );
}

export async function fetchNixleGuilderlandPd(now = Date.now()): Promise<LiveWireItem[]> {
  return fetchNixleAgency(
    {
      id: "nixle:guilderland-pd",
      label: "Nixle · Guilderland PD",
      url: "https://nixle.us/guilderland-police-department",
      agency: "Guilderland Police Department",
      municipalityHint: "Guilderland",
    },
    now,
  );
}

export async function fetchNixleWatervliet(now = Date.now()): Promise<LiveWireItem[]> {
  return fetchNixleAgency(
    {
      id: "nixle:watervliet",
      label: "Nixle · Watervliet",
      url: "https://nixle.us/city-of-watervliet",
      agency: "City of Watervliet",
      municipalityHint: "Watervliet",
    },
    now,
  );
}

export async function fetchNixleAltamont(now = Date.now()): Promise<LiveWireItem[]> {
  return fetchNixleAgency(
    {
      id: "nixle:altamont",
      label: "Nixle · Altamont",
      url: "https://nixle.us/village-of-altamont-ny",
      agency: "Village of Altamont",
      municipalityHint: "Altamont",
    },
    now,
  );
}

export async function fetchNixleColoniePd(now = Date.now()): Promise<LiveWireItem[]> {
  return fetchNixleAgency(
    {
      id: "nixle:colonie-pd",
      label: "Nixle · Colonie PD",
      url: "https://nixle.us/town-of-colonie-police-ny",
      agency: "Town of Colonie Police Department",
      municipalityHint: "Colonie",
    },
    now,
  );
}

