import type { Incident, IncidentSource } from "./types";
import type { MapKind, MapSourceGroup, MapVerification } from "./store";

export function isOfficialSource(s: IncidentSource): boolean {
  return s.tier === "official";
}

export function incidentVerification(inc: Incident): MapVerification {
  if (inc.verification === "confirmed" || inc.verification === "developing" || inc.verification === "scanner") {
    return inc.verification;
  }
  return "developing";
}

export function isOfficialIncident(inc: Incident): boolean {
  if (incidentVerification(inc) === "confirmed") return true;
  return inc.sources.some(isOfficialSource);
}

export function mapKindOf(inc: Incident): MapKind {
  const seen = new Set((inc.seenOn ?? []).map((c) => c.key));
  if (seen.has("511") || seen.has("tinc") || seen.has("nws")) return "traffic";
  if (inc.sources.some((s) => s.kind === "cfs")) return "traffic";
  const t = (inc.type || "").toLowerCase();
  if (t === "fire" || /\bfire\b/.test(t)) return "fire";
  if (t === "crash" || t === "dwi" || t === "disabled-vehicle" || /\bcrash\b/.test(t)) return "crash";
  return "crime";
}

export function incidentMatchesSourceGroup(inc: Incident, group: MapSourceGroup): boolean {
  if (group === "official") return isOfficialIncident(inc);
  if (group === "scanner") return inc.verification === "scanner" || inc.sources.some((s) => s.kind === "scanner");
  if (group === "social") return inc.sources.some((s) => s.kind === "social");
  // "news"
  return inc.sources.some((s) => s.kind === "news");
}

