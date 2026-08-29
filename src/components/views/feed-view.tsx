import { useRef, useState } from "react";
import { IncidentCard } from "@/components/incident-card";
import { NewsView } from "@/components/views/news-view";
import { areaCounts } from "@/lib/data";
import { compactFromMinutes, minutesSinceNy7am } from "@/lib/format";
import { type LiveWireItem, sourceMix } from "@/lib/sources";
import { incidentVisible, useAppStore } from "@/lib/store";
import type { Incident, NewsStory } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FeedView({
  incidents,
  news,
  wire,
  wireLive,
  wireOutlets = [],
  refreshing = false,
  onRefresh,
}: {
  incidents: Incident[];
  news: NewsStory[];
  wire: LiveWireItem[];
  wireLive: boolean;
  wireOutlets?: string[];
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
  const newest = liveItems[0] ?? visible[0];
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
  onSelect,
  refreshing,
  onRefresh,
}: {
  liveItems: Incident[];
  dayCount: number;
  areas: { name: string; count: number }[];
  areaFilter: string;
  setAreaFilter: (a: string | "all") => void;
  sourceLens: "all" | "official" | "scanner" | "news";
  setSourceLens: (s: "all" | "official" | "scanner" | "news") => void;
  mix: { official: number; scanner: number; news: number };
  newest?: Incident;
  wireLive: boolean;
  wireOutlets: string[];
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
        NYSP’s last 24-hour report (through 7 AM ET), plus radio, 511, and breaking crime since then.
        {wireOutlets.length ? ` · ${wireOutlets.slice(0, 4).join(" · ")}` : ""}
      </p>

      <div className="sticky top-0 z-10 -mx-3 mb-3 bg-bg/90 px-3 py-1.5 backdrop-blur-md">
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain scrollbar-none snap-x">
          <Chip
            active={sourceLens === "all"}
            onClick={() => setSourceLens("all")}
            label={`All · ${mix.official + mix.scanner + mix.news}`}
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

      {liveItems.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-4 py-12 text-center text-sm text-muted">
          {wireLive
            ? "No matching activity. NYSP posts the daily blotter at 7 AM ET; radio and 511 cover the hours since."
            : "Pulling NYSP blotter, scanner, 511, and newsrooms…"}
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
  const fresh = items.filter((i) => i.minutesAgo <= since7);
  const overnight = items.filter((i) => i.minutesAgo > since7);
  return (
    <div className="flex flex-col gap-5">
      {fresh.length ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Since 7 AM</h2>
          <ul className="flex flex-col gap-2.5">
            {fresh.map((inc) => (
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
