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
  const source = incident.sources[0]?.name;
  const kind = incident.sources[0]?.kind;
  const badge =
    kind === "blotter" ? "NYSP" : kind === "scanner" ? "Scanner" : kind === "cfs" ? "511NY" : "Newsroom";
  const badgeTone = kind === "blotter" || kind === "cfs" ? "cyan" : kind === "scanner" ? "accent" : "muted";

  return (
    <button
      type="button"
      onClick={() => onSelect(incident.id)}
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-border bg-surface py-3.5 pl-4 pr-3.5 text-left",
        "transition-transform duration-150 ease-out active:scale-[0.99] active:bg-surface-2",
      )}
    >
      <span className={cn("absolute inset-y-2 left-0 w-1 rounded-full", rail[incident.severity])} />
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-xs font-semibold uppercase tracking-wide text-subtle">
          {typeLabel(incident.type)}
          {source ? (
            <>
              <span className="mx-1.5">·</span>
              {source}
            </>
          ) : null}
        </p>
        <time className="shrink-0 font-mono text-xs font-semibold tabular-nums text-muted">
          {compactFromMinutes(incident.minutesAgo)}
        </time>
      </div>
      <h3 className="mt-1 text-sm font-semibold leading-snug tracking-tight text-fg">
        {incident.title}
      </h3>
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
        <MapPin className="size-3.5 shrink-0 text-subtle" />
        <span className="truncate">
          {incident.address}
          <span className="text-subtle"> · {incident.municipality}</span>
        </span>
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={incident.severity}>{incident.severity}</Badge>
        {incident.origin === "live" ? <Badge tone={badgeTone}>{badge}</Badge> : null}
      </div>
    </button>
  );
}
