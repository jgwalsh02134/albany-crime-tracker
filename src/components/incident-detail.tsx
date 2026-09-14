import { ExternalLink, Map as MapIcon, X } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { kindLabel, verificationWhy } from "@/lib/sources";
import { clockTime, relativeTime, typeLabel } from "@/lib/format";
import { decodeHtmlEntities } from "@/lib/html";
import { incidentSharePayload } from "@/lib/share";
import { useAppStore } from "@/lib/store";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

function signalLabel(v: Incident["verification"]): string {
  if (v === "confirmed") return "Official";
  if (v === "scanner") return "Scanner (early)";
  return "Developing";
}

export function IncidentDetail({
  incident,
  variant = "drawer",
  onClose,
}: {
  incident: Incident;
  variant?: "drawer" | "panel";
  onClose?: () => void;
}) {
  const select = useAppStore((s) => s.selectIncident);
  const setView = useAppStore((s) => s.setView);
  const title = decodeHtmlEntities(incident.title);
  const description = decodeHtmlEntities(incident.description || "");

  return (
    <div className={cn(variant === "panel" ? "p-4" : "px-4 pb-8 pt-3")}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{typeLabel(incident.type)}</p>
          <p className="mt-0.5 font-mono text-xs tabular-nums text-subtle">
            {clockTime(incident.occurredAt)} · {relativeTime(incident.occurredAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={incident.severity}>{incident.severity}</Badge>
          {onClose ? (
            <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
              <X className="size-5" />
            </Button>
          ) : null}
        </div>
      </div>

      <h2 className={cn("mt-2 font-semibold leading-snug tracking-tight", variant === "panel" ? "text-lg" : "text-xl")}>
        {title}
      </h2>
      <p className="mt-1.5 text-sm text-muted">
        {incident.address}
        {incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
          ? ""
          : `, ${incident.municipality}`}
      </p>

      <p className="mt-4 text-sm leading-relaxed text-fg">{description}</p>

      {incident.origin === "live" &&
      incident.verification === "developing" &&
      incident.sources.some((s) => s.kind === "social") ? (
        <p className="mt-3 rounded-lg border border-sev-medium/30 bg-sev-medium/10 px-3 py-2 text-xs leading-relaxed text-muted">
          Citizen or social post — an early report, not a 911/CAD log. May be wrong.
        </p>
      ) : incident.origin === "live" && incident.verification === "developing" ? (
        <p className="mt-3 rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-2 text-xs leading-relaxed text-muted">
          Newsroom report — early signal without an official post in the mix yet. Open the source for the original story.
        </p>
      ) : incident.verification === "scanner" ? (
        <p className="mt-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-muted">
          Scanner traffic — early report, not a CAD log. May be wrong.
        </p>
      ) : (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
          {verificationWhy(incident)}
        </p>
      )}

      {incident.seenOn && incident.seenOn.length ? (
        <p className="mt-3 flex flex-wrap items-center gap-1 text-xs text-subtle">
          <span>Seen on:</span>
          {incident.seenOn.map((chip) => (
            <span
              key={chip.key}
              className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-medium text-muted"
            >
              {chip.label}
            </span>
          ))}
          {typeof incident.corroborationScore === "number" ? (
            <span className="ml-auto font-mono tabular-nums">{incident.corroborationScore}/100</span>
          ) : null}
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-subtle">Agency</dt>
          <dd className="mt-0.5 font-medium">{incident.agency}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-subtle">Status</dt>
          <dd className="mt-0.5 font-medium">{incident.disposition || incident.status}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-subtle">Verification</dt>
          <dd className="mt-0.5 font-medium">{signalLabel(incident.verification)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-subtle">Category</dt>
          <dd className="mt-0.5 font-medium capitalize">{incident.category}</dd>
        </div>
      </dl>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Sources</h3>
      <ul className="mt-2 space-y-1.5">
        {incident.sources.map((s) => {
          const inner = (
            <>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="text-xs text-subtle">
                  {kindLabel(s.kind)} · {s.tier}
                </p>
              </div>
              {s.url ? <ExternalLink className="size-4 shrink-0 text-subtle" /> : (
                <span className="font-mono text-xs text-subtle">{s.tier}</span>
              )}
            </>
          );
          return (
            <li key={`${s.kind}-${s.name}-${s.url ?? ""}`}>
              {s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2"
                >
                  {inner}
                </a>
              ) : (
                <div className="flex min-h-11 items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-5 flex gap-2">
        <ShareButton
          payload={incidentSharePayload(incident)}
          size="default"
          variant="secondary"
          label="Share"
          className="flex-1"
          stopPropagation={false}
        />
        <Button
          className="flex-1"
          onClick={() => {
            select(incident.id);
            setView("map");
          }}
        >
          <MapIcon className="size-4" />
          View on map
        </Button>
      </div>
    </div>
  );
}

