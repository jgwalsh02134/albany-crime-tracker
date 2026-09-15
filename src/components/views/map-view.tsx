import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Supercluster from "supercluster";
import { Drawer } from "vaul";
import { Filter, Home, List, LocateFixed, Maximize2, Megaphone, Radio, ShieldAlert, X } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import { CoverageDrawer } from "@/components/coverage-drawer";
import { Button } from "@/components/ui/button";
import { coverageSummary } from "@/lib/coverage";
import { lastHours } from "@/lib/data";
import { haversineKm, isApproxPrecision } from "@/lib/geo";
import { decodeHtmlEntities } from "@/lib/html";
import { incidentMatchesSourceGroup, incidentVerification, isOfficialIncident, mapKindOf } from "@/lib/map";
import { type NearMePos } from "@/lib/near-me-empty-state";
import { mapSharePayload } from "@/lib/share";
import { clockTime, severityLabel, typeLabel } from "@/lib/format";
import { incidentVisible, useAppStore } from "@/lib/store";
import type { MapKind, MapSourceGroup, MapTimeWindowHours, MapVerification } from "@/lib/store";
import { type Incident, type Severity } from "@/lib/types";
import { cn } from "@/lib/utils";
import "leaflet/dist/leaflet.css";
import type { WireHealth } from "@/lib/sources";

const FALLBACK: Record<Severity, string> = {
  critical: "#ff8a22",
  high: "#ff6b4a",
  medium: "#00e5ff",
  low: "#8b9bb4",
};

const DOT: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

