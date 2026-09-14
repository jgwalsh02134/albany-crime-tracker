import { createServerFn } from "@tanstack/react-start";
import { extractAudioFromMpegTs } from "./scanner-hls";
import { getScannerFeed, SCANNER_FEEDS } from "./scanner-feeds";
import { isSttJunk } from "./stt-junk";

const LISTEN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const KEYTERMS = [
  "Albany",
  "Colonie",
  "Bethlehem",
  "Guilderland",
  "Cohoes",
  "Watervliet",
  "Menands",
  "Latham",
  "Delmar",
  "Loudonville",
  "Glenmont",
  "Selkirk",
  "Rensselaer",
  "Troy",
  "Western Avenue",
  "Central Avenue",
  "Clinton Avenue",
  "Lark Street",
  "Pearl Street",
  "Washington Avenue",
  "Madison Avenue",
  "New Scotland",
  "Delaware Avenue",
  "Southern Boulevard",
  "Broadway",
  "Henry Johnson",
  "Wolf Road",
  "Northway",
  "Thruway",
  "Interstate 87",
  "Interstate 90",
  "Interstate 787",
  "Route 9W",
  "10-4",
  "10-8",
  "10-10",
  "10-13",
  "10-16",
  "10-33",
  "10-50",
  "10-52",
  "10-54",
  "10-55",
  "10-57",
  "10-78",
  "10-80",
  "panic alarm",
  "welfare check",
  "domestic",
  "personal injury",
  "shots fired",
  "structure fire",
  "hit and run",
  "search warrant",
  "Speedway",
  "Albany Police",
  "Colonie Police",
  "Bethlehem Police",
  "Albany Fire",
  "Engine",
  "Ladder",
  "Rescue",
  "Ambulance",
  "Troop G",
  "NYSP",
];

type ResolvedFeed = {
  hlsUrl: string;
  candidates: string[];
  online: boolean;
  at: number;
};

const resolveCache = new Map<string, ResolvedFeed>();
const RESOLVE_TTL_MS = 45_000;

function unescapeJsString(raw: string): string {
  return raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");
}

