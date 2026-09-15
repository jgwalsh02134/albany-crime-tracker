import { useEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "vaul";
import { Bell, ChevronRight, LocateFixed, Megaphone, ShieldAlert, SlidersHorizontal } from "lucide-react";
import { CoverageDrawer } from "@/components/coverage-drawer";
import { IncidentCard } from "@/components/incident-card";
import { IncidentDetail } from "@/components/incident-detail";
import { NearbyAlertsCard } from "@/components/nearby-alerts-card";
import { NewsView } from "@/components/views/news-view";
import { coverageSummary } from "@/lib/coverage";
import { compactFromMinutes, minutesSinceNy7am } from "@/lib/format";
import { type WireHealth, sourceMix } from "@/lib/sources";
import { liveWindowHonesty } from "@/lib/live-honesty";
import { incidentVisible, useAppStore } from "@/lib/store";
import { compareNowLaneWithContext, nowUrgencyScore } from "@/lib/live-rank";
import { haversineKm } from "@/lib/geo";
import { selectNearMeEmptyState, type LocateErrorKind, type NearMePos } from "@/lib/near-me-empty-state";
import type { Incident, NewsStory, SourceLens, LiveKind } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FeedView({
  incidents,
  news,
  wireItems,
  wireLive,
  wireHealth = null,
  refreshing = false,
  onRefresh,
}: {
  incidents: Incident[];
  news: NewsStory[];
  wireItems?: import("@/lib/sources").LiveWireItem[];
  wireLive: boolean;
  wireHealth?: WireHealth | null;
  refreshing?: boolean;
  onRefresh?: () => Promise<void> | void;
}) {
  const homeMode = useAppStore((s) => s.homeMode);
  const setHomeMode = useAppStore((s) => s.setHomeMode);
  const select = useAppStore((s) => s.selectIncident);
  const selectedId = useAppStore((s) => s.selectedId);
  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const setSourceLens = useAppStore((s) => s.setSourceLens);
  const liveKind = useAppStore((s) => s.liveKind);
  const setLiveKind = useAppStore((s) => s.setLiveKind);

  const visible = incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens }));
  const liveAll = incidents.filter(
    (i) => i.origin === "live" && incidentVisible(i, { severities, municipalities, areaFilter, sourceLens: "all" }),
  );
  const liveItems = visible.filter((i) => i.origin === "live" && matchesLiveKind(i, liveKind));
  const newest = liveItems.reduce<Incident | undefined>((best, row) => {
    if (!best || row.minutesAgo < best.minutesAgo) return row;
    return best;
  }, undefined);
  const mix = sourceMix(liveAll);
  const selected = selectedId ? incidents.find((i) => i.id === selectedId) ?? null : null;
  const colonieFocused =
    areaFilter === "Colonie" || (municipalities.length === 1 && municipalities[0] === "Colonie");

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
      <div className="shrink-0 px-3 pt-1.5">
        <div className="grid grid-cols-2 rounded-full bg-surface-2 p-0.5">
          {(["live", "news"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setHomeMode(mode)}
              className={cn(
                "h-10 rounded-full text-sm font-semibold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                homeMode === mode ? "bg-surface text-fg shadow-sm" : "text-subtle",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {homeMode === "live" ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="flex min-h-0 flex-1 flex-col lg:max-w-lg xl:max-w-xl">
              <LiveList
                liveItems={liveItems}
                liveKind={liveKind}
                setLiveKind={setLiveKind}
                sourceLens={sourceLens}
                setSourceLens={setSourceLens}
                mix={mix}
                newest={newest}
                wireLive={wireLive}
                wireHealth={wireHealth}
                onSelect={select}
                refreshing={refreshing}
                onRefresh={onRefresh}
                colonieFocused={colonieFocused}
              />
            </div>
            <aside className="hidden min-h-0 flex-1 flex-col border-l border-border bg-bg lg:flex">
              {selected ? (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain scrollbar-thin">
                  <IncidentDetail incident={selected} wireItems={wireItems} variant="panel" onClose={() => select(null)} />
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted">
                  Select an incident to see details.
                </div>
              )}
            </aside>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-6 pt-2 scrollbar-thin">
          <NewsView stories={news} />
        </div>
      )}
    </div>
  );
}

