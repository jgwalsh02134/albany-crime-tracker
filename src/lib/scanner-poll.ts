import { extractAudioFromMpegTs, parseM3u8 } from "./scanner-hls";
import { http2Get, http2GetText } from "./http2-get";
import { transcribeAudioFile } from "./transcribe";
import { getScannerFeed, SCANNER_FEEDS } from "./scanner-feeds";
import type { LiveWireItem } from "./sources";
import { locateSpoken } from "./geo";

const TICK_MS = 12000;
const MAX_ITEMS = 120;
const MIN_AUDIO = 1400;
const EXTRA_FEEDS = ["1440", "37206", "36327"] as const;
const CALL =
  /\b(panic|alarm|welfare|domestic|crash|collision|accident|personal injury|\bpi\b|fire|ems|ambulance|shoot|shots|gun|stab|fight|assault|burglary|robbery|larceny|theft|stolen|suspicious|wanted|dwi|intoxicated|overdose|unconscious|medical|rescue|injury|injured|hit.?and.?run|pursuit|missing|trespass|harass|person down|man down|priority|hold.?up|weapon|carjack|disabled|breakdown|speedway|10-1[0-9]|10-5[0-9]|10-8[0-9])\b/i;
const PLACE =
  /\b(street|st\.|avenue|ave\.|road|rd\.|boulevard|blvd|place|pl\.|parkway|pkwy|highway|hwy|interstate|i-?8[79]|i-?90|i-?787|route|western|central|lark|pearl|madison|washington|new scotland|delaware|southern|broadway|wolf road|henry johnson|colonie|latham|bethlehem|guilderland|albany|cohoes|watervliet|menands|delmar|loudonville|selkirk|glenmont|troy)\b/i;

export type CaptionLine = {
  id: string;
  at: number;
  text: string;
  feedId: string;
  feedName: string;
};

type ScanState = {
  ver: 3;
  buffer: LiveWireItem[];
  captions: CaptionLine[];
  seenSeq: Map<string, Set<number>>;
  lastText: Map<string, string>;
  stats: {
    ticks: number;
    kept: number;
    lastTickAt: number;
    lastError: string;
    lastErrorAt: number;
    lastSpoken: string;
    lastSpokenAt: number;
    lastFeed: string;
  };
  ticking: boolean;
  cursor: number;
  sttBlockedUntil: number;
  listenFeed: string | null;
  listenUntil: number;
  timer?: ReturnType<typeof setInterval>;
};


const g = globalThis as unknown as {
  __actScan?: ScanState;
  __actScanTimer?: ReturnType<typeof setInterval>;
  __actScanTicking?: boolean;
};

function freshState(): ScanState {
  return {
    ver: 3,
    buffer: [],
    captions: [],
    seenSeq: new Map(),
    lastText: new Map(),
    stats: {
      ticks: 0,
      kept: 0,
      lastTickAt: 0,
      lastError: "",
      lastErrorAt: 0,
      lastSpoken: "",
      lastSpokenAt: 0,
      lastFeed: "",
    },
    ticking: false,
    cursor: 0,
    sttBlockedUntil: 0,
    listenFeed: null,
    listenUntil: 0,
  };
}

if (!g.__actScan || g.__actScan.ver !== 3) g.__actScan = freshState();
const state = g.__actScan;

function stopZombie() {
  if (g.__actScanTimer) {
    clearInterval(g.__actScanTimer);
    g.__actScanTimer = undefined;
  }
  g.__actScanTicking = false;
  state.ticking = false;
}

function looksCaption(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 3) return false;
  if (!/[a-z0-9]/i.test(t)) return false;
  if (/^(silence|inaudible|music|blank|\.+)$/i.test(t)) return false;
  if (/brooklyn|queens|bronx|manhattan|automatic line|brooklyn north/i.test(t)) return false;
  if ((t.match(/10-\d+/g) || []).length >= 3) return false;
  if (/copy\s+en route\s+on scene/i.test(t)) return false;
  if ((t.match(/,/g) || []).length >= 6) return false;
  return true;
}

function looksDispatch(text: string): boolean {
  if (!looksCaption(text)) return false;
  if (text.replace(/\s+/g, " ").trim().length < 12) return false;
  if (CALL.test(text) || PLACE.test(text)) return true;
  return streetsOf(text).length > 0;
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
  const nature = natureOf(spoken);
  if (nature && streets.length) return `${nature} · ${streets.slice(0, 2).join(" & ")}`;
  if (nature) return `${kind} radio · ${nature}`;
  if (streets.length) return `${kind} radio · ${streets.slice(0, 2).join(" & ")}`;
  const t = spoken.replace(/\s+/g, " ").trim();
  return `${kind} radio · ${t.length <= 72 ? t : `${t.slice(0, 68).replace(/\s+\S*$/, "")}…`}`;
}

