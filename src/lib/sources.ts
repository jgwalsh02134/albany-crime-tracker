import type { Incident, IncidentSource, SourceKind, SourceLens, SourceTier, Verification } from "./types";

export const OFFICIAL_KINDS = new Set<SourceKind>(["blotter", "cfs", "nixle", "press", "opendata"]);

export const SOURCE_LENSES: { id: SourceLens; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "official", label: "Official" },
  { id: "scanner", label: "Scanner" },
  { id: "news", label: "News" },
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
    raw === "opendata"
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
  if (kind === "scanner") return "https://openmhz.com/system/albanycony";
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
  if (kind === "cfs") return "Calls for service";
  if (kind === "nixle") return "Nixle";
  if (kind === "scanner") return "OpenMHz P25";
  return name;
}

export function kindLabel(kind: SourceKind): string {
  switch (kind) {
    case "blotter":
      return "Blotter";
    case "cfs":
      return "CAD";
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

export function matchesSourceLens(inc: Incident, lens: SourceLens): boolean {
  if (lens === "all") return true;
  if (lens === "official") return inc.sources.some((s) => OFFICIAL_KINDS.has(s.kind));
  return inc.sources.some((s) => s.kind === lens);
}

export function sourceMix(incidents: Incident[]): { official: number; scanner: number; news: number } {
  let official = 0;
  let scanner = 0;
  let news = 0;
  for (const inc of incidents) {
    if (inc.sources.some((s) => OFFICIAL_KINDS.has(s.kind))) official += 1;
    if (inc.sources.some((s) => s.kind === "scanner")) scanner += 1;
    if (inc.sources.some((s) => s.kind === "news")) news += 1;
  }
  return { official, scanner, news };
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
  if (inc.origin === "live" || (hasNews && !hasScan && official.length === 0)) {
    return "Newsroom report only — not a confirmed CAD / blotter incident. Treat as developing.";
  }
  if (hasNews && hasScan) return "Newsroom plus scanner traffic — treat as developing until an official source posts.";
  if (hasScan) return "Scanner only. Radio traffic is not a confirmed incident.";
  if (hasNews) return "Newsroom reporting only. No official blotter on this item yet.";
  return "Source mix is thin — treat as unconfirmed.";
}

export type LiveWireItem = {
  id: string;
  title: string;
  url: string;
  outlet: string;
  summary: string;
  publishedAt: string;
  minutesAgo: number;
};

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

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

const PLACES: { name: string; lat: number; lng: number; re: RegExp }[] = [
  { name: "New Scotland", lat: 42.6217, lng: -73.9412, re: /new scotland/i },
  { name: "Green Island", lat: 42.7442, lng: -73.6918, re: /green island/i },
  { name: "Guilderland", lat: 42.7045, lng: -73.9115, re: /guilderland|altamont/i },
  { name: "Bethlehem", lat: 42.5917, lng: -73.824, re: /bethlehem|delmar|selkirk|glenmont/i },
  { name: "Watervliet", lat: 42.7301, lng: -73.7012, re: /watervliet/i },
  { name: "Menands", lat: 42.692, lng: -73.7237, re: /menands/i },
  { name: "Colonie", lat: 42.7179, lng: -73.8373, re: /colonie|latham|loudonville/i },
  { name: "Cohoes", lat: 42.7742, lng: -73.7001, re: /cohoes/i },
  { name: "Westerlo", lat: 42.5145, lng: -74.044, re: /westerlo/i },
  { name: "Coeymans", lat: 42.4737, lng: -73.7923, re: /coeymans|ravena/i },
  { name: "Albany", lat: 42.6526, lng: -73.7562, re: /\balbany\b/i },
];

function placeOf(text: string): { name: string; lat: number; lng: number } {
  for (const p of PLACES) {
    if (p.re.test(text)) return p;
  }
  return { name: "Albany County", lat: 42.6526, lng: -73.7562 };
}

function classify(title: string): { type: string; category: Incident["category"]; severity: Incident["severity"] } {
  const t = title.toLowerCase();
  if (/\b(shot|shooting|homicide|murder|stab)\b/.test(t)) {
    return { type: "shots-fired", category: "violent", severity: "critical" };
  }
  if (/\b(fire|blaze|2-alarm|two-alarm)\b/.test(t)) return { type: "fire", category: "other", severity: "high" };
  if (/\b(crash|collision|fatal)\b/.test(t) || (/\bkilled\b/.test(t) && /\b(car|vehicle|traffic)\b/.test(t))) {
    return { type: "crash", category: "other", severity: "high" };
  }
  if (/\bkilled\b/.test(t)) return { type: "homicide", category: "violent", severity: "critical" };
  if (/\b(robbery|carjack)\b/.test(t)) return { type: "robbery", category: "violent", severity: "high" };
  if (/\bassault\b/.test(t)) return { type: "assault", category: "violent", severity: "high" };
  if (/\b(burglary|break-in)\b/.test(t)) return { type: "burglary", category: "property", severity: "medium" };
  if (/\b(theft|stolen|larceny)\b/.test(t)) return { type: "larceny", category: "property", severity: "medium" };
  if (/\b(arrest|charged|indicted)\b/.test(t)) return { type: "arrest", category: "other", severity: "medium" };
  return { type: "public-safety", category: "other", severity: "medium" };
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `wire-${Math.abs(h).toString(36)}`;
}

export function wireToIncidents(wire: LiveWireItem[]): Incident[] {
  return wire.map((item) => {
    const hay = `${item.title} ${item.summary}`;
    const place = placeOf(hay);
    const kind = classify(item.title);
    const muni = place.name === "Albany County" ? "Albany" : place.name;
    const jitter = (item.title.length % 7) * 0.0018;
    return {
      id: hashId(item.url),
      minutesAgo: item.minutesAgo,
      occurredAt: item.publishedAt,
      title: item.title,
      type: kind.type,
      category: kind.category,
      severity: kind.severity,
      status: item.minutesAgo <= 360 ? "active" : "developing",
      municipality: muni,
      address: place.name === "Albany County" ? "Countywide" : place.name,
      lat: place.lat + jitter,
      lng: place.lng - jitter,
      agency: item.outlet,
      agencyAbbr: item.outlet.replace(/\s+/g, "").slice(0, 6).toUpperCase(),
      description: item.summary || item.title,
      sources: [
        {
          kind: "news",
          name: item.outlet,
          tier: "context",
          url: item.url,
          excerpt: item.summary || item.title,
        },
      ],
      verification: "developing",
      origin: "live",
    } satisfies Incident;
  });
}

export function mergeLiveFeed(_seed: Incident[], wire: LiveWireItem[]): Incident[] {
  return wireToIncidents(wire);
}
