import { useRef, useState } from "react";
import { Drawer } from "vaul";
import { IncidentCard } from "@/components/incident-card";
import { NewsView } from "@/components/views/news-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { areaCounts } from "@/lib/data";
import { compactFromMinutes, minutesSinceNy7am } from "@/lib/format";
import { submitCitizenTip } from "@/lib/social-sources";
import { type LiveWireItem, type WireHealth, sourceMix } from "@/lib/sources";
import { incidentVisible, useAppStore } from "@/lib/store";
import type { Incident, NewsStory, SourceLens } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FeedView({
  incidents,
  news,
  wire,
  wireLive,
  wireOutlets = [],
  wireHealth = null,
  refreshing = false,
  onRefresh,
}: {
  incidents: Incident[];
  news: NewsStory[];
  wire: LiveWireItem[];
  wireLive: boolean;
  wireOutlets?: string[];
  wireHealth?: WireHealth | null;
  refreshing?: boolean;
  onRefresh?: () => Promise<void> | void;
}) {
  const homeMode = useAppStore((s) => s.homeMode);
  const setHomeMode = useAppStore((s) => s.setHomeMode);
  const select = useAppStore((s) => s.selectIncident);
  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const setAreaFilter = useAppStore((s) => s.setAreaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const setSourceLens = useAppStore((s) => s.setSourceLens);

  const visible = incidents.filter((i) =>
    incidentVisible(i, { severities, municipalities, areaFilter, sourceLens }),
  );
  const areaVisible = incidents.filter((i) =>
    incidentVisible(i, { severities, municipalities, areaFilter, sourceLens: "all" }),
  );
  const liveAll = areaVisible.filter((i) => i.origin === "live");
  const areas = areaCounts(liveAll);
  const liveItems = visible.filter((i) => i.origin === "live");
  const newest = liveItems.reduce<Incident | undefined>((best, row) => {
    if (!best || row.minutesAgo < best.minutesAgo) return row;
    return best;
  }, undefined);
  const mix = sourceMix(liveAll);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pb-1.5 pt-2">
        <div className="grid grid-cols-2 rounded-full bg-surface-2 p-1">
          {(["live", "news"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setHomeMode(mode)}
              className={cn(
                "h-10 rounded-full text-sm font-semibold capitalize transition-colors duration-150",
                homeMode === mode ? "bg-surface text-fg shadow-sm" : "text-subtle",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {homeMode === "live" ? (
        <LiveList
          liveItems={liveItems}
          dayCount={liveAll.length}
          areas={areas}
          areaFilter={areaFilter}
          setAreaFilter={setAreaFilter}
          sourceLens={sourceLens}
          setSourceLens={setSourceLens}
          mix={mix}
          newest={newest}
          wireLive={wireLive}
          wireOutlets={wireOutlets}
          wireHealth={wireHealth}
          onSelect={select}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-6 pt-2 scrollbar-thin">
          <NewsView stories={news} />
        </div>
      )}
    </div>
  );
}

function LiveList({
  liveItems,
  dayCount,
  areas,
  areaFilter,
  setAreaFilter,
  sourceLens,
  setSourceLens,
  mix,
  newest,
  wireLive,
  wireOutlets,
  wireHealth,
  onSelect,
  refreshing,
  onRefresh,
}: {
  liveItems: Incident[];
  dayCount: number;
  areas: { name: string; count: number }[];
  areaFilter: string;
  setAreaFilter: (a: string | "all") => void;
  sourceLens: SourceLens;
  setSourceLens: (s: SourceLens) => void;
  mix: { official: number; scanner: number; news: number; social: number };
  newest?: Incident;
  wireLive: boolean;
  wireOutlets: string[];
  wireHealth: WireHealth | null;
  onSelect: (id: string) => void;
  refreshing: boolean;
  onRefresh?: () => Promise<void> | void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);

  function onTouchStart(e: React.TouchEvent) {
    if (!scroller.current || scroller.current.scrollTop > 0) {
      startY.current = null;
      return;
    }
    startY.current = e.touches[0]!.clientY;
  }
  function onTouchMove(e: React.TouchEvent) {
    if (startY.current == null || !scroller.current || scroller.current.scrollTop > 0) return;
    const dy = e.touches[0]!.clientY - startY.current;
    setPull(dy > 0 ? Math.min(72, dy) : 0);
  }
  async function onTouchEnd() {
    const should = pull > 52 && onRefresh;
    startY.current = null;
    setPull(0);
    if (should) await onRefresh();
  }

  return (
    <div
      ref={scroller}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => void onTouchEnd()}
      className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-6 scrollbar-thin"
    >
      <div
        className="overflow-hidden text-center text-xs text-subtle transition-[height] duration-150"
        style={{ height: refreshing || pull > 8 ? 28 : 0 }}
      >
        <p className="pt-1.5">{refreshing ? "Updating…" : pull > 52 ? "Release to refresh" : "Pull to refresh"}</p>
      </div>

      <div className="flex items-center justify-between gap-2 py-2">
        <p className="min-w-0 truncate text-xs text-subtle">
          <span className="font-semibold text-fg">{liveItems.length}</span>
          {wireLive ? " calls" : " · connecting…"}
        </p>
        <p className="shrink-0 font-mono text-xs tabular-nums text-subtle">
          {newest ? compactFromMinutes(newest.minutesAgo) : "—"}
        </p>
      </div>
      <p className="pb-2 text-xs leading-snug text-subtle">
        {wireLive && newest && newest.minutesAgo >= 180
          ? "NYSP’s blotter last posted at 7 AM ET. Radio, Facebook, civic alerts, citizen reports, and 511 fill the hours since — city CAD is not public."
          : wireLive && wireHealth && wireHealth.blotter === 0 && wireHealth.blotterFailed > 0
            ? "NYSP’s daily blotter is delayed. Radio, department Facebook, civic alerts, and newsrooms still update — this is not a city CAD dump."
            : "NYSP’s last 24-hour report (through 7 AM ET), plus radio, 511, department Facebook, civic alerts, citizen reports, and breaking crime. City CAD is not public."}
        {wireOutlets.length ? ` · ${wireOutlets.slice(0, 5).join(" · ")}` : ""}
      </p>

      {wireHealth ? <SourcePipes health={wireHealth} /> : null}

      <div className="sticky top-0 z-10 -mx-3 mb-3 bg-bg/90 px-3 py-1.5 backdrop-blur-md">
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain scrollbar-none snap-x">
          <Chip
            active={sourceLens === "all"}
            onClick={() => setSourceLens("all")}
            label={`All · ${mix.official + mix.scanner + mix.news + mix.social}`}
          />
          <Chip
            active={sourceLens === "official"}
            onClick={() => setSourceLens("official")}
            label={`Official · ${mix.official}`}
          />
          <Chip
            active={sourceLens === "scanner"}
            onClick={() => setSourceLens("scanner")}
            label={`Scanner · ${mix.scanner}`}
          />
          <Chip
            active={sourceLens === "news"}
            onClick={() => setSourceLens("news")}
            label={`News · ${mix.news}`}
          />
          <Chip
            active={sourceLens === "social"}
            onClick={() => setSourceLens("social")}
            label={`Social · ${mix.social}`}
          />
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain scrollbar-none snap-x">
          <Chip
            active={areaFilter === "all"}
            onClick={() => setAreaFilter("all")}
            label={`Capital District · ${dayCount}`}
          />
          {areas.map((a) => (
            <Chip
              key={a.name}
              active={areaFilter === a.name}
              onClick={() => setAreaFilter(a.name)}
              label={`${a.name} · ${a.count}`}
            />
          ))}
        </div>
      </div>

      {wireLive ? (
        <ReportButton onRefresh={onRefresh} />
      ) : null}

      {liveItems.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-4 py-12 text-center text-sm text-muted">
          {wireLive
            ? "No matching activity. NYSP posts the daily blotter at 7 AM ET; radio, Facebook, and citizen reports cover the hours since."
            : "Pulling NYSP blotter, scanner, 511, Facebook, and newsrooms…"}
        </p>
      ) : (
        <GroupedList items={liveItems} onSelect={onSelect} />
      )}
    </div>
  );
}

function GroupedList({
  items,
  onSelect,
}: {
  items: Incident[];
  onSelect: (id: string) => void;
}) {
  const since7 = minutesSinceNy7am();
  const nowItems = items.filter((i) => i.minutesAgo <= 180);
  const today = items.filter((i) => i.minutesAgo > 180 && i.minutesAgo <= since7);
  const overnight = items.filter((i) => i.minutesAgo > since7);
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Last 3 hours</h2>
        {nowItems.length ? (
          <ul className="flex flex-col gap-2.5">
            {nowItems.map((inc) => (
              <li key={inc.id}>
                <IncidentCard incident={inc} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
            No radio, 511, social, or breaking news in the last 3 hours. NYSP’s next official blotter posts at 7 AM.
          </p>
        )}
      </section>
      {today.length ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Since 7 AM</h2>
          <ul className="flex flex-col gap-2.5">
            {today.map((inc) => (
              <li key={inc.id}>
                <IncidentCard incident={inc} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {overnight.length ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">
            NYSP overnight report
          </h2>
          <ul className="flex flex-col gap-2.5">
            {overnight.map((inc) => (
              <li key={inc.id}>
                <IncidentCard incident={inc} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-10 shrink-0 snap-start rounded-full border px-3.5 text-sm font-medium active:opacity-80",
        active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
      )}
    >
      {label}
    </button>
  );
}

function SourcePipes({ health }: { health: WireHealth }) {
  const [open, setOpen] = useState(false);
  const pipes: { label: string; n: number }[] = [
    { label: "Blotter", n: health.blotter },
    { label: "Radio", n: health.scanner },
    { label: "511", n: health.traffic },
    { label: "Facebook", n: health.facebook ?? 0 },
    { label: "News", n: health.news },
    { label: "Civic", n: health.civic ?? 0 },
    { label: "Citizens", n: (health.reddit ?? 0) + (health.citizen ?? 0) },
    { label: "NWS", n: health.nws ?? 0 },
  ];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-left"
      >
        <div className="grid grid-cols-4 gap-1.5">
          {pipes.map((p) => (
            <div key={p.label} className="min-w-0">
              <p className="font-mono text-sm font-semibold tabular-nums text-fg">{p.n}</p>
              <p className="truncate text-[10px] uppercase tracking-wide text-subtle">{p.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs leading-snug text-muted">
          {health.traffic === 0
            ? "511 has no Capital District crashes posted. City CAD is not public. Tap for the source map."
            : "Tap for what is feeding Live — and what is blocked."}
        </p>
      </button>
      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
            <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
            <div className="overflow-y-auto px-4 pb-8 pt-3 scrollbar-thin">
              <Drawer.Title className="text-base font-semibold">Live source map</Drawer.Title>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Albany, Colonie, and Bethlehem do not publish live CAD. Counts below are what this refresh actually pulled.
              </p>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Wired this refresh</h3>
              <ul className="mt-2 space-y-2">
                {[
                  ["NYSP blotter", health.blotter, "Official 7 AM dump. Not a live dispatch board."],
                  ["Radio captions", health.scanner, "Albany/Colonie PD, Bethlehem PD/Fire/EMS, Albany Fire, volunteer fire. Unconfirmed."],
                  ["511NY crashes", health.traffic, "Capital District accidents only. Construction is ignored."],
                  ["Department Facebook", health.facebook ?? 0, "APD, Colonie, Bethlehem, Cohoes, Watervliet, Guilderland."],
                  ["X", health.x ?? 0, "NYSP, Albany Fire, CBS6, NEWS10, Times Union when they tweet crime."],
                  ["Town civic", health.civic ?? 0, "Bethlehem / Guilderland / Albany news flashes — crashes and arrests only."],
                  ["Newsrooms", health.news, "News10, CBS6, WNYT, WAMC, Patch, Times Union, Spotlight, Gazette, FOX23."],
                  ["Citizens", (health.reddit ?? 0) + (health.citizen ?? 0), "Reddit r/Albany, r/Troy, r/Schenectady and in-app reports. Not 911."],
                  ["NWS warnings", health.nws ?? 0, "Tornado, flash flood, severe thunderstorm, blizzard. Not routine weather."],
                ].map(([name, n, why]) => (
                  <li key={String(name)} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{name}</p>
                      <p className="font-mono text-sm tabular-nums">{n}</p>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{why}</p>
                  </li>
                ))}
              </ul>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Tried and blocked</h3>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
                <li>
                  <span className="font-medium text-fg">Live CAD / CFS</span> — Albany, Colonie, and Bethlehem do not publish a dispatch board. City open-data host is dead.
                </li>
                <li>
                  <span className="font-medium text-fg">PulsePoint</span> — Albany NY is not on PulsePoint. API returns 401.
                </li>
                <li>
                  <span className="font-medium text-fg">OpenMHz</span> — albanycony is live in a browser, Cloudflare 403 to servers.
                </li>
                <li>
                  <span className="font-medium text-fg">Nixle / NY-Alert</span> — login wall. APD Alert Center RSS is empty until the city posts.
                </li>
                <li>
                  <span className="font-medium text-fg">SpotCrime / CrimeMapping / RAIDS</span> — no public JSON. SpotCrime API 403.
                </li>
                <li>
                  <span className="font-medium text-fg">Citizen App, Ring, Nextdoor, Waze</span> — no public feed.
                </li>
                <li>
                  <span className="font-medium text-fg">Meta Graph / Instagram</span> — needs an app review token. We index public Facebook posts via Google instead.
                </li>
                <li>
                  <span className="font-medium text-fg">X PD accounts</span> — APD last posted Jan 2025. Colonie tells people to use Facebook.
                </li>
                <li>
                  <span className="font-medium text-fg">Jail bookings / FOIL CAD</span> — not a live stream. DCJS and FBI NIBRS are annual, on Trends.
                </li>
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-subtle">
                511 construction, CDTA notices, and hiring posts are fetched then dropped so Live stays public-safety.
              </p>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}

const NATURES = [
  { id: "crash", label: "Crash" },
  { id: "fire", label: "Fire" },
  { id: "police", label: "Police activity" },
  { id: "shots", label: "Shots fired" },
  { id: "other", label: "Other" },
] as const;

function ReportButton({ onRefresh }: { onRefresh?: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [nature, setNature] = useState<(typeof NATURES)[number]["id"]>("police");
  const [where, setWhere] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await submitCitizenTip({ data: { nature, where, details } });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setWhere("");
      setDetails("");
      setOpen(false);
      await onRefresh?.();
    } catch {
      setError("Could not post that report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 flex min-h-11 w-full items-center justify-center rounded-xl border border-dashed border-border bg-surface px-3 text-sm font-medium text-muted active:bg-surface-2"
      >
        Saw something — report it
      </button>
      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 outline-none">
            <div className="mx-auto h-1.5 w-12 rounded-full bg-border" />
            <Drawer.Title className="mt-3 text-base font-semibold">Report what you see</Drawer.Title>
            <p className="mt-1 text-xs leading-relaxed text-subtle">
              Call 911 for emergencies. This is not a police report — it is an unconfirmed citizen note on Live.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {NATURES.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setNature(n.id)}
                  className={cn(
                    "h-10 rounded-full border px-3 text-sm font-medium",
                    nature === n.id ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2 text-muted",
                  )}
                >
                  {n.label}
                </button>
              ))}
            </div>
            <label className="mt-3 text-xs font-semibold uppercase tracking-wide text-subtle">
              Street or intersection
              <Input
                className="mt-1"
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                placeholder="Western Ave & Quail"
                maxLength={80}
              />
            </label>
            <label className="mt-3 text-xs font-semibold uppercase tracking-wide text-subtle">
              Details (optional)
              <textarea
                className="mt-1 min-h-20 w-full rounded-md border border-border bg-surface px-3 py-2 text-base text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="What you saw — no names of victims."
                maxLength={280}
              />
            </label>
            {error ? <p className="mt-2 text-sm text-sev-high">{error}</p> : null}
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button className="flex-1" disabled={busy} onClick={() => void submit()}>
                {busy ? "Posting…" : "Post to Live"}
              </Button>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
