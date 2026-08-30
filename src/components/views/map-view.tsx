import { useEffect, useRef, useState } from "react";
import { LocateFixed, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lastHours } from "@/lib/data";
import { incidentVisible, useAppStore } from "@/lib/store";
import { type Category, type Incident, type Severity } from "@/lib/types";
import { cn } from "@/lib/utils";
import "leaflet/dist/leaflet.css";

const COLORS: Record<Severity, string> = {
  critical: "#ff8a22",
  high: "#ff6b4a",
  medium: "#00e5ff",
  low: "#8b9bb4",
};

const FILTERS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "violent", label: "Violent" },
  { id: "property", label: "Property" },
  { id: "other", label: "Other" },
];

export function MapView({ incidents, active }: { incidents: Incident[]; active: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{
    map: import("leaflet").Map;
    layer: import("leaflet").LayerGroup;
    L: typeof import("leaflet");
  } | null>(null);
  const [ready, setReady] = useState(false);

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

  const visible = lastHours(
    incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens })),
    mapHours,
  ).filter((i) => mapCategory === "all" || i.category === mapCategory);

  useEffect(() => {
    let cancelled = false;
    let map: import("leaflet").Map | undefined;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !el.current) return;
      map = L.map(el.current, {
        zoomControl: false,
        attributionControl: true,
      }).setView([42.78, -73.8], 10);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      const tiles =
        theme === "light"
          ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
      L.tileLayer(tiles, {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
        maxZoom: 18,
      }).addTo(map);
      const layer = L.layerGroup().addTo(map);
      mapRef.current = { map, layer, L };
      setReady(true);
    })();
    return () => {
      cancelled = true;
      setReady(false);
      map?.remove();
      mapRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    if (!active || !ready) return;
    const ctx = mapRef.current;
    const map = ctx?.map;
    const L = ctx?.L;
    const id = window.setTimeout(() => {
      map?.invalidateSize();
      if (!selectedId && L && visible.length) {
        const bounds = L.latLngBounds(visible.map((i) => [i.lat, i.lng] as [number, number]));
        if (bounds.isValid()) map?.fitBounds(bounds.pad(0.16), { maxZoom: 11, animate: false });
      }
    }, 80);
    const id2 = window.setTimeout(() => map?.invalidateSize(), 300);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(id2);
    };
  }, [active, ready, selectedId, visible.length, mapHours]);

  useEffect(() => {
    const ctx = mapRef.current;
    if (!ctx || !ready) return;
    const { L, layer, map } = ctx;
    layer.clearLayers();
    const pts: [number, number][] = [];
    for (const inc of visible) {
      const selected = inc.id === selectedId;
      const r = heatmap ? 16 : selected ? 10 : 7;
      const marker = L.circleMarker([inc.lat, inc.lng], {
        radius: r,
        color: selected ? "#fff" : COLORS[inc.severity],
        weight: selected ? 3 : 2,
        fillColor: COLORS[inc.severity],
        fillOpacity: heatmap ? 0.22 : 0.92,
      });
      const tip = [inc.title, inc.address, inc.description].filter(Boolean).join("\n").slice(0, 240);
      marker.bindTooltip(tip, { direction: "top", opacity: 0.96, className: "act-tip", sticky: true });
      marker.on("click", () => select(inc.id));
      marker.addTo(layer);
      pts.push([inc.lat, inc.lng]);
    }
    if (!active) return;
    if (selectedId) {
      const hit = visible.find((i) => i.id === selectedId);
      if (hit) map.panTo([hit.lat, hit.lng], { animate: false });
    } else if (pts.length > 0) {
      const bounds = L.latLngBounds(pts);
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.16), { maxZoom: 11, animate: false });
    }
  }, [visible, heatmap, selectedId, select, ready, active]);

  function locate() {
    if (!navigator.geolocation || !mapRef.current) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      mapRef.current?.map.setView([pos.coords.latitude, pos.coords.longitude], 13);
    });
  }

  async function share() {
    const text = `${visible.length} Capital District incidents in the last ${mapHours}h`;
    try {
      if (navigator.share) await navigator.share({ title: "Albany County Crime Tracker", text });
      else await navigator.clipboard.writeText(text);
    } catch {
      /* user cancelled */
    }
  }

  return (
    <div className="relative h-full min-h-0">
      <div ref={el} className="absolute inset-0" role="region" aria-label="Incident map" />

      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
        <div className="pointer-events-auto flex gap-1 overflow-x-auto rounded-full border border-border bg-surface/95 p-1 shadow-md scrollbar-none">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setMapCategory(f.id)}
              className={cn(
                "h-10 min-w-11 rounded-full px-3.5 text-sm font-semibold",
                mapCategory === f.id ? "bg-accent text-accent-fg" : "text-muted",
              )}
            >
              {f.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setHeatmap(!heatmap)}
            className={cn(
              "h-10 min-w-11 rounded-full px-3.5 text-sm font-semibold",
              heatmap ? "bg-cyan text-accent-fg" : "text-muted",
            )}
          >
            Heat
          </button>
        </div>
      </div>

      <div className="pointer-events-none absolute right-3 top-16 z-10">
        <Button size="icon" variant="secondary" className="pointer-events-auto size-12 rounded-full shadow-md" onClick={locate} aria-label="Locate me">
          <LocateFixed className="size-5" />
        </Button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-3">
        <div className="pointer-events-auto flex min-h-11 items-center gap-3 rounded-full border border-border bg-surface/95 px-3.5 py-1.5 shadow-md">
          <span className="font-mono text-xs tabular-nums text-muted">{visible.length} shown</span>
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-subtle">
            {mapHours}h
            <input
              type="range"
              min={1}
              max={72}
              value={mapHours}
              onChange={(e) => setMapHours(Number(e.target.value))}
              className="w-full accent-accent"
            />
            Now
          </label>
          <Button size="icon-sm" variant="ghost" onClick={share}>
            <Share2 className="size-4" />
          </Button>
        </div>
        {visible.length === 0 ? (
          <p className="pointer-events-none mt-2 text-center text-xs text-subtle">
            No mapped calls in this window. NYSP blotter pins appear after the 7 AM report.
          </p>
        ) : null}
      </div>
    </div>
  );
}