function natureOf(text: string): string {
  if (/panic/i.test(text)) return "Panic alarm";
  if (/hold.?up|robbery/i.test(text)) return "Robbery";
  if (/shots? fired|shoot/i.test(text)) return "Shots fired";
  if (/domestic/i.test(text)) return "Domestic";
  if (/welfare/i.test(text)) return "Welfare check";
  if (/personal injury|\bpi\b|injury crash/i.test(text)) return "Injury crash";
  if (/crash|collision|accident|mva/i.test(text)) return "Crash";
  if (/structure fire|building fire/i.test(text)) return "Structure fire";
  if (/\bfire\b/i.test(text)) return "Fire";
  if (/ems|ambulance|medical|overdose|unconscious/i.test(text)) return "EMS";
  if (/burglar/i.test(text)) return "Burglar alarm";
  if (/\balarm\b/i.test(text)) return "Alarm";
  if (/suspicious/i.test(text)) return "Suspicious";
  if (/dwi|intoxicated/i.test(text)) return "DWI";
  return "";
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

function withDisclaimer(spoken: string, agency: string): string {
  const clip = spoken.replace(/\s+/g, " ").trim().slice(0, 220);
  const body = clip.length < spoken.trim().length ? `${clip.replace(/\s+\S*$/, "")}…` : clip;
  const punct = /[.!?…]$/.test(body) ? "" : ".";
  return `${body}${punct} Unconfirmed ${agency} radio — not a CAD call.`;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function rememberCaption(feedId: string, feedName: string, spoken: string) {
  const last = state.captions[0];
  if (last && last.feedId === feedId && last.text === spoken) return;
  state.captions.unshift({
    id: `cap-${feedId}-${Date.now()}`,
    at: Date.now(),
    text: spoken,
    feedId,
    feedName,
  });
  if (state.captions.length > 80) state.captions.length = 80;
}

async function tickFeed(feedId: string) {
  const feed = getScannerFeed(feedId) ?? SCANNER_FEEDS[0]!;
  const playlistUrl = feed.hlsFallback;
  const playlist = await http2GetText(playlistUrl, 8000);
  const segs = parseM3u8(playlist, playlistUrl);
  const window = segs.slice(-3);
  const last = window.at(-1);
  if (!last) return;
  const seen = state.seenSeq.get(feedId) ?? new Set<number>();
  if (seen.has(last.seq)) return;
  if (Date.now() < state.sttBlockedUntil) return;

  const parts: Uint8Array[] = [];
  let mime = "audio/mpeg";
  let filename = "segment.mp3";
  for (const seg of window) {
    try {
      const ts = await http2Get(seg.url, 8000);
      const audio = extractAudioFromMpegTs(ts);
      if (!audio || audio.bytes.byteLength < 400) continue;
      parts.push(audio.bytes);
      mime = audio.mime;
      filename = audio.filename;
    } catch (err) {
      state.stats.lastError = err instanceof Error ? err.message : "seg-fetch";
      state.stats.lastErrorAt = Date.now();
    }
  }
  if (!parts.length) {
    seen.add(last.seq);
    state.seenSeq.set(feedId, seen);
    return;
  }

  let spoken = "";
  try {
    const merged = parts.length === 1 ? parts[0]! : concatBytes(parts);
    if (merged.byteLength < MIN_AUDIO) {
      seen.add(last.seq);
      state.seenSeq.set(feedId, seen);
      return;
    }
    const result = await transcribeAudioFile(merged, filename, mime);
    spoken = result.text.trim();
    seen.add(last.seq);
    state.stats.lastError = "";
    state.stats.lastErrorAt = 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stt";
    state.stats.lastError = msg;
    state.stats.lastErrorAt = Date.now();
    console.error("[scanner] stt", feedId, msg);
    if (msg.includes("429")) state.sttBlockedUntil = Date.now() + 60_000;
    state.seenSeq.set(feedId, seen);
    return;
  }
  if (seen.size > 400) {
    const keep = [...seen].slice(-200);
    seen.clear();
    for (const s of keep) seen.add(s);
  }
  state.seenSeq.set(feedId, seen);

  if (!spoken) return;
  state.stats.lastSpoken = spoken.slice(0, 160);
  state.stats.lastSpokenAt = Date.now();
  state.stats.lastFeed = feedId;
  if (!looksCaption(spoken)) return;
  rememberCaption(feedId, feed.name, spoken);
  if (!looksDispatch(spoken)) return;
  const key = spoken.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (key === state.lastText.get(feedId)) return;
  state.lastText.set(feedId, key);
  const now = Date.now();
  const muni = placeName(spoken, "Albany");
  const pin = locateSpoken(spoken, muni);
  const item: LiveWireItem = {
    id: `scan-${feedId}-${last.seq}`,
    title: scannerTitle(spoken, feed.name),
    url: feed.url,
    outlet: "Scanner",
    summary: withDisclaimer(spoken, feed.name),
    publishedAt: new Date(now).toISOString(),
    minutesAgo: 0,
    kind: "scanner",
    municipality: muni,
    address: pin.road ? `${pin.road} · ${muni}` : feed.coverage,
    agency: feed.name,
    lat: pin.geo.lat,
    lng: pin.geo.lng,
  };
  state.buffer.unshift(item);
  state.stats.kept += 1;
  if (state.buffer.length > MAX_ITEMS) state.buffer.length = MAX_ITEMS;
}

async function tick() {
  if (state.ticking || g.__actScanTicking) return;
  state.ticking = true;
  g.__actScanTicking = true;
  state.stats.ticks += 1;
  state.stats.lastTickAt = Date.now();
  try {
    if (!process.env.XAI_API_KEY) {
      state.stats.lastError = "no-key";
      state.stats.lastErrorAt = Date.now();
      return;
    }
    if (Date.now() < state.sttBlockedUntil) return;
    const jobs = [tickFeed("3626")];
    const listen = state.listenFeed && Date.now() < state.listenUntil ? state.listenFeed : null;
    if (listen && listen !== "3626") jobs.push(tickFeed(listen));
    else if (state.stats.ticks % 3 === 0) {
      jobs.push(tickFeed(EXTRA_FEEDS[state.cursor % EXTRA_FEEDS.length]!));
      state.cursor += 1;
    }
    await Promise.race([
      Promise.all(jobs),
      new Promise((_, reject) => setTimeout(() => reject(new Error("tick-timeout")), 18000)),
    ]);
  } catch (err) {
    state.stats.lastError = err instanceof Error ? err.message : "tick";
    state.stats.lastErrorAt = Date.now();
    console.error("[scanner] tick", state.stats.lastError);
  } finally {
    state.ticking = false;
    g.__actScanTicking = false;
  }
}

export function startScannerPoll() {
  const stale = state.stats.lastTickAt > 0 && Date.now() - state.stats.lastTickAt > 45_000;
  if (g.__actScanTimer && !stale) return;
  stopZombie();
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  g.__actScanTimer = timer;
  state.timer = timer;
}

export function setListenFeed(feedId: string | null) {
  state.listenFeed = feedId;
  state.listenUntil = feedId ? Date.now() + 10 * 60_000 : 0;
  startScannerPoll();
}

export function captionLines(feedId?: string): CaptionLine[] {
  const rows = feedId ? state.captions.filter((c) => c.feedId === feedId) : state.captions;
  return rows.slice(0, 40);
}

export async function awaitScannerTick(ms = 12000): Promise<void> {
  startScannerPoll();
  if (state.buffer.length > 0) return;
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (state.stats.ticks > 0 && !state.ticking) return;
    await new Promise((r) => setTimeout(r, 350));
  }
}

export function scannerHealth(): {
  ticks: number;
  kept: number;
  lastError: string;
  lastErrorAt: number;
  lastSpoken: string;
  lastSpokenAt: number;
  lastFeed: string;
  ageSec: number;
  captions: number;
} {
  return {
    ticks: state.stats.ticks,
    kept: state.stats.kept,
    lastError: state.stats.lastError,
    lastErrorAt: state.stats.lastErrorAt,
    lastSpoken: state.stats.lastSpoken,
    lastSpokenAt: state.stats.lastSpokenAt,
    lastFeed: state.stats.lastFeed,
    ageSec: state.stats.lastTickAt ? Math.round((Date.now() - state.stats.lastTickAt) / 1000) : -1,
    captions: state.captions.length,
  };
}

export function scannerItems(now = Date.now()): LiveWireItem[] {
  return state.buffer
    .map((row) => {
      const spoken = spokenFrom(row);
      const muni = placeName(spoken, row.municipality || "Albany");
      const pin = locateSpoken(spoken, muni);
      return {
        ...row,
        title: scannerTitle(spoken, row.agency || "Scanner"),
        summary: withDisclaimer(spoken, row.agency || "scanner"),
        municipality: muni,
        address: pin.road ? `${pin.road} · ${muni}` : row.address,
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        minutesAgo: Math.max(0, Math.round((now - Date.parse(row.publishedAt)) / 60_000)),
      };
    })
    .filter((row) => row.minutesAgo <= 24 * 60 && looksDispatch(spokenFrom(row)));
}

stopZombie();
startScannerPoll();
