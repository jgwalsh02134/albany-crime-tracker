import type { Incident, Severity } from "./types";
import { isOfficialAgencySocial } from "./social-official";

const SEV_BOOST: Record<Severity, number> = {
  critical: 90,
  high: 45,
  medium: 15,
  low: 0,
};

export type LiveRankInput = {
  minutesAgo: number;
  corroborationScore?: number;
  severity?: Severity;
  geoPrecision?: string;
  verification?: string;
  type?: string;
  title?: string;
  address?: string;
  status?: string;
  description?: string;
  municipality?: string;
  sources?: { kind?: string; name?: string; tier?: string }[];
};

function isPlaceSpecific(inc: LiveRankInput): boolean {
  const muni = (inc.municipality || "").toLowerCase().trim();
  if (!muni || /^(albany county|capital district|countywide|unknown|area unknown)$/.test(muni)) return false;
  const addr = (inc.address || "").toLowerCase().trim();
  if (inc.geoPrecision && !["town", "county", "unknown"].includes(inc.geoPrecision)) return true;
  return Boolean(addr && addr !== "area unknown" && addr !== muni);
}

function placePrecisionBonus(inc: LiveRankInput): number {
  const p = inc.geoPrecision;
  if (p === "street" || p === "intersection") return 40;
  if (p === "landmark") return 28;
  if (p === "road") return 16;
  if (p === "town") return 4;
  const addr = (inc.address || "").toLowerCase();
  if (addr && addr !== "area unknown" && /\b(st|street|ave|avenue|rd|road|blvd|broadway|wolf|western|central|delaware)\b/.test(addr)) {
    return 32;
  }
  return 0;
}

function freshnessPoints(minutesAgo: number): number {
  const age = Math.max(0, minutesAgo);
  if (age <= 20) return 240 - age * 2;
  if (age <= 60) return 200 - (age - 20);
  if (age <= 180) return 140 - (age - 60) * 0.45;
  if (age <= 360) return 40 - (age - 180) * 0.1;
  return Math.max(0, 12 - (age - 360) * 0.01);
}

function fluffDemotion(inc: LiveRankInput): number {
  const hay = `${inc.title ?? ""} ${inc.type ?? ""} ${inc.description ?? ""}`.toLowerCase();
  let d = 0;
  if (/\b(lane closure|lanes? closed|disabled vehicle|disabled motorist)\b/.test(hay) || inc.type === "disabled-vehicle") {
    d += 80;
  }
  if (
    /\b(psa\b|public service|forensic science week|safe speed|emt program|students seek|open house|yom kippur)\b/.test(hay) &&
    !/\b(shoot|stab|crash|structure fire|robbery|homicide)\b/.test(hay)
  ) {
    d += 70;
  }
  if (inc.status === "closed") d += 50;
  const sources = inc.sources ?? [];
  if (sources.some((s) => s.kind === "blotter") && inc.minutesAgo > 360) d += 45;
  if (sources.some((s) => s.kind === "press" || /civic/i.test(s.name || "")) && inc.minutesAgo > 24 * 60) d += 40;
  return d;
}

/**
 * Now / default Live / Near-me score.
 * Freshness, place precision, severity, and an early-signal bonus dominate.
 * Corroboration only breaks ties.
 */
export function liveWitnessScore(inc: LiveRankInput): number {
  const place = placePrecisionBonus(inc);
  const sources = inc.sources ?? [];
  const scanner = inc.verification === "scanner" || sources.some((s) => s.kind === "scanner");
  const nixle = sources.some((s) => s.kind === "nixle" || /^nixle\b/i.test(s.name || ""));
  let early = 0;
  if ((scanner || nixle) && place >= 16 && inc.minutesAgo <= 180) early += 36;
  const corr = Math.min(8, (inc.corroborationScore ?? 0) / 12);
  const sev = SEV_BOOST[inc.severity ?? "low"] ?? 0;
  return freshnessPoints(inc.minutesAgo) + sev + place + early + corr - fluffDemotion(inc);
}

function hasRecentAgencySocial(inc: Incident): boolean {
  if (inc.minutesAgo > 120) return false;
  return inc.sources.some(
    (s) => s.kind === "social" && /^(?:Facebook|X)\s+·\s+/i.test(s.name) && isOfficialAgencySocial(s.name),
  );
}

export type NowRankContext = {
  colonieFocused?: boolean;
};

function hasRecentColonieEarlySignal(inc: Incident): boolean {
  if (inc.minutesAgo > 120) return false;
  return inc.sources.some((s) => {
    if (s.kind === "news" && /^Nixle\s+·\s+Colonie\b/i.test(s.name)) return true;
    if (s.kind !== "social") return false;
    if (!/^(?:Facebook|X)\s+·\s+/i.test(s.name)) return false;
    // Prefer early Colonie fire/EMS/alerts when CPD radio is encrypted.
    return /\bColonie\b/i.test(s.name) || /\b(Latham Fire|Fuller Road VFD|Midway Fire|Shaker Road–Loudonville)\b/i.test(s.name);
  });
}

export function nowUrgencyScore(inc: Incident, ctx?: NowRankContext): number {
  let s = liveWitnessScore(inc);
  // Witness gap: when an agency social post is both recent and place-specific, prefer it slightly
  // in the Now lane while still keeping it unconfirmed (social is not CAD).
  if (hasRecentAgencySocial(inc) && isPlaceSpecific(inc)) s += 12;
  // Colonie "silent hole": lightly prefer early Colonie alerts (Nixle / FD / EMS / agency social)
  // when the user is focused on Colonie. This only affects ordering, not severity/labels.
  if (ctx?.colonieFocused && /^colonie$/i.test(inc.municipality || "") && hasRecentColonieEarlySignal(inc) && isPlaceSpecific(inc)) {
    s += 9;
  }
  return s;
}

/**
 * Now-lane ranking: prioritize witness relevance (recency + severity) while staying honest about
 * verification. Corroboration still matters as a tie-breaker, but it should not bury fresh,
 * serious unconfirmed activity under hours-old multi-source news.
 */
export function compareNowLane(a: Incident, b: Incident): number {
  const aUrgency = nowUrgencyScore(a);
  const bUrgency = nowUrgencyScore(b);
  if (bUrgency !== aUrgency) return bUrgency - aUrgency;

  const aCorr = a.corroborationScore ?? 0;
  const bCorr = b.corroborationScore ?? 0;
  if (bCorr !== aCorr) return bCorr - aCorr;

  // Stable: newest first when otherwise equal.
  if (a.minutesAgo !== b.minutesAgo) return a.minutesAgo - b.minutesAgo;
  return a.id.localeCompare(b.id);
}

export function compareNowLaneWithContext(ctx?: NowRankContext): (a: Incident, b: Incident) => number {
  return (a, b) => {
    const aUrgency = nowUrgencyScore(a, ctx);
    const bUrgency = nowUrgencyScore(b, ctx);
    if (bUrgency !== aUrgency) return bUrgency - aUrgency;

    const aCorr = a.corroborationScore ?? 0;
    const bCorr = b.corroborationScore ?? 0;
    if (bCorr !== aCorr) return bCorr - aCorr;

    if (a.minutesAgo !== b.minutesAgo) return a.minutesAgo - b.minutesAgo;
    return a.id.localeCompare(b.id);
  };
}

