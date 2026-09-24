import type { Incident } from "@/lib/types";
import { isWitnessIncident } from "@/lib/witness";

export type PillTone = "cyan" | "accent" | "gold" | "muted";

export function incidentSourcePill(incident: Incident): { label: string; tone: PillTone } {
  const official = incident.sources.find((s) => s.tier === "official") ?? incident.sources[0];
  const source = official?.name ?? "";
  const kind = official?.kind;

  if ((incident.seenOn?.length ?? 0) >= 2) return { label: "Fused", tone: "cyan" };
  if (kind === "blotter") return { label: "NYSP", tone: "cyan" };
  if (kind === "scanner") return { label: "Scanner", tone: "accent" };
  if (kind === "cfs") return { label: "511NY", tone: "cyan" };
  if (/Facebook/i.test(source)) return { label: "Facebook", tone: "cyan" };
  if (/X ·/i.test(source)) return { label: "X", tone: "muted" };
  if (/Reddit/i.test(source)) return { label: "Reddit", tone: "gold" };
  if (kind === "social" || /Citizen/i.test(source)) return { label: "Social", tone: "gold" };
  if (kind === "press") return { label: "Press", tone: "cyan" };
  return { label: "News", tone: "muted" };
}

function isTrafficSource(source: { kind?: string; name?: string }): boolean {
  return source.kind === "cfs" || /\b(tinc|thruway|511|nysta)\b/i.test(source.name || "");
}

export function incidentProvenancePill(incident: Incident): { label: string; tone: PillTone } {
  const sources = incident.sources ?? [];
  const trafficOnly = sources.length > 0 && sources.every(isTrafficSource);
  if (trafficOnly) {
    const names = sources.map((s) => s.name).join(" ");
    if (/\b(tinc|thruway|nysta)\b/i.test(names)) return { label: "Thruway", tone: "muted" };
    return { label: "Traffic", tone: "muted" };
  }
  if (incident.verification === "confirmed") {
    const agencyOfficial = sources.some(
      (s) => s.kind === "blotter" || s.kind === "nixle" || s.kind === "press" || s.kind === "opendata",
    );
    if (agencyOfficial) return { label: "Official", tone: "cyan" };
    if (sources.some(isTrafficSource)) return { label: "Traffic", tone: "muted" };
    return { label: "Official", tone: "cyan" };
  }
  if (incident.verification === "scanner") return { label: "Scanner", tone: "accent" };
  if (isWitnessIncident(incident)) return { label: "Witness", tone: "gold" };
  if (incident.sources.some((s) => s.kind === "social")) return { label: "Unconfirmed", tone: "gold" };
  return { label: "Developing", tone: "muted" };
}

