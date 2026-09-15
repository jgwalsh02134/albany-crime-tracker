import { Badge } from "@/components/ui/badge";
import { ShareButton } from "@/components/share-button";
import { clockTime, relativeTime, typeLabel } from "@/lib/format";
import { decodeHtmlEntities } from "@/lib/html";
import { incidentProvenancePill, incidentSourcePill } from "@/lib/incident-pills";
import { incidentSharePayload } from "@/lib/share";
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

function formatDistanceMi(mi: number): string {
  if (!Number.isFinite(mi) || mi < 0) return "";
  if (mi < 0.2) return "<0.2 mi";
  if (mi < 10) return `${Math.round(mi * 10) / 10} mi`;
  return `${Math.round(mi)} mi`;
}

export function IncidentCard({
  incident,
  onSelect,
  distanceMi = null,
  compact = false,
}: {
  incident: Incident;
  onSelect: (id: string) => void;
  distanceMi?: number | null;
  compact?: boolean;
}) {
  const title = decodeHtmlEntities(incident.title);
  const witness = isWitnessIncident(incident);
  const badge = incidentSourcePill(incident);
  const conf = incidentProvenancePill(incident);
  const loc = incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
    ? incident.address
    : `${incident.address} · ${incident.municipality}`;
  const extra = blurb(incident);
  const distance = distanceMi != null ? formatDistanceMi(distanceMi) : "";

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <button
        type="button"
        onClick={() => onSelect(incident.id)}
        className="w-full px-3.5 py-3.5 pr-12 text-left active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <span className={cn("absolute inset-y-3 left-0 w-1 rounded-full", rail[incident.severity])} />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={conf.tone}>{conf.label}</Badge>
              {compact ? null : (
                <Badge tone={badge.tone} className="normal-case tracking-normal">
                  {badge.label}
                </Badge>
              )}
              {!compact && incident.seenOn?.length ? (
                <span className="ml-auto inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
                  {incident.seenOn.length} sources
                </span>
              ) : null}
            </div>

            <h3 className="mt-1 min-w-0 line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight text-fg">
              {title}
            </h3>
            <p className="mt-0.5 min-w-0 truncate text-sm text-muted">{loc}</p>
          </div>

          <div className="mt-0.5 shrink-0 text-right">
            <time className="block font-mono text-xs font-semibold tabular-nums text-fg">
              {relativeTime(incident.occurredAt)}
            </time>
            <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-subtle">
              {distance || clockTime(incident.occurredAt)}
            </span>
          </div>
        </div>

        {!compact && extra ? <p className="mt-1.5 line-clamp-1 text-sm text-muted">{extra}</p> : null}

        <div className={cn("mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-subtle", compact && "mt-1")}>
          <span className="shrink-0 uppercase tracking-wide">{typeLabel(incident.type)}</span>
          {compact ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono tabular-nums">{clockTime(incident.occurredAt)}</span>
            </>
          )}
          {distance ? (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono tabular-nums">{distance}</span>
            </>
          ) : null}
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
