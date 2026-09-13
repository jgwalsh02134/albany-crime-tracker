import type { Incident, IncidentSource, ScannerCall, SourceKind, SourceLens, SourceTier, Verification } from "./types";
import { COUNTY_CENTROID, locateSpoken, placeFromText, spreadItems, type GeoPrecision } from "./geo";
import {
  classifyCall,
  clusterLiveItems,
  compareFused,
  fuseId,
  itemToSource,
  pickPrimary,
  scoreCorroboration,
  seenOnFromItems,
  tokens,
  verificationFor,
} from "./fusion";

export const OFFICIAL_KINDS = new Set<SourceKind>(["blotter", "cfs", "nixle", "press", "opendata"]);

export const SOURCE_LENSES: { id: SourceLens; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "official", label: "Official" },
  { id: "scanner", label: "Scanner" },
  { id: "news", label: "News" },
  { id: "social", label: "Social" },
];

const AGENCY_HOME: Record<string, string> = {
  APD: "https://www.albanyny.gov/",
  CPD: "https://www.colonie.org/departments/police",
  BPD: "https://www.townofbethlehem.org/180/Police",
  GPD: "https://www.townofguilderland.org/police",
  ACSO: "https://www.albanycounty.com/departments/sheriff",
  NYSP: "https://troopers.ny.gov/location/troop-g",
  AFD: "https://www.albanyny.gov/",
};

function normalizeKind(raw: string): SourceKind {
  if (
    raw === "blotter" ||
    raw === "cfs" ||
    raw === "nixle" ||
    raw === "press" ||
    raw === "scanner" ||
    raw === "news" ||
    raw === "opendata" ||
    raw === "social"
  ) {
    return raw;
  }
  return "news";
}

function normalizeTier(raw: string, kind: SourceKind): SourceTier {
  if (raw === "official" || raw === "context" || raw === "unconfirmed") return raw;
  if (raw === "tier_1" || OFFICIAL_KINDS.has(kind)) return "official";
  if (raw === "tier_3" || kind === "scanner") return "unconfirmed";
  return "context";
}

function sourceUrl(kind: SourceKind, name: string, agencyAbbr: string): string {
  if (kind === "scanner") return "https://www.broadcastify.com/listen/feed/3626";
  if (kind === "nixle") return "https://local.nixle.com/albany-police-department/";
  if (kind === "cfs" || kind === "opendata") return "https://data.albanyny.gov/";
  if (kind === "news") {
    const n = name.toLowerCase();
    if (n.includes("cbs")) return "https://cbs6albany.com/news/local";
    if (n.includes("news10") || n.includes("wtens")) return "https://www.news10.com/";
    if (n.includes("spectrum")) return "https://spectrumlocalnews.com/nys/capital-region";
    return "https://www.timesunion.com/news/crime/";
  }
  return AGENCY_HOME[agencyAbbr] ?? "https://www.albanyny.gov/";
}

function sourceLabel(kind: SourceKind, name: string, agencyAbbr: string): string {
  if (kind === "blotter") return `${agencyAbbr} blotter`;
  if (kind === "press") return `${agencyAbbr} press`;
  if (kind === "cfs") return "511NY";
  if (kind === "nixle") return "Nixle";
  if (kind === "scanner") return name.includes("Fire") ? "Albany Fire radio" : "Broadcastify P25";
  return name;
}

export function kindLabel(kind: SourceKind): string {
  switch (kind) {
    case "blotter":
      return "Blotter";
    case "cfs":
      return "511";
    case "nixle":
      return "Nixle";
    case "press":
      return "Press";
    case "scanner":
      return "Scanner";
    case "news":
      return "News";
    case "opendata":
      return "Open data";
    case "social":
      return "Social";
  }
}

