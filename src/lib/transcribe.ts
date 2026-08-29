import { createServerFn } from "@tanstack/react-start";
import { extractAudioFromMpegTs } from "./scanner-hls";
import { getScannerFeed, SCANNER_FEEDS } from "./scanner-feeds";

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
  "Western Avenue",
  "Central Avenue",
  "Lark Street",
  "Pearl Street",
  "Washington Avenue",
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
  const t = text.trim();
  if (!t) return true;
  if (t.length < 8) return true;
  if (/^(silence|\[?(blank|silence|inaudible|music)\]?|\(+.*?quiet.*?\)+)$/i.test(t)) return true;
  if ((t.match(/10-\d+/g) || []).length >= 3) return true;
  if (/copy\s+en route\s+on scene/i.test(t)) return true;
  if ((t.match(/,/g) || []).length >= 4) return true;
  return false;
}

function decodeBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function looksLikeMpegTs(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 188) return false;
  return bytes[0] === 0x47 && (bytes[188] === 0x47 || bytes.length < 376);
}

export async function transcribeAudioFile(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<{ text: string; duration: number }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("missing-key");

  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);

  const form = new FormData();
  form.append("language", "en");
  form.append("format", "true");
  form.append("vad_threshold", "0.2");
  for (const term of KEYTERMS) form.append("keyterm", term);
  form.append("file", new File([copy], filename, { type: mime }));

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
  return { text: body.text?.trim() ?? "", duration: body.duration ?? 0 };
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
  const feeds = await Promise.all(
    SCANNER_FEEDS.map(async (feed) => {
      const resolved = await resolveHls(feed.id);
      return { id: feed.id, online: resolved.online };
    }),
  );
  return { ok: true as const, feeds };
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
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
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
      if (msg.startsWith("stt-429")) {
        return { ok: false as const, fatal: false, error: "Transcript is busy. Retrying…" };
      }
      return { ok: false as const, fatal: false, error: "Caption skipped — trying the next clip." };
    }
  });
