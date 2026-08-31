import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bolt,
  Map as MapIcon,
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
import { wireToIncidents, wireToScannerCalls, type LiveWireItem, type WireHealth } from "@/lib/sources";
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
  const [wireHealth, setWireHealth] = useState<WireHealth | null>(null);
  const [stories, setStories] = useState<LiveWireItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const incidents = useMemo(() => wireToIncidents(wire), [wire]);
  const scannerCalls = useMemo(() => wireToScannerCalls(wire), [wire]);
  const news = useMemo(() => mergeWireNews([], stories.length ? stories : wire), [stories, wire]);

  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const setFilterOpen = useAppStore((s) => s.setFilterOpen);
  const setMoreOpen = useAppStore((s) => s.setMoreOpen);
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

  const pullWire = useCallback(async () => {
    try {
      const r = await fetch("/api/wire", { headers: { Accept: "application/json" } });
      if (!r.ok) return;
      const res = (await r.json()) as {
        ok: boolean;
        items: LiveWireItem[];
        stories?: LiveWireItem[];
        outlets?: string[];
        health?: WireHealth;
      };
      if (!res?.ok) return;
      setWire(res.items);
      setStories(res.stories?.length ? res.stories : res.items);
      setWireLive(true);
      setWireHealth(res.health ?? null);
    } catch {
      /* keep last good wire */
    }
  }, []);

  useEffect(() => {
    void pullWire();
    const id = window.setInterval(() => void pullWire(), 45_000);
    return () => window.clearInterval(id);
  }, [pullWire]);

  async function refresh() {
    setRefreshing(true);
    try {
      await pullWire();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3 pt-[max(0.35rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldLogo className="size-8 shrink-0 rounded-full" />
          <div className="min-w-0 leading-tight">
            <p className="flex items-center gap-1.5 truncate text-sm font-semibold tracking-tight">
              <span className="size-1.5 shrink-0 rounded-full bg-accent lg:hidden" />
              Albany County
            </p>
            <p className="hidden items-center gap-1.5 text-xs text-subtle lg:flex">
              <span className="size-1.5 rounded-full bg-accent" />
              Crime Tracker
            </p>
          </div>
        </div>
        <div className="flex items-center">
          {view === "feed" || view === "map" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Filter"
              onClick={() => setFilterOpen(true)}
            >
              <SlidersHorizontal className="size-5" />
            </Button>
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
            wireLive={wireLive}
            wireHealth={wireHealth}
            refreshing={refreshing}
            onRefresh={refresh}
          />
        </div>
        <div className={cn("absolute inset-0", view === "map" ? "z-[1]" : "invisible pointer-events-none")}>
          <MapView incidents={incidents} active={view === "map"} />
        </div>
        <div className={cn("absolute inset-0", view === "scanner" ? "block" : "hidden")}>
          <ScannerView calls={scannerCalls} active={view === "scanner"} />
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
        className="flex shrink-0 border-t border-border bg-bg/90 pt-1 backdrop-blur-md lg:hidden pb-[max(0.35rem,env(safe-area-inset-bottom))]"
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
                "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold active:opacity-70",
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
            "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold active:opacity-70",
            moreOpen ? "text-accent" : "text-subtle",
          )}
        >
          {moreOpen ? <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" /> : null}
          <MoreHorizontal className="size-5" strokeWidth={moreOpen ? 2.4 : 2} />
          More
        </button>
      </nav>

      <FilterDrawer />
      <IncidentDrawer incident={selected} />
      <MoreDrawer />
    </div>
  );
}

function storyKicker(title: string): string {
  const t = title.toLowerCase();
  if (/\b(shot|shooting|stab|homicide|murder|assault)\b/.test(t) || /stabbing/.test(t)) return "Crime";
  if (/\b(fire|blaze)\b/.test(t)) return "Fire";
  if (/\b(crash|collision|fatal)\b/.test(t)) return "Crash";
  if (/\b(arrest|charged|sentenced|prison|indicted)\b/.test(t)) return "Courts";
  return "Local";
}

function mergeWireNews(seed: NewsStory[], wire: LiveWireItem[]): NewsStory[] {
  const extra: NewsStory[] = wire.map((w) => ({
    id: w.id,
    minutesAgo: w.minutesAgo,
    occurredAt: w.publishedAt,
    kicker: storyKicker(w.title),
    title: w.title,
    summary: w.summary || "Capital Region coverage.",
    outlet: w.outlet,
    municipality: "Albany County",
    url: w.url,
    category: "other",
    image: w.image,
  }));
  const urls = new Set(extra.map((e) => e.url));
  return [...extra, ...seed.filter((n) => !urls.has(n.url))];
}
