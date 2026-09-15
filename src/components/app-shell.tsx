import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Bolt,
  Map as MapIcon,
  Megaphone,
  Moon,
  MoreHorizontal,
  Radio,
  Shield,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { FilterDrawer, IncidentDrawer, MoreDrawer } from "@/components/drawers";
import { ShieldLogo } from "@/components/shield-logo";
import { WitnessReportDrawer } from "@/components/witness-report-drawer";
import { Button } from "@/components/ui/button";
import { ChatView } from "@/components/views/chat-view";
import { DirectoryView } from "@/components/views/directory-view";
import { FeedView } from "@/components/views/feed-view";
import { MapView } from "@/components/views/map-view";
import { MoreView } from "@/components/views/more-view";
import { ScannerView } from "@/components/views/scanner-view";
import { wireToIncidents, wireToScannerCalls, type LiveWireItem, type WireHealth } from "@/lib/sources";
import { decodeHtmlEntities } from "@/lib/html";
import { useAppStore } from "@/lib/store";
import type { NewsStory, ViewId } from "@/lib/types";
import { cn } from "@/lib/utils";

const TABS: { id: ViewId; label: string; icon: typeof Bolt }[] = [
  { id: "feed", label: "Live", icon: Bolt },
  { id: "map", label: "Map", icon: MapIcon },
  { id: "scanner", label: "Radio", icon: Radio },
  { id: "directory", label: "Agencies", icon: Shield },
];

