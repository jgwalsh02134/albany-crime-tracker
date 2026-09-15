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
import { isApproxPrecision } from "@/lib/geo";
import { isWitnessIncident } from "@/lib/witness";
import type { LiveWireItem } from "@/lib/sources";
import { buildIncidentThread } from "@/lib/incident-thread";

function signalLabel(incident: Incident): string {
  const v = incident.verification;
  if (v === "confirmed") return "Official";
  if (v === "scanner") return "Scanner (early)";
  if (isWitnessIncident(incident)) return "Unconfirmed";
  if (incident.sources.some((s) => s.kind === "social")) return "Unconfirmed";
  return "Developing";
}

function updateProvenance(u: ReturnType<typeof buildIncidentThread>[number]): {
  label: "Official" | "Scanner" | "Witness" | "Unconfirmed" | "Report";
  tone: "cyan" | "accent" | "medium" | "muted";
} {
  if (u.chip.key === "witness") return { label: "Witness", tone: "medium" };
  if (u.source.kind === "scanner" || u.chip.key === "scanner") return { label: "Scanner", tone: "accent" };
  if (u.tier === "official") return { label: "Official", tone: "cyan" };
  if (u.tier === "unconfirmed") return { label: "Unconfirmed", tone: "medium" };
  return { label: "Report", tone: "muted" };
}

export function IncidentDetail({
  incident,
  wireItems,
  variant = "drawer",
  onClose,
}: {
  incident: Incident;
  wireItems?: LiveWireItem[];
  variant?: "drawer" | "panel";
  onClose?: () => void;
}) {
  const select = useAppStore((s) => s.selectIncident);
  const setView = useAppStore((s) => s.setView);
  const title = decodeHtmlEntities(incident.title);
  const description = decodeHtmlEntities(incident.description || "");
  const witness = isWitnessIncident(incident);
  const approx = isApproxPrecision(incident.geoPrecision);
  const updates = buildIncidentThread(incident, wireItems);
  const latestUpdate = updates[0];
  const latestProv = latestUpdate ? updateProvenance(latestUpdate) : null;

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
      witness ? (
        <p className="mt-3 rounded-lg border border-sev-medium/30 bg-sev-medium/10 px-3 py-2 text-xs leading-relaxed text-muted">
          Witness report — an early signal, not a 911/CAD log. May be wrong.
          {" "}
          {approx ? "Location is approximate." : "Pinned location is user-provided."}
        </p>
      ) : incident.sources.some((s) => s.kind === "social") ? (
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
          <dd className="mt-0.5 font-medium">{signalLabel(incident)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-subtle">Category</dt>
          <dd className="mt-0.5 font-medium capitalize">{incident.category}</dd>
        </div>
      </dl>

      {updates.length ? (
        <div className="mt-5">
          <div className="rounded-xl border border-border bg-surface-2">
            <div className="rounded-t-xl border-b border-border bg-surface/95 px-4 py-2 shadow-sm backdrop-blur">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Updates</h3>
                  <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Latest
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle">
                  {updates.length} item{updates.length === 1 ? "" : "s"}
                </span>
              </div>

              {latestUpdate ? (() => {
                const latestTitle = decodeHtmlEntities(latestUpdate.title);
                const latestSummary = decodeHtmlEntities(latestUpdate.summary || "");
                const latestLine = latestTitle || (latestSummary && latestSummary !== latestTitle ? latestSummary : "");
                return (
                  <>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-snug text-muted">
                      {latestProv ? <Badge tone={latestProv.tone}>{latestProv.label}</Badge> : null}
                      <span className="rounded-full border border-border bg-surface px-2 py-0.5 font-medium text-muted">
                        {latestUpdate.chip.label}
                      </span>
                      <span className="text-subtle">·</span>
                      <span className="truncate">{latestUpdate.outlet}</span>
                      <span className="text-subtle">·</span>
                      <span className="font-mono tabular-nums text-subtle">
                        {clockTime(latestUpdate.publishedAt)} · {relativeTime(latestUpdate.publishedAt)}
                      </span>
                    </p>
                    {latestLine ? (
                      <p className="mt-1 line-clamp-1 text-sm font-semibold leading-snug text-fg">
                        {latestLine}
                      </p>
                    ) : null}
                  </>
                );
              })() : null}
            </div>

            <div
              className="max-h-[min(52dvh,28rem)] overflow-y-auto overscroll-y-contain px-4 py-2 scrollbar-thin"
              data-vaul-no-drag
            >
              <ol className="space-y-1.5">
              {updates.map((u, idx) => {
            const isLatest = idx === 0;
            const isFirstReport = idx === updates.length - 1;
            const time = `${clockTime(u.publishedAt)} · ${relativeTime(u.publishedAt)}`;
            const prov = updateProvenance(u);
            const title = decodeHtmlEntities(u.title);
            const summary = decodeHtmlEntities(u.summary || "");
            const excerpt = summary && summary !== title ? summary : "";
            const dot =
              prov.label === "Official"
                ? "bg-cyan"
                : prov.label === "Scanner"
                  ? "bg-accent"
                  : prov.label === "Witness" || prov.label === "Unconfirmed"
                    ? "bg-sev-medium"
                    : "bg-border";
            const body = (
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={prov.tone}>{prov.label}</Badge>
                  <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
                    {u.chip.label}
                  </span>
                  <span className="text-subtle">·</span>
                  <span className="truncate text-[11px] font-medium text-muted">{u.outlet}</span>
                  <span className="ml-auto font-mono text-[11px] tabular-nums text-subtle">{time}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-fg">{title}</p>
                {excerpt ? <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{excerpt}</p> : null}
                {isLatest || isFirstReport ? (
                  <p className="mt-1 text-[11px] font-semibold text-subtle">
                    {isLatest ? "latest" : "first report"}
                  </p>
                ) : null}
              </div>
            );
            return (
              <li key={u.memberId}>
                <div className="relative">
                  {idx !== updates.length - 1 ? (
                    <span
                      className="absolute left-[7px] top-4 h-[calc(100%-0.75rem)] w-px bg-border"
                      aria-hidden
                    />
                  ) : null}
                  <span className={cn("absolute left-[4px] top-3.5 size-2 rounded-full", dot)} aria-hidden />
                  {u.url ? (
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-5 flex items-start justify-between gap-3 rounded-md bg-surface-2 px-3 py-2 active:opacity-90"
                    >
                      {body}
                      <ExternalLink className="mt-1 size-4 shrink-0 text-subtle" />
                    </a>
                  ) : (
                    <div className="ml-5 flex items-start justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
                      {body}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
              </ol>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Updates</h3>
          <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
            No fused updates are available for this incident in the current refresh.
          </p>
        </div>
      )}

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

