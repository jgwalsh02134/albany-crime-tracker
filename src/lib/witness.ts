import type { GeoPrecision } from "@/lib/geo";
import type { Incident, WitnessKind } from "@/lib/types";

export function isWitnessIncident(inc: Incident): boolean {
  return inc.sources.some((s) => /citizen\s*·\s*witness/i.test(s.name));
}

export function witnessKindLabel(kind: WitnessKind): string {
  switch (kind) {
    case "police":
      return "Police";
    case "fire":
      return "Fire";
    case "crash":
      return "Crash";
    case "other":
      return "Other";
  }
}

export function deriveGeoPrecisionFromAccuracy(accuracyM: number | null | undefined): GeoPrecision {
  const a = typeof accuracyM === "number" && Number.isFinite(accuracyM) ? accuracyM : null;
  if (a == null) return "road";
  if (a <= 80) return "street";
  if (a <= 250) return "road";
  if (a <= 1500) return "town";
  return "county";
}