function matchesLiveKind(inc: Incident, kind: LiveKind): boolean {
  if (kind === "all") return true;
  const t = inc.type.toLowerCase();
  const title = inc.title.toLowerCase();
  const desc = (inc.description || "").toLowerCase();
  const hay = `${title} ${desc} ${inc.address.toLowerCase()} ${inc.municipality.toLowerCase()}`;
  const has = (re: RegExp) => re.test(hay);

  if (kind === "fire") {
    return t === "fire" || has(/\b(fire|blaze|smoke|alarm|structure fire|vehicle fire|brush fire|ems|ambulance)\b/i);
  }
  if (kind === "crash") {
    return t === "crash" || t === "dwi" || t === "disabled-vehicle" || has(/\b(crash|collision|hit[- ]and[- ]run|rollover|vehicle.*into|pedestrian struck|fatal crash)\b/i);
  }
  if (kind === "traffic") {
    const officialTraffic = inc.sources.some((s) => s.kind === "cfs") || has(/\b(road closed|lane closure|lanes blocked|traffic alert|disabled vehicle|thruway|northway|i-?87|i-?90|i-?787)\b/i);
    return officialTraffic || t === "crash" || t === "disabled-vehicle";
  }
  // crime
  if (inc.category === "violent" || inc.category === "property") return true;
  return (
    t === "shots-fired" ||
    t === "assault" ||
    t === "robbery" ||
    t === "domestic" ||
    t === "burglary" ||
    t === "larceny" ||
    t === "arrest" ||
    t === "drugs" ||
    t === "trespass" ||
    has(/\b(shooting|shots fired|stab|stabbing|robbery|burglary|assault|arrest|charged|wanted|gun|weapon|homicide|larceny)\b/i)
  );
}

