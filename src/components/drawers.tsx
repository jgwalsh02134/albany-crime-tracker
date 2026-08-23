import type { ReactNode } from "react";
import { Drawer } from "vaul";
import { ExternalLink, Map as MapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { kindLabel, SOURCE_LENSES, verificationWhy } from "@/lib/sources";
import { MUNICIPALITIES, SEVERITIES, type Severity, type ViewId } from "@/lib/types";
import { clockTime, relativeTime, typeLabel } from "@/lib/format";
import { useAppStore } from "@/lib/store";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

function SheetFrame({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export function FilterDrawer() {
  const open = useAppStore((s) => s.filterOpen);
  const setOpen = useAppStore((s) => s.setFilterOpen);
  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const setSeverities = useAppStore((s) => s.setSeverities);
  const setMunicipalities = useAppStore((s) => s.setMunicipalities);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const setSourceLens = useAppStore((s) => s.setSourceLens);
  const reset = useAppStore((s) => s.resetFilters);

  function toggleSev(s: Severity) {
    setSeverities(
      severities.includes(s) ? severities.filter((x) => x !== s) : [...severities, s],
    );
  }
  function toggleMuni(m: string) {
    setMunicipalities(
      municipalities.includes(m) ? municipalities.filter((x) => x !== m) : [...municipalities, m],
    );
  }

  return (
    <SheetFrame open={open} onOpenChange={setOpen}>
      <div className="overflow-y-auto px-4 pb-8 pt-3 scrollbar-thin">
        <Drawer.Title className="text-base font-semibold">Filter incidents</Drawer.Title>
        <p className="mt-1 text-xs text-subtle">Severity, municipality, and source. Applied instantly.</p>

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Severity</h3>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {SEVERITIES.map((s) => (
            <label
              key={s}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm capitalize",
                severities.includes(s) ? "border-accent/50 bg-surface-2" : "border-border",
              )}
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={severities.includes(s)}
                onChange={() => toggleSev(s)}
              />
              {s}
            </label>
          ))}
        </div>

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Source</h3>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {SOURCE_LENSES.map((lens) => (
            <button
              key={lens.id}
              type="button"
              onClick={() => setSourceLens(lens.id)}
              className={cn(
                "flex min-h-11 items-center justify-center rounded-md border px-3 text-sm font-medium",
                sourceLens === lens.id ? "border-accent/50 bg-surface-2" : "border-border",
              )}
            >
              {lens.label}
            </button>
          ))}
        </div>

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">
          Municipality
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MUNICIPALITIES.map((m) => (
            <label
              key={m}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                municipalities.includes(m) ? "border-accent/50 bg-surface-2" : "border-border",
              )}
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={municipalities.includes(m)}
                onChange={() => toggleMuni(m)}
              />
              {m}
            </label>
          ))}
        </div>

        <div className="mt-6 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={reset}>
            Reset
          </Button>
          <Button className="flex-1" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </SheetFrame>
  );
}

export function IncidentDrawer({ incident }: { incident: Incident | null }) {
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.selectIncident);
  const setView = useAppStore((s) => s.setView);

  return (
    <SheetFrame open={!!selectedId} onOpenChange={(o) => !o && select(null)}>
      {incident ? (
        <div className="overflow-y-auto px-4 pb-8 pt-3 scrollbar-thin">
          <div className="flex items-center justify-between gap-2">
            <Drawer.Title className="text-xs font-semibold uppercase tracking-wide text-subtle">
              {typeLabel(incident.type)}
            </Drawer.Title>
            <Badge tone={incident.severity}>{incident.severity}</Badge>
          </div>
          <h2 className="mt-2 text-xl font-semibold leading-snug tracking-tight">{incident.title}</h2>
          <p className="mt-1.5 text-sm text-muted">
            {incident.address}, {incident.municipality}
          </p>
          <p className="mt-0.5 font-mono text-xs tabular-nums text-subtle">
            {clockTime(incident.occurredAt)} · {relativeTime(incident.occurredAt)}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted">{incident.description}</p>
          {incident.origin === "live" ? (
            <p className="mt-3 rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-2 text-xs leading-relaxed text-muted">
              Newsroom report — not a confirmed police CAD call. Open the source for the original story.
            </p>
          ) : (
            <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
              {verificationWhy(incident)}
            </p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-subtle">Agency</dt>
              <dd className="mt-0.5 font-medium">{incident.agency}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-subtle">Status</dt>
              <dd className="mt-0.5 font-medium capitalize">{incident.status}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-subtle">Verification</dt>
              <dd className="mt-0.5 font-medium capitalize">{incident.verification}</dd>
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
      ) : null}
    </SheetFrame>
  );
}

const MORE_ITEMS: { view: ViewId; label: string; hint: string }[] = [
  { view: "chat", label: "AI assistant", hint: "Ask about the last 48 hours" },
  { view: "more", label: "Trends", hint: "Last 24 hours from newsrooms · FBI / DCJS links" },
];

export function MoreDrawer() {
  const open = useAppStore((s) => s.moreOpen);
  const setOpen = useAppStore((s) => s.setMoreOpen);
  const setView = useAppStore((s) => s.setView);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const theme = useAppStore((s) => s.theme);

  return (
    <SheetFrame open={open} onOpenChange={setOpen}>
      <div className="px-4 pb-8 pt-3">
        <Drawer.Title className="text-base font-semibold">More</Drawer.Title>
        <div className="mt-3 flex flex-col gap-1.5">
          {MORE_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="flex min-h-12 items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-3 text-left"
              onClick={() => setView(item.view)}
            >
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-subtle">{item.hint}</span>
              </span>
            </button>
          ))}
          <button
            type="button"
            className="flex min-h-12 items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-3 text-left"
            onClick={toggleTheme}
          >
            <span>
              <span className="block text-sm font-medium">Theme</span>
              <span className="block text-xs text-subtle">
                {theme === "dark" ? "Dark (navy)" : "Light"}
              </span>
            </span>
          </button>
          <a
            href="https://nibrs.fbi.gov/2024/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-12 items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-3 text-sm"
          >
            FBI / NIBRS resources
            <ExternalLink className="size-4 text-subtle" />
          </a>
        </div>
      </div>
    </SheetFrame>
  );
}
