import { create } from "zustand";
import { matchesSourceLens } from "./sources";
import {
  MUNICIPALITIES,
  SEVERITIES,
  type Category,
  type HomeMode,
  type Incident,
  type Severity,
  type SourceLens,
  type ViewId,
} from "./types";

type Theme = "dark" | "light";

type AppState = {
  view: ViewId;
  homeMode: HomeMode;
  theme: Theme;
  severities: Severity[];
  municipalities: string[];
  areaFilter: string | "all";
  sourceLens: SourceLens;
  mapCategory: Category | "all";
  mapHours: number;
  heatmap: boolean;
  selectedId: string | null;
  filterOpen: boolean;
  moreOpen: boolean;
  setView: (v: ViewId) => void;
  setHomeMode: (m: HomeMode) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setSeverities: (s: Severity[]) => void;
  setMunicipalities: (m: string[]) => void;
  setAreaFilter: (a: string | "all") => void;
  setSourceLens: (s: SourceLens) => void;
  setMapCategory: (c: Category | "all") => void;
  setMapHours: (h: number) => void;
  setHeatmap: (h: boolean) => void;
  selectIncident: (id: string | null) => void;
  setFilterOpen: (o: boolean) => void;
  setMoreOpen: (o: boolean) => void;
  resetFilters: () => void;
};

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("act-theme", theme);
  } catch {
    /* ignore */
  }
}

export const useAppStore = create<AppState>()((set, get) => ({
  view: "feed",
  homeMode: "live",
  theme: "dark",
  severities: [...SEVERITIES],
  municipalities: [...MUNICIPALITIES],
  areaFilter: "all",
  sourceLens: "all",
  mapCategory: "all",
  mapHours: 24,
  heatmap: false,
  selectedId: null,
  filterOpen: false,
  moreOpen: false,
  setView: (view) => set({ view, moreOpen: false }),
  setHomeMode: (homeMode) => set({ homeMode }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    set({ theme });
  },
  setSeverities: (severities) => set({ severities }),
  setMunicipalities: (municipalities) => set({ municipalities }),
  setAreaFilter: (areaFilter) => set({ areaFilter }),
  setSourceLens: (sourceLens) => set({ sourceLens }),
  setMapCategory: (mapCategory) => set({ mapCategory }),
  setMapHours: (mapHours) => set({ mapHours }),
  setHeatmap: (heatmap) => set({ heatmap }),
  selectIncident: (selectedId) => set({ selectedId }),
  setFilterOpen: (filterOpen) => set({ filterOpen }),
  setMoreOpen: (moreOpen) => set({ moreOpen }),
  resetFilters: () =>
    set({
      severities: [...SEVERITIES],
      municipalities: [...MUNICIPALITIES],
      areaFilter: "all",
      sourceLens: "all",
    }),
}));

export function incidentVisible(
  inc: Incident,
  state: Pick<AppState, "severities" | "municipalities" | "areaFilter" | "sourceLens">,
): boolean {
  if (state.severities.length && !state.severities.includes(inc.severity)) return false;
  const known = (MUNICIPALITIES as readonly string[]).includes(inc.municipality);
  if (known && state.municipalities.length && !state.municipalities.includes(inc.municipality)) return false;
  if (!known && state.areaFilter !== "all") return false;
  if (!known && state.municipalities.length < MUNICIPALITIES.length) return false;
  if (state.areaFilter !== "all" && inc.municipality !== state.areaFilter) return false;
  if (!matchesSourceLens(inc, state.sourceLens)) return false;
  return true;
}