function fleetVariants(url: string): string[] {
  const urls = [url];
  for (const fleet of ["s0", "s1", "s2"]) {
    const swapped = url.replace(/\/s[0-2]\//, `/${fleet}/`);
    if (!urls.includes(swapped)) urls.push(swapped);
  }
  return urls;
}

async function resolveHls(feedId: string): Promise<ResolvedFeed> {
  const hit = resolveCache.get(feedId);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit;

  const feed = getScannerFeed(feedId);
  const extracted: string[] = [];

  try {
    const res = await fetch(`https://www.broadcastify.com/listen/feed/${feedId}`, {
      headers: { "User-Agent": LISTEN_UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const html = await res.text();
      const raw = html.match(/hlsUrl:\s*"((?:\\.|[^"])*)"/)?.[1] ?? "";
      const hlsUrl = unescapeJsString(raw).split("?")[0] ?? "";
      if (hlsUrl.startsWith("http")) extracted.push(hlsUrl);
    }
  } catch {
    /* HTML probe is optional — client HLS is the source of truth */
  }

  const urls = [...new Set([...extracted.flatMap(fleetVariants), ...(feed ? fleetVariants(feed.hlsFallback) : [])])];
  const entry: ResolvedFeed = {
    hlsUrl: urls[0] ?? feed?.hlsFallback ?? "",
    candidates: urls,
    online: extracted.length > 0 || urls.length > 0,
    at: Date.now(),
  };
  resolveCache.set(feedId, entry);
  return entry;
}

function looksBlank(text: string): boolean {
  return isSttJunk(text);
}

export function tidyRadio(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  t = t.replace(/\b10\s+(\d{1,2})\b/gi, "10-$1");
  t = t.replace(
    /\b(\d)\s+(\d)\s+(\d)\s+(\d)\s+(?=(?:\d{1,3}(?:st|nd|rd|th)\b|[A-Za-z]))/g,
    "$1$2$3$4 ",
  );
  t = t.replace(
    /\b(\d{1,2})\s+(\d{2})\s+(?=(?:\d{1,3}(?:st|nd|rd|th)\b|(?:north|south|east|west|n\.?|s\.?|e\.?|w\.?)?\s*[A-Za-z][A-Za-z']+\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|place|pl\.?|boulevard|blvd|drive|dr\.?)))/gi,
    "$1$2 ",
  );
  return t.replace(/\s+/g, " ").trim();
}

function decodeBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function looksLikeMpegTs(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 188) return false;
  return bytes[0] === 0x47 && (bytes[188] === 0x47 || bytes.length < 376);
}

/** Skip xAI STT while ACL/auth is broken so we do not hammer api.x.ai. */
let xaiSttBlockedUntil = 0;
const XAI_ACL_BACKOFF_MS = 10 * 60_000;

type WhisperProvider = "openai" | "groq";

/**
 * Provider-level backoff for 429s (and other rate-limit style failures).
 * This avoids hammering a single tier when feeds are hot or credits are exhausted.
 */
let openaiWhisperBlockedUntil = 0;
let groqWhisperBlockedUntil = 0;
let openai429s = 0;
let groq429s = 0;

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after") || res.headers.get("Retry-After") || "";
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.min(30 * 60_000, Math.round(n * 1000));
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const ms = t - Date.now();
    if (ms > 0) return Math.min(30 * 60_000, ms);
  }
  return null;
}

function providerBlockedUntil(provider: WhisperProvider): number {
  return provider === "openai" ? openaiWhisperBlockedUntil : groqWhisperBlockedUntil;
}

function setProviderBlocked(provider: WhisperProvider, until: number): void {
  if (provider === "openai") openaiWhisperBlockedUntil = until;
  else groqWhisperBlockedUntil = until;
}

function bumpProvider429(provider: WhisperProvider, res?: Response): number {
  const retry = res ? parseRetryAfterMs(res) : null;
  if (retry != null) {
    const until = Date.now() + retry;
    setProviderBlocked(provider, until);
    return until;
  }
  const base = provider === "openai" ? 45_000 : 75_000;
  const max = provider === "openai" ? 6 * 60_000 : 10 * 60_000;
  if (provider === "openai") openai429s += 1;
  else groq429s += 1;
  const n = provider === "openai" ? openai429s : groq429s;
  const ms = Math.min(max, base * 2 ** Math.min(6, n - 1));
  const jitter = Math.round(ms * (0.12 * Math.random()));
  const until = Date.now() + ms + jitter;
  setProviderBlocked(provider, until);
  return until;
}

function clearProvider429(provider: WhisperProvider): void {
  if (provider === "openai") openai429s = 0;
  else groq429s = 0;
}

function whisperModels(envKey: string, fallbackModel: string): string[] {
  const list = (process.env[envKey] || "").trim();
  if (list) {
    return list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [fallbackModel];
}

function fileCopy(bytes: Uint8Array, filename: string, mime: string): File {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new File([copy], filename, { type: mime });
}

async function transcribeWithXai(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ text: string; duration: number }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("missing-key");

  const form = new FormData();
  form.append("language", "en");
  form.append("format", "true");
  form.append("vad_threshold", "0.15");
  for (const term of KEYTERMS) form.append("keyterm", term);
  form.append("file", fileCopy(bytes, filename, mime));

  const res = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(22000),
  });
  if (!res.ok) {
    throw new Error(`stt-${res.status}`);
  }
  const body = (await res.json()) as { text?: string; duration?: number };
  return { text: tidyRadio(body.text?.trim() ?? ""), duration: body.duration ?? 0 };
}