export function enrichSources(
  raw: { kind: string; name: string; tier: string; url?: string; excerpt?: string }[],
  agencyAbbr: string,
  description: string,
): IncidentSource[] {
  const excerpt = description.replace(/\s+/g, " ").trim().slice(0, 140);
  return raw.map((s) => {
    const kind = normalizeKind(s.kind);
    return {
      kind,
      name: sourceLabel(kind, s.name, agencyAbbr),
      tier: normalizeTier(s.tier, kind),
      url: s.url || sourceUrl(kind, s.name, agencyAbbr),
      excerpt: s.excerpt || excerpt,
    };
  });
}

export function deriveVerification(sources: IncidentSource[], fallback: Verification): Verification {
  if (sources.some((s) => s.tier === "official")) return "confirmed";
  if (sources.length > 0 && sources.every((s) => s.kind === "scanner")) return "scanner";
  if (fallback === "confirmed") return "developing";
  return fallback;
}

function hasScannerSource(inc: Incident): boolean {
  if (inc.sources.some((s) => s.kind === "scanner")) return true;
  if (inc.seenOn?.some((c) => c.key === "scanner")) return true;
  if (inc.verification === "scanner") return true;
  return false;
}

export function matchesSourceLens(inc: Incident, lens: SourceLens): boolean {
  if (lens === "all") return true;
  if (lens === "official") return inc.sources.some((s) => OFFICIAL_KINDS.has(s.kind));
  if (lens === "social") {
    return inc.sources.some(
      (s) => s.kind === "social" || /Facebook|X ·|Reddit|Citizen/i.test(s.name),
    );
  }
  if (lens === "scanner") return hasScannerSource(inc);
  return inc.sources.some((s) => s.kind === lens);
}

export function sourceMix(incidents: Incident[]): {
  official: number;
  scanner: number;
  news: number;
  social: number;
} {
  let official = 0;
  let scanner = 0;
  let news = 0;
  let social = 0;
  for (const inc of incidents) {
    if (inc.sources.some((s) => OFFICIAL_KINDS.has(s.kind))) official += 1;
    if (hasScannerSource(inc)) scanner += 1;
    if (inc.sources.some((s) => s.kind === "news")) news += 1;
    if (inc.sources.some((s) => s.kind === "social" || /Facebook|X ·|Reddit|Citizen/i.test(s.name))) {
      social += 1;
    }
  }
  return { official, scanner, news, social };
}

export function verificationWhy(inc: Incident): string {
  const official = inc.sources.filter((s) => s.tier === "official");
  const others = inc.sources.length - official.length;
  if (official.length && others > 0) {
    return `Confirmed by ${official[0]!.name} and ${others} independent source${others === 1 ? "" : "s"}.`;
  }
  if (official.length) {
    return `Official ${kindLabel(official[0]!.kind).toLowerCase()} from ${official[0]!.name}.`;
  }
  const hasNews = inc.sources.some((s) => s.kind === "news");
  const hasScan = inc.sources.some((s) => s.kind === "scanner");
  const hasSocial = inc.sources.some((s) => s.kind === "social");
  if (hasSocial && !hasNews && !hasScan) {
    return "Citizen or social post — not a CAD call. Treat as unconfirmed.";
  }
  if (inc.origin === "live" || (hasNews && !hasScan && official.length === 0)) {
    return "Newsroom report only — not a confirmed CAD / blotter incident. Treat as developing.";
  }
  if (hasNews && hasScan) return "Newsroom plus scanner traffic — treat as developing until an official source posts.";
  if (hasScan) return "Scanner only. Radio traffic is not a confirmed incident.";
  if (hasNews) return "Newsroom reporting only. No official blotter on this item yet.";
  return "Source mix is thin — treat as unconfirmed.";
}

export type ActivityKind = "news" | "blotter" | "scanner" | "traffic" | "social";

export type WirePipeSnap = {
  id: string;
  label: string;
  lastCount: number;
  ageSec: number;
  lastError?: string;
  ok: number;
  fail: number;
};

