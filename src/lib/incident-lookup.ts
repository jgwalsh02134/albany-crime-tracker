import { clockTime } from "./format";
import { fetchLiveWire } from "./live-sources";
import { sourceCaveat } from "./share";
import { wireToIncidents } from "./sources";
import type { Incident } from "./types";

export type IncidentCardMeta = {
  id: string;
  title: string;
  description: string;
  place: string;
  when: string;
  caveat: string;
  imagePath: string;
  found: boolean;
  incident: Incident | null;
  /** Present when the shared id is a news-story URL (or similar external link). */
  originalUrl?: string;
  /** "incident" for in-feed incidents; "story" when the id itself is a URL/story. */
  kind?: "incident" | "story";
};

const FALLBACK: IncidentCardMeta = {
  id: "",
  title: "Albany County Crime Tracker",
  description: "Live crime intelligence for Albany County, NY — incident feed, map, and scanner.",
  place: "Albany County, NY",
  when: "",
  caveat: "",
  imagePath: "/og.jpg",
  found: false,
  incident: null,
  kind: "incident",
};

export function cardMetaFromIncident(incident: Incident, id: string): IncidentCardMeta {
  const place = incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
    ? incident.address
    : `${incident.address}, ${incident.municipality}`;
  const when = clockTime(incident.occurredAt);
  const caveat = sourceCaveat(incident);
  const description = [place, when, caveat].filter(Boolean).join(" · ");
  return {
    id,
    title: incident.title,
    description,
    place,
    when,
    caveat,
    imagePath: `/api/og/${encodeURIComponent(id)}`,
    found: true,
    incident,
    kind: "incident",
  };
}

function looksLikeExternalUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim());
}

function safeDecodeMaybe(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    // Some bots / proxies double-encode path segments.
    const once = decodeURIComponent(s);
    return once.includes("%") ? decodeURIComponent(once) : once;
  } catch {
    return s;
  }
}

function cardMetaFromStory(opts: {
  id: string;
  url: string;
  title: string;
  outlet: string;
  summary?: string;
  municipality?: string;
  occurredAt?: string;
}): IncidentCardMeta {
  const when = opts.occurredAt ? clockTime(opts.occurredAt) : "";
  const place = [opts.municipality, opts.outlet].filter(Boolean).join(" · ") || opts.outlet || "News story";
  const description =
    (opts.summary || "").trim().slice(0, 360) ||
    `Newsroom coverage from ${opts.outlet || "a local outlet"}. Open Albany Watch for context and the source for the full story.`;
  return {
    id: opts.id,
    title: opts.title || "News story on Albany Watch",
    description,
    place,
    when,
    caveat: "Newsroom coverage — open the source for the full story.",
    imagePath: `/api/og/${encodeURIComponent(opts.id)}`,
    found: true,
    incident: null,
    originalUrl: opts.url,
    kind: "story",
  };
}

export async function lookupIncidentCard(id: string): Promise<IncidentCardMeta> {
  const raw = safeDecodeMaybe(String(id ?? ""));
  if (!raw) return { ...FALLBACK, id: raw };
  try {
    const wire = await fetchLiveWire();
    // Story shares use the outlet URL as the stable id. Handle those first so we can
    // return meaningful OG metadata and a landing page even when no fused incident exists.
    if (looksLikeExternalUrl(raw)) {
      const all = [...(wire.stories ?? []), ...(wire.items ?? [])];
      const hit = all.find((w) => w.id === raw || w.url === raw) ?? null;
      if (hit) {
        return cardMetaFromStory({
          id: raw,
          url: hit.url || raw,
          title: hit.title,
          outlet: hit.outlet,
          summary: hit.summary,
          municipality: hit.municipality,
          occurredAt: hit.publishedAt,
        });
      }
      return {
        ...FALLBACK,
        id: raw,
        title: "Story on Albany Watch",
        description: "This story may have aged off the live feed. Open Albany Watch for the current headlines.",
        imagePath: `/api/og/${encodeURIComponent(raw)}`,
        found: false,
        incident: null,
        originalUrl: raw,
        kind: "story",
      };
    }

    const incidents = wireToIncidents(wire.items ?? []);
    const hit =
      incidents.find((i) => i.id === raw) ??
      incidents.find((i) => i.memberIds?.includes(raw)) ??
      incidents.find((i) => i.id.endsWith(raw) || raw.endsWith(i.id)) ??
      null;
    if (!hit) {
      return {
        ...FALLBACK,
        id: raw,
        title: "Incident on Albany Watch",
        description: "This item may have aged off Live. Open Albany County Crime Tracker for the current feed.",
        imagePath: `/api/og/${encodeURIComponent(raw)}`,
      };
    }
    return cardMetaFromIncident(hit, hit.id);
  } catch {
    return { ...FALLBACK, id: raw, imagePath: `/api/og/${encodeURIComponent(raw)}` };
  }
}

export function ogMetaTags(meta: IncidentCardMeta, canonicalUrl: string) {
  const image = meta.imagePath.startsWith("http")
    ? meta.imagePath
    : `https://app.albany.watch${meta.imagePath.startsWith("/") ? meta.imagePath : `/${meta.imagePath}`}`;
  return [
    { title: meta.title },
    { name: "description", content: meta.description },
    { property: "og:title", content: meta.title },
    { property: "og:description", content: meta.description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: canonicalUrl },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:site_name", content: "Albany County Crime Tracker" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: meta.title },
    { name: "twitter:description", content: meta.description },
    { name: "twitter:image", content: image },
  ];
}