async function transcribeWithOpenAiWhisper(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ text: string; duration: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("missing-openai-key");
  if (Date.now() < openaiWhisperBlockedUntil) throw new Error("openai-429");

  // Server-only dependency (uses node:fs + ffmpeg). Keep it out of the client bundle.
  const { prepareAudioForWhisper, formatProviderErrorBody } = await import("./audio-for-whisper");

  const prepared = await prepareAudioForWhisper(bytes, filename, mime);
  if (prepared.remuxed) {
    console.info("[stt] remuxed audio for whisper", filename, "->", prepared.filename);
  }

  const models = whisperModels(
    "SCANNER_TRANSCRIBE_MODELS",
    (process.env.SCANNER_TRANSCRIBE_MODEL?.trim() || "whisper-1").trim(),
  );

  const errors: string[] = [];
  for (const model of models) {
    const form = new FormData();
    form.append("model", model);
    form.append("language", "en");
    form.append("file", fileCopy(prepared.bytes, prepared.filename, prepared.mime));

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      clearProvider429("openai");
      const json = (await res.json()) as { text?: string; duration?: number };
      return { text: tidyRadio(json.text?.trim() ?? ""), duration: json.duration ?? 0 };
    }
    if (res.status === 429) bumpProvider429("openai", res);
    const body = await res.text().catch(() => "");
    const msg = formatProviderErrorBody(res.status, body, "whisper");
    errors.push(msg);
    console.error("[stt] whisper error", msg);
    // If the model name is wrong, try the next configured model.
    if (res.status === 400 && models.length > 1) continue;
    throw new Error(msg);
  }
  throw new Error(errors.at(-1) || "whisper");
}

async function transcribeWithGroqWhisper(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ text: string; duration: number }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("missing-groq-key");
  if (Date.now() < groqWhisperBlockedUntil) throw new Error("groq-429");

  // Server-only dependency (uses node:fs + ffmpeg). Keep it out of the client bundle.
  const { prepareAudioForWhisper, formatProviderErrorBody } = await import("./audio-for-whisper");

  const prepared = await prepareAudioForWhisper(bytes, filename, mime);
  const models = whisperModels(
    "GROQ_TRANSCRIBE_MODELS",
    (process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3").trim(),
  );

  const errors: string[] = [];
  for (const model of models) {
    const form = new FormData();
    form.append("model", model);
    form.append("language", "en");
    form.append("file", fileCopy(prepared.bytes, prepared.filename, prepared.mime));

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      clearProvider429("groq");
      const json = (await res.json()) as { text?: string; duration?: number };
      return { text: tidyRadio(json.text?.trim() ?? ""), duration: json.duration ?? 0 };
    }
    if (res.status === 429) bumpProvider429("groq", res);
    const body = await res.text().catch(() => "");
    const msg = formatProviderErrorBody(res.status, body, "groq");
    errors.push(msg);
    console.error("[stt] groq whisper error", msg);
    if (res.status === 400 && models.length > 1) continue;
    throw new Error(msg);
  }
  throw new Error(errors.at(-1) || "groq");
}

/**
 * Prefer OpenAI Whisper, then Groq.
 * Never abort the chain on OpenAI 429 while Groq is configured — prod hits
 * whisper-429 (no credits) with GROQ_API_KEY set and must still caption.
 * Exported for unit tests (fetch-mocked cascades).
 */
