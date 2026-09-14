import type { LiveWireItem } from "./sources";
import { locateSpoken, placeFromText } from "./geo";
import { recordPipeFail, recordPipeOk } from "./pipe-health";
import { decodeHtmlEntities } from "./html";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const URL = "https://tincevents.thruway.ny.gov/tincview.aspx?zone=albany";
const PIPE_ID = "tinc:albany";
const PIPE_LABEL = "NYSTA TINC · Albany";
const CACHE_MS = 60_000;
const LIVE_MIN = 24 * 60;

type Cache = { at: number; items: LiveWireItem[] } | null;
const g = globalThis as unknown as { __actTincAlbany?: Cache };

function decodeHtml(raw: string): string {
  const s = raw.replace(/&nbsp;/gi, " ");
  return decodeHtmlEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function zonedNyGuess(year: number, month: number, day: number, hour: number, minute: number): number {
  const utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
  const asIf = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return utc - (asIf - utc);
}

function parseTincWhen(raw: string, now: number): number {
  // Example: "9/14  06:26 AM"
  const s = decodeHtml(raw);
  const m = s.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return now;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let hour = Number(m[3]);
  const minute = Number(m[4]);
  const ap = m[5]!.toUpperCase();
  if (ap === "PM" && hour < 12) hour += 12;
  if (ap === "AM" && hour === 12) hour = 0;
  const nowD = new Date(now);
  const year = nowD.getUTCFullYear();
  let t = zonedNyGuess(year, month, day, hour, minute);
  // If TINC list crosses year boundary, keep the closest past timestamp.
  if (t > now + 3 * 60_000) {
    t = zonedNyGuess(year - 1, month, day, hour, minute);
  }
  return t;
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `tinc-${Math.abs(h).toString(36)}`;
}

export async function fetchThruwayTincAlbany(now = Date.now()): Promise<LiveWireItem[]> {
  if (g.__actTincAlbany && now - g.__actTincAlbany.at < CACHE_MS) return g.__actTincAlbany.items;
  try {
    const res = await fetch(URL, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      recordPipeFail(PIPE_ID, PIPE_LABEL, `HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const table = html.match(/<table[\s\S]*?<tbody>([\s\S]*?)<\/tbody>[\s\S]*?<\/table>/i)?.[1] ?? "";
    if (!table) {
      recordPipeOk(PIPE_ID, PIPE_LABEL, 0);
      g.__actTincAlbany = { at: now, items: [] };
      return [];
    }

    const out: LiveWireItem[] = [];
    const seen = new Set<string>();
    for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => decodeHtml(m[1]!));
      if (cells.length < 4) continue;
      const callNo = (cells[0] || "").replace(/\D/g, "");
      const whenRaw = cells[1] || "";
      const callType = (cells[2] || "").replace(/\s+/g, " ").trim();
      const loc = (cells[3] || "").replace(/\s+/g, " ").trim();
      if (!callType || !loc) continue;

      const at = parseTincWhen(whenRaw, now);
      const minutesAgo = Math.max(0, Math.round((now - at) / 60_000));
      if (minutesAgo > LIVE_MIN) continue;

      const id = callNo ? `tinc-albany-${callNo}-${Math.floor(at / 60_000)}` : hashId(`${callType}|${loc}|${at}`);
      if (seen.has(id)) continue;
      seen.add(id);

      const road = loc.replace(/^MP\s+/i, "").replace(/\s+/g, " ").trim();
      const place = placeFromText(`${callType} ${road}`) || { name: "Capital District", lat: 42.65, lng: -73.75 };
      const pin = locateSpoken(`${callType} ${road}`, place.name);
      out.push({
        id,
        title: `${callType} — ${road}`.slice(0, 180),
        url: URL,
        outlet: "NYSTA TINC",
        summary: `${callType} reported by NYS Thruway (TINC). Link out for official details.`.slice(0, 240),
        publishedAt: new Date(at).toISOString(),
        minutesAgo,
        kind: "traffic",
        municipality: place.name,
        address: road,
        agency: "NYS Thruway",
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        geoPrecision: pin.precision,
      });
    }

    out.sort((a, b) => a.minutesAgo - b.minutesAgo);
    recordPipeOk(PIPE_ID, PIPE_LABEL, out.length);
    g.__actTincAlbany = { at: now, items: out };
    return out;
  } catch (err) {
    recordPipeFail(PIPE_ID, PIPE_LABEL, err instanceof Error ? err.message : "tinc-error");
    return [];
  }
}