function LiveList({
  liveItems,
  liveKind,
  setLiveKind,
  sourceLens,
  setSourceLens,
  mix,
  newest,
  wireLive,
  wireHealth,
  onSelect,
  refreshing,
  onRefresh,
  colonieFocused: colonieFocusedProp,
}: {
  liveItems: Incident[];
  liveKind: LiveKind;
  setLiveKind: (k: LiveKind) => void;
  sourceLens: SourceLens;
  setSourceLens: (s: SourceLens) => void;
  mix: { official: number; scanner: number; news: number; social: number };
  newest?: Incident;
  wireLive: boolean;
  wireHealth: WireHealth | null;
  onSelect: (id: string) => void;
  refreshing: boolean;
  onRefresh?: () => Promise<void> | void;
  colonieFocused: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const liveNearMe = useAppStore((s) => s.liveNearMe);
  const setLiveNearMe = useAppStore((s) => s.setLiveNearMe);
  const liveNearMiles = useAppStore((s) => s.liveNearMiles);
  const setLiveNearMiles = useAppStore((s) => s.setLiveNearMiles);
  const setWitnessOpen = useAppStore((s) => s.setWitnessOpen);
  const [pos, setPos] = useState<NearMePos | null>(null);
  const [locateErr, setLocateErr] = useState<string>("");
  const [locateErrorKind, setLocateErrorKind] = useState<LocateErrorKind | null>(null);
  const colonieNear =
    liveNearMe && pos
      ? haversineKm({ lat: pos.lat, lng: pos.lng }, { lat: 42.7179, lng: -73.8373 }) <= 10
      : false;
  const colonieFocused = colonieFocusedProp || colonieNear;
  const [coverageOpen, setCoverageOpen] = useState(false);
  const coverage = useMemo(
    () => coverageSummary({ health: wireHealth, colonieFocused }),
    [wireHealth, colonieFocused],
  );

  const coverageDot =
    coverage.tone === "down"
      ? "bg-rose-500"
      : coverage.tone === "warn"
        ? "bg-amber-500"
        : coverage.tone === "ok"
          ? "bg-emerald-500"
          : "bg-border";

  function requestLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocateErr("Location isn’t available in this browser.");
      setLocateErrorKind("unavailable");
      return;
    }
    setLocateErr("");
    setLocateErrorKind(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accM: p.coords.accuracy || 0, at: Date.now() });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setLocateErr("Location permission denied.");
          setLocateErrorKind("denied");
        } else {
          setLocateErr("Couldn’t fetch your location.");
          setLocateErrorKind("unavailable");
        }
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 60_000 },
    );
  }

  useEffect(() => {
    if (!liveNearMe) return;
    if (!pos || Date.now() - pos.at > 5 * 60_000) requestLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveNearMe]);

  const nearKm = liveNearMiles * 1.60934;
  const withinNear =
    liveNearMe && pos
      ? liveItems.filter((i) => haversineKm({ lat: pos.lat, lng: pos.lng }, { lat: i.lat, lng: i.lng }) <= nearKm)
      : liveNearMe
        ? []
        : liveItems;
  const showing = withinNear;
  const nearActive = liveNearMe;
  const nearEmptyState = selectNearMeEmptyState({ nearActive, pos, locateErrorKind });

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={() => void onTouchEnd()}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-24 scrollbar-thin"
      >
        <div
          className="overflow-hidden text-center text-xs text-subtle motion-safe:transition-[height] motion-safe:duration-150 motion-reduce:transition-none"
          style={{ height: refreshing || pull > 8 ? 28 : 0 }}
        >
          <p className="pt-1.5">{refreshing ? "Updating…" : pull > 52 ? "Release to refresh" : "Pull to refresh"}</p>
        </div>

        <div className="sticky top-0 z-10 -mx-3 mb-1.5 bg-bg/95 px-3 py-1 backdrop-blur-md">
          {/* Mobile: minimal chrome; everything else behind Filters sheet */}
          <div className="lg:hidden">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                {wireHealth ? (
                  <SourcePipes
                    health={wireHealth}
                    count={showing.length}
                    newest={newest}
                    wireLive={wireLive}
                    compact
                  />
                ) : (
                  <p className="py-1.5 text-xs text-subtle">{wireLive ? `${showing.length} calls` : "Connecting…"}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1" data-vaul-no-drag>
                <button
                  type="button"
                  onClick={() => setFiltersOpen(true)}
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-3 text-xs font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                  aria-label="Open live filters"
                >
                  <SlidersHorizontal className="size-4 text-subtle" aria-hidden />
                  Filters
                </button>
                <button
                  type="button"
                  onClick={() => setAlertsOpen(true)}
                  className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                  aria-label="Alert me nearby"
                >
                  <Bell className="size-4" aria-hidden />
                </button>
                {wireHealth ? (
                  <button
                    type="button"
                    onClick={() => setCoverageOpen(true)}
                    className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                    aria-label="Open coverage"
                  >
                    <span className="relative inline-flex items-center justify-center">
                      <ShieldAlert className="size-4" aria-hidden />
                      <span className={cn("absolute -right-1 -top-1 size-2 rounded-full", coverageDot)} aria-hidden />
                    </span>
                  </button>
                ) : null}
              </div>
            </div>

            {wireHealth && (coverage.tone === "down" || coverage.tone === "warn") ? (
              <button
                type="button"
                onClick={() => setCoverageOpen(true)}
                className="mt-1 inline-flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-left text-xs font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", coverageDot)} aria-hidden />
                  <span className="truncate">{coverage.shortLabel}</span>
                </span>
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-subtle">Tap for details</span>
              </button>
            ) : null}
          </div>

          {/* Desktop: keep richer controls */}
          <div className="hidden lg:block">
            {wireHealth ? (
              <SourcePipes
                health={wireHealth}
                count={showing.length}
                newest={newest}
                wireLive={wireLive}
              />
            ) : (
              <p className="py-1.5 text-xs text-subtle">{wireLive ? `${showing.length} calls` : "Connecting…"}</p>
            )}
            {wireHealth ? (
              <button
                type="button"
                onClick={() => setCoverageOpen(true)}
                className="mt-1 inline-flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-left text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                aria-label="Open coverage"
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", coverageDot)} aria-hidden />
                  <span className="truncate">Coverage (reporting gaps)</span>
                </span>
                <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-subtle">
                  {coverage.shortLabel}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setWitnessOpen(true)}
              className="mt-1.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-accent/35 bg-accent/10 px-3 text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
            >
              <Megaphone className="size-4 text-accent" aria-hidden />
              Report activity
            </button>
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain scrollbar-none pr-3">
                <Chip
                  active={liveKind === "all"}
                  onClick={() => setLiveKind("all")}
                  label="All"
                />
                <Chip active={liveKind === "crime"} onClick={() => setLiveKind("crime")} label="Crime" />
                <Chip active={liveKind === "crash"} onClick={() => setLiveKind("crash")} label="Crash" />
                <Chip active={liveKind === "fire"} onClick={() => setLiveKind("fire")} label="Fire" />
                <Chip active={liveKind === "traffic"} onClick={() => setLiveKind("traffic")} label="Traffic" />
              </div>
              <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain scrollbar-none pr-3">
                <Chip
                  active={sourceLens === "all"}
                  onClick={() => setSourceLens("all")}
                  label={`All sources ${mix.official + mix.scanner + mix.news + mix.social}`}
                />
                <Chip active={sourceLens === "official"} onClick={() => setSourceLens("official")} label={`Official ${mix.official}`} />
                <Chip active={sourceLens === "scanner"} onClick={() => setSourceLens("scanner")} label={`Scanner ${mix.scanner}`} />
                <Chip active={sourceLens === "news"} onClick={() => setSourceLens("news")} label={`News ${mix.news}`} />
                <Chip active={sourceLens === "social"} onClick={() => setSourceLens("social")} label={`Social ${mix.social}`} />
              </div>
              <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain scrollbar-none pr-3">
                <Chip
                  active={!nearActive}
                  onClick={() => setLiveNearMe(false)}
                  label="All area"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (nearActive) {
                      setLiveNearMe(false);
                      setLocateErr("");
                      setLocateErrorKind(null);
                    } else {
                      setLiveNearMe(true);
                      requestLocation();
                    }
                  }}
                  className={cn(
                    "h-10 shrink-0 snap-start rounded-full border px-3 text-xs font-medium active:opacity-80 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                    nearActive ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
                  )}
                >
                  <LocateFixed className="size-3.5" aria-hidden />
                  Near me
                </button>
                {nearActive ? (
                  <>
                    {([1, 2, 3] as const).map((m) => (
                      <Chip
                        key={m}
                        active={liveNearMiles === m}
                        onClick={() => setLiveNearMiles(m)}
                        label={`${m} mi`}
                      />
                    ))}
                  </>
                ) : null}
              </div>
              {nearActive ? (
                <p className="pt-0.5 text-[11px] leading-snug text-subtle">
                  {pos
                    ? `${showing.length} within ~${liveNearMiles} mi (±${pos.accM ? Math.round(pos.accM) : "?"}m) · pins can be approximate`
                    : locateErr
                      ? locateErr
                      : "Allow location to see calls near you."}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mb-3 hidden lg:block">
          <NearbyAlertsCard variant="inline" />
        </div>

        {showing.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
            {wireLive && colonieFocused ? (
              <div className="mb-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-fg">
                Colonie Police radio is encrypted — treat missing police calls as a coverage gap.
              </div>
            ) : null}
            {wireLive ? (
              nearActive ? (
                <>
                  {nearEmptyState === "denied" ? (
                    <>
                      <span className="block font-medium text-fg">Location permission denied.</span>
                      <span className="mt-1 block">
                        Near me needs location access. You can still view county-wide calls by switching to <span className="font-semibold">All area</span>.
                      </span>
                    </>
                  ) : nearEmptyState === "unavailable" ? (
                    <>
                      <span className="block font-medium text-fg">Location unavailable.</span>
                      <span className="mt-1 block">
                        Near me can’t run without a location fix. You can still view county-wide calls by switching to <span className="font-semibold">All area</span>.
                      </span>
                    </>
                  ) : nearEmptyState === "locating" ? (
                    <>
                      <span className="block font-medium text-fg">Waiting for location…</span>
                      <span className="mt-1 block">Allow location to see calls near you, or switch to <span className="font-semibold">All area</span>.</span>
                    </>
                  ) : nearEmptyState === "quiet" ? (
                    <>
                      <span className="block font-medium text-fg">No calls reported within ~{liveNearMiles} mi right now.</span>
                      <span className="mt-1 block">
                        Could be a quiet moment — or a reporting gap (dark pipes, encrypted radio). Pull to refresh or switch to All sources to sanity-check coverage.
                      </span>
                    </>
                  ) : null}
                </>
              ) : (
                <p>{liveWindowHonesty({ health: wireHealth, nowItems: [], liveItems: [], sourceLens }).emptyFilterCopy}</p>
              )
            ) : (
              <p>Pulling blotter, radio, and newsrooms…</p>
            )}
          </div>
        ) : (
          <GroupedList
            items={showing}
            onSelect={onSelect}
            wireHealth={wireHealth}
            sourceLens={sourceLens}
            pos={pos}
          />
        )}
      </div>

      {/* Mobile: compact Report Activity FAB */}
      <button
        type="button"
        onClick={() => setWitnessOpen(true)}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-4 z-30 inline-flex size-12 items-center justify-center rounded-full border border-accent/35 bg-accent text-accent-fg shadow-lg active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 lg:hidden"
        aria-label="Report activity"
      >
        <Megaphone className="size-5" aria-hidden />
      </button>

      <CoverageDrawer
        open={coverageOpen}
        onOpenChange={setCoverageOpen}
        health={wireHealth}
        colonieFocused={colonieFocused}
      />

      <LiveFiltersDrawer
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        liveKind={liveKind}
        setLiveKind={setLiveKind}
        sourceLens={sourceLens}
        setSourceLens={setSourceLens}
        mix={mix}
        nearActive={nearActive}
        setLiveNearMe={setLiveNearMe}
        liveNearMiles={liveNearMiles}
        setLiveNearMiles={setLiveNearMiles}
        onRequestLocation={requestLocation}
        pos={pos}
        locateErr={locateErr}
        locateErrorKind={locateErrorKind}
        onDisableNear={() => {
          setLiveNearMe(false);
          setLocateErr("");
          setLocateErrorKind(null);
        }}
        showingCount={showing.length}
      />
      <LiveAlertsDrawer open={alertsOpen} onOpenChange={setAlertsOpen} />
    </div>
  );
}

