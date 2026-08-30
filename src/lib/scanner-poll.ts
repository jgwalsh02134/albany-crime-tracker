import { extractAudioFromMpegTs, parseM3u8 } from "./scanner-hls";
import { http2Get, http2GetText } from "./http2-get";
import { transcribeAudioFile } from "./transcribe";
import { getScannerFeed, SCANNER_FEEDS } from "./scanner-feeds";
import type { LiveWireItem } from "./sources";
import { locateSpoken } from "./geo";

const TICK_MS = 12000;
const MAX_ITEMS = 120;
const MIN_AUDIO = 1400;
const EXTRA_FEEDS = ["1440", "37206"] as const;

const buffer: LiveWireItem[] = [];
const seenSeq = new Map<string, Set<number>>();
const lastText = new Map<string, string>();
const g = globalThis as unknown as {
  __actScanTimer?: ReturnType<typeof setInterval>;
  __actScanTicking?: boolean;
};

function stopZombie() {
  if (g.__actScanTimer) {
    clearInterval(g.__actScanTimer);
    g.__actScanTimer = undefined;
  }
  g.__actScanTicking = false;
}

stopZombie();

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let cursor = 0;
let sttBlockedUntil = 0;

const stats = {
  ticks: 0,
  kept: 0,
  lastTickAt: 0,
  lastError: "",
  lastSpoken: "",
};

const PLACE =
  /\b(albany|colonie|latham|bethlehem|delmar|guilderland|cohoes|watervliet|menands|loudonville|central avenue|western avenue|lark|pearl|washington avenue|henry johnson|new scotland|madison|state street|north pearl|central ave|western ave|broadway|wolf road|northway|thruway)\b/i;

function looksVoice(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/^(silence|inaudible|music|blank|\.+)$/i.test(t)) return false;
  if (!/[a-z]/i.test(t)) return false;
  if (/brooklyn|queens|bronx|manhattan|automatic line|see you later|brooklyn north/i.test(t)) return false;
  if ((t.match(/10-\d+/g) || []).length >= 3) return false;
  if (/copy\s+en route\s+on scene/i.test(t)) return false;
  const hasPlace =
    PLACE.test(t) || /\b\d{1,5}\s+[A-Za-z][A-Za-z']+(?:\s+[A-Za-z][A-Za-z']+)?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard)\b/i.test(t);
  if ((t.match(/,/g) || []).length >= 5 && !hasPlace) return false;
  const RADIO =
    /\b(10-\d+|copy|dispatch|en route|on scene|in custody|unit|officer|\bpd\b|fire|ems|rescue|ambulance|respond|priority|wanted|suspect|traffic stop|welfare|albany|colonie|latham|central|western|lark|pearl|truck|male|female|weapon|engine|take us|cross street|car )\b/i;
  return RADIO.test(t) || hasPlace;
}

