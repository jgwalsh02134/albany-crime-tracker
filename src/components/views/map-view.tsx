import { useEffect, useMemo, useRef, useState } from "react";
import Supercluster from "supercluster";
import { Drawer } from "vaul";
import { Filter, Home, List, LocateFixed, Maximize2, Radio } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import { Button } from "@/components/ui/button";
import { lastHours } from "@/lib/data";
import { isApproxPrecision } from "@/lib/geo";
import { incidentMatchesSourceGroup, incidentVerification, isOfficialIncident, mapKindOf } from "@/lib/map";
import { mapSharePayload } from "@/lib/share";
import { clockTime, severityLabel, typeLabel } from "@/lib/format";
import { incidentVisible, useAppStore } from "@/lib/store";
import type { MapKind, MapSourceGroup, MapTimeWindowHours, MapVerification } from "@/lib/store";
import { type Incident, type Severity } from "@/lib/types";
import { cn } from "@/lib/utils";
import "leaflet/dist/leaflet.css";

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

function pinColor(sev: Severity): string {
  return cssVar(`--sev-${sev}`, FALLBACK[sev]);
}

function pinLabel(inc: Incident): string {
  const when = clockTime(inc.occurredAt);
  const approx = isApproxPrecision(inc.geoPrecision) ? "approximate location" : "street-level pin";
  return [inc.agency, inc.title, inc.address, when, typeLabel(inc.type), severityLabel(inc.severity), approx]
    .filter(Boolean)
    .join(", ");
}

function tipNode(inc: Incident): HTMLElement {
  const root = document.createElement("div");
  const title = document.createElement("p");
  title.className = "act-tip-title";
  title.textContent = inc.title;
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
  return v === "confirmed" ? "Confirmed" : v === "developing" ? "Developing" : "Scanner unconfirmed";
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
  wireHealth: { daytimePipesFailing?: boolean; daytimePipesDry?: boolean } | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const mapRef = useRef<{
    map: import("leaflet").Map;
    layer: import("leaflet").LayerGroup;
    L: typeof import("leaflet");
    renderer: import("leaflet").Renderer;
  } | null>(null);
  const indexRef = useRef<Supercluster<ClusterProps, ClusterProps> | null>(null);
  const byIdRef = useRef<Map<string, Incident>>(new Map());
  const rafRef = useRef<number | null>(null);
  const [mapFilterOpen, setMapFilterOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [locateErr, setLocateErr] = useState<string>("");

  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
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

  const base = useMemo(
    () => incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens })),
    [incidents, severities, municipalities, areaFilter, sourceLens],
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
        attributionControl: true,
        keyboard: true,
      }).setView([42.68, -73.8], 11);
      L.control.zoom({ position: "bottomright" }).addTo(map);
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
      const layer = L.layerGroup().addTo(map);
      mapRef.current = { map, layer, L, renderer };
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
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.16), { maxZoom: 14, animate: true });
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
    const { map, layer, L, renderer } = ctx;
    layer.clearLayers();
    const b = map.getBounds();
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const z = Math.round(map.getZoom());
    const clusters = index.getClusters(bbox, z) as any[];
    const stroke = cssVar("--fg", "#0a1128");

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
          map.flyTo([lat, lng], nextZ, { animate: true, duration: 0.6 });
        });
        m.addTo(layer);
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
      const weight = selected ? 3 : approx ? 1.5 : inc.severity === "critical" || inc.severity === "high" ? 3 : 2;
      const marker = L.circleMarker([lat, lng], {
        radius: selected ? 12 : approx ? 9.5 : 9,
        color: selected ? stroke : color,
        weight,
        fillColor: color,
        fillOpacity: approx ? 0.32 : 0.92,
        dashArray: approx ? "4 3" : undefined,
        className: approx
          ? `act-incident-pin act-pin-approx act-pin-${inc.severity}`
          : `act-incident-pin act-pin-precise act-pin-${inc.severity}`,
        renderer,
        interactive: true,
      });
      marker.bindTooltip(tipNode(inc), { direction: "top", opacity: 1, className: "act-tip", sticky: true });
      marker.on("click", () => select(inc.id));
      marker.addTo(layer);
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
    map.flyTo([hit.lat, hit.lng], z, { animate: true, duration: 0.6 });
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
        mapRef.current?.map.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { animate: true, duration: 0.7 });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setLocateErr("Location permission denied.");
        else setLocateErr("Couldn’t fetch your location.");
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 60_000 },
    );
  }

  return (
    <div className="relative h-full min-h-0">
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
        </div>
      </div>

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
                        {inc.title}
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
            {wireHealth?.daytimePipesFailing ? "Some sources failing — map may be incomplete." : wireHealth?.daytimePipesDry ? "Quiet window — sources returned 0." : approxShown ? `${approxShown} approx pin${approxShown === 1 ? "" : "s"} shown` : "Street-level pins where available"}
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
                      "flex min-h-11 items-center justify-center rounded-md border px-3 text-sm font-semibold",
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

              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Verification</h3>
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
    </div>
  );
}