function esriUrl(id: string) {
  return `${ESRI}/${id}/MapServer/tile/{z}/{y}/{x}`;
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.trim();
  if (!h.startsWith("#") || (h.length !== 7 && h.length !== 4)) return hex;
  const full =
    h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
  const r = Number.parseInt(full.slice(1, 3), 16);
  const g = Number.parseInt(full.slice(3, 5), 16);
  const b = Number.parseInt(full.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function pinColor(sev: Severity): string {
  return cssVar(`--sev-${sev}`, FALLBACK[sev]);
}

function pinLabel(inc: Incident): string {
  const when = clockTime(inc.occurredAt);
  const approx = isApproxPrecision(inc.geoPrecision) ? "approximate location" : "street-level pin";
  const title = decodeHtmlEntities(inc.title);
  return [inc.agency, title, inc.address, when, typeLabel(inc.type), severityLabel(inc.severity), approx]
    .filter(Boolean)
    .join(", ");
}

function tipNode(inc: Incident): HTMLElement {
  const root = document.createElement("div");
  const title = document.createElement("p");
  title.className = "act-tip-title";
  title.textContent = decodeHtmlEntities(inc.title);
  const agency = document.createElement("p");
  agency.className = "act-tip-agency";
  agency.textContent = inc.agency || inc.agencyAbbr || "";
  const meta = document.createElement("p");
  meta.className = "act-tip-meta";
  const when = clockTime(inc.occurredAt);
  const addr = inc.address || "area unknown";
  meta.textContent = [addr, when].filter(Boolean).join(" · ");
  const kind = document.createElement("p");
  kind.className = "act-tip-kind";
  const approx = isApproxPrecision(inc.geoPrecision) ? " · approx" : "";
  kind.textContent = `${typeLabel(inc.type)} · ${severityLabel(inc.severity)}${approx}`;
  root.append(agency, title, meta, kind);
  return root;
}

function typeGlyph(type: string): string {
  const t = type.toLowerCase();
  if (/shot|shoot|homicide|stab|assault|robbery|violent/.test(t)) return "!";
  if (/fire|blaze|smoke/.test(t)) return "F";
  if (/crash|collision|mva|pi\b/.test(t)) return "C";
  if (/ems|medical|overdose/.test(t)) return "+";
  return "·";
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const chip =
  "h-11 shrink-0 snap-start rounded-full px-3.5 text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type ClusterProps = {
  kind: "incident" | "cluster";
  incidentId?: string;
  sevRank: number;
  official: 0 | 1;
  scanner: 0 | 1;
  approx: 0 | 1;
  count: number;
};

function windowLabel(hours: MapTimeWindowHours): string {
  return hours === 1 ? "1h" : hours === 6 ? "6h" : hours === 24 ? "24h" : "48h";
}

function kindLabel(kind: MapKind): string {
  switch (kind) {
    case "crime":
      return "Crime";
    case "crash":
      return "Crash";
    case "fire":
      return "Fire";
    case "traffic":
      return "Traffic";
  }
}

function sourceLabel(group: MapSourceGroup): string {
  switch (group) {
    case "official":
      return "Official";
    case "news":
      return "News";
    case "scanner":
      return "Scanner";
    case "social":
      return "Social";
  }
}

function verificationLabel(v: MapVerification): string {
  return v === "confirmed" ? "Official" : v === "developing" ? "Developing" : "Scanner (early)";
}

function clusterBadgeHtml(n: number, color: string, tone: "official" | "scanner" | "mixed") {
  const tag =
    tone === "official" ? "✓" : tone === "scanner" ? "…" : "";
  const label = n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
  return `<span class="act-pin-badge-inner" style="--m:${color}">${label}${tag ? `<span style="margin-left:2px;opacity:.9">${tag}</span>` : ""}</span>`;
}

export function MapView({
  incidents,
  active,
  wireLive,
  wireHealth,
}: {
  incidents: Incident[];
  active: boolean;
  wireLive: boolean;
  wireHealth: WireHealth | null;
}) {
  const reduceMotion = useMemo(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  const el = useRef<HTMLDivElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const mapRef = useRef<{
    map: import("leaflet").Map;
    pinLayer: import("leaflet").LayerGroup;
    coverageLayer: import("leaflet").LayerGroup;
    L: typeof import("leaflet");
    renderer: import("leaflet").Renderer;
  } | null>(null);
  const indexRef = useRef<Supercluster<ClusterProps, ClusterProps> | null>(null);
  const byIdRef = useRef<Map<string, Incident>>(new Map());
  const rafRef = useRef<number | null>(null);
  const [mapFilterOpen, setMapFilterOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [locateErr, setLocateErr] = useState<string>("");
  const [nearPos, setNearPos] = useState<NearMePos | null>(null);
  const [nearLocateErr, setNearLocateErr] = useState<string>("");

  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const liveNearMe = useAppStore((s) => s.liveNearMe);
  const liveNearMiles = useAppStore((s) => s.liveNearMiles);
  const mapWindowHours = useAppStore((s) => s.mapWindowHours);
  const setMapWindowHours = useAppStore((s) => s.setMapWindowHours);
  const mapKinds = useAppStore((s) => s.mapKinds);
  const setMapKinds = useAppStore((s) => s.setMapKinds);
  const mapSourceGroups = useAppStore((s) => s.mapSourceGroups);
  const setMapSourceGroups = useAppStore((s) => s.setMapSourceGroups);
  const mapVerifications = useAppStore((s) => s.mapVerifications);
  const setMapVerifications = useAppStore((s) => s.setMapVerifications);
  const mapShowApprox = useAppStore((s) => s.mapShowApprox);
  const setMapShowApprox = useAppStore((s) => s.setMapShowApprox);
  const resetMapFilters = useAppStore((s) => s.resetMapFilters);
  const select = useAppStore((s) => s.selectIncident);
  const selectedId = useAppStore((s) => s.selectedId);
  const setView = useAppStore((s) => s.setView);
  const setWitnessOpen = useAppStore((s) => s.setWitnessOpen);
  const witnessPickingOnMap = useAppStore((s) => s.witnessPickingOnMap);
  const setWitnessPickingOnMap = useAppStore((s) => s.setWitnessPickingOnMap);
  const setWitnessDraft = useAppStore((s) => s.setWitnessDraft);
  const mapCoverage = useAppStore((s) => s.mapCoverage);
  const setMapCoverage = useAppStore((s) => s.setMapCoverage);
  const theme = useAppStore((s) => s.theme);

  const colonieFocused = areaFilter === "Colonie" || (municipalities.length === 1 && municipalities[0] === "Colonie");
  const coverage = useMemo(() => coverageSummary({ health: wireHealth, colonieFocused }), [wireHealth, colonieFocused]);

  const requestNearLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNearLocateErr("Location isn’t available in this browser.");
      return;
    }
    setNearLocateErr("");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setNearPos({ lat: p.coords.latitude, lng: p.coords.longitude, accM: p.coords.accuracy || 0, at: Date.now() });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setNearLocateErr("Location permission denied.");
        } else {
          setNearLocateErr("Couldn’t fetch your location.");
        }
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 60_000 },
    );
  }, []);

  useEffect(() => {
    if (!liveNearMe) {
      setNearPos(null);
      setNearLocateErr("");
      return;
    }
    if (!nearPos || Date.now() - nearPos.at > 5 * 60_000) requestNearLocation();
  }, [liveNearMe, nearPos, requestNearLocation]);

  const base = useMemo(
    () => {
      const visible = incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens }));
      if (!liveNearMe) return visible;
      if (!nearPos) return [];
      const nearKm = liveNearMiles * 1.60934;
      return visible.filter((i) => haversineKm({ lat: nearPos.lat, lng: nearPos.lng }, { lat: i.lat, lng: i.lng }) <= nearKm);
    },
    [incidents, severities, municipalities, areaFilter, sourceLens, liveNearMe, liveNearMiles, nearPos],
  );

  const inWindow = useMemo(() => lastHours(base, mapWindowHours), [base, mapWindowHours]);

  const filtered = useMemo(() => {
    return inWindow
      .filter((i) => mapKinds.includes(mapKindOf(i)))
      .filter((i) => mapVerifications.includes(incidentVerification(i)))
      .filter((i) => mapSourceGroups.some((g) => incidentMatchesSourceGroup(i, g)))
      .filter((i) => mapShowApprox || !isApproxPrecision(i.geoPrecision));
  }, [inWindow, mapKinds, mapVerifications, mapSourceGroups, mapShowApprox]);

  const approxHidden = useMemo(() => inWindow.filter((i) => isApproxPrecision(i.geoPrecision)).length, [inWindow]);
  const approxShown = useMemo(() => filtered.filter((i) => isApproxPrecision(i.geoPrecision)).length, [filtered]);

  // Light basemap only — never recreate on theme change.
  useEffect(() => {
    let cancelled = false;
    let map: import("leaflet").Map | undefined;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !el.current) return;
      map = L.map(el.current, {
        zoomControl: false,
        attributionControl: false,
        keyboard: true,
      }).setView([42.68, -73.8], 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);
      const tiles = {
        maxZoom: 19,
        maxNativeZoom: 16,
      };
      // Dark basemap to match app chrome; no keys.
      L.tileLayer(esriUrl("Canvas/World_Dark_Gray_Base"), {
        ...tiles,
        attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS",
      }).addTo(map);
      L.tileLayer(esriUrl("Canvas/World_Dark_Gray_Reference"), tiles).addTo(map);
      const renderer = L.canvas({ padding: 0.3 });
      const coverageLayer = L.layerGroup().addTo(map);
      const pinLayer = L.layerGroup().addTo(map);
      mapRef.current = { map, pinLayer, coverageLayer, L, renderer };
      setReady(true);
    })();
    return () => {
      cancelled = true;
      setReady(false);
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const ctx = mapRef.current;
    if (!ctx) return;
    const { L, coverageLayer } = ctx;
    coverageLayer.clearLayers();
    if (!mapCoverage) return;

    const accent = cssVar("--accent", "#ff8a22");
    const ring = withAlpha(accent, 0.65);
    const fill = withAlpha(accent, 0.10);

    // v1: Colonie PD encrypted zone (approx).
    const COLONIE = { lat: 42.7179, lng: -73.8373 };
    const circle = L.circle([COLONIE.lat, COLONIE.lng], {
      radius: 7800,
      color: ring,
      weight: 2,
      dashArray: "6 8",
      fillColor: fill,
      fillOpacity: 1,
      interactive: false,
    });
    circle.addTo(coverageLayer);

    const label = L.marker([COLONIE.lat, COLONIE.lng], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "act-coverage-label",
        html: `<div class="act-coverage-pill"><span class="act-coverage-dot"></span><span>Colonie PD police radio encrypted</span></div>`,
        iconSize: [220, 26],
        iconAnchor: [110, 13],
      }),
    });
    label.addTo(coverageLayer);
  }, [ready, mapCoverage, theme]);

  useEffect(() => {
    if (!active || !ready) return;
    const ctx = mapRef.current;
    const map = ctx?.map;
    const id = window.setTimeout(() => {
      map?.invalidateSize();
      if (!selectedId) fitCounty();
    }, 80);
    const id2 = window.setTimeout(() => map?.invalidateSize(), 300);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(id2);
    };
  }, [active, ready, selectedId]);

  useEffect(() => {
    if (!ready || !active || !witnessPickingOnMap) return;
    const ctx = mapRef.current;
    if (!ctx) return;
    const map = ctx.map;
    const container = map.getContainer();
    const prevCursor = container.style.cursor;
    container.style.cursor = "crosshair";
    const onClick = (e: any) => {
      const lat = e?.latlng?.lat;
      const lng = e?.latlng?.lng;
      if (typeof lat !== "number" || typeof lng !== "number") return;
      setWitnessDraft({
        lat,
        lng,
        accuracyM: null,
        geoPrecision: "road",
        locationSource: "map",
      });
      setWitnessPickingOnMap(false);
      setWitnessOpen(true);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      container.style.cursor = prevCursor;
    };
  }, [ready, active, witnessPickingOnMap, setWitnessDraft, setWitnessPickingOnMap, setWitnessOpen]);

  function fitCounty() {
    const ctx = mapRef.current;
    if (!ctx) return;
    const { map, L } = ctx;
    // Albany County-ish bbox (plus near neighbors for a better first impression).
    const bounds = L.latLngBounds(
      [42.35, -74.35],
      [43.05, -73.45],
    );
    map.fitBounds(bounds.pad(0.04), { maxZoom: 11, animate: false });
  }

  function fitResults() {
    const ctx = mapRef.current;
    if (!ctx) return;
    const { map, L } = ctx;
    if (!filtered.length) return fitCounty();
    const bounds = L.latLngBounds(filtered.map((i) => [i.lat, i.lng] as [number, number]));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.16), { maxZoom: 14, animate: !reduceMotion });
  }

  function buildIndex(list: Incident[]) {
    const index = new Supercluster<ClusterProps, ClusterProps>({
      radius: 62,
      maxZoom: 18,
      minZoom: 0,
      map: (p: ClusterProps): ClusterProps => ({
        kind: "incident",
        sevRank: p.sevRank,
        official: p.official,
        scanner: p.scanner,
        approx: p.approx,
        count: 1,
      }),
      reduce: (acc: ClusterProps, p: ClusterProps) => {
        acc.kind = "cluster";
        acc.sevRank = Math.min(acc.sevRank, p.sevRank);
        acc.official = acc.official || p.official ? 1 : 0;
        acc.scanner = acc.scanner || p.scanner ? 1 : 0;
        acc.approx = acc.approx || p.approx ? 1 : 0;
        acc.count += p.count;
      },
    });

    const byId = new Map<string, Incident>();
    const points = list.map((inc) => {
      byId.set(inc.id, inc);
      const official = isOfficialIncident(inc) ? 1 : 0;
      const scanner = incidentVerification(inc) === "scanner" ? 1 : 0;
      const approx = isApproxPrecision(inc.geoPrecision) ? 1 : 0;
      const props: ClusterProps = {
        kind: "incident",
        incidentId: inc.id,
        sevRank: SEV_RANK[inc.severity] ?? 3,
        official,
        scanner,
        approx,
        count: 1,
      };
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [inc.lng, inc.lat] as [number, number] },
        properties: props,
      };
    });
    index.load(points);
    indexRef.current = index;
    byIdRef.current = byId;
  }

  function scheduleRender() {
    if (!ready || !active) return;
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      renderClusters();
    });
  }

  function renderClusters() {
    const ctx = mapRef.current;
    const index = indexRef.current;
    if (!ctx || !index) return;
    const { map, pinLayer, L, renderer } = ctx;
    pinLayer.clearLayers();
    const b = map.getBounds();
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const z = Math.round(map.getZoom());
    const clusters = index.getClusters(bbox, z) as any[];
    const fg = cssVar("--fg", "#f0f4f8");

    for (const f of clusters) {
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties as any;
      const isCluster = Boolean(p.cluster);
      if (isCluster) {
        const count = Number(p.point_count) || 0;
        const sevRank = Number(p.sevRank) || 3;
        const sev = (Object.keys(SEV_RANK).find((k) => SEV_RANK[k as Severity] === sevRank) as Severity) || "low";
        const color = pinColor(sev);
        const tone: "official" | "scanner" | "mixed" =
          p.official ? (p.scanner ? "mixed" : "official") : p.scanner ? "scanner" : "mixed";
        const icon = L.divIcon({
          className: "act-pin-badge",
          html: clusterBadgeHtml(count, color, tone),
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        const m = L.marker([lat, lng], { icon, interactive: true, keyboard: true });
        m.on("click", () => {
          const nextZ = Math.min(18, index.getClusterExpansionZoom(p.cluster_id));
          map.flyTo([lat, lng], nextZ, { animate: !reduceMotion, duration: reduceMotion ? 0 : 0.6 });
        });
        m.addTo(pinLayer);
        const node = m.getElement();
        if (node) {
          node.setAttribute("role", "img");
          node.setAttribute("aria-label", `${count} incidents in this area. Activate to zoom in.`);
        }
        continue;
      }

      const id = String(p.incidentId || "");
      const inc = byIdRef.current.get(id);
      if (!inc) continue;
      const selected = inc.id === selectedId;
      const approx = isApproxPrecision(inc.geoPrecision);
      const color = pinColor(inc.severity);
      const ring = selected ? fg : approx ? withAlpha(color, 0.85) : withAlpha(fg, 0.55);
      const weight = selected ? 3 : approx ? 2.25 : inc.severity === "critical" || inc.severity === "high" ? 3 : 2.5;
      const marker = L.circleMarker([lat, lng], {
        radius: selected ? 12 : approx ? 10 : 9,
        color: ring,
        weight,
        fillColor: color,
        fillOpacity: approx ? 0.14 : 0.92,
        dashArray: approx ? "2 6" : undefined,
        className: approx
          ? `act-incident-pin act-pin-approx act-pin-${inc.severity}`
          : `act-incident-pin act-pin-precise act-pin-${inc.severity}`,
        renderer,
        interactive: true,
      });
      marker.bindTooltip(tipNode(inc), { direction: "top", opacity: 1, className: "act-tip", sticky: true });
      marker.on("click", () => select(inc.id));
      marker.addTo(pinLayer);
      const node = marker.getElement();
      if (node) {
        node.setAttribute("role", "img");
        node.setAttribute("aria-label", pinLabel(inc));
      }
    }
  }

  useEffect(() => {
    if (!ready) return;
    buildIndex(filtered);
    scheduleRender();
  }, [ready, filtered]);

  useEffect(() => {
    if (!ready || !active) return;
    scheduleRender();
  }, [ready, active, selectedId]);

  useEffect(() => {
    const ctx = mapRef.current;
    if (!ctx || !ready) return;
    const onMove = () => scheduleRender();
    ctx.map.on("moveend zoomend", onMove);
    return () => {
      ctx.map.off("moveend zoomend", onMove);
    };
  }, [ready, active]);

  useEffect(() => {
    if (!active || !ready || !selectedId) return;
    const ctx = mapRef.current;
    const map = ctx?.map;
    if (!map) return;
    const hit = filtered.find((i) => i.id === selectedId) || incidents.find((i) => i.id === selectedId);
    if (!hit) return;
    if (!mapShowApprox && isApproxPrecision(hit.geoPrecision)) return;
    const z = Math.max(map.getZoom(), isApproxPrecision(hit.geoPrecision) ? 13 : 16);
    map.flyTo([hit.lat, hit.lng], z, { animate: !reduceMotion, duration: reduceMotion ? 0 : 0.6 });
  }, [active, ready, selectedId, filtered, incidents, mapShowApprox]);

  useEffect(() => {
    if (!listOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setListOpen(false);
      listToggle.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen]);

  function locate() {
    if (!navigator.geolocation || !mapRef.current) return;
    setLocateErr("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current?.map.flyTo([pos.coords.latitude, pos.coords.longitude], 15, {
          animate: !reduceMotion,
          duration: reduceMotion ? 0 : 0.7,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setLocateErr("Location permission denied.");
        else setLocateErr("Couldn’t fetch your location.");
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 60_000 },
    );
  }

  return (
    <div className="act-map relative flex-1 min-h-0 w-full">
      <div
        ref={el}
        className="absolute inset-0"
        role="region"
        aria-label="Public-safety incident map. Use plus and minus to zoom. Open List for a text version of the pins."
      />
      <p className="sr-only">
        Map shows street-level pins when available. Town or county pins are always styled as approximate. Dense areas cluster and expand as you zoom.
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {filtered.length} incidents on the map for the last {mapWindowHours} hours.
        {!mapShowApprox && approxHidden > 0 ? ` ${approxHidden} approximate pins hidden.` : ""}
      </p>

      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
        <div className="pointer-events-auto flex max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-surface/95 p-1 shadow-md scrollbar-none snap-x">
          <div className="flex gap-1" role="group" aria-label="Time window">
            {([1, 6, 24, 48] as const).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setMapWindowHours(h)}
                aria-pressed={mapWindowHours === h}
                className={cn(chip, mapWindowHours === h ? "bg-accent text-accent-fg" : "text-fg")}
              >
                {windowLabel(h)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setCoverageOpen(true)}
            className={cn(chip, "text-fg")}
            aria-label="Open coverage"
          >
            <ShieldAlert className="mr-1 inline size-4" aria-hidden />
            Coverage
          </button>
          <button
            ref={listToggle}
            type="button"
            onClick={() => setListOpen((o) => !o)}
            aria-pressed={listOpen}
            aria-controls="map-incident-list"
            className={cn(chip, listOpen ? "bg-accent text-accent-fg" : "text-fg")}
          >
            <List className="mr-1 inline size-4" aria-hidden />
            List
          </button>
          <button
            type="button"
            onClick={() => setMapFilterOpen(true)}
            className={cn(chip, "text-fg")}
            aria-label="Open map filters"
          >
            <Filter className="mr-1 inline size-4" aria-hidden />
            Filters
          </button>
          <button
            type="button"
            onClick={() => setView("feed")}
            className={cn(chip, "text-fg")}
            aria-label="Open Live feed"
          >
            <Radio className="mr-1 inline size-4" aria-hidden />
            Live
          </button>
          <button
            type="button"
            onClick={() => setWitnessOpen(true)}
            className={cn(chip, "text-fg")}
            aria-label="Report activity"
          >
            <Megaphone className="mr-1 inline size-4" aria-hidden />
            Report
          </button>
        </div>
      </div>

      {witnessPickingOnMap ? (
        <div className="pointer-events-none absolute inset-x-3 top-20 z-20">
          <div className="pointer-events-auto rounded-xl border border-accent/35 bg-surface/95 px-3 py-3 shadow-md backdrop-blur">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-fg">Tap the map to drop a pin</p>
                <p className="mt-0.5 text-xs leading-relaxed text-subtle">
                  This sets the witness location. Don’t fake street precision — use “Other” if you’re unsure.
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                aria-label="Cancel pin drop"
                onClick={() => setWitnessPickingOnMap(false)}
              >
                <X className="size-5" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-3 top-20 z-10 flex flex-col gap-2">
        <Button
          size="icon"
          variant="secondary"
          className="pointer-events-auto size-12 rounded-full shadow-md"
          onClick={locate}
          aria-label="Locate me"
        >
          <LocateFixed className="size-5" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="pointer-events-auto size-12 rounded-full shadow-md"
          onClick={fitResults}
          aria-label="Fit map to results"
        >
          <Maximize2 className="size-5" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="pointer-events-auto size-12 rounded-full shadow-md"
          onClick={fitCounty}
          aria-label="Recenter to Capital Region"
        >
          <Home className="size-5" />
        </Button>
      </div>

      {listOpen ? (
        <div
          id="map-incident-list"
          className="absolute inset-x-3 bottom-24 top-1/2 z-10 overflow-y-auto overscroll-y-contain rounded-xl border border-border bg-surface/95 shadow-md scrollbar-thin lg:inset-x-auto lg:left-3 lg:top-20 lg:w-96"
        >
          <h2
            tabIndex={-1}
            className="sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-3 text-sm font-semibold tracking-tight"
          >
            {filtered.length} mapped calls
          </h2>
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm leading-relaxed text-muted">
              {wireLive
                ? "No mapped incidents match your filters in this window."
                : "Loading live map data…"}
            </p>
          ) : (
            <ul>
              {filtered.map((inc) => (
                <li key={inc.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => select(inc.id)}
                    aria-current={inc.id === selectedId ? "true" : undefined}
                    className={cn(
                      "flex min-h-14 w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                      inc.id === selectedId ? "bg-surface-2" : "",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-3 shrink-0 rounded-full",
                        DOT[inc.severity],
                        isApproxPrecision(inc.geoPrecision) ? "opacity-50 ring-1 ring-dashed ring-fg/40" : "",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold uppercase tracking-wide text-subtle">
                        {inc.agency} · {typeLabel(inc.type)} · {severityLabel(inc.severity)}
                        {isApproxPrecision(inc.geoPrecision) ? " · approx" : ""}
                        {incidentVerification(inc) === "scanner" ? " · scanner" : isOfficialIncident(inc) ? " · official" : ""}
                      </span>
                      <span className="mt-0.5 block text-sm font-semibold leading-snug tracking-tight text-fg">
                        {decodeHtmlEntities(inc.title)}
                      </span>
                      <span className="mt-0.5 block text-sm leading-snug text-muted">
                        {inc.address}
                        <span className="mx-1.5 font-mono tabular-nums">{clockTime(inc.occurredAt)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-3">
        <div className="pointer-events-auto flex min-h-12 items-center gap-3 rounded-full border border-border bg-surface/95 px-4 py-2 shadow-md">
          <p className="shrink-0 leading-tight">
            <span className="block font-mono text-base font-semibold tabular-nums tracking-tight text-fg">
              {filtered.length}
            </span>
            <span className="block text-xs font-semibold uppercase tracking-wide text-subtle">shown</span>
          </p>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-fg">
            {coverage.tone === "down"
              ? "Coverage degraded — reporting gap, not all clear."
              : coverage.tone === "warn"
                ? "Coverage limited — treat gaps as missing signal."
                : wireHealth?.daytimePipesDry
                  ? "Daytime pipes returned 0 — treat as a feed gap."
                  : approxShown
                    ? `${approxShown} approx pin${approxShown === 1 ? "" : "s"} shown`
                    : "Street-level pins where available"}
          </p>
          <ShareButton
            payload={mapSharePayload(filtered.length, mapWindowHours)}
            size="icon"
            variant="ghost"
            className="size-11"
            label="Share map"
          />
        </div>
        {!listOpen && !wireLive ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            Loading live map data…
          </p>
        ) : !listOpen && filtered.length === 0 ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            No incidents match your filters in this window.
          </p>
        ) : null}
        {locateErr ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            {locateErr}
          </p>
        ) : null}
        {!listOpen && liveNearMe && !nearPos ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            {nearLocateErr || "Waiting for location…"}
          </p>
        ) : null}
        {!listOpen && liveNearMe && nearPos && filtered.length === 0 ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            No incidents within ~{liveNearMiles} mi in this window.
          </p>
        ) : null}
      </div>

      <Drawer.Root open={mapFilterOpen} onOpenChange={setMapFilterOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
            <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
            <div className="overflow-y-auto px-4 pb-8 pt-3 scrollbar-thin">
              <Drawer.Title className="text-base font-semibold">Map filters</Drawer.Title>
              <p className="mt-1 text-xs text-subtle">Time window, kind, sources, verification, and precision honesty.</p>

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Time window</h3>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {([1, 6, 24, 48] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setMapWindowHours(h)}
                    className={cn(
                      "flex min-h-11 items-center justify-center rounded-md border px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                      mapWindowHours === h ? "border-accent/50 bg-surface-2" : "border-border",
                    )}
                  >
                    {windowLabel(h)}
                  </button>
                ))}
              </div>

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Incident kind</h3>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(["crime", "crash", "fire", "traffic"] as const).map((k) => (
                  <label
                    key={k}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                      mapKinds.includes(k) ? "border-accent/50 bg-surface-2" : "border-border",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={mapKinds.includes(k)}
                      onChange={() =>
                        setMapKinds(mapKinds.includes(k) ? mapKinds.filter((x) => x !== k) : [...mapKinds, k])
                      }
                    />
                    {kindLabel(k)}
                  </label>
                ))}
              </div>

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Sources</h3>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(["official", "news", "scanner", "social"] as const).map((g) => (
                  <label
                    key={g}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                      mapSourceGroups.includes(g) ? "border-accent/50 bg-surface-2" : "border-border",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={mapSourceGroups.includes(g)}
                      onChange={() =>
                        setMapSourceGroups(
                          mapSourceGroups.includes(g) ? mapSourceGroups.filter((x) => x !== g) : [...mapSourceGroups, g],
                        )
                      }
                    />
                    {sourceLabel(g)}
                  </label>
                ))}
              </div>

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Signal</h3>
              <div className="mt-2 grid grid-cols-1 gap-2">
                {(["confirmed", "developing", "scanner"] as const).map((v) => (
                  <label
                    key={v}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                      mapVerifications.includes(v) ? "border-accent/50 bg-surface-2" : "border-border",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={mapVerifications.includes(v)}
                      onChange={() =>
                        setMapVerifications(
                          mapVerifications.includes(v) ? mapVerifications.filter((x) => x !== v) : [...mapVerifications, v],
                        )
                      }
                    />
                    {verificationLabel(v)}
                  </label>
                ))}
              </div>

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Precision honesty</h3>
              <label
                className={cn(
                  "mt-2 flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                  mapShowApprox ? "border-accent/50 bg-surface-2" : "border-border",
                )}
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={mapShowApprox}
                  onChange={() => setMapShowApprox(!mapShowApprox)}
                />
                Show approximate town/county pins
                <span className="ml-auto font-mono text-xs tabular-nums text-subtle">{approxHidden}</span>
              </label>

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Legend</h3>
              <div className="mt-2 space-y-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
                <p>
                  <span className="font-semibold text-fg">Solid pins</span> are street/intersection/landmark-level when available.{" "}
                  <span className="font-semibold text-fg">Dashed, lighter pins</span> are approximate (town/county) — never a fake street address.
                </p>
                <p>
                  <span className="font-semibold text-fg">Cluster badges</span> show the count. A <span className="font-semibold text-fg">✓</span> indicates the cluster includes official sources;{" "}
                  <span className="font-semibold text-fg">…</span> indicates scanner/early reporting activity.
                </p>
                <p>
                  <span className="font-semibold text-fg">Color</span> follows severity (critical/high/medium/low).
                </p>
              </div>

              <div className="mt-6 flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    resetMapFilters();
                  }}
                >
                  Reset
                </Button>
                <Button className="flex-1" onClick={() => setMapFilterOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      <CoverageDrawer
        open={coverageOpen}
        onOpenChange={setCoverageOpen}
        health={wireHealth}
        colonieFocused={colonieFocused}
        mapToggle={{ on: mapCoverage, setOn: setMapCoverage }}
      />
    </div>
  );
}
