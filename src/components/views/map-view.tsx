import { useEffect, useRef, useState } from "react";
import { LocateFixed, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lastHours } from "@/lib/data";
import { incidentVisible, useAppStore } from "@/lib/store";
import { ALBANY_CENTER, type Category, type Incident, type Severity } from "@/lib/types";
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
      }).setView(ALBANY_CENTER, 12);
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
    const map = mapRef.current?.map;
    const id = window.setTimeout(() => map?.invalidateSize(), 50);
    const id2 = window.setTimeout(() => map?.invalidateSize(), 250);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(id2);
    };
  }, [active, ready]);

  useEffect(() => {
    const ctx = mapRef.current;
    if (!ctx || !ready) return;
    const { L, layer, map } = ctx;
    layer.clearLayers();
    for (const inc of visible) {
      const r = heatmap ? 18 : inc.severity === "critical" ? 9 : 7;
      const marker = L.circleMarker([inc.lat, inc.lng], {
        radius: r,
        color: COLORS[inc.severity],
        weight: heatmap ? 0 : 2,
        fillColor: COLORS[inc.severity],
        fillOpacity: heatmap ? 0.22 : 0.85,
      });
      marker.on("click", () => select(inc.id));
      marker.addTo(layer);
    }
    if (selectedId) {
      const hit = visible.find((i) => i.id === selectedId);
      if (hit) map.panTo([hit.lat, hit.lng]);
    }
  }, [visible, heatmap, selectedId, select, ready]);

  function locate() {
    if (!navigator.geolocation || !mapRef.current) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      mapRef.current?.map.setView([pos.coords.latitude, pos.coords.longitude], 13);
    });
  }

  async function share() {
    const text = `${visible.length} Albany County incidents in the last ${mapHours}h`;
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
        <div className="pointer-events-auto flex gap-1 overflow-x-auto rounded-full border border-border bg-surface/95 p-1 shadow-md">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setMapCategory(f.id)}
              className={cn(
                "h-10 rounded-full px-3 text-sm font-semibold",
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
              "h-10 rounded-full px-3 text-sm font-semibold",
              heatmap ? "bg-cyan text-accent-fg" : "text-muted",
            )}
          >
            Heat
          </button>
        </div>
      </div>

      <div className="pointer-events-none absolute right-3 top-16 z-10">
        <Button size="icon" variant="secondary" className="pointer-events-auto shadow-md" onClick={locate}>
          <LocateFixed className="size-4" />
        </Button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-4">
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-surface/95 px-3 py-2 shadow-md">
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
      </div>
    </div>
  );
}
