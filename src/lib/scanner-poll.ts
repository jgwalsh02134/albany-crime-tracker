import { extractAudioFromMpegTs, parseM3u8 } from "./scanner-hls";
import { http2Get, http2GetText } from "./http2-get";
import { transcribeAudioFile } from "./transcribe";
import { getScannerFeed, SCANNER_FEEDS } from "./scanner-feeds";
import type { LiveWireItem } from "./sources";

const TICK_MS = 8000;
const MAX_ITEMS = 120;
const MIN_AUDIO = 1400;
const LIVE_FEEDS = ["3626", "1440"] as const;

const buffer: LiveWireItem[] = [];
const seenSeq = new Map<string, Set<number>>();
const lastText = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let cursor = 0;

const PLACE =
  /\b(albany|colonie|latham|bethlehem|delmar|guilderland|cohoes|watervliet|menands|loudonville|central avenue|western avenue|lark|pearl|washington avenue|henry johnson|new scotland|madison|state street|north pearl|central ave|western ave)\b/i;

function looksVoice(text: string): boolean {
  const t = text.trim();
  if (t.length < 18) return false;
  if (/^(silence|inaudible|music|blank|\.+)$/i.test(t)) return false;
  if (!/[a-z]/i.test(t)) return false;
  if ((t.match(/10-\d+/g) || []).length >= 3) return false;
  if (/copy\s+en route\s+on scene/i.test(t)) return false;
  if (/(?:^|,)\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/.test(t)) return false;
  if ((t.match(/,/g) || []).length >= 4) return false;
  const RADIO =
    /\b(10-\d+|copy|dispatch|en route|on scene|in custody|unit|officer|pd|fire|ems|rescue|ambulance|respond|priority|wanted|suspect|traffic stop|welfare|albany|colonie|latham|central|western|lark|pearl|car |truck|male|female|weapons)\b/i;
  return RADIO.test(t) || PLACE.test(t);
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= 96) return t;
  return `${t.slice(0, 92).replace(/\s+\S*$/, "")}…`;
}

function placeName(text: string, fallback: string): string {
  if (/colonie|latham/i.test(text)) return "Colonie";
  if (/bethlehem|delmar/i.test(text)) return "Bethlehem";
  if (/guilderland/i.test(text)) return "Guilderland";
  if (/cohoes/i.test(text)) return "Cohoes";
  if (/watervliet/i.test(text)) return "Watervliet";
  return fallback;
}

async function tickFeed(feedId: string) {
  const feed = getScannerFeed(feedId) ?? SCANNER_FEEDS[0]!;
  const playlistUrl = feed.hlsFallback;
  const playlist = await http2GetText(playlistUrl, 8000);
  const segs = parseM3u8(playlist, playlistUrl);
  const latestFew = segs.slice(-3);
  const seen = seenSeq.get(feedId) ?? new Set<number>();
  for (const latest of latestFew) {
    if (seen.has(latest.seq)) continue;
    seen.add(latest.seq);
    const ts = await http2Get(latest.url, 8000);
    const audio = extractAudioFromMpegTs(ts);
    if (!audio || audio.bytes.byteLength < MIN_AUDIO) continue;
    const result = await transcribeAudioFile(audio.bytes, audio.filename, audio.mime);
    const spoken = result.text.trim();
    if (!looksVoice(spoken)) continue;
    const key = spoken.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (key === lastText.get(feedId)) continue;
    lastText.set(feedId, key);
    const now = Date.now();
    const muni = placeName(spoken, "Albany");
    const item: LiveWireItem = {
      id: `scan-${feedId}-${latest.seq}`,
      title: titleFrom(spoken),
      url: feed.url,
      outlet: "Scanner",
      summary: `${feed.name} · ${PLACE.test(spoken) ? "location heard" : "unconfirmed radio traffic"}`,
      publishedAt: new Date(now).toISOString(),
      minutesAgo: 0,
      kind: "scanner",
      municipality: muni,
      address: feed.coverage,
      agency: feed.name,
    };
    buffer.unshift(item);
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
  if (ticking) return;
  ticking = true;
  try {
    if (!process.env.XAI_API_KEY) return;
    const feedId = LIVE_FEEDS[cursor % LIVE_FEEDS.length]!;
    cursor += 1;
    await tickFeed(feedId);
  } catch {
    /* non-fatal — blotter still feeds Live */
  } finally {
    ticking = false;
  }
}

export function startScannerPoll() {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
}

export function scannerItems(now = Date.now()): LiveWireItem[] {
  return buffer
    .map((row) => ({
      ...row,
      minutesAgo: Math.max(0, Math.round((now - Date.parse(row.publishedAt)) / 60_000)),
    }))
    .filter((row) => row.minutesAgo <= 24 * 60);
}
