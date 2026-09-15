/**
 * Cluster FuseItems into one incident when time, place, and call-type agree.
 * Corroboration scores independent source families so a lone scanner cannot
 * outrank blotter + 511 + news. This is not CAD and does not invent a dispatch board.
 */
import type { Incident, IncidentSource, SourceKind, SourceTier, Verification } from "./types";
import { usableExcerpt } from "./html";

export type FuseKind = "news" | "blotter" | "scanner" | "traffic" | "social";

/** Structural subset of FuseItem — kept here to avoid a cycle with sources.ts. */
export type FuseItem = {
  id: string;
  title: string;
  url: string;
  outlet: string;
  summary: string;
  publishedAt: string;
  minutesAgo: number;
  kind?: FuseKind;
  municipality?: string;
  address?: string;
  agency?: string;
  category?: string;
  status?: string;
  lat?: number;
  lng?: number;
  geoPrecision?: "street" | "intersection" | "landmark" | "road" | "town" | "county" | "unknown";
};

export type CallClass = {
  type: string;
  category: Incident["category"];
  severity: Incident["severity"];
  family: string;
};

export type SeenOnChip = { key: string; label: string };

export type Corroboration = {
  score: number;
  families: string[];
  independent: number;
  why: string;
};

const GENERIC_MUNI = /^(albany county|capital district|countywide|unknown|area unknown)$/i;

const MUNI_ALIAS: Record<string, string> = {
  delmar: "bethlehem",
  selkirk: "bethlehem",
  glenmont: "bethlehem",
  elsmere: "bethlehem",
  slingerlands: "bethlehem",
  latham: "colonie",
  loudonville: "colonie",
  altamont: "guilderland",
  voorheesville: "new scotland",
  ravena: "coeymans",
};

const FAMILY_OF: Record<string, string> = {
  "shots-fired": "violent",
  assault: "violent",
  robbery: "violent",
  domestic: "violent",
  crash: "crash",
  dwi: "crash",
  "disabled-vehicle": "crash",
  fire: "fire",
  burglary: "property",
  larceny: "property",
  alarm: "property",
  drugs: "other",
  "welfare-check": "other",
  disturbance: "other",
  trespass: "other",
  suspicious: "other",
  arrest: "other",
  "missing-person": "other",
  "public-safety": "other",
};

