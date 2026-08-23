import { useEffect, useMemo, useState } from "react";
import {
  Bolt,
  Map as MapIcon,
  Menu,
  Moon,
  MoreHorizontal,
  Radio,
  Shield,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { FilterDrawer, IncidentDrawer, MoreDrawer } from "@/components/drawers";
import { ShieldLogo } from "@/components/shield-logo";
import { Button } from "@/components/ui/button";
import { ChatView } from "@/components/views/chat-view";
import { DirectoryView } from "@/components/views/directory-view";
import { FeedView } from "@/components/views/feed-view";
import { MapView } from "@/components/views/map-view";
import { MoreView } from "@/components/views/more-view";
import { ScannerView } from "@/components/views/scanner-view";
import { hydrateCalls, hydrateIncidents, hydrateNews } from "@/lib/data";
import { getLiveWire } from "@/lib/live-sources";
import { mergeLiveFeed, type LiveWireItem } from "@/lib/sources";
import { useAppStore } from "@/lib/store";
import type { NewsStory, ViewId } from "@/lib/types";
import { cn } from "@/lib/utils";

const TABS: { id: ViewId; label: string; icon: typeof Bolt }[] = [
  { id: "feed", label: "Live", icon: Bolt },
  { id: "map", label: "Map", icon: MapIcon },
  { id: "scanner", label: "Scanner", icon: Radio },
  { id: "directory", label: "Directory", icon: Shield },
];

export function AppShell() {
  const [now, setNow] = useState(() => Date.now());
  const [wire, setWire] = useState<LiveWireItem[]>([]);
  const [wireLive, setWireLive] = useState(false);
  const [wireOutlets, setWireOutlets] = useState<string[]>([]);
  const seedIncidents = useMemo(() => hydrateIncidents(now), [now]);
  const seedNews = useMemo(() => hydrateNews(now), [now]);
  const calls = useMemo(() => hydrateCalls(now), [now]);
  const incidents = useMemo(() => mergeLiveFeed(seedIncidents, wire), [seedIncidents, wire]);
  const news = useMemo(() => mergeWireNews(seedNews, wire), [seedNews, wire]);

  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const setFilterOpen = useAppStore((s) => s.setFilterOpen);
  const setMoreOpen = useAppStore((s) => s.setMoreOpen);
  const selectedId = useAppStore((s) => s.selectedId);
  const selected = incidents.find((i) => i.id === selectedId) ?? null;

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

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await getLiveWire();
        if (cancelled || !res.ok) return;
        setWire(res.items);
        setWireLive(res.items.length > 0);
        setWireOutlets(res.outlets ?? []);
      } catch {
        /* keep last good wire */
      }
    }
    void pull();
    const id = window.setInterval(pull, 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2.5">
          <ShieldLogo className="size-8 shrink-0" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-tight">Albany County</p>
            <p className="text-xs text-subtle">Crime Tracker</p>
          </div>
          <span className="ml-1 hidden items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 sm:flex">
            <span className="live-dot" />
            <span className="text-xs font-semibold uppercase tracking-wide">Live</span>
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Filter incidents"
            onClick={() => setFilterOpen(true)}
          >
            <SlidersHorizontal className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            className="hidden md:inline-flex"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            className="md:hidden"
            onClick={() => setMoreOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
        </div>
      </header>

      <nav
        className="hidden shrink-0 border-b border-border md:flex"
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
              "relative h-12 flex-1 text-sm font-semibold",
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

      <main className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0", view === "feed" ? "block" : "hidden")}>
          <FeedView
            incidents={incidents}
            news={news}
            wire={wire}
            wireLive={wireLive}
            wireOutlets={wireOutlets}
          />
        </div>
        <div className={cn("absolute inset-0", view === "map" ? "block" : "hidden")}>
          <MapView incidents={incidents} active={view === "map"} />
        </div>
        <div className={cn("absolute inset-0", view === "scanner" ? "block" : "hidden")}>
          <ScannerView calls={calls} />
        </div>
        <div className={cn("absolute inset-0", view === "chat" ? "block" : "hidden")}>
          <ChatView />
        </div>
        <div className={cn("absolute inset-0", view === "directory" ? "block" : "hidden")}>
          <DirectoryView />
        </div>
        <div className={cn("absolute inset-0", view === "more" ? "block" : "hidden")}>
          <MoreView incidents={incidents} />
        </div>
      </main>

      <nav
        className="flex shrink-0 border-t border-border bg-bg pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
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
                "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold",
                on ? "text-accent" : "text-subtle",
              )}
            >
              <Icon className="size-5" />
              {tab.label}
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected={view === "chat" || view === "more"}
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold",
            view === "chat" || view === "more" ? "text-accent" : "text-subtle",
          )}
        >
          <MoreHorizontal className="size-5" />
          More
        </button>
      </nav>

      <FilterDrawer />
      <IncidentDrawer incident={selected} />
      <MoreDrawer />
    </div>
  );
}

function mergeWireNews(seed: NewsStory[], wire: LiveWireItem[]): NewsStory[] {
  if (!wire.length) return seed;
  const extra: NewsStory[] = wire.map((w) => ({
    id: w.id,
    minutesAgo: w.minutesAgo,
    occurredAt: w.publishedAt,
    kicker: "Live wire",
    title: w.title,
    summary: w.summary || "Capital Region public-safety coverage.",
    outlet: w.outlet,
    municipality: "Albany County",
    url: w.url,
    category: "other",
  }));
  const urls = new Set(extra.map((e) => e.url));
  return [...extra, ...seed.filter((n) => !urls.has(n.url))];
}
