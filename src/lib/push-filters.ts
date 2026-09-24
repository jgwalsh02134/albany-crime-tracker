import type { Incident, Severity } from "@/lib/types";
import { haversineKm } from "@/lib/fusion";

export type SeverityFloor = "high" | "critical";

export function severityRank(s: Severity): number {
  switch (s) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

export function severityFloorMeets(incidentSeverity: Severity, floor: SeverityFloor): boolean {
  return severityRank(incidentSeverity) >= severityRank(floor);
}

export function distanceMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineKm(a, b) * 0.621371;
}

export function incidentHasReliableGeo(inc: Pick<Incident, "lat" | "lng" | "geoPrecision" | "address">): boolean {
  // Some fused cards only have county/town centroids; treat that as "no geo" for in-radius matching.
  if (!Number.isFinite(inc.lat) || !Number.isFinite(inc.lng)) return false;
  if (inc.geoPrecision === "county" || inc.geoPrecision === "unknown") return false;
  if ((inc.address || "").toLowerCase().includes("area unknown")) return false;
  return true;
}

export function incidentInRadiusMiles(
  inc: Pick<Incident, "lat" | "lng" | "geoPrecision" | "address">,
  user: { lat: number; lng: number } | null,
  radiusMiles: 1 | 2 | 3,
): boolean {
  if (!user) return true; // county-wide fallback when the subscriber has no geo
  if (!incidentHasReliableGeo(inc)) return true; // county-wide fallback when the incident has no geo
  return distanceMiles({ lat: inc.lat, lng: inc.lng }, user) <= radiusMiles;
}

export function pushHonestyLabel(
  inc: Pick<Incident, "verification" | "sources">,
): "Official" | "Scanner" | "Unconfirmed" | "Thruway" | "Traffic" {
  const sources = inc.sources ?? [];
  const trafficOnly =
    sources.length > 0 && sources.every((s) => s.kind === "cfs" || /\b(tinc|thruway|511|nysta)\b/i.test(s.name));
  if (trafficOnly) {
    return /\b(tinc|thruway|nysta)\b/i.test(sources.map((s) => s.name).join(" ")) ? "Thruway" : "Traffic";
  }
  const agencyOfficial = sources.some(
    (s) => s.kind === "blotter" || s.kind === "nixle" || s.kind === "press" || s.kind === "opendata",
  );
  if (agencyOfficial || (inc.verification === "confirmed" && sources.some((s) => s.tier === "official" && s.kind !== "cfs"))) {
    return "Official";
  }
  if (inc.verification === "scanner" || (sources.length > 0 && sources.every((s) => s.kind === "scanner"))) return "Scanner";
  return "Unconfirmed";
}