export type WireHealth = {
  blotter: number;
  blotterFailed: number;
  scanner: number;
  traffic: number;
  news: number;
  captions: boolean;
  extractor?: string;
  scannerTicks?: number;
  scannerError?: string;
  scannerHeard?: string;
  scannerCaptioned?: number;
  facebook?: number;
  x?: number;
  reddit?: number;
  citizen?: number;
  civic?: number;
  nws?: number;
  /** True when 511 + civic + NWS all returned 0 this refresh (may be healthy-empty). */
  daytimePipesDry?: boolean;
  /** True when one or more daytime pipes failed (not merely empty). */
  daytimePipesFailing?: boolean;
  pipes?: WirePipeSnap[];
};

export type LiveWireItem = {
  id: string;
  title: string;
  url: string;
  outlet: string;
  summary: string;
  publishedAt: string;
  minutesAgo: number;
  image?: string;
  kind?: ActivityKind;
  municipality?: string;
  address?: string;
  agency?: string;
  category?: string;
  status?: string;
  lat?: number;
  lng?: number;
  geoPrecision?: GeoPrecision;
};


export function fuseLiveWire(incidents: Incident[], wire: LiveWireItem[]): Incident[] {
  if (!wire.length) return incidents;
  return incidents.map((inc) => {
    const hay = `${inc.title} ${inc.municipality} ${inc.type}`.toLowerCase();
    const extra: IncidentSource[] = [];
    for (const item of wire) {
      const words = tokens(item.title);
      const hit = words.filter((w) => hay.includes(w) && w !== "albany" && w !== "county").length;
      const place = item.title.toLowerCase().includes(inc.municipality.toLowerCase());
      if (hit >= 2 || (place && hit >= 1)) {
        extra.push({
          kind: "news",
          name: item.outlet,
          tier: "context",
          url: item.url,
          excerpt: item.title,
        });
      }
    }
    if (!extra.length) return inc;
    const urls = new Set(inc.sources.map((s) => s.url));
    const merged = [...inc.sources];
    for (const s of extra) {
      if (!s.url || urls.has(s.url)) continue;
      urls.add(s.url);
      merged.push(s);
    }
    return merged.length === inc.sources.length ? inc : { ...inc, sources: merged };
  });
}

function placeOf(text: string): { name: string; lat: number; lng: number; precision: GeoPrecision } {
  const pin = locateSpoken(text, "");
  const town = placeFromText(text);
  if (pin.road) {
    return { name: town?.name || "Albany County", lat: pin.geo.lat, lng: pin.geo.lng, precision: pin.precision };
  }
  if (town) return { name: town.name, lat: town.lat, lng: town.lng, precision: "town" };
  return { name: "Albany County", lat: COUNTY_CENTROID.lat, lng: COUNTY_CENTROID.lng, precision: "county" };
}

export function classify(title: string): { type: string; category: Incident["category"]; severity: Incident["severity"] } {
  const c = classifyCall(title);
  return { type: c.type, category: c.category, severity: c.severity };
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `wire-${Math.abs(h).toString(36)}`;
}

function agencyAbbrFor(item: LiveWireItem, activity: ActivityKind): string {
  if (activity === "blotter") return "NYSP";
  if (activity === "scanner") {
    if (/colonie/i.test(item.agency || "")) return "CPD";
    if (/albany\s*pd|albany police/i.test(item.agency || "")) return "APD";
    if (/bethlehem/i.test(item.agency || "")) return "BPD";
    if (/albany\s*fire/i.test(item.agency || "")) return "AFD";
    if (/thruway|nysta/i.test(item.agency || "")) return "NYSTA";
    if (/nysp/i.test(item.agency || "")) return "NYSP";
    return "SCAN";
  }
  if (activity === "social") {
    if (/albany pd/i.test(item.outlet)) return "APD";
    if (/colonie/i.test(item.outlet)) return "CPD";
    if (/bethlehem/i.test(item.outlet)) return "BPD";
    if (/reddit/i.test(item.outlet)) return "RDT";
    if (/citizen/i.test(item.outlet)) return "TIP";
    return "SOC";
  }
  return item.outlet.replace(/\s+/g, "").slice(0, 6).toUpperCase();
}

