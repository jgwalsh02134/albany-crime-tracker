import { createServerFn } from "@tanstack/react-start";
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
  "APD",
  "AFD",
  "NYSP",
  "Thruway",
  "Western Avenue",
  "Central Avenue",
  "Lark Street",
  "Pearl Street",
  "Washington Avenue",
  "10-4",
  "10-10",
  "10-13",
  "10-33",
  "copy",
  "en route",
  "on scene",
  "in custody",
  "dispatch",
];

type ResolvedFeed = {
  hlsUrl: string;
  online: boolean;
  at: number;
};

const resolveCache = new Map<string, ResolvedFeed>();
const RESOLVE_TTL_MS = 90_000;

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
  const fallback: ResolvedFeed = {
    hlsUrl: feed?.hlsFallback ?? "",
    online: true,
    at: Date.now(),
  };

  try {
    const res = await fetch(`https://www.broadcastify.com/listen/feed/${feedId}`, {
      headers: { "User-Agent": LISTEN_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      resolveCache.set(feedId, fallback);
      return fallback;
    }
    const html = await res.text();
    const raw = html.match(/hlsUrl:\s*"((?:\\.|[^"])*)"/)?.[1] ?? "";
    const hlsUrl = unescapeJsString(raw).split("?")[0] ?? "";
    const online = /isOnline:\s*true/.test(html);
    const entry: ResolvedFeed = { hlsUrl: hlsUrl || fallback.hlsUrl, online, at: Date.now() };
    resolveCache.set(feedId, entry);
    return entry;
  } catch {
    resolveCache.set(feedId, fallback);
    return fallback;
  }
}

function looksBlank(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 3) return true;
  return /^(silence|\[?(blank|silence|inaudible|music)\]?|\(+.*?quiet.*?\)+)$/i.test(t);
}

async function transcribeBytes(bytes: Uint8Array): Promise<{ text: string; duration: number }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("missing-key");

  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);

  const form = new FormData();
  form.append("language", "en");
  form.append("format", "true");
  form.append("vad_threshold", "0.28");
  for (const term of KEYTERMS) form.append("keyterm", term);
  form.append("file", new File([copy], "segment.ts", { type: "video/mp2t" }));

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

function decodeBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
      candidates: fleetVariants(resolved.hlsUrl),
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
  .validator((input: { feedId: string; b64: string }) => {
    const feedId = String(input.feedId ?? "");
    if (!SCANNER_FEEDS.some((f) => f.id === feedId)) {
      throw new Error("Unknown scanner feed.");
    }
    const b64 = String(input.b64 ?? "").replace(/\s/g, "");
    if (b64.length < 24) throw new Error("Audio chunk is empty.");
    if (b64.length > 700_000) throw new Error("Audio chunk is too large.");
    return { feedId, b64 };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "Transcript is not available in this environment." };
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data.b64);
    } catch {
      return { ok: false as const, error: "Could not decode audio." };
    }
    if (bytes.byteLength < 400) {
      return { ok: true as const, silent: true, text: "", reason: "tiny" as const };
    }
    if (bytes.byteLength > 500_000) {
      return { ok: false as const, error: "Audio chunk too large." };
    }

    try {
      const result = await transcribeBytes(bytes);
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
        return { ok: false as const, error: "Transcript is not available in this environment." };
      }
      if (msg.startsWith("stt-429")) {
        return { ok: false as const, error: "Transcript is busy. Wait a moment and retry." };
      }
      return { ok: false as const, error: "Transcription failed. Try again." };
    }
  });
