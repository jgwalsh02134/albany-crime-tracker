import type { LiveWireItem } from "./sources";
import { locateSpoken, placeFromText } from "./geo";
import { recordPipeFail, recordPipeOk } from "./pipe-health";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const PIPE_ID = "nixle:apd";
const PIPE_LABEL = "Nixle · Albany PD";
const MAX_MIN = 7 * 24 * 60;

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
  const re = new RegExp(`\\b${key}\\b\\s*:\\s*(\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|\\d+|true|false|null)`, "i");
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

export async function fetchNixleApd(now = Date.now()): Promise<LiveWireItem[]> {
  try {
    const res = await fetch("https://nixle.us/albany-police-department", {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) {
      recordPipeFail(PIPE_ID, PIPE_LABEL, `HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const inner = extractAlertsArray(html);
    if (!inner) {
      recordPipeOk(PIPE_ID, PIPE_LABEL, 0);
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
      const pin = locateSpoken(`${headline} ${summary}`, place?.name || "Albany");

      out.push({
        id: stableId,
        title: headline.slice(0, 180),
        url,
        outlet: PIPE_LABEL,
        summary,
        publishedAt: new Date(at).toISOString(),
        minutesAgo,
        kind: "news",
        agency: "Albany Police Department",
        municipality: place?.name,
        address: pin.road || place?.name,
        lat: pin.geo.lat,
        lng: pin.geo.lng,
        geoPrecision: pin.precision,
      });
    }

    out.sort((a, b) => a.minutesAgo - b.minutesAgo);
    recordPipeOk(PIPE_ID, PIPE_LABEL, out.length);
    return out;
  } catch (err) {
    recordPipeFail(PIPE_ID, PIPE_LABEL, err instanceof Error ? err.message : "nixle-error");
    return [];
  }
}