function LiveFiltersDrawer({
  open,
  onOpenChange,
  liveKind,
  setLiveKind,
  sourceLens,
  setSourceLens,
  mix,
  nearActive,
  setLiveNearMe,
  liveNearMiles,
  setLiveNearMiles,
  onRequestLocation,
  pos,
  locateErr,
  locateErrorKind,
  onDisableNear,
  showingCount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  liveKind: LiveKind;
  setLiveKind: (k: LiveKind) => void;
  sourceLens: SourceLens;
  setSourceLens: (s: SourceLens) => void;
  mix: { official: number; scanner: number; news: number; social: number };
  nearActive: boolean;
  setLiveNearMe: (v: boolean) => void;
  liveNearMiles: 1 | 2 | 3;
  setLiveNearMiles: (m: 1 | 2 | 3) => void;
  onRequestLocation: () => void;
  pos: NearMePos | null;
  locateErr: string;
  locateErrorKind: LocateErrorKind | null;
  onDisableNear: () => void;
  showingCount: number;
}) {
  const nearEmptyState = selectNearMeEmptyState({ nearActive, pos, locateErrorKind });
  const total = mix.official + mix.scanner + mix.news + mix.social;

  function resetLiveFilters() {
    setLiveKind("all");
    setSourceLens("all");
    onDisableNear();
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none lg:hidden">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 scrollbar-thin">
            <Drawer.Title className="text-base font-semibold">Live filters</Drawer.Title>
            <p className="mt-1 text-xs text-subtle">Category, source lens, and Near me. Applied instantly.</p>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Category</h3>
            <div className="mt-2 flex flex-wrap gap-2" data-vaul-no-drag>
              {([
                ["all", "All"],
                ["crime", "Crime"],
                ["crash", "Crash"],
                ["fire", "Fire"],
                ["traffic", "Traffic"],
              ] as const).map(([id, label]) => (
                <Chip key={id} active={liveKind === id} onClick={() => setLiveKind(id)} label={label} />
              ))}
            </div>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Sources</h3>
            <div className="mt-2 flex flex-wrap gap-2" data-vaul-no-drag>
              <Chip active={sourceLens === "all"} onClick={() => setSourceLens("all")} label={`All sources ${total}`} />
              <Chip active={sourceLens === "official"} onClick={() => setSourceLens("official")} label={`Official ${mix.official}`} />
              <Chip active={sourceLens === "scanner"} onClick={() => setSourceLens("scanner")} label={`Scanner ${mix.scanner}`} />
              <Chip active={sourceLens === "news"} onClick={() => setSourceLens("news")} label={`News ${mix.news}`} />
              <Chip active={sourceLens === "social"} onClick={() => setSourceLens("social")} label={`Social ${mix.social}`} />
            </div>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Area</h3>
            <div className="mt-2 flex flex-wrap gap-2" data-vaul-no-drag>
              <Chip active={!nearActive} onClick={() => onDisableNear()} label="All area" />
              <button
                type="button"
                onClick={() => {
                  if (nearActive) onDisableNear();
                  else {
                    setLiveNearMe(true);
                    onRequestLocation();
                  }
                }}
                className={cn(
                  "h-10 shrink-0 rounded-full border px-3 text-xs font-medium active:opacity-80 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                  nearActive ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
                )}
              >
                <LocateFixed className="size-3.5" aria-hidden />
                Near me
              </button>
              {nearActive ? (
                <>
                  {([1, 2, 3] as const).map((m) => (
                    <Chip
                      key={m}
                      active={liveNearMiles === m}
                      onClick={() => setLiveNearMiles(m)}
                      label={`${m} mi`}
                    />
                  ))}
                </>
              ) : null}
            </div>

            {nearActive ? (
              <div className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                {pos ? (
                  <p>
                    <span className="font-semibold text-fg">{showingCount}</span> within ~{liveNearMiles} mi
                    {" · "}
                    ±{pos.accM ? Math.round(pos.accM) : "?"}m
                  </p>
                ) : locateErr ? (
                  <p className="text-fg">{locateErr}</p>
                ) : nearEmptyState === "locating" ? (
                  <p className="text-fg">Waiting for location…</p>
                ) : nearEmptyState === "denied" ? (
                  <p className="text-fg">Location permission denied.</p>
                ) : nearEmptyState === "unavailable" ? (
                  <p className="text-fg">Location unavailable.</p>
                ) : (
                  <p className="text-fg">Allow location to see calls near you.</p>
                )}
                <p className="mt-1 leading-relaxed">
                  Pins can be approximate. Near me is a convenience lens — when in doubt, switch back to All area and All sources to sanity-check coverage.
                </p>
              </div>
            ) : null}
          </div>

          <div className="px-4 pt-2" data-vaul-no-drag>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetLiveFilters}
                className="flex-1 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="flex-1 rounded-lg border border-accent/35 bg-accent/10 px-4 py-3 text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                Done
              </button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function LiveAlertsDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none lg:hidden">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 scrollbar-thin">
            <Drawer.Title className="text-base font-semibold">Alert me nearby</Drawer.Title>
            <p className="mt-1 text-xs text-subtle">
              Turn on notifications for serious activity near you. Unconfirmed alerts are labeled honestly.
            </p>
            <div className="mt-3">
              <NearbyAlertsCard variant="inline" />
            </div>
          </div>
          <div className="px-4 pt-2" data-vaul-no-drag>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="w-full rounded-lg border border-accent/35 bg-accent/10 px-4 py-3 text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
            >
              Done
            </button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function GroupedList({
  items,
  onSelect,
  wireHealth,
  sourceLens,
  pos,
}: {
  items: Incident[];
  onSelect: (id: string) => void;
  wireHealth: WireHealth | null;
  sourceLens: SourceLens;
  pos: NearMePos | null;
}) {
  const since7 = minutesSinceNy7am();
  const areaFilter = useAppStore((s) => s.areaFilter);
  const municipalities = useAppStore((s) => s.municipalities);
  const colonieFocused = areaFilter === "Colonie" || (municipalities.length === 1 && municipalities[0] === "Colonie");
  const nowItems = [...items.filter((i) => i.minutesAgo <= 180)].sort(
    compareNowLaneWithContext({ colonieFocused }),
  );
  const earlierToday = items.filter((i) => i.minutesAgo > 180 && i.minutesAgo <= since7);
  const overnight = items.filter((i) => i.minutesAgo > since7);
  const honesty = liveWindowHonesty({ health: wireHealth, nowItems, liveItems: items, sourceLens, colonieFocused });

  const split = (rows: Incident[]) => ({
    confirmed: rows.filter((r) => r.verification === "confirmed"),
    developing: rows.filter((r) => r.verification === "developing"),
    scanner: rows.filter((r) => r.verification === "scanner"),
  });

  const now = split(nowItems);
  const today = split(earlierToday);

  type LaneId = "confirmed" | "developing" | "scanner";
  type LaneDef = { id: LaneId; label: string; items: Incident[]; priority: number; order: number };
  function lanePriority(id: LaneId, laneItems: Incident[], order: number): number {
    if (!laneItems.length) return -1;
    const top = laneItems[0]!;
    let score = nowUrgencyScore(top, { colonieFocused });
    // Keep the UI honest: only let scanner-only lanes jump the stack when the activity is serious.
    if (id === "scanner") {
      score -= top.severity === "critical" ? 0 : top.severity === "high" ? 10 : top.severity === "medium" ? 25 : 45;
    }
    if (id === "developing") score -= 5;
    return score * 1000 - order;
  }
  const mkLanes = (bucket: typeof now, baseOrder = 0): LaneDef[] =>
    ([
      { id: "confirmed" as const, label: "Official", items: bucket.confirmed, order: baseOrder + 0 },
      { id: "developing" as const, label: "Developing", items: bucket.developing, order: baseOrder + 1 },
      { id: "scanner" as const, label: "Scanner (early)", items: bucket.scanner, order: baseOrder + 2 },
    ] as const)
      .filter((l) => l.items.length)
      .map((l) => ({ ...l, priority: lanePriority(l.id, l.items, l.order) }))
      .sort((a, b) => b.priority - a.priority);

  return (
    <div className="flex flex-col gap-4">
      <section>
        <div className="mb-1.5 flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Now</h2>
          <p className="text-[11px] text-subtle">Last 3 hours</p>
        </div>

        {nowItems.length ? (
          <div className="flex flex-col gap-3">
            {mkLanes(now).map((lane) => (
              <Lane key={lane.id} label={lane.label} items={lane.items} onSelect={onSelect} pos={pos} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
            {honesty.last3hCopy}
          </p>
        )}
      </section>

      {earlierToday.length ? (
        <section>
          <div className="mb-1.5 flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Developing</h2>
            <p className="text-[11px] text-subtle">Since 7 AM</p>
          </div>
          <div className="flex flex-col gap-3">
            {mkLanes(today, 10).map((lane) => (
              <Lane key={lane.id} label={lane.label} items={lane.items} onSelect={onSelect} pos={pos} />
            ))}
          </div>
        </section>
      ) : null}

      {overnight.length ? (
        <section>
          <div className="mb-1.5 flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Overnight</h2>
            <p className="text-[11px] text-subtle">NYSP blotter</p>
          </div>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-1">
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

function Lane({
  label,
  items,
  onSelect,
  pos,
}: {
  label: string;
  items: Incident[];
  onSelect: (id: string) => void;
  pos: NearMePos | null;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
        {label} · {items.length}
      </p>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-1">
        {items.map((inc) => (
          <li key={inc.id}>
            <IncidentCard
              incident={inc}
              onSelect={onSelect}
              distanceMi={
                pos ? haversineKm({ lat: pos.lat, lng: pos.lng }, { lat: inc.lat, lng: inc.lng }) / 1.60934 : null
              }
            />
          </li>
        ))}
      </ul>
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
        "h-10 shrink-0 rounded-full border px-3 text-xs font-medium active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
        active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
      )}
    >
      {label}
    </button>
  );
}

function SourcePipes({
  health,
  count,
  newest,
  wireLive,
  compact = false,
}: {
  health: WireHealth;
  count: number;
  newest?: Incident;
  wireLive: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const parts = [
    health.blotter ? `${health.blotter} blotter` : "",
    health.scanner ? `${health.scanner} radio` : "",
    health.news ? `${health.news} news` : "",
    (health.facebook ?? 0) ? `${health.facebook} fb` : "",
    (health.reddit ?? 0) ? `${health.reddit} reddit` : "",
  ].filter(Boolean);

  const otherPipesOk =
    (health.news ?? 0) > 0 ||
    (health.traffic ?? 0) > 0 ||
    (health.civic ?? 0) > 0 ||
    (health.nws ?? 0) > 0 ||
    (health.facebook ?? 0) > 0 ||
    (health.x ?? 0) > 0 ||
    (health.reddit ?? 0) > 0 ||
    (health.citizen ?? 0) > 0 ||
    (health.blotter ?? 0) > 0;

  const radioDown =
    (health.scanner ?? 0) === 0 &&
    otherPipesOk &&
    ((health.scannerSttState && health.scannerSttState !== "quiet" && health.scannerSttState !== "ok") ||
      (health.scannerHlsState && health.scannerHlsState === "error") ||
      !health.captions);

  const radioDownReason =
    !health.captions || health.scannerSttState === "no-key"
      ? "speech keys are not configured here"
      : health.scannerHlsState === "error"
        ? "the live radio stream looks unreachable"
        : health.scannerSttState === "busy"
          ? "speech transcription is rate-limited/backing off"
          : health.scannerSttState === "error"
            ? "speech transcription is erroring"
            : "";

  type Tone = "ok" | "warn" | "down" | "unknown";
  const toneClasses: Record<Tone, string> = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-fg",
    warn: "border-amber-500/30 bg-amber-500/10 text-fg",
    down: "border-rose-500/30 bg-rose-500/10 text-fg",
    unknown: "border-border bg-surface-2 text-muted",
  };
  const dotClasses: Record<Tone, string> = {
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    down: "bg-rose-500",
    unknown: "bg-border",
  };
  function ageLabel(ageSec: number): string {
    if (ageSec < 0) return "—";
    return compactFromMinutes(ageSec / 60);
  }
  function toneFor(ageSec: number, lastError?: string): Tone {
    if (lastError) return "down";
    if (ageSec < 0) return "unknown";
    if (ageSec <= 150) return "ok";
    if (ageSec <= 12 * 60) return "warn";
    return "down";
  }
  function groupTone(pipes: NonNullable<WireHealth["pipes"]>): { tone: Tone; ageSec: number } {
    if (!pipes.length) return { tone: "unknown", ageSec: -1 };
    const okish = pipes.filter((p) => !p.lastError && p.ageSec >= 0 && p.ageSec <= 30 * 60);
    const failing = pipes.filter((p) => Boolean(p.lastError) || p.ageSec < 0);
    if (!okish.length) {
      const newest = pipes.map((p) => p.ageSec).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? -1;
      return { tone: failing.length ? "down" : "unknown", ageSec: newest };
    }
    const newestOk = okish.map((p) => p.ageSec).sort((a, b) => a - b)[0] ?? -1;
    const fracFail = failing.length / pipes.length;
    if (fracFail >= 0.5) return { tone: "down", ageSec: newestOk };
    if (failing.length) return { tone: "warn", ageSec: newestOk };
    return { tone: toneFor(newestOk, undefined), ageSec: newestOk };
  }
  const pipes = health.pipes ?? [];
  const scannerPipe = pipes.find((p) => p.id === "scanner");
  const nixleAgg = groupTone(pipes.filter((p) => p.id.startsWith("nixle:")));
  const newsAgg = groupTone(pipes.filter((p) => p.id.startsWith("news:")));
  const dot511 = pipes.find((p) => p.id === "511ny");
  const scannerTone = scannerPipe ? toneFor(scannerPipe.ageSec, scannerPipe.lastError) : "unknown";
  const nixleTone = nixleAgg.tone;
  const newsTone = newsAgg.tone;
  const tone511 = dot511 ? toneFor(dot511.ageSec, dot511.lastError) : "unknown";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 rounded-md",
          compact ? "min-h-8" : "min-h-9",
        )}
      >
        <p className="min-w-0 truncate text-xs text-subtle">
          <span className="font-semibold text-fg">{count}</span>
          {wireLive ? " calls" : " connecting"}
          {parts.length ? <span> · {parts.slice(0, 3).join(" · ")}</span> : null}
        </p>
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-subtle">
          {newest ? compactFromMinutes(newest.minutesAgo) : "—"}
          <ChevronRight className="size-3.5" />
        </span>
      </button>
      <Drawer.Root open={open} onOpenChange={setOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
            <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
            <div className="overflow-y-auto px-4 pb-8 pt-3 scrollbar-thin">
              <Drawer.Title className="text-base font-semibold">Live source map</Drawer.Title>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Albany, Colonie, and Bethlehem do not publish live CAD. Colonie Police radio is encrypted. Counts below are what this refresh actually pulled.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {[
                  { key: "scanner", label: "Scanner", tone: scannerTone, age: ageLabel(scannerPipe?.ageSec ?? -1) },
                  { key: "nixle", label: "Nixle", tone: nixleTone, age: ageLabel(nixleAgg.ageSec) },
                  { key: "news", label: "News", tone: newsTone, age: ageLabel(newsAgg.ageSec) },
                  { key: "511", label: "511", tone: tone511, age: ageLabel(dot511?.ageSec ?? -1) },
                ].map((p) => (
                  <span
                    key={p.key}
                    className={cn(
                      "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium inline-flex items-center gap-1.5",
                      toneClasses[p.tone],
                    )}
                  >
                    <span className={cn("size-1.5 rounded-full", dotClasses[p.tone])} aria-hidden />
                    <span>{p.label}</span>
                    <span className="font-mono tabular-nums text-subtle">{p.age}</span>
                  </span>
                ))}
              </div>
              {health.daytimePipesFailing ? (
                <p className="mt-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-fg">
                  One or more daytime pipes failed this refresh — empty counts may mean the pipe is down, not that nothing happened.
                </p>
              ) : health.daytimePipesDry ? (
                <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                  511, civic, and NWS all returned 0 this refresh. That can be a quiet hour on those feeds — not a county-wide all-clear.
                </p>
              ) : null}
              {radioDown ? (
                <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                  Radio captions are down right now ({radioDownReason || "no recent captions"}). This is a reporting gap: Live may still show other feeds, but it will miss early radio reporting until captions recover.
                </p>
              ) : null}
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Wired this refresh</h3>
              <ul className="mt-2 space-y-2">
                {[
                  ["NYSP blotter", health.blotter, "Official 7 AM dump. Not a live dispatch board."],
                  [
                    "Radio captions",
                    health.scanner,
                    `Albany PD (Colonie PD encrypted), Bethlehem PD/Fire/EMS, Albany Fire, volunteer fire (includes Colonie Fire/EMS), Thruway. Early reporting signal; may be wrong.${
                      radioDownReason && (health.scanner ?? 0) === 0 ? ` (${radioDownReason})` : ""
                    }`,
                  ],
                  ["511NY crashes", health.traffic, "Capital District accidents only. Construction is ignored."],
                  ["Thruway TINC", health.pipes?.find((p) => p.id.startsWith("tinc:"))?.lastCount ?? 0, "NYSTA incident board for Albany area. Closures and major incidents."],
                  ["Nixle", health.pipes?.filter((p) => p.id.startsWith("nixle:")).reduce((a, p) => a + (p.lastCount || 0), 0) ?? 0, "Agency alert centers (public Nixle pages)."],
                  [
                    "Department Facebook",
                    health.facebook ?? 0,
                    "APD/AFD/NYSP + local PD/FD/EMS pages (Colonie, Colonie EMS, Bethlehem, Cohoes PD/Fire, Watervliet, Guilderland PD, Schenectady PD/Fire, Rensselaer County Sheriff, East Greenbush / Green Island / Menands / Rensselaer City police, volunteer fire).",
                  ],
                  [
                    "X",
                    health.x ?? 0,
                    "NYSP, Albany Fire, Troy PD, Schdy Police, Cohoes Fire, ACSO, Albany+Colonie Police, Thruway TRANSalert, Guilderland+Bethlehem PD mirrors, plus Spectrum/Gazette/WAMC and CBS6/NEWS10/Times Union when they tweet crime.",
                  ],
                  ["Town civic", health.civic ?? 0, "Bethlehem, Guilderland, Albany, Cohoes, Troy, Schenectady — incident-keyword filtered. Some sites may block or rate-limit RSS fetches."],
                  ["Live news lens", health.news, "Capital Region public-safety headlines in the last 24h on Live (out-of-area dropped)."],
                  ["News tab", health.stories ?? health.news, "Headlines on the News tab after local keep + fresher ranking. Blotter is capped so it does not drown newsrooms."],
                  ["Citizens", health.reddit ?? 0, "Reddit r/Albany, r/Troy, r/Schenectady. Not 911."],
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
              {health.pipes?.some((p) => p.lastError) ? (
                <>
                  <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Pipe errors this process</h3>
                  <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
                    {health.pipes
                      .filter((p) => p.lastError)
                      .slice(0, 8)
                      .map((p) => (
                        <li key={p.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                          <span className="font-medium text-fg">{p.label}</span>
                          {" — "}
                          {p.lastError}
                          {p.ageSec >= 0 ? ` · last ok ${p.ageSec}s ago` : " · never ok"}
                        </li>
                      ))}
                  </ul>
                </>
              ) : null}
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