export function classifyCall(title: string): CallClass {
  const t = title.toLowerCase();
  if (/\b(shot|shooting|homicide|murder|stab)\b/.test(t)) {
    return { type: "shots-fired", category: "violent", severity: "critical", family: "violent" };
  }
  if (/\b(fire|blaze|2-alarm|two-alarm)\b/.test(t)) {
    return { type: "fire", category: "other", severity: "high", family: "fire" };
  }
  if (/\bfatal crash\b|\baccident - fatal\b/.test(t)) {
    return { type: "crash", category: "other", severity: "critical", family: "crash" };
  }
  if (/\b(crash|collision|hit-and-run|hit & run|accident - )\b/.test(t)) {
    return { type: "crash", category: "other", severity: "high", family: "crash" };
  }
  if (/\bdwi|intoxicat/.test(t)) return { type: "dwi", category: "other", severity: "high", family: "crash" };
  if (/\bdomestic\b/.test(t)) return { type: "domestic", category: "violent", severity: "high", family: "violent" };
  if (/\b(robbery|carjack)\b/.test(t)) return { type: "robbery", category: "violent", severity: "high", family: "violent" };
  if (/\b(panic alarm|hold-?up alarm|burglar alarm)\b/.test(t)) {
    return { type: "alarm", category: "other", severity: "high", family: "property" };
  }
  if (/\bassault\b/.test(t)) return { type: "assault", category: "violent", severity: "high", family: "violent" };
  if (/\b(burglary|break-in|alarm - burglary)\b/.test(t)) {
    return { type: "burglary", category: "property", severity: "medium", family: "property" };
  }
  if (/\b(theft|stolen|larceny)\b/.test(t)) {
    return { type: "larceny", category: "property", severity: "medium", family: "property" };
  }
  if (/\bdrug\b|\babc violation\b/.test(t)) {
    return { type: "drugs", category: "other", severity: "medium", family: "other" };
  }
  if (/\bwelfare check\b|\bchild welfare\b/.test(t)) {
    return { type: "welfare-check", category: "other", severity: "medium", family: "other" };
  }
  if (/\bdisturbance\b|\bdisorderly\b|\bscreaming\b/.test(t)) {
    return { type: "disturbance", category: "other", severity: "medium", family: "other" };
  }
  if (/\b(harassment|trespass|menacing)\b/.test(t)) {
    return { type: "trespass", category: "other", severity: "medium", family: "other" };
  }
  if (/\bsuspicious\b/.test(t)) return { type: "suspicious", category: "other", severity: "low", family: "other" };
  if (/\b(arrest|charged|indicted)\b/.test(t)) {
    return { type: "arrest", category: "other", severity: "medium", family: "other" };
  }
  if (/\bdisabled vehicle\b/.test(t)) {
    return { type: "disabled-vehicle", category: "other", severity: "low", family: "crash" };
  }
  if (/\blocate person\b|\bmissing child\b/.test(t)) {
    return { type: "missing-person", category: "other", severity: "high", family: "other" };
  }
  return { type: "public-safety", category: "other", severity: "medium", family: "other" };
}

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(albany|county|police|street|avenue|road|that|with|from|this|have|been)\b/.test(w));
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function normMuni(raw?: string): string {
  const s = (raw || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return MUNI_ALIAS[s] || s;
}

function hay(item: FuseItem): string {
  return `${item.title} ${item.summary} ${item.address ?? ""} ${item.category ?? ""}`;
}

function callOf(item: FuseItem): CallClass {
  return classifyCall(`${item.title} ${item.category ?? ""} ${item.summary ?? ""}`);
}

function kindsCompatible(a: CallClass, b: CallClass): boolean {
  if (a.type === b.type) return true;
  if (a.family === b.family && a.family !== "other") return true;
  return false;
}

function windowMin(a: FuseItem, b: FuseItem): number {
  const kinds = new Set([a.kind ?? "news", b.kind ?? "news"]);
  if (kinds.has("blotter") && (kinds.has("news") || kinds.has("social") || kinds.has("scanner") || kinds.has("traffic"))) {
    return 16 * 60;
  }
  if (kinds.has("news") && kinds.has("news")) return 8 * 60;
  if (kinds.has("scanner") && kinds.has("traffic")) return 90;
  if (kinds.has("scanner") && kinds.has("news")) return 4 * 60;
  if (kinds.has("scanner") && kinds.has("scanner")) return 45;
  if (kinds.has("traffic") && kinds.has("news")) return 4 * 60;
  if (kinds.has("social")) return 8 * 60;
  return 90;
}

function hasPin(item: FuseItem): boolean {
  return typeof item.lat === "number" && typeof item.lng === "number" && Number.isFinite(item.lat) && Number.isFinite(item.lng);
}

function isApproxGeoPrecision(p: FuseItem["geoPrecision"] | undefined): boolean {
  return !p || p === "town" || p === "county" || p === "unknown";
}

function streetKeys(item: FuseItem): Set<string> {
  const s = `${item.title} ${item.address ?? ""} ${item.summary ?? ""}`.toLowerCase();
  const keys = new Set<string>();

  // Corridor streets (very common in early reporting)
  if (/\bwolf\b/.test(s)) keys.add("wolf");
  if (/\bpearl\b/.test(s)) keys.add("pearl");
  if (/\bdelaware\b/.test(s)) keys.add("delaware");
  if (/\bwashington\b/.test(s)) keys.add("washington");
  if (/\bmadison\b/.test(s)) keys.add("madison");
  if (/\bbroadway\b/.test(s)) keys.add("broadway");
  if (/\blark\b/.test(s)) keys.add("lark");
  if (/\bhoosick\b/.test(s)) keys.add("hoosick");
  if (/\bcentral\b/.test(s) && !/\bcentral\s+(park|district|region)\b/.test(s)) keys.add("central");
  if (/\bwestern\b/.test(s) && !/\bwestern\s+(district|region)\b/.test(s)) keys.add("western");

  // Route numbers / highway labels
  if (/\bi-?\s*87\b|\bnorthway\b/.test(s)) keys.add("i87");
  if (/\bi-?\s*90\b|\bthruway\b/.test(s)) keys.add("i90");
  if (/\bi-?\s*787\b/.test(s)) keys.add("i787");
  if (/\bny\s*5\b|\broute\s*5\b/.test(s)) keys.add("ny5");
  if (/\bny\s*7\b|\broute\s*7\b/.test(s)) keys.add("ny7");
  if (/\bny\s*4\b|\broute\s*4\b|\brt\.?\s*4\b/.test(s)) keys.add("ny4");
  if (/\bny\s*32\b|\broute\s*32\b/.test(s)) keys.add("ny32");
  if (/\bny\s*43\b|\broute\s*43\b/.test(s)) keys.add("ny43");
  if (/\bus\s*20\b|\broute\s*20\b/.test(s)) keys.add("us20");

  return keys;
}

function sharesStreetKey(a: FuseItem, b: FuseItem): { shared: boolean; common: boolean } {
  const ka = streetKeys(a);
  const kb = streetKeys(b);
  for (const k of ka) {
    if (!kb.has(k)) continue;
    // Central/Western are extremely common; require stronger corroboration.
    const common = k === "central" || k === "western";
    return { shared: true, common };
  }
  return { shared: false, common: false };
}

function geoClose(a: FuseItem, b: FuseItem): boolean {
  const ma = normMuni(a.municipality);
  const mb = normMuni(b.municipality);
  const genericA = !ma || GENERIC_MUNI.test(ma);
  const genericB = !mb || GENERIC_MUNI.test(mb);
  if (hasPin(a) && hasPin(b)) {
    const km = haversineKm({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! });
    // Very close pins can still be the same place even when municipal labels differ (border streets).
    if (km <= 0.35) return true;
    // Do not treat "nearby" as a place match across two concrete different municipalities.
    // This prevents mega-incidents fused from adjacent towns' unrelated posts.
    const muniConflict = ma && mb && ma !== mb && !genericA && !genericB;
    if (!muniConflict && km <= 1.6) return true;
    if (km <= 4 && ma && mb && ma === mb && !genericA) return true;
    // When one pin is explicitly approximate (town centroid / unknown), allow a wider in-town radius.
    if (km <= 12 && ma && mb && ma === mb && !genericA && (isApproxGeoPrecision(a.geoPrecision) || isApproxGeoPrecision(b.geoPrecision))) {
      return true;
    }
    return false;
  }
  if (ma && mb && ma === mb && !genericA && !genericB) return true;
  return false;
}

function tokenHit(a: FuseItem, b: FuseItem): number {
  const wa = tokens(hay(a));
  const wb = new Set(tokens(hay(b)));
  return wa.filter((w) => wb.has(w)).length;
}

function outletBase(outlet: string): string {
  return outlet
    .trim()
    .replace(/^(?:facebook|x)\s+·\s+/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNewsroomSocial(outlet: string): boolean {
  return /^(?:Facebook|X)\s+·\s+(?:CBS6|NEWS10|WNYT|Spectrum News 1|Daily Gazette|Troy Record|Times Union|WAMC)\b/i.test(outlet);
}

function tokenSimilarity(a: string, b: string): { inter: number; union: number; jaccard: number; overlap: number } {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  const jaccard = union ? inter / union : 0;
  const overlap = Math.min(sa.size, sb.size) ? inter / Math.min(sa.size, sb.size) : 0;
  return { inter, union, jaccard, overlap };
}

function stripNewsroomSocialLinks(text: string): string {
  return (text || "")
    .replace(/\bMORE:\s*https?:\/\/\S+/gi, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bMORE:\s*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function weakScannerPlace(item: FuseItem): boolean {
  if ((item.kind ?? "") !== "scanner") return false;
  const addr = (item.address || "").trim();
  const muni = normMuni(item.municipality);
  if (!addr || /^area unknown$/i.test(addr) || isLowConfAddr(addr)) return true;
  if (!muni || GENERIC_MUNI.test(muni)) return true;
  return false;
}

function isLowConfAddr(addr: string): boolean {
  return /triumph|trion|across|unknown/i.test(addr);
}

export function shouldFuse(a: FuseItem, b: FuseItem): boolean {
  if (a.id === b.id) return true;
  const ca = callOf(a);
  const cb = callOf(b);
  if (!kindsCompatible(ca, cb)) return false;
  if (Math.abs(a.minutesAgo - b.minutesAgo) > windowMin(a, b)) return false;

  // Newsroom social posts are frequently cross-posted across Facebook + X with slightly different
  // municipality hints or pins. When it's the same outlet and titles clearly describe the same
  // event, fuse them even if place strings disagree.
  if ((a.kind ?? "") === "social" && (b.kind ?? "") === "social" && isNewsroomSocial(a.outlet) && isNewsroomSocial(b.outlet)) {
    const ba = outletBase(a.outlet);
    const bb = outletBase(b.outlet);
    if (ba && ba === bb) {
      const ta = stripNewsroomSocialLinks(a.title);
      const tb = stripNewsroomSocialLinks(b.title);
      if (ta && tb && ta.toLowerCase() === tb.toLowerCase()) return true;
      const sim = tokenSimilarity(ta, tb);
      if (sim.inter >= 4 && sim.overlap >= 0.8 && sim.jaccard >= 0.67) return true;
      const sa = stripNewsroomSocialLinks(a.summary);
      const sb = stripNewsroomSocialLinks(b.summary);
      const simWide = tokenSimilarity(`${ta} ${sa}`, `${tb} ${sb}`);
      if (simWide.inter >= 6 && simWide.overlap >= 0.8 && simWide.jaccard >= 0.65) return true;
    }
  }

  const ma = normMuni(a.municipality);
  const mb = normMuni(b.municipality);
  const concreteA = Boolean(ma && !GENERIC_MUNI.test(ma));
  const concreteB = Boolean(mb && !GENERIC_MUNI.test(mb));
  const muniConflict = concreteA && concreteB && ma !== mb;
  const place = geoClose(a, b);
  const hit = tokenHit(a, b);
  const street = sharesStreetKey(a, b);
  const km =
    hasPin(a) && hasPin(b) ? haversineKm({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }) : Number.POSITIVE_INFINITY;
  // Do not let a weak/unknown-place scanner dissolve into blotter/news on muni alone —
  // that zeros the Radio lens and hides real captions from Last 3 hours.
  const weakScan = weakScannerPlace(a) || weakScannerPlace(b);
  const kinds = [a.kind, b.kind];
  const crossOfficial =
    kinds.includes("scanner") &&
    kinds.some((k) => k === "blotter" || k === "news" || k === "social");
  if (weakScan && crossOfficial) {
    // If both sides have a real pin and it's close, allow the fuse even when the scanner row's
    // address/muni strings are weak. This prevents "scanner then newsroom" upgrades from
    // showing as duplicates while still blocking muni-only dissolves.
    if (muniConflict) {
      // Across towns, require street evidence or extremely close precise pins + same call family.
      if (street.shared && ca.family === cb.family && ca.family !== "other") return hit >= (street.common ? 3 : 2);
      if (
        place &&
        km <= 0.35 &&
        !isApproxGeoPrecision(a.geoPrecision) &&
        !isApproxGeoPrecision(b.geoPrecision) &&
        ca.family === cb.family &&
        ca.family !== "other"
      ) {
        return hit >= 1;
      }
      return false;
    }
    if (place && hit >= 2) return true;
    if (street.shared) return hit >= (street.common ? 2 : 1);
    return hit >= 3 && Boolean(extractStreetHint(a) && extractStreetHint(b));
  }
  if (muniConflict) {
    // Harder fusion when municipalities differ: never fuse on "nearby pin + same family/type" alone.
    // Require shared street evidence (and higher token hit), or an extremely close precise pin match.
    if (street.shared && ca.family === cb.family && ca.family !== "other") return hit >= (street.common ? 3 : 2);
    if (
      place &&
      km <= 0.35 &&
      !isApproxGeoPrecision(a.geoPrecision) &&
      !isApproxGeoPrecision(b.geoPrecision) &&
      ca.family === cb.family &&
      ca.family !== "other"
    ) {
      return hit >= 1;
    }
    return false;
  }
  if (place) return hit >= 1 || ca.type === cb.type;
  // Weak geo: only fuse when titles clearly overlap (same street / same event words).
  const need = Math.max(3, Math.ceil(Math.min(tokens(a.title).length, tokens(b.title).length) * 0.5));
  return hit >= need;
}

function extractStreetHint(item: FuseItem): boolean {
  return /\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd|route|highway|wolf|western|central|lark|pearl)\b/i.test(
    `${item.title} ${item.address ?? ""} ${item.summary ?? ""}`,
  );
}

export function clusterLiveItems(items: FuseItem[]): FuseItem[][] {
  const groups: FuseItem[][] = [];
  for (const item of items) {
    const found = groups.find((g) => g.some((member) => shouldFuse(item, member)));
    if (found) found.push(item);
    else groups.push([item]);
  }
  return groups;
}

export function sourceFamily(kind: FuseKind | undefined, outlet: string): string {
  const activity = kind ?? "news";
  if (activity === "blotter") return "blotter";
  if (activity === "scanner") return "scanner";
  if (/^Nixle\b/i.test(outlet)) return "nixle";
  if (/\bTINC\b/i.test(outlet) || /\bNYSTA\b/i.test(outlet)) return "tinc";
  if (outlet === "511NY" || (activity === "traffic" && /511/i.test(outlet))) return "511";
  if (outlet === "NWS" || /National Weather/i.test(outlet)) return "nws";
  if (/^Civic ·/i.test(outlet)) return "civic";
  if (activity === "social") return "social";
  if (activity === "traffic") return "511";
  return "news";
}

export function familyChip(family: string): SeenOnChip {
  switch (family) {
    case "blotter":
      return { key: "blotter", label: "Blotter" };
    case "nixle":
      return { key: "nixle", label: "Nixle" };
    case "tinc":
      return { key: "tinc", label: "Thruway" };
    case "scanner":
      return { key: "scanner", label: "Scanner" };
    case "511":
      return { key: "511", label: "511" };
    case "nws":
      return { key: "nws", label: "NWS" };
    case "civic":
    case "press":
      return { key: "civic", label: "Civic" };
    case "social":
      return { key: "social", label: "Social" };
    default:
      return { key: "news", label: "News" };
  }
}

export function seenOnFromItems(items: FuseItem[]): SeenOnChip[] {
  const seen = new Set<string>();
  const out: SeenOnChip[] = [];
  for (const item of items) {
    const chip = familyChip(sourceFamily(item.kind, item.outlet));
    if (seen.has(chip.key)) continue;
    seen.add(chip.key);
    out.push(chip);
  }
  return out;
}

export function seenOnFromSources(sources: IncidentSource[]): SeenOnChip[] {
  const seen = new Set<string>();
  const out: SeenOnChip[] = [];
  for (const s of sources) {
    const family =
      s.kind === "blotter"
        ? "blotter"
        : s.kind === "nixle"
          ? "nixle"
        : s.kind === "scanner"
          ? "scanner"
          : s.kind === "cfs" || /511/i.test(s.name)
            ? "511"
            : /NWS/i.test(s.name)
              ? "nws"
              : s.kind === "social"
                ? "social"
                : s.kind === "press" || /Civic/i.test(s.name)
                  ? "civic"
                  : "news";
    const chip = familyChip(family);
    if (seen.has(chip.key)) continue;
    seen.add(chip.key);
    out.push(chip);
  }
  return out;
}

function familyTier(family: string): SourceTier {
  if (
    family === "blotter" ||
    family === "nixle" ||
    family === "tinc" ||
    family === "511" ||
    family === "nws" ||
    family === "civic" ||
    family === "press"
  ) {
    return "official";
  }
  if (family === "scanner" || family === "social") return "unconfirmed";
  return "context";
}

function confidenceRank(family: string): number {
  // Higher = more trustworthy / authoritative in Live.
  // official > blotter > nixle > news > scanner_stt > social
  if (family === "tinc" || family === "511" || family === "nws" || family === "civic" || family === "press") return 6;
  if (family === "blotter") return 5;
  if (family === "nixle") return 4;
  if (family === "news") return 3;
  if (family === "scanner") return 2;
  if (family === "social") return 1;
  return 0;
}

/**
 * Independent-family corroboration. Official > context > unconfirmed.
 * A lone scanner is capped so it cannot outrank a multi-source cluster.
 */
export function scoreCorroboration(items: FuseItem[]): Corroboration {
  const families = [...new Set(items.map((i) => sourceFamily(i.kind, i.outlet)))];
  const newsOutlets = new Set(
    items.filter((i) => sourceFamily(i.kind, i.outlet) === "news").map((i) => i.outlet.toLowerCase()),
  );
  let score = 0;
  const official = families.filter((f) => familyTier(f) === "official");
  const context = families.filter((f) => familyTier(f) === "context");
  const unconfirmed = families.filter((f) => familyTier(f) === "unconfirmed");
  score += official.length * 36;
  score += context.length * 18;
  score += Math.min(2, newsOutlets.size) * 6;
  score += unconfirmed.length * 8;
  if (families.length >= 2) score += 16;
  if (families.length >= 3) score += 12;
  if (official.length && (context.length || unconfirmed.length)) score += 10;

  const onlyScanner = families.length === 1 && families[0] === "scanner";
  const onlySocial = families.length === 1 && families[0] === "social";
  if (onlyScanner || onlySocial) score = Math.min(score, 22);

  score = Math.max(0, Math.min(100, score));
  const why = onlyScanner
    ? "Scanner only — early report, not a CAD log. May be wrong."
    : onlySocial
      ? "Citizen or social post — not a 911 or CAD call."
      : official.length && families.length > 1
        ? `Official ${official.join(" + ")} plus ${families.length - official.length} independent source${families.length - official.length === 1 ? "" : "s"}.`
        : official.length
          ? `Official ${official.join(" + ")}.`
          : `${families.length} independent source famil${families.length === 1 ? "y" : "ies"} (${families.join(", ")}).`;
  return { score, families, independent: families.length, why };
}

export function compareFused(a: { corroborationScore?: number; minutesAgo: number }, b: { corroborationScore?: number; minutesAgo: number }): number {
  const sa = a.corroborationScore ?? 0;
  const sb = b.corroborationScore ?? 0;
  // Live feed should feel live: when two incidents are far apart in time,
  // prefer recency over corroboration so yesterday's blotter doesn't pin the top.
  const gap = Math.abs(a.minutesAgo - b.minutesAgo);
  if (gap >= 6 * 60) return a.minutesAgo - b.minutesAgo;
  if (sb !== sa) return sb - sa;
  return a.minutesAgo - b.minutesAgo;
}

export function pickPrimary(group: FuseItem[]): FuseItem {
  const rank = (item: FuseItem): number => {
    const family = sourceFamily(item.kind, item.outlet);
    const tier = familyTier(family);
    const tierN = tier === "official" ? 3 : tier === "context" ? 2 : 1;
    const conf = confidenceRank(family);
    const recency = Math.max(0, 2000 - item.minutesAgo);
    return conf * 20_000 + tierN * 10_000 + recency;
  };
  return [...group].sort((a, b) => rank(b) - rank(a))[0]!;
}

export function itemToSource(item: FuseItem): IncidentSource {
  const activity = item.kind ?? "news";
  const family = sourceFamily(activity, item.outlet);
  const kind: SourceKind =
    family === "blotter"
      ? "blotter"
      : family === "nixle"
        ? "nixle"
        : family === "tinc"
          ? "cfs"
      : family === "scanner"
        ? "scanner"
        : family === "511"
          ? "cfs"
          : family === "social"
            ? "social"
            : family === "civic" || family === "press" || family === "nws"
              ? "press"
              : "news";
  return {
    kind,
    name: item.outlet,
    tier: familyTier(family),
    url: item.url,
    excerpt: usableExcerpt(item.summary, item.title),
  };
}

export function verificationFor(items: FuseItem[], sources: IncidentSource[]): Verification {
  if (sources.some((s) => s.tier === "official")) return "confirmed";
  if (sources.length > 0 && sources.every((s) => s.kind === "scanner")) return "scanner";
  const families = new Set(items.map((i) => sourceFamily(i.kind, i.outlet)));
  if (families.size === 1 && families.has("scanner")) return "scanner";
  return "developing";
}

export function fuseId(group: FuseItem[], primary: FuseItem): string {
  if (group.length === 1) {
    const item = group[0]!;
    if (
      item.id.startsWith("nysp-") ||
      item.id.startsWith("scan-") ||
      item.id.startsWith("citizen-") ||
      item.id.startsWith("511-") ||
      item.id.startsWith("nws-") ||
      item.id.startsWith("nixle-") ||
      item.id.startsWith("tinc-")
    ) {
      return item.id;
    }
  }
  const official = group.find(
    (g) =>
      g.id.startsWith("nysp-") ||
      g.id.startsWith("511-") ||
      g.id.startsWith("nws-") ||
      g.id.startsWith("nixle-") ||
      g.id.startsWith("tinc-"),
  );
  if (official) return official.id;

  // Soft cluster identity (no hard ids): geo+time bucket+call family. Stable across refreshes even
  // when individual URLs change or scanner seq rolls.
  const family = callOf(primary).family || "other";
  const muni = normMuni(primary.municipality) || "unknown";
  const addr = (primary.address || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const road =
    addr
      .match(
        /\b(?:north|south|east|west|n|s|e|w)?\s*[a-z][a-z0-9']+(?:\s+[a-z][a-z0-9']+){0,2}\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|place|pl|drive|dr)\b/i,
      )?.[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
  const at = Date.parse(primary.publishedAt);
  const bucketMs = 15 * 60_000;
  const t = Number.isFinite(at) ? Math.floor(at / bucketMs) * bucketMs : 0;
  const geo =
    typeof primary.lat === "number" && typeof primary.lng === "number" && Number.isFinite(primary.lat) && Number.isFinite(primary.lng)
      ? `${Math.round(primary.lat * 100) / 100},${Math.round(primary.lng * 100) / 100}`
      : muni;
  const soft = `${family}|${muni}|${geo}|${road}|${t}`;
  let hs = 0;
  for (let i = 0; i < soft.length; i++) hs = (hs * 31 + soft.charCodeAt(i)) | 0;
  return `evt-${Math.abs(hs).toString(36)}`;
}
