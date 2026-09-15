import type { Incident, Severity } from "./types";
import { isOfficialAgencySocial } from "./social-official";

const SEV_BOOST: Record<Severity, number> = {
  critical: 90,
  high: 45,
  medium: 15,
  low: 0,
};

function isPlaceSpecific(inc: Incident): boolean {
  const muni = (inc.municipality || "").toLowerCase().trim();
  if (!muni || /^(albany county|capital district|countywide|unknown|area unknown)$/.test(muni)) return false;
  const addr = (inc.address || "").toLowerCase().trim();
  if (inc.geoPrecision && !["town", "county", "unknown"].includes(inc.geoPrecision)) return true;
  return Boolean(addr && addr !== "area unknown" && addr !== muni);
}

function hasRecentAgencySocial(inc: Incident): boolean {
  if (inc.minutesAgo > 120) return false;
  return inc.sources.some(
    (s) => s.kind === "social" && /^(?:Facebook|X)\s+·\s+/i.test(s.name) && isOfficialAgencySocial(s.name),
  );
}

export function nowUrgencyScore(inc: Incident): number {
  let s = Math.max(0, 180 - inc.minutesAgo) + (SEV_BOOST[inc.severity] ?? 0);
  // Witness gap: when an agency social post is both recent and place-specific, prefer it slightly
  // in the Now lane while still keeping it unconfirmed (social is not CAD).
  if (hasRecentAgencySocial(inc) && isPlaceSpecific(inc)) s += 12;
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

