import { useEffect, useMemo, useRef, useState } from "react";
import { List, LocateFixed, Radio } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import { Button } from "@/components/ui/button";
import { lastHours } from "@/lib/data";
import { isApproxPrecision } from "@/lib/geo";
import {
  fetchParcelsGeoJson,
  PARCEL_CREDIT,
  PARCEL_MIN_ZOOM,
  parcelPopupHtml,
  type ParcelAttrs,
} from "@/lib/parcels";
import { mapSharePayload } from "@/lib/share";
import { clockTime, severityLabel, typeLabel } from "@/lib/format";
import { incidentVisible, useAppStore } from "@/lib/store";
import { type Category, type Incident, type Severity } from "@/lib/types";
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

const FILTERS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "violent", label: "Violent" },
  { id: "property", label: "Property" },
  { id: "other", label: "Other" },
];

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

const chip =
  "h-11 shrink-0 snap-start rounded-full px-3.5 text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function MapView({ incidents, active }: { incidents: Incident[]; active: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const mapRef = useRef<{
    map: import("leaflet").Map;
    layer: import("leaflet").LayerGroup;
    parcels: import("leaflet").GeoJSON;
    L: typeof import("leaflet");
  } | null>(null);
  const parcelAbort = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [parcelsOn, setParcelsOn] = useState(true);
  const [parcelCount, setParcelCount] = useState(0);
  const [parcelNote, setParcelNote] = useState("");

  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const mapCategory = useAppStore((s) => s.mapCategory);
  const setMapCategory = useAppStore((s) => s.setMapCategory);
  const mapHours = useAppStore((s) => s.mapHours);
  const setMapHours = useAppStore((s) => s.setMapHours);
  const heatmap = useAppStore((s) => s.heatmap);
  const setHeatmap = useAppStore((s) => s.setHeatmap);
  const theme = useAppStore((s) => s.theme);
  const select = useAppStore((s) => s.selectIncident);
  const selectedId = useAppStore((s) => s.selectedId);
  const setView = useAppStore((s) => s.setView);

  const visible = useMemo(
    () =>
      lastHours(
        incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens })),
        mapHours,
      ).filter((i) => mapCategory === "all" || i.category === mapCategory),
    [incidents, severities, municipalities, areaFilter, sourceLens, mapHours, mapCategory],
  );

  const recent = useMemo(() => lastHours(visible, Math.min(mapHours, 3)), [visible, mapHours]);

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
      const tone = theme === "light" ? "Light" : "Dark";
      const tiles = {
        maxZoom: 19,
        maxNativeZoom: 16,
      };
      L.tileLayer(esriUrl(`Canvas/World_${tone}_Gray_Base`), {
        ...tiles,
        attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS",
      }).addTo(map);
      L.tileLayer(esriUrl(`Canvas/World_${tone}_Gray_Reference`), tiles).addTo(map);
      const layer = L.layerGroup().addTo(map);
      const parcels = L.geoJSON(undefined, {
        style: {
          color: cssVar("--accent", "#3d8bfd"),
          weight: 1.25,
          fillColor: cssVar("--accent", "#3d8bfd"),
          fillOpacity: 0.06,
        },
        onEachFeature: (feature, lyr) => {
          const attrs = (feature.properties || {}) as ParcelAttrs;
          lyr.bindPopup(parcelPopupHtml(attrs), {
            className: "act-parcel-popup",
            maxWidth: 280,
          });
        },
      }).addTo(map);
      map.attributionControl?.addAttribution(`Parcels &copy; ${PARCEL_CREDIT}`);
      mapRef.current = { map, layer, parcels, L };
      setReady(true);
    })();
    return () => {
      cancelled = true;
      setReady(false);
      parcelAbort.current?.abort();
      map?.remove();
      mapRef.current = null;
    };
  }, [theme]);

  async function refreshParcels() {
    const ctx = mapRef.current;
    if (!ctx || !parcelsOn) {
      ctx?.parcels.clearLayers();
      setParcelCount(0);
      return;
    }
    const z = ctx.map.getZoom();
    if (z < PARCEL_MIN_ZOOM) {
      ctx.parcels.clearLayers();
      setParcelCount(0);
      setParcelNote("Zoom in for tax parcels");
      return;
    }
    setParcelNote("Loading parcels…");
    const b = ctx.map.getBounds();
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    parcelAbort.current?.abort();
    const ac = new AbortController();
    parcelAbort.current = ac;
    try {
      const geojson = await fetchParcelsGeoJson(bbox, { viaProxy: true, signal: ac.signal });
      if (ac.signal.aborted) return;
      ctx.parcels.clearLayers();
      ctx.parcels.addData(geojson as never);
      setParcelCount(geojson.features?.length || 0);
      setParcelNote(geojson.features?.length ? `${geojson.features.length} parcels · ${PARCEL_CREDIT}` : "No parcels in view");
    } catch (err) {
      if (ac.signal.aborted) return;
      setParcelNote(err instanceof Error ? err.message : "Parcel layer unavailable");
    }
  }

  useEffect(() => {
    const ctx = mapRef.current;
    if (!ctx || !ready) return;
    const onMove = () => {
      void refreshParcels();
    };
    ctx.map.on("moveend", onMove);
    ctx.map.on("zoomend", onMove);
    void refreshParcels();
    return () => {
      ctx.map.off("moveend", onMove);
      ctx.map.off("zoomend", onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, parcelsOn, theme]);

  useEffect(() => {
    if (!active || !ready) return;
    const ctx = mapRef.current;
    const map = ctx?.map;
    const L = ctx?.L;
    const id = window.setTimeout(() => {
      map?.invalidateSize();
      if (!selectedId && L && recent.length) {
        const bounds = L.latLngBounds(recent.map((i) => [i.lat, i.lng] as [number, number]));
        if (bounds.isValid()) map?.fitBounds(bounds.pad(0.22), { maxZoom: 14, animate: false });
      } else if (!selectedId && L && visible.length) {
        const bounds = L.latLngBounds(visible.map((i) => [i.lat, i.lng] as [number, number]));
        if (bounds.isValid()) map?.fitBounds(bounds.pad(0.18), { maxZoom: 13, animate: false });
      }
    }, 80);
    const id2 = window.setTimeout(() => map?.invalidateSize(), 300);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(id2);
    };
  }, [active, ready, selectedId, visible, recent, mapHours]);

  useEffect(() => {
    const ctx = mapRef.current;
    if (!ctx || !ready) return;
    const { L, layer, map } = ctx;
    layer.clearLayers();
    const pts: [number, number][] = [];
    const fill = (sev: Severity) => pinColor(sev);
    const stroke = cssVar("--fg", "#f0f4f8");
    for (const inc of visible) {
      const selected = inc.id === selectedId;
      const approx = isApproxPrecision(inc.geoPrecision);
      const r = heatmap ? 16 : selected ? 13 : approx ? 10 : 9;
      const color = fill(inc.severity);
      const marker = L.circleMarker([inc.lat, inc.lng], {
        radius: r,
        color: selected ? stroke : approx ? color : color,
        weight: selected ? 3 : approx ? 1.5 : inc.severity === "critical" || inc.severity === "high" ? 3 : 2,
        fillColor: color,
        fillOpacity: heatmap ? 0.22 : approx ? 0.35 : 0.92,
        dashArray: approx ? "4 3" : undefined,
        className: approx ? `act-incident-pin act-pin-approx act-pin-${inc.severity}` : `act-incident-pin act-pin-precise act-pin-${inc.severity}`,
      });
      // DivIcon badge for type/severity readability at street zoom
      const glyph = typeGlyph(inc.type);
      if (!heatmap && (inc.severity === "critical" || inc.severity === "high" || selected)) {
        const icon = L.divIcon({
          className: "act-pin-badge",
          html: `<span class="act-pin-badge-inner" style="--m:${color}">${glyph}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const badge = L.marker([inc.lat, inc.lng], { icon, interactive: true, keyboard: true });
        badge.bindTooltip(tipNode(inc), {
          direction: "top",
          opacity: 1,
          className: "act-tip",
          sticky: true,
        });
        badge.on("click", () => select(inc.id));
        badge.addTo(layer);
      }
      marker.bindTooltip(tipNode(inc), {
        direction: "top",
        opacity: 1,
        className: "act-tip",
        sticky: true,
      });
      marker.on("click", () => select(inc.id));
      marker.addTo(layer);
      const node = marker.getElement();
      if (node) {
        node.setAttribute("role", "img");
        node.setAttribute("aria-label", pinLabel(inc));
      }
      pts.push([inc.lat, inc.lng]);
    }
    if (!active) return;
    if (selectedId) {
      const hit = visible.find((i) => i.id === selectedId) || incidents.find((i) => i.id === selectedId);
      if (hit) {
        const z = Math.max(map.getZoom(), isApproxPrecision(hit.geoPrecision) ? 13 : 16);
        map.setView([hit.lat, hit.lng], z, { animate: true });
      }
    } else if (pts.length > 0) {
      const focus = recent.length ? recent : visible;
      const bounds = L.latLngBounds(focus.map((i) => [i.lat, i.lng] as [number, number]));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: recent.length ? 14 : 12, animate: false });
    }
  }, [visible, recent, heatmap, selectedId, select, ready, active, theme, incidents]);

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
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current?.map.setView([pos.coords.latitude, pos.coords.longitude], 16);
      },
      () => {
        /* permission denied */
      },
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={el}
        className="absolute inset-0"
        role="region"
        aria-label="Incident map with tax parcels when zoomed in. Use plus and minus to zoom. Open List for a text version of the pins."
      />
      <p className="sr-only">
        Map is the primary view. Street pins prefer intersections and addresses; dashed pins are town or county
        approximations. Tax parcels from {PARCEL_CREDIT} appear when zoomed in.
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {visible.length} incidents on the map for the last {mapHours} hours. {parcelNote}
      </p>

      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
        <div
          className="pointer-events-auto flex max-w-full gap-1 overflow-x-auto rounded-full border border-border bg-surface/95 p-1 shadow-md scrollbar-none snap-x"
          role="toolbar"
          aria-label="Map filters"
        >
          <div className="flex gap-1" role="group" aria-label="Incident category">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setMapCategory(f.id)}
                aria-pressed={mapCategory === f.id}
                className={cn(chip, mapCategory === f.id ? "bg-accent text-accent-fg" : "text-fg")}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setHeatmap(!heatmap)}
            aria-pressed={heatmap}
            className={cn(chip, heatmap ? "bg-cyan text-accent-fg" : "text-fg")}
          >
            Heat
          </button>
          <button
            type="button"
            onClick={() => setParcelsOn((v) => !v)}
            aria-pressed={parcelsOn}
            className={cn(chip, parcelsOn ? "bg-accent text-accent-fg" : "text-fg")}
            title={PARCEL_CREDIT}
          >
            Parcels
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
            {visible.length} mapped calls
          </h2>
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm leading-relaxed text-muted">
              No mapped calls in this window. NYSP blotter pins appear after the 7 AM report.
            </p>
          ) : (
            <ul>
              {visible.map((inc) => (
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
              {visible.length}
            </span>
            <span className="block text-xs font-semibold uppercase tracking-wide text-subtle">shown</span>
          </p>
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-fg">{mapHours}h</span>
            <input
              type="range"
              min={1}
              max={72}
              value={mapHours}
              onChange={(e) => setMapHours(Number(e.target.value))}
              className="w-full accent-accent"
              aria-valuemin={1}
              aria-valuemax={72}
              aria-valuenow={mapHours}
              aria-label={`Hours on the map, ${mapHours} hours`}
            />
            <span className="shrink-0 text-sm font-semibold text-fg">Now</span>
          </label>
          <ShareButton
            payload={mapSharePayload(visible.length, mapHours)}
            size="icon"
            variant="ghost"
            className="size-11"
            label="Share map"
          />
        </div>
        {parcelsOn ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-1.5 text-center text-xs leading-snug text-muted">
            {parcelNote || (parcelCount ? `${parcelCount} parcels` : `Parcels · ${PARCEL_CREDIT}`)}
          </p>
        ) : null}
        {!listOpen && visible.length === 0 ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            No mapped calls in this window. NYSP blotter pins appear after the 7 AM report.
          </p>
        ) : null}
      </div>
    </div>
  );
}
