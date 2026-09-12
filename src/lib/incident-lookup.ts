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
  };
}

export async function lookupIncidentCard(id: string): Promise<IncidentCardMeta> {
  const raw = String(id ?? "").trim();
  if (!raw || raw.length > 200) return { ...FALLBACK, id: raw };
  try {
    const wire = await fetchLiveWire();
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