export function AppShell() {
  const [wire, setWire] = useState<LiveWireItem[]>([]);
  const [wireLive, setWireLive] = useState(false);
  const [wireReady, setWireReady] = useState(false);
  const [wireHealth, setWireHealth] = useState<WireHealth | null>(null);
  const [stories, setStories] = useState<LiveWireItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, startTransition] = useTransition();
  const pullInFlight = useRef<{ controller: AbortController; startedAt: number; budgetMs: number } | null>(null);
  const retryTimer = useRef<number | null>(null);
  const [wireInitAttempts, setWireInitAttempts] = useState(0);
  const [wireInitError, setWireInitError] = useState<string | null>(null);
  const [wireInitNextRetryAt, setWireInitNextRetryAt] = useState<number | null>(null);
  const incidents = useMemo(() => wireToIncidents(wire), [wire]);
  const scannerCalls = useMemo(() => wireToScannerCalls(wire), [wire]);
  const news = useMemo(() => mergeWireNews([], stories.length ? stories : wire), [stories, wire]);

  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const homeMode = useAppStore((s) => s.homeMode);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const setFilterOpen = useAppStore((s) => s.setFilterOpen);
  const setMoreOpen = useAppStore((s) => s.setMoreOpen);
  const setWitnessOpen = useAppStore((s) => s.setWitnessOpen);
  const selectedId = useAppStore((s) => s.selectedId);
  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const moreOpen = view === "chat" || view === "more";

  useEffect(() => {
    try {
      const saved = localStorage.getItem("act-theme");
      if (saved === "light" || saved === "dark") {
        useAppStore.getState().setTheme(saved);
        return;
      }
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.theme = useAppStore.getState().theme;
  }, []);

  const pullWire = useCallback(
    async (opts?: { full?: boolean; force?: boolean }) => {
      const wantFull = Boolean(opts?.full) || homeMode === "news";
      const budgetMs = wantFull ? 16_000 : 12_000;
      const initialConnect = !wireLive;
      let gotOk = false;

      const existing = pullInFlight.current;
      if (existing) {
        const age = Date.now() - existing.startedAt;
        // Avoid deadlocks if a prior request wedges (can happen on mobile Safari).
        if (!opts?.force && age < existing.budgetMs + 1500) return;
        try {
          existing.controller.abort();
        } catch {
          /* ignore */
        }
      }

      const controller = new AbortController();
      pullInFlight.current = { controller, startedAt: Date.now(), budgetMs };
      setWireInitAttempts((n) => n + 1);
      const t = window.setTimeout(() => controller.abort(), budgetMs);

      try {
        const r = await fetch(`/api/wire?mode=${wantFull ? "full" : "live"}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!r.ok) {
          setWireReady(true);
          if (initialConnect) setWireInitError(`HTTP ${r.status}`);
          return;
        }

        const res = (await r.json()) as {
          ok: boolean;
          items: LiveWireItem[];
          stories?: LiveWireItem[];
          outlets?: string[];
          health?: WireHealth;
        };
        if (!res?.ok) {
          setWireReady(true);
          if (initialConnect) setWireInitError("wire unavailable");
          return;
        }

        gotOk = true;
        startTransition(() => {
          setWire(res.items);
          setStories(res.stories?.length ? res.stories : res.items);
          setWireLive(true);
          setWireReady(true);
          setWireHealth(res.health ?? null);
          setWireInitError(null);
        });
      } catch (err) {
        setWireReady(true);
        if (initialConnect) {
          const msg = err instanceof Error ? err.message : "wire error";
          setWireInitError(/aborted|abort/i.test(msg) ? "timeout" : String(msg).slice(0, 140));
        }
      } finally {
        window.clearTimeout(t);
        if (pullInFlight.current?.controller === controller) {
          pullInFlight.current = null;
        }
      }

      // While we're still trying to get the first usable live response, retry quickly with backoff.
      if (initialConnect && !gotOk) {
        const attempts = wireInitAttempts + 1;
        const delayMs = attempts <= 1 ? 1500 : attempts === 2 ? 2500 : attempts === 3 ? 4000 : 6500;
        if (retryTimer.current == null) {
          setWireInitNextRetryAt(Date.now() + delayMs);
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            setWireInitNextRetryAt(null);
            void pullWire({ full: wantFull, force: true });
          }, delayMs);
        }
      }
    },
    [homeMode, startTransition, wireInitAttempts, wireLive],
  );

  useEffect(() => {
    void pullWire({ full: homeMode === "news" });
    // Daytime honesty: poll open pipes faster so 511 / news / Superfeedr land on Live.
    const daytime = (() => {
      try {
        const h = Number(
          new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(
            new Date(),
          ),
        );
        return h >= 7 && h < 22;
      } catch {
        return true;
      }
    })();
    const id = window.setInterval(
      () => void pullWire({ full: homeMode === "news" }),
      wireLive ? (daytime ? 25_000 : 45_000) : 6_000,
    );
    return () => window.clearInterval(id);
  }, [pullWire, homeMode, wireLive]);

  useEffect(() => {
    function onRefresh() {
      void pullWire({ full: homeMode === "news", force: true });
    }
    window.addEventListener("act:refresh-wire", onRefresh as EventListener);
    return () => window.removeEventListener("act:refresh-wire", onRefresh as EventListener);
  }, [pullWire, homeMode]);

  async function refresh() {
    setRefreshing(true);
    try {
      await pullWire({ full: true });
    } finally {
      setRefreshing(false);
    }
  }

  function retryWire() {
    if (retryTimer.current != null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
      setWireInitNextRetryAt(null);
    }
    setWireInitError(null);
    void pullWire({ full: homeMode === "news", force: true });
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header className="relative z-40 flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg px-3 pt-[max(0.35rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldLogo className="size-9 shrink-0 sm:size-11 lg:size-12" />
          <div className="min-w-0 leading-tight">
            <p className="flex items-center gap-1.5 truncate text-sm font-semibold tracking-tight">
              <span className="size-1.5 shrink-0 rounded-full bg-accent lg:hidden" />
              Albany County
            </p>
            <p className="truncate text-[11px] text-subtle lg:hidden">
              {view === "feed" ? (homeMode === "news" ? "News · Capital Region" : "Live feed · Capital Region") : "Crime Tracker"}
            </p>
            <p className="hidden items-center gap-1.5 text-xs text-subtle lg:flex">
              <span className="size-1.5 rounded-full bg-accent" />
              Crime Tracker
            </p>
          </div>
        </div>
        <div className="flex items-center">
          {view === "map" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Filter"
              onClick={() => setFilterOpen(true)}
            >
              <SlidersHorizontal className="size-5" />
            </Button>
          ) : view === "feed" ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Report activity"
                className="lg:hidden"
                onClick={() => setWitnessOpen(true)}
              >
                <Megaphone className="size-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Filter"
                className="hidden lg:inline-flex"
                onClick={() => setFilterOpen(true)}
              >
                <SlidersHorizontal className="size-5" />
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            className="hidden lg:inline-flex"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </Button>
        </div>
      </header>

      <nav
        className="hidden shrink-0 border-b border-border lg:flex"
        role="tablist"
        aria-label="Primary views"
      >
        {[
          ...TABS,
          { id: "chat" as const, label: "AI", icon: Bolt },
          { id: "more" as const, label: "Trends", icon: MoreHorizontal },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => setView(tab.id)}
            className={cn(
              "relative h-12 flex-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
              view === tab.id ? "text-fg" : "text-subtle",
            )}
          >
            {tab.label}
            {view === tab.id ? (
              <span className="absolute inset-x-8 bottom-0 h-0.5 rounded-full bg-accent" />
            ) : null}
          </button>
        ))}
      </nav>

      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={cn("absolute inset-0 flex min-h-0", view === "feed" ? "flex" : "hidden")}>
          <FeedView
            incidents={incidents}
            news={news}
            wireItems={wire}
            wireLive={wireLive}
            wireReady={wireReady}
            wireInitError={wireInitError}
            wireInitNextRetryAt={wireInitNextRetryAt}
            onRetryWire={retryWire}
            wireHealth={wireHealth}
            refreshing={refreshing || pending}
            onRefresh={refresh}
          />
        </div>
        <div className={cn("absolute inset-0 flex min-h-0", view === "map" ? "z-[1]" : "invisible pointer-events-none")}>
          <MapView
            incidents={incidents}
            active={view === "map"}
            wireLive={wireLive}
            wireReady={wireReady}
            wireInitError={wireInitError}
            wireHealth={wireHealth}
            wireItems={wire}
          />
        </div>
        <div className={cn("absolute inset-0 flex min-h-0", view === "scanner" ? "flex" : "hidden")}>
          <ScannerView calls={scannerCalls} active={view === "scanner"} />
        </div>
        <div className={cn("absolute inset-0 flex min-h-0", view === "chat" ? "flex" : "hidden")}>
          <ChatView />
        </div>
        <div className={cn("absolute inset-0 flex min-h-0", view === "directory" ? "flex" : "hidden")}>
          <DirectoryView />
        </div>
        <div className={cn("absolute inset-0 flex min-h-0", view === "more" ? "flex" : "hidden")}>
          <MoreView incidents={incidents} />
        </div>
      </main>

      <nav
        className="relative z-40 flex shrink-0 border-t border-border bg-bg pt-1 lg:hidden pb-[max(0.35rem,env(safe-area-inset-bottom))]"
        role="tablist"
        aria-label="Main navigation"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const on = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setView(tab.id)}
              className={cn(
                "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                on ? "text-accent" : "text-subtle",
              )}
            >
              {on ? <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" /> : null}
              <Icon className="size-5" strokeWidth={on ? 2.4 : 2} />
              {tab.label}
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={moreOpen}
          onClick={() => setMoreOpen(true)}
          className={cn(
            "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
            moreOpen ? "text-accent" : "text-subtle",
          )}
        >
          {moreOpen ? <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" /> : null}
          <MoreHorizontal className="size-5" strokeWidth={moreOpen ? 2.4 : 2} />
          More
        </button>
      </nav>

      <FilterDrawer incidents={incidents} />
      <IncidentDrawer incident={selected} wireItems={wire} />
      <MoreDrawer />
      <WitnessReportDrawer />
    </div>
  );
}

function storyKicker(title: string): string {
  const t = title.toLowerCase();
  if (/\b(shot|shooting|stab|homicide|murder|assault)\b/.test(t) || /stabbing/.test(t)) return "Crime";
  if (/\b(fire|blaze)\b/.test(t)) return "Fire";
  if (/\b(crash|collision|fatal)\b/.test(t)) return "Crash";
  if (/\b(arrest|charged|sentenced|prison|indicted)\b/.test(t)) return "Courts";
  if (/\b(dwi|intoxicated)\b/.test(t)) return "DWI";
  return "Local";
}

const CLIENT_OUT_OF_AREA =
  /\b(philippines|mississippi|louisiana|portland|seattle|chicago|brooklyn|queens|bronx|manhattan|albany,? georgia|albany,? oregon|new orleans)\b/i;

function mergeWireNews(seed: NewsStory[], wire: LiveWireItem[]): NewsStory[] {
  const extra: NewsStory[] = wire
    .filter((w) => !CLIENT_OUT_OF_AREA.test(`${w.title} ${w.summary}`))
    .map((w) => ({
      id: w.id,
      minutesAgo: w.minutesAgo,
      occurredAt: w.publishedAt,
      kicker: storyKicker(decodeHtmlEntities(w.title)),
      title: decodeHtmlEntities(w.title),
      summary: decodeHtmlEntities(w.summary || "Capital Region coverage."),
      outlet: w.outlet,
      municipality: w.municipality || w.address || "Capital Region",
      url: w.url,
      category: "other" as const,
      image: w.image,
    }));
  const urls = new Set(extra.map((e) => e.url));
  return [...extra, ...seed.filter((n) => !urls.has(n.url) && !CLIENT_OUT_OF_AREA.test(`${n.title} ${n.summary}`))];
}