export function wireToIncidents(wire: LiveWireItem[]): Incident[] {
  const groups = clusterLiveItems(wire);
  const incidents = groups.map((group) => {
    const item = pickPrimary(group);
    const hay = group.map((g) => `${g.title} ${g.summary}`).join(" ");
    const hayPlace = placeOf(hay);
    const placed = item.lat != null && item.lng != null
      ? {
          name: item.municipality || hayPlace.name,
          lat: item.lat,
          lng: item.lng,
          precision: (item.geoPrecision || hayPlace.precision) as GeoPrecision,
        }
      : item.municipality && item.municipality !== "Albany County" && item.municipality !== "Capital District"
        ? {
            name: item.municipality,
            lat: item.lat ?? hayPlace.lat,
            lng: item.lng ?? hayPlace.lng,
            precision: (item.geoPrecision || (item.lat != null ? hayPlace.precision : "town")) as GeoPrecision,
          }
        : hayPlace;
    const kind = classify(`${item.title} ${item.category ?? ""} ${item.summary ?? ""}`);
    const muni =
      item.municipality && item.municipality !== "Albany County"
        ? item.municipality
        : placed.name === "Albany County"
          ? "Albany"
          : placed.name;
    const seen = new Set<string>();
    const sources: IncidentSource[] = [];
    for (const g of group) {
      if (seen.has(g.url)) continue;
      seen.add(g.url);
      sources.push(itemToSource(g));
    }
    const corr = scoreCorroboration(group);
    const seenOn = seenOnFromItems(group);
    const activity = item.kind ?? "news";
    const verification = verificationFor(group, sources);
    return {
      id: fuseId(group, item) || (item.id.startsWith("nysp-") || item.id.startsWith("scan-") || item.id.startsWith("citizen-")
        ? item.id
        : hashId(item.url)),
      minutesAgo: Math.min(...group.map((g) => g.minutesAgo)),
      occurredAt: item.publishedAt,
      title: item.title,
      type: kind.type,
      category: kind.category,
      severity: kind.severity,
      status: item.minutesAgo <= 180 ? "active" : item.minutesAgo <= 24 * 60 ? "developing" : "closed",
      municipality: muni,
      address: item.address || (placed.name === "Albany County" ? "area unknown" : placed.name),
      lat: item.lat ?? placed.lat,
      lng: item.lng ?? placed.lng,
      geoPrecision: item.geoPrecision || placed.precision || (item.address && item.address !== "area unknown" ? undefined : "town"),
      agency: item.agency || item.outlet,
      agencyAbbr: agencyAbbrFor(item, activity),
      description: item.summary || item.title,
      sources,
      verification,
      origin: "live",
      disposition: item.status,
      corroborationScore: corr.score,
      seenOn,
      memberIds: group.map((g) => g.id),
    } satisfies Incident;
  });
  return spreadItems(incidents).sort(compareFused);
}

export function mergeLiveFeed(_seed: Incident[], wire: LiveWireItem[]): Incident[] {
  return wireToIncidents(wire);
}

export function wireToScannerCalls(wire: LiveWireItem[]): ScannerCall[] {
  return wire
    .filter((w) => (w.kind ?? "news") === "scanner")
    .map((w) => {
      const hay = `${w.agency} ${w.title} ${w.summary}`;
      const discipline: ScannerCall["discipline"] = /\b(fire|ems|rescue|ambulance)\b/i.test(hay)
        ? /ems|ambulance/i.test(hay)
          ? "ems"
          : "fire"
        : "police";
      return {
        id: w.id,
        minutesAgo: w.minutesAgo,
        occurredAt: w.publishedAt,
        talkgroup: w.agency || "Dispatch",
        discipline,
        summary: (w.summary || w.title).replace(/\. Unconfirmed[\s\S]*$/i, "").trim() || w.title,
        durationSec: 6,
        priority: /weapon|shots|priority|10-13/i.test(hay) ? "high" : "medium",
        agency: w.agency || "Scanner",
        channel: w.outlet,
        municipality: w.municipality || "Albany",
      };
    });
}
