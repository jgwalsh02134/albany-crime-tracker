import { ShareButton } from "@/components/share-button";
import { clockTime, relativeTime, typeLabel } from "@/lib/format";
import { decodeHtmlEntities } from "@/lib/html";
import { incidentSharePayload } from "@/lib/share";
import { IncidentPills } from "@/components/incident-pills";
import type { Incident, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isWitnessIncident } from "@/lib/witness";

const rail: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

function blurb(incident: Incident): string | null {
  const raw = decodeHtmlEntities(
    (incident.description || "").replace(/[.!?…]\s+(?:Unconfirmed|Early report)[\s\S]*$/i, "").trim(),
  );
  const title = decodeHtmlEntities(incident.title);
  if (!raw || raw === title) return null;
  return raw;
}

export function IncidentCard({
  incident,
  onSelect,
}: {
  incident: Incident;
  onSelect: (id: string) => void;
}) {
  const title = decodeHtmlEntities(incident.title);
  const witness = isWitnessIncident(incident);
  const loc = incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
    ? incident.address
    : `${incident.address} · ${incident.municipality}`;
  const extra = blurb(incident);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => onSelect(incident.id)}
        className="w-full py-3 pl-3.5 pr-12 text-left active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <span className={cn("absolute inset-y-2 left-0 w-1 rounded-full", rail[incident.severity])} />
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-fg">
            {title}
          </h3>
          <div className="mt-0.5 shrink-0 text-right">
            <time className="block font-mono text-xs font-semibold tabular-nums text-fg">{relativeTime(incident.occurredAt)}</time>
            <span className="block font-mono text-[11px] tabular-nums text-subtle">{clockTime(incident.occurredAt)}</span>
          </div>
        </div>
        {extra ? <p className="mt-1 line-clamp-1 text-sm text-muted">{extra}</p> : null}
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="shrink-0 uppercase tracking-wide text-subtle">{typeLabel(incident.type)}</span>
          <span className="text-subtle">·</span>
          <span className="min-w-0 truncate">{loc}</span>
        </p>

        <div className="mt-2">
          <IncidentPills incident={incident} />
        </div>

        {incident.verification === "scanner" ? (
          <p className="mt-1 text-[11px] text-subtle">Early radio report — not a CAD log. May be wrong.</p>
        ) : witness ? (
          <p className="mt-1 text-[11px] text-subtle">Witness report — may be wrong.</p>
        ) : null}
      </button>
      <div className="absolute right-1.5 top-1.5">
        <ShareButton payload={incidentSharePayload(incident)} label="Share incident" />
      </div>
    </div>
  );
}
