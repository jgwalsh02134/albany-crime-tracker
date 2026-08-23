import { MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { compactFromMinutes, typeLabel } from "@/lib/format";
import type { Incident, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

const rail: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

export function IncidentCard({
  incident,
  onSelect,
}: {
  incident: Incident;
  onSelect: (id: string) => void;
}) {
  const hot = incident.severity === "critical" || incident.status === "active";
  const unique = [...new Set(incident.sources.map((s) => s.name))];
  const sourceNames = unique.slice(0, 2);
  const extra = unique.length - sourceNames.length;

  return (
    <button
      type="button"
      onClick={() => onSelect(incident.id)}
      className={cn(
        "relative w-full overflow-hidden rounded-xl border bg-surface p-4 pl-5 text-left",
        "transition-colors duration-150 ease-out active:bg-surface-2",
        hot ? "border-accent/40" : "border-border",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", rail[incident.severity])} />
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-xs font-semibold uppercase tracking-wide text-subtle">
          {typeLabel(incident.type)}
          <span className="mx-1.5 text-subtle">·</span>
          {incident.agencyAbbr}
        </p>
        <time className="shrink-0 font-mono text-xs font-semibold tabular-nums text-muted">
          {compactFromMinutes(incident.minutesAgo)}
        </time>
      </div>
      <h3 className="mt-1 text-base font-semibold leading-snug tracking-tight text-fg">
        {incident.title}
      </h3>
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
        <MapPin className="size-3.5 shrink-0 text-subtle" />
        <span className="truncate">
          {incident.address}
          <span className="text-subtle"> · {incident.municipality}</span>
        </span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone={incident.severity}>{incident.severity}</Badge>
        <Badge tone={incident.verification === "confirmed" ? "cyan" : "muted"}>
          {incident.verification}
        </Badge>
        {incident.status === "active" ? <Badge tone="accent">active</Badge> : null}
      </div>
      {sourceNames.length ? (
        <p className="mt-2 truncate text-xs text-subtle">
          Via {sourceNames.join(" · ")}
          {extra > 0 ? ` · +${extra}` : ""}
        </p>
      ) : null}
    </button>
  );
}
