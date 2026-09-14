import type { Incident, Severity } from "./types";

const SEV_BOOST: Record<Severity, number> = {
  critical: 90,
  high: 45,
  medium: 15,
  low: 0,
};

export function nowUrgencyScore(inc: Incident): number {
  return Math.max(0, 180 - inc.minutesAgo) + (SEV_BOOST[inc.severity] ?? 0);
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