export async function transcribeWithWhisperFallback(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ text: string; duration: number }> {
  const errors: string[] = [];
  if (process.env.OPENAI_API_KEY && Date.now() >= providerBlockedUntil("openai")) {
    try {
      return await transcribeWithOpenAiWhisper(bytes, filename, mime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "whisper";
      errors.push(msg);
      console.error("[stt] openai whisper failed; trying next", msg);
      // Continue to Groq even on 429 — do not throw until the chain is exhausted.
    }
  }
  if (process.env.GROQ_API_KEY && Date.now() >= providerBlockedUntil("groq")) {
    try {
      return await transcribeWithGroqWhisper(bytes, filename, mime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "groq";
      errors.push(msg);
      console.error("[stt] groq whisper failed", msg);
    }
  }
  // Prefer the last (most recent / useful) error over the first.
  throw new Error(errors.at(-1) || errors[0] || "whisper-fallback-unavailable");
}

/** Test helper: clear in-process xAI ACL backoff. */
export function resetXaiSttBackoff(): void {
  xaiSttBlockedUntil = 0;
  openaiWhisperBlockedUntil = 0;
  groqWhisperBlockedUntil = 0;
  openai429s = 0;
  groq429s = 0;
}

export function sttBackoffHealth(): {
  xaiAclBlockedSec: number;
  openaiWhisperBlockedSec: number;
  groqWhisperBlockedSec: number;
} {
  const now = Date.now();
  return {
    xaiAclBlockedSec: Math.max(0, Math.ceil((xaiSttBlockedUntil - now) / 1000)),
    openaiWhisperBlockedSec: Math.max(0, Math.ceil((openaiWhisperBlockedUntil - now) / 1000)),
    groqWhisperBlockedSec: Math.max(0, Math.ceil((groqWhisperBlockedUntil - now) / 1000)),
  };
}

export function sttProvidersConfigured(): boolean {
  return Boolean(process.env.XAI_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
}

/**
 * Prefer Whisper/Groq while xAI is ACL-blocked (or when SCANNER_STT_PREFER=whisper).
 * Never mask a Whisper failure as stt-403 — surface the real provider error.
 */
export async function transcribeAudioFile(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ text: string; duration: number }> {
  const hasXai = Boolean(process.env.XAI_API_KEY);
  const hasWhisper = Boolean(process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  if (!hasXai && !hasWhisper) throw new Error("missing-key");

  // Default to Whisper/Groq when configured — xAI ACL is currently broken in prod.
  // Set SCANNER_STT_PREFER=xai to force xAI-first again after ACL is fixed.
  const preferEnv = (process.env.SCANNER_STT_PREFER || "").trim().toLowerCase();
  const preferWhisper =
    preferEnv === "whisper" ||
    preferEnv === "openai" ||
    preferEnv === "groq" ||
    (preferEnv !== "xai" && hasWhisper);
  const xaiBlocked = Date.now() < xaiSttBlockedUntil;

  if (hasWhisper && (preferWhisper || xaiBlocked || !hasXai)) {
    return await transcribeWithWhisperFallback(bytes, filename, mime);
  }

  if (hasXai && !xaiBlocked) {
    try {
      return await transcribeWithXai(bytes, filename, mime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "stt-401" || msg === "stt-403") {
        xaiSttBlockedUntil = Date.now() + XAI_ACL_BACKOFF_MS;
        console.error("[stt] xai acl", msg, "backoff_ms", XAI_ACL_BACKOFF_MS);
        if (hasWhisper) {
          // Surface Whisper/Groq errors as-is — do not rethrow stt-403.
          return await transcribeWithWhisperFallback(bytes, filename, mime);
        }
      }
      throw err instanceof Error ? err : new Error("stt");
    }
  }

  if (hasWhisper) {
    return await transcribeWithWhisperFallback(bytes, filename, mime);
  }
  throw new Error(xaiBlocked ? "stt-403" : "missing-key");
}

/** Test helper: whether Whisper fallback error should replace an xAI ACL code. */
export function preferFallbackError(xaiAclMsg: string, fallbackMsg: string): string {
  if (fallbackMsg && fallbackMsg !== xaiAclMsg) return fallbackMsg;
  return xaiAclMsg;
}

export const getScannerPlaylist = createServerFn({ method: "POST" })
  .validator((input: { feedId: string }) => {
    const feedId = String(input.feedId ?? "");
    if (!SCANNER_FEEDS.some((f) => f.id === feedId)) {
      throw new Error("Unknown scanner feed.");
    }
    return { feedId };
  })
  .handler(async ({ data }) => {
    const resolved = await resolveHls(data.feedId);
    if (!resolved.hlsUrl) {
      return { ok: false as const, error: "No live stream URL for this feed." };
    }
    return {
      ok: true as const,
      hlsUrl: resolved.hlsUrl,
      candidates: resolved.candidates,
      online: resolved.online,
    };
  });

export const getScannerStatuses = createServerFn({ method: "POST" }).handler(async () => {
  const { startScannerPoll } = await import("./scanner-poll");
  startScannerPoll();
  const feeds = await Promise.all(
    SCANNER_FEEDS.map(async (feed) => {
      const resolved = await resolveHls(feed.id);
      return { id: feed.id, online: resolved.online };
    }),
  );
  return { ok: true as const, feeds };
});

export const getScannerCaptions = createServerFn({ method: "POST" })
  .validator((input: { feedId?: string; listen?: boolean }) => ({
    feedId: String(input.feedId ?? ""),
    listen: Boolean(input.listen),
  }))
  .handler(async ({ data }) => {
    const poll = await import("./scanner-poll");
    poll.startScannerPoll();
    if (data.listen && data.feedId) poll.setListenFeed(data.feedId);
    else if (!data.listen) poll.setListenFeed(null);
    const health = poll.scannerHealth();
    return {
      ok: true as const,
      lines: poll.captionLines(),
      lastSpoken: health.lastSpoken,
      lastSpokenAt: health.lastSpokenAt,
      lastFeed: health.lastFeed,
      lastError: health.lastError,
      lastErrorAt: health.lastErrorAt,
      ticks: health.ticks,
      kept: health.kept,
      ageSec: health.ageSec,
      sttState: health.sttState,
      sttBlockedSec: health.sttBlockedSec,
    };
  });

export const transcribeAudioChunk = createServerFn({ method: "POST" })
  .validator((input: { feedId: string; b64: string; mime?: string; filename?: string }) => {
    const feedId = String(input.feedId ?? "");
    if (!SCANNER_FEEDS.some((f) => f.id === feedId)) {
      throw new Error("Unknown scanner feed.");
    }
    const b64 = String(input.b64 ?? "").replace(/\s/g, "");
    if (b64.length < 24) throw new Error("Audio chunk is empty.");
    if (b64.length > 900_000) throw new Error("Audio chunk is too large.");
    const mime = String(input.mime ?? "audio/mpeg");
    const filename = String(input.filename ?? "segment.mp3");
    return { feedId, b64, mime, filename };
  })
  .handler(async ({ data }) => {
    if (!sttProvidersConfigured()) {
      return {
        ok: false as const,
        fatal: true,
        error: "Transcript is not available in this environment.",
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data.b64);
    } catch {
      return { ok: false as const, fatal: false, error: "Could not decode audio." };
    }
    if (bytes.byteLength < 64) {
      return { ok: true as const, silent: true, text: "", reason: "tiny" as const };
    }

    let audio = { bytes, mime: data.mime, filename: data.filename };
    if (looksLikeMpegTs(bytes)) {
      const extracted = extractAudioFromMpegTs(bytes);
      if (!extracted) {
        return { ok: true as const, silent: true, text: "", reason: "decode" as const };
      }
      audio = extracted;
    }

    try {
      const result = await transcribeAudioFile(audio.bytes, audio.filename, audio.mime);
      const spoken = looksBlank(result.text) ? "" : result.text;
      return {
        ok: true as const,
        silent: spoken.length === 0,
        text: spoken,
        duration: result.duration,
        reason: spoken ? ("voice" as const) : ("quiet" as const),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "missing-key") {
        return {
          ok: false as const,
          fatal: true,
          error: "Transcript is not available in this environment.",
        };
      }
      if (msg.includes("429") || msg.startsWith("stt-429") || msg.startsWith("whisper-429") || msg.startsWith("groq-429")) {
        return { ok: false as const, fatal: false, error: "Speech API busy — retrying shortly." };
      }
      if (msg === "stt-401" || msg === "stt-403") {
        return { ok: false as const, fatal: false, error: "Speech API auth issue — Whisper fallback when available." };
      }
      return { ok: false as const, fatal: false, error: "Caption glitch — keeping last good local caption." };
    }
  });