function streetsOf(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b(?:\d{1,5}\s+)?(?:north|south|east|west|n\.?|s\.?|e\.?|w\.?)?\s*[A-Za-z][A-Za-z']+(?:\s+[A-Za-z][A-Za-z']+){0,2}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|place|pl\.?)\b/gi;
  for (const m of text.matchAll(re)) {
    const s = m[0]!.replace(/\s+/g, " ").trim();
    if (s.length < 6) continue;
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

function scannerTitle(spoken: string, feedName: string): string {
  const streets = streetsOf(spoken);
  const kind = /ems|ambulance|rescue/i.test(`${spoken} ${feedName}`)
    ? "EMS"
    : /fire|engine|truck/i.test(`${spoken} ${feedName}`)
      ? "Fire"
      : "Police";
  if (streets.length) return `${kind} radio · ${streets.slice(0, 2).join(" & ")}`;
  const t = spoken.replace(/\s+/g, " ").trim();
  return `${kind} radio · ${t.length <= 72 ? t : `${t.slice(0, 68).replace(/\s+\S*$/, "")}…`}`;
}

function placeName(text: string, fallback: string): string {
  if (/colonie|latham/i.test(text)) return "Colonie";
  if (/bethlehem|delmar/i.test(text)) return "Bethlehem";
  if (/guilderland/i.test(text)) return "Guilderland";
  if (/cohoes/i.test(text)) return "Cohoes";
  if (/watervliet/i.test(text)) return "Watervliet";
  if (/troy/i.test(text)) return "Troy";
  return fallback;
}

function spokenFrom(row: LiveWireItem): string {
  if (/Unconfirmed .* radio/i.test(row.summary)) {
    return row.summary.replace(/\. Unconfirmed[\s\S]*$/i, "").trim();
  }
  return row.title;
}

async function tickFeed(feedId: string) {
  const feed = getScannerFeed(feedId) ?? SCANNER_FEEDS[0]!;
  const playlistUrl = feed.hlsFallback;
  const playlist = await http2GetText(playlistUrl, 8000);
  const segs = parseM3u8(playlist, playlistUrl);
  const latestFew = segs.slice(-2);
  const seen = seenSeq.get(feedId) ?? new Set<number>();
  for (const latest of latestFew) {
    if (seen.has(latest.seq)) continue;
    if (Date.now() < sttBlockedUntil) break;
    let ts: Uint8Array;
    try {
      ts = await http2Get(latest.url, 8000);
    } catch (err) {
      stats.lastError = err instanceof Error ? err.message : "seg-fetch";
      continue;
    }
    const audio = extractAudioFromMpegTs(ts);
    if (!audio || audio.bytes.byteLength < MIN_AUDIO) {
      seen.add(latest.seq);
      continue;
    }
    let spoken = "";
    try {
      const result = await transcribeAudioFile(audio.bytes, audio.filename, audio.mime);
      spoken = result.text.trim();
      seen.add(latest.seq);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "stt";
      stats.lastError = msg;
      console.error("[scanner] stt", feedId, msg);
      if (msg.includes("429")) sttBlockedUntil = Date.now() + 60_000;
      continue;
    }
    if (!spoken) continue;
    stats.lastSpoken = spoken.slice(0, 160);
    if (!looksVoice(spoken)) continue;
    const key = spoken.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (key === lastText.get(feedId)) continue;
    lastText.set(feedId, key);
    const now = Date.now();
    const muni = placeName(spoken, "Albany");
    const pin = locateSpoken(spoken, muni);
    const item: LiveWireItem = {
      id: `scan-${feedId}-${latest.seq}`,
      title: scannerTitle(spoken, feed.name),
      url: feed.url,
      outlet: "Scanner",
      summary: `${spoken.slice(0, 220)}${spoken.length > 220 ? "…" : ""}. Unconfirmed ${feed.name} radio — not a CAD call.`,
      publishedAt: new Date(now).toISOString(),
      minutesAgo: 0,
      kind: "scanner",
      municipality: muni,
      address: pin.road ? `${pin.road} · ${muni}` : feed.coverage,
      agency: feed.name,
      lat: pin.geo.lat,
      lng: pin.geo.lng,
    };
    buffer.unshift(item);
    stats.kept += 1;
    if (buffer.length > MAX_ITEMS) buffer.length = MAX_ITEMS;
  }
  if (seen.size > 400) {
    const keep = [...seen].slice(-200);
    seen.clear();
    for (const s of keep) seen.add(s);
  }
  seenSeq.set(feedId, seen);
}

async function tick() {
  if (ticking || g.__actScanTicking) return;
  ticking = true;
  g.__actScanTicking = true;
  stats.ticks += 1;
  stats.lastTickAt = Date.now();
  try {
    if (!process.env.XAI_API_KEY) {
      stats.lastError = "no-key";
      return;
    }
    if (Date.now() < sttBlockedUntil) return;
    const jobs = [tickFeed("3626")];
    if (stats.ticks % 3 === 0) {
      jobs.push(tickFeed(EXTRA_FEEDS[cursor % EXTRA_FEEDS.length]!));
      cursor += 1;
    }
    await Promise.race([
      Promise.all(jobs),
      new Promise((_, reject) => setTimeout(() => reject(new Error("tick-timeout")), 18000)),
    ]);
  } catch (err) {
    stats.lastError = err instanceof Error ? err.message : "tick";
    console.error("[scanner] tick", stats.lastError);
  } finally {
    ticking = false;
    g.__actScanTicking = false;
  }
}

export function startScannerPoll() {
  const stale = stats.lastTickAt > 0 && Date.now() - stats.lastTickAt > 45_000;
  if (timer && !stale) return;
  stopZombie();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  ticking = false;
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
  g.__actScanTimer = timer;
}

export async function awaitScannerTick(ms = 12000): Promise<void> {
  startScannerPoll();
  if (buffer.length > 0) return;
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (stats.ticks > 0 && !ticking) return;
    await new Promise((r) => setTimeout(r, 350));
  }
}

export function scannerHealth(): { ticks: number; kept: number; lastError: string; lastSpoken: string; ageSec: number } {
  return {
    ticks: stats.ticks,
    kept: stats.kept,
    lastError: stats.lastError,
    lastSpoken: stats.lastSpoken,
    ageSec: stats.lastTickAt ? Math.round((Date.now() - stats.lastTickAt) / 1000) : -1,
  };
}

export function scannerItems(now = Date.now()): LiveWireItem[] {
  return buffer
    .map((row) => {
      const spoken = spokenFrom(row);
      const muni = placeName(spoken, row.municipality || "Albany");
      const pin = locateSpoken(spoken, muni);
      return {
        ...row,
        title: scannerTitle(spoken, row.agency || "Scanner"),
        summary: `${spoken.slice(0, 220)}${spoken.length > 220 ? "…" : ""}. Unconfirmed ${row.agency || "scanner"} radio — not a CAD call.`,
        municipality: muni,
        address: pin.road ? `${pin.road} · ${muni}` : row.address,
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        minutesAgo: Math.max(0, Math.round((now - Date.parse(row.publishedAt)) / 60_000)),
      };
    })
    .filter((row) => row.minutesAgo <= 24 * 60 && looksVoice(spokenFrom(row)));
}
