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

export function incidentProvenancePill(incident: Incident): { label: string; tone: PillTone } {
  if (incident.verification === "confirmed") return { label: "Official", tone: "cyan" };
  if (incident.verification === "scanner") return { label: "Scanner", tone: "accent" };
  if (isWitnessIncident(incident)) return { label: "Witness", tone: "gold" };
  if (incident.sources.some((s) => s.kind === "social")) return { label: "Unconfirmed", tone: "gold" };
  return { label: "Developing", tone: "muted" };
}

