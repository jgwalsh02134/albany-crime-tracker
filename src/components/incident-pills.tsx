import { Badge } from "@/components/ui/badge";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isWitnessIncident } from "@/lib/witness";

function sourceFallback(incident: Incident): { label: string; key: string } {
  const official = incident.sources.find((s) => s.tier === "official") ?? incident.sources[0];
  const source = official?.name ?? "";
  const kind = official?.kind;
  if ((incident.seenOn?.length ?? 0) >= 2) return { label: "Fused", key: "fused" };
  if (kind === "blotter") return { label: "NYSP", key: "nysp" };
  if (kind === "scanner") return { label: "Scanner", key: "scanner" };
  if (kind === "cfs") return { label: "511NY", key: "511" };
  if (/Facebook/i.test(source)) return { label: "Facebook", key: "facebook" };
  if (/X ·/i.test(source)) return { label: "X", key: "x" };
  if (/Reddit/i.test(source)) return { label: "Reddit", key: "reddit" };
  if (kind === "social" || /Citizen/i.test(source)) return { label: "Citizen", key: "social" };
  if (kind === "press") return { label: "Press", key: "press" };
  return { label: "News", key: "news" };
}

function confidenceBadge(incident: Incident): { label: string; tone: "cyan" | "accent" | "medium" | "muted" } {
  const sources = incident.sources ?? [];
  const trafficOnly =
    sources.length > 0 && sources.every((s) => s.kind === "cfs" || /\b(tinc|thruway|511|nysta)\b/i.test(s.name));
  if (trafficOnly) {
    const names = sources.map((s) => s.name).join(" ");
    return /\b(tinc|thruway|nysta)\b/i.test(names)
      ? { label: "Thruway", tone: "muted" }
      : { label: "Traffic", tone: "muted" };
  }
  if (incident.verification === "confirmed") {
    const agencyOfficial = sources.some(
      (s) => s.kind === "blotter" || s.kind === "nixle" || s.kind === "press" || s.kind === "opendata",
    );
    if (agencyOfficial) return { label: "Official", tone: "cyan" };
    if (sources.some((s) => s.kind === "cfs")) return { label: "Traffic", tone: "muted" };
    return { label: "Official", tone: "cyan" };
  }
  if (incident.verification === "scanner") return { label: "Scanner", tone: "accent" };
  if (isWitnessIncident(incident)) return { label: "Unconfirmed", tone: "medium" };
  if (incident.sources.some((s) => s.kind === "social")) return { label: "Unconfirmed", tone: "medium" };
  return { label: "Developing", tone: "muted" };
}

export function IncidentPills({
  incident,
  max = 6,
  className,
  badgeClassName,
}: {
  incident: Incident;
  max?: number;
  className?: string;
  badgeClassName?: string;
}) {
  const witness = isWitnessIncident(incident);
  const fallback = sourceFallback(incident);
  const conf = confidenceBadge(incident);
  const chips =
    [
      ...(witness ? [{ key: "witness", label: "Witness" }] : []),
      ...(incident.seenOn?.length ? incident.seenOn : [{ key: fallback.key, label: fallback.label }]),
    ].slice(0, max);

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted"
        >
          {chip.label}
        </span>
      ))}
      <Badge className={cn("ml-auto shrink-0", badgeClassName)} tone={conf.tone}>
        {conf.label}
      </Badge>
    </div>
  );
}

