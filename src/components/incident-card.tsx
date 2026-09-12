import { Badge } from "@/components/ui/badge";
import { ShareButton } from "@/components/share-button";
import { clockTime, typeLabel } from "@/lib/format";
import { incidentSharePayload } from "@/lib/share";
import type { Incident, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

const rail: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

function sourceBadge(incident: Incident): { label: string; tone: "cyan" | "accent" | "medium" | "muted" } {
  const official = incident.sources.find((s) => s.tier === "official") ?? incident.sources[0];
  const source = official?.name ?? "";
  const kind = official?.kind;
  if ((incident.seenOn?.length ?? 0) >= 2) return { label: "Fused", tone: "cyan" };
  if (kind === "blotter") return { label: "NYSP", tone: "cyan" };
  if (kind === "scanner") return { label: "Scanner", tone: "accent" };
  if (kind === "cfs") return { label: "511NY", tone: "cyan" };
  if (/Facebook/i.test(source)) return { label: "Facebook", tone: "cyan" };
  if (/X ·/i.test(source)) return { label: "X", tone: "muted" };
  if (/Reddit/i.test(source)) return { label: "Reddit", tone: "medium" };
  if (kind === "social" || /Citizen/i.test(source)) return { label: "Citizen", tone: "medium" };
  if (kind === "press") return { label: "Press", tone: "cyan" };
  return { label: "News", tone: "muted" };
}

function blurb(incident: Incident): string | null {
  const raw = (incident.description || "").replace(/\. Unconfirmed[\s\S]*$/i, "").trim();
  if (!raw || raw === incident.title) return null;
  return raw;
}

export function IncidentCard({
  incident,
  onSelect,
}: {
  incident: Incident;
  onSelect: (id: string) => void;
}) {
  const badge = sourceBadge(incident);
  const loc = incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
    ? incident.address
    : `${incident.address} · ${incident.municipality}`;
  const extra = blurb(incident);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={() => onSelect(incident.id)}
        className="w-full py-2.5 pl-3.5 pr-12 text-left active:bg-surface-2"
      >
        <span className={cn("absolute inset-y-2 left-0 w-1 rounded-full", rail[incident.severity])} />
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 line-clamp-2 text-sm font-semibold leading-snug tracking-tight text-fg">
            {incident.title}
          </h3>
          <time className="mt-0.5 shrink-0 font-mono text-xs font-semibold tabular-nums text-fg">
            {clockTime(incident.occurredAt)}
          </time>
        </div>
        {extra ? <p className="mt-0.5 line-clamp-1 text-sm text-muted">{extra}</p> : null}
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="shrink-0 uppercase tracking-wide text-subtle">{typeLabel(incident.type)}</span>
          <span className="text-subtle">·</span>
          <span className="min-w-0 truncate">{loc}</span>
          <Badge className="ml-auto shrink-0" tone={badge.tone}>
            {badge.label}
          </Badge>
        </p>
        {incident.seenOn && incident.seenOn.length > 1 ? (
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-subtle">
            <span className="shrink-0">Seen on:</span>
            {incident.seenOn.map((chip) => (
              <span
                key={chip.key}
                className="rounded-full border border-border bg-surface-2 px-1.5 py-0.5 font-medium text-muted"
              >
                {chip.label}
              </span>
            ))}
          </p>
        ) : incident.verification === "scanner" ? (
          <p className="mt-1 text-[11px] text-subtle">Unconfirmed radio — not a CAD call.</p>
        ) : null}
      </button>
      <div className="absolute right-1.5 top-1.5">
        <ShareButton payload={incidentSharePayload(incident)} label="Share incident" />
      </div>
    </div>
  );
}
