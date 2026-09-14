import { create } from "zustand";
import { matchesSourceLens } from "./sources";
import {
  MUNICIPALITIES,
  SEVERITIES,
  type Category,
  type HomeMode,
  type Incident,
  type LiveKind,
  type Severity,
  type SourceLens,
  type ViewId,
  type WitnessKind,
} from "./types";
import type { GeoPrecision } from "./geo";

type Theme = "dark" | "light";

export type MapTimeWindowHours = 1 | 6 | 24 | 48;
export type MapKind = "crime" | "crash" | "fire" | "traffic";
export type MapSourceGroup = "official" | "news" | "scanner" | "social";
export type MapVerification = "confirmed" | "developing" | "scanner";

type AppState = {
  view: ViewId;
  homeMode: HomeMode;
  theme: Theme;
  severities: Severity[];
  municipalities: string[];
  areaFilter: string | "all";
  sourceLens: SourceLens;
  liveKind: LiveKind;
  liveNearMe: boolean;
  liveNearMiles: 1 | 2 | 3;
  mapCategory: Category | "all";
  mapHours: number;
  mapWindowHours: MapTimeWindowHours;
  mapKinds: MapKind[];
  mapSourceGroups: MapSourceGroup[];
  mapVerifications: MapVerification[];
  mapShowApprox: boolean;
  mapCoverage: boolean;
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
  setLiveKind: (k: LiveKind) => void;
  setLiveNearMe: (o: boolean) => void;
  setLiveNearMiles: (m: 1 | 2 | 3) => void;
  setMapCategory: (c: Category | "all") => void;
  setMapHours: (h: number) => void;
  setMapWindowHours: (h: MapTimeWindowHours) => void;
  setMapKinds: (k: MapKind[]) => void;
  setMapSourceGroups: (g: MapSourceGroup[]) => void;
  setMapVerifications: (v: MapVerification[]) => void;
  setMapShowApprox: (o: boolean) => void;
  setMapCoverage: (o: boolean) => void;
  resetMapFilters: () => void;
  setHeatmap: (h: boolean) => void;
  selectIncident: (id: string | null) => void;
  setFilterOpen: (o: boolean) => void;
  setMoreOpen: (o: boolean) => void;
  resetFilters: () => void;

  witnessOpen: boolean;
  witnessPickingOnMap: boolean;
  witnessDraft: {
    kind: WitnessKind;
    note: string;
    lat: number | null;
    lng: number | null;
    accuracyM: number | null;
    geoPrecision: GeoPrecision | null;
    locationSource: "device" | "map" | null;
  };
  setWitnessOpen: (o: boolean) => void;
  setWitnessPickingOnMap: (o: boolean) => void;
  setWitnessDraft: (patch: Partial<AppState["witnessDraft"]>) => void;
  resetWitnessDraft: () => void;
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
  liveKind: "all",
  liveNearMe: false,
  liveNearMiles: 2,
  mapCategory: "all",
  mapHours: 3,
  mapWindowHours: 6,
  mapKinds: ["crime", "crash", "fire", "traffic"],
  mapSourceGroups: ["official", "news", "scanner", "social"],
  mapVerifications: ["confirmed", "developing", "scanner"],
  mapShowApprox: true,
  mapCoverage: false,
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
  setLiveKind: (liveKind) => set({ liveKind }),
  setLiveNearMe: (liveNearMe) => set({ liveNearMe }),
  setLiveNearMiles: (liveNearMiles) => set({ liveNearMiles }),
  setMapCategory: (mapCategory) => set({ mapCategory }),
  setMapHours: (mapHours) => set({ mapHours }),
  setMapWindowHours: (mapWindowHours) => set({ mapWindowHours }),
  setMapKinds: (mapKinds) => set({ mapKinds }),
  setMapSourceGroups: (mapSourceGroups) => set({ mapSourceGroups }),
  setMapVerifications: (mapVerifications) => set({ mapVerifications }),
  setMapShowApprox: (mapShowApprox) => set({ mapShowApprox }),
  setMapCoverage: (mapCoverage) => set({ mapCoverage }),
  resetMapFilters: () =>
    set({
      mapWindowHours: 6,
      mapKinds: ["crime", "crash", "fire", "traffic"],
      mapSourceGroups: ["official", "news", "scanner", "social"],
      mapVerifications: ["confirmed", "developing", "scanner"],
      mapShowApprox: true,
      mapCoverage: false,
    }),
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
      liveKind: "all",
      liveNearMe: false,
      liveNearMiles: 2,
    }),

  witnessOpen: false,
  witnessPickingOnMap: false,
  witnessDraft: {
    kind: "police",
    note: "",
    lat: null,
    lng: null,
    accuracyM: null,
    geoPrecision: null,
    locationSource: null,
  },
  setWitnessOpen: (witnessOpen) => set({ witnessOpen }),
  setWitnessPickingOnMap: (witnessPickingOnMap) => set({ witnessPickingOnMap }),
  setWitnessDraft: (patch) => set({ witnessDraft: { ...get().witnessDraft, ...patch } }),
  resetWitnessDraft: () =>
    set({
      witnessDraft: {
        kind: "police",
        note: "",
        lat: null,
        lng: null,
        accuracyM: null,
        geoPrecision: null,
        locationSource: null,
      },
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
