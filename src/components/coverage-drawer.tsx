import { Drawer } from "vaul";
import { EyeOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { coverageSummary, type CoverageTone } from "@/lib/coverage";
import type { WireHealth } from "@/lib/sources";
import { cn } from "@/lib/utils";

export function CoverageDrawer({
  open,
  onOpenChange,
  health,
  colonieFocused = false,
  mapToggle,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  health: WireHealth | null | undefined;
  colonieFocused?: boolean;
  mapToggle?: { on: boolean; setOn: (v: boolean) => void };
}) {
  const summary = coverageSummary({ health, colonieFocused });

  const toneBadge = (tone: CoverageTone) => {
    if (tone === "down") return { dot: "bg-rose-500", wrap: "border-rose-500/30 bg-rose-500/10 text-fg" };
    if (tone === "warn") return { dot: "bg-amber-500", wrap: "border-amber-500/30 bg-amber-500/10 text-fg" };
    if (tone === "ok") return { dot: "bg-emerald-500", wrap: "border-emerald-500/30 bg-emerald-500/10 text-fg" };
    return { dot: "bg-border", wrap: "border-border bg-surface-2 text-muted" };
  };

  const top = toneBadge(summary.tone);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
          <div className="overflow-y-auto px-4 pb-8 pt-3 scrollbar-thin">
            <Drawer.Title className="flex items-center justify-between gap-2 text-base font-semibold">
              <span className="inline-flex items-center gap-2">
                <ShieldAlert className="size-4 text-accent" aria-hidden />
                Coverage
              </span>
              <span className={cn("shrink-0 rounded-full border px-2 py-1 text-[11px] font-semibold", top.wrap)}>
                <span className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", top.dot)} aria-hidden />
                {summary.shortLabel}
              </span>
            </Drawer.Title>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              This is a reporting map — not a CAD feed. When sources are missing, treat empty space as a <span className="font-semibold text-fg">coverage gap</span>, not “all clear.”
            </p>

            {mapToggle ? (
              <div className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={mapToggle.on}
                    onChange={() => mapToggle.setOn(!mapToggle.on)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-fg">Show coverage overlay on the map</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      Shades known blind spots and highlights live pipe outages.
                    </span>
                  </span>
                  <EyeOff className="size-4 text-subtle" aria-hidden />
                </label>
              </div>
            ) : null}

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Known blind spots</h3>
            <ul className="mt-2 space-y-2">
              {summary.flags
                .filter((f) => f.kind === "static")
                .map((f) => (
                  <li key={f.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                    <p className="text-sm font-medium text-fg">{f.label}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{f.detail}</p>
                  </li>
                ))}
            </ul>

            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Right now</h3>
            <ul className="mt-2 space-y-2">
              {summary.flags
                .filter((f) => f.kind === "dynamic")
                .map((f) => {
                  const t = toneBadge(f.tone);
                  return (
                    <li key={f.id} className={cn("rounded-lg border px-3 py-2", t.wrap)}>
                      <p className="text-sm font-medium">
                        <span className={cn("mr-2 inline-block size-2 rounded-full align-middle", t.dot)} aria-hidden />
                        {f.label}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">{f.detail}</p>
                    </li>
                  );
                })}
              {summary.flags.filter((f) => f.kind === "dynamic").length === 0 ? (
                <li className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                  No active pipe warnings detected on this refresh.
                </li>
              ) : null}
            </ul>

            <div className="mt-6 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

