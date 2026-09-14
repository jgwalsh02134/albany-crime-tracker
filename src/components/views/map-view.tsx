import { useEffect, useMemo, useRef, useState } from "react";
import { List, LocateFixed, Radio } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import { Button } from "@/components/ui/button";
import { lastHours } from "@/lib/data";
import { isApproxPrecision } from "@/lib/geo";
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

type PinCluster = { lat: number; lng: number; items: Incident[] };

/** Grid-cluster overlapping pins by rounding lat/lng to ~4 decimals (~11 m). */
function clusterPins(incs: Incident[]): PinCluster[] {
  const buckets = new Map<string, PinCluster>();
  for (const inc of incs) {
    const key = `${inc.lat.toFixed(4)},${inc.lng.toFixed(4)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { lat: Number(inc.lat.toFixed(4)), lng: Number(inc.lng.toFixed(4)), items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(inc);
  }
  return [...buckets.values()];
}

function pickPrimary(items: Incident[]): Incident {
  return [...items].sort((a, b) => {
    const sev = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (sev !== 0) return sev;
    return b.occurredAt.localeCompare(a.occurredAt);
  })[0]!;
}

const chip =
  "h-11 shrink-0 snap-start rounded-full px-3.5 text-sm font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function MapView({ incidents, active }: { incidents: Incident[]; active: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const listToggle = useRef<HTMLButtonElement>(null);
  const mapRef = useRef<{
    map: import("leaflet").Map;
    layer: import("leaflet").LayerGroup;
    L: typeof import("leaflet");
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [showApprox, setShowApprox] = useState(false);

  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const mapCategory = useAppStore((s) => s.mapCategory);
  const setMapCategory = useAppStore((s) => s.setMapCategory);
  const mapHours = useAppStore((s) => s.mapHours);
  const setMapHours = useAppStore((s) => s.setMapHours);
  const select = useAppStore((s) => s.selectIncident);
  const selectedId = useAppStore((s) => s.selectedId);
  const setView = useAppStore((s) => s.setView);

  const visible = useMemo(
    () =>
      lastHours(
        incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens })),
        mapHours,
      )
        .filter((i) => mapCategory === "all" || i.category === mapCategory)
        .filter((i) => showApprox || !isApproxPrecision(i.geoPrecision)),
    [incidents, severities, municipalities, areaFilter, sourceLens, mapHours, mapCategory, showApprox],
  );

  const recent = useMemo(() => lastHours(visible, Math.min(mapHours, 3)), [visible, mapHours]);

  const approxHidden = useMemo(
    () =>
      lastHours(
        incidents.filter((i) => incidentVisible(i, { severities, municipalities, areaFilter, sourceLens })),
        mapHours,
      ).filter(
        (i) =>
          (mapCategory === "all" || i.category === mapCategory) && isApproxPrecision(i.geoPrecision),
      ).length,
    [incidents, severities, municipalities, areaFilter, sourceLens, mapHours, mapCategory],
  );

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
      L.tileLayer(esriUrl("Canvas/World_Dark_Gray_Base"), {
        ...tiles,
        attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS",
      }).addTo(map);
      L.tileLayer(esriUrl("Canvas/World_Dark_Gray_Reference"), tiles).addTo(map);
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
  }, []);

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
    const fg = cssVar("--fg", "#f0f4f8");
    const clusters = clusterPins(visible);

    for (const cluster of clusters) {
      const primary = pickPrimary(cluster.items);
      const selected = cluster.items.some((i) => i.id === selectedId);
      const approx = isApproxPrecision(primary.geoPrecision);
      const multi = cluster.items.length > 1;
      const color = pinColor(primary.severity);
      const r = selected ? 13 : multi ? 12 : approx ? 10 : 9;

      if (multi) {
        const icon = L.divIcon({
          className: "act-pin-badge",
          html: `<span class="act-pin-badge-inner" style="--m:${color}">${cluster.items.length}</span>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const badge = L.marker([cluster.lat, cluster.lng], { icon, interactive: true, keyboard: true });
        const tip = document.createElement("div");
        tip.innerHTML = "";
        const head = document.createElement("p");
        head.className = "act-tip-title";
        head.textContent = `${cluster.items.length} calls here`;
        tip.append(head);
        for (const inc of cluster.items.slice(0, 4)) {
          const row = document.createElement("p");
          row.className = "act-tip-meta";
          row.textContent = `${inc.title} · ${clockTime(inc.occurredAt)}`;
          tip.append(row);
        }
        badge.bindTooltip(tip, {
          direction: "top",
          opacity: 1,
          className: "act-tip",
          sticky: true,
        });
        badge.on("click", () => select(primary.id));
        badge.addTo(layer);
        const node = badge.getElement();
        if (node) {
          node.setAttribute("role", "img");
          node.setAttribute(
            "aria-label",
            `${cluster.items.length} overlapping calls, including ${pinLabel(primary)}`,
          );
        }
      } else {
        const inc = primary;
        const ring = selected ? fg : approx ? withAlpha(color, 0.85) : withAlpha(fg, 0.55);
        const marker = L.circleMarker([cluster.lat, cluster.lng], {
          radius: r,
          color: ring,
          weight: selected ? 3 : approx ? 2.25 : inc.severity === "critical" || inc.severity === "high" ? 3 : 2.5,
          fillColor: color,
          fillOpacity: approx ? 0.14 : 0.92,
          dashArray: approx ? "2 6" : undefined,
          className: approx
            ? `act-incident-pin act-pin-approx act-pin-${inc.severity}`
            : `act-incident-pin act-pin-precise act-pin-${inc.severity}`,
        });
        const glyph = typeGlyph(inc.type);
        if (inc.severity === "critical" || inc.severity === "high" || selected) {
          const icon = L.divIcon({
            className: "act-pin-badge",
            html: `<span class="act-pin-badge-inner" style="--m:${color}">${glyph}</span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          });
          const badge = L.marker([cluster.lat, cluster.lng], { icon, interactive: true, keyboard: true });
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
      }
      pts.push([cluster.lat, cluster.lng]);
    }

    if (!active) return;
    if (selectedId) {
      const hit = visible.find((i) => i.id === selectedId) || incidents.find((i) => i.id === selectedId);
      if (hit && (showApprox || !isApproxPrecision(hit.geoPrecision))) {
        const z = Math.max(map.getZoom(), isApproxPrecision(hit.geoPrecision) ? 13 : 16);
        map.setView([hit.lat, hit.lng], z, { animate: true });
      }
    } else if (pts.length > 0) {
      const focus = recent.length ? recent : visible;
      const bounds = L.latLngBounds(focus.map((i) => [i.lat, i.lng] as [number, number]));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: recent.length ? 14 : 12, animate: false });
    }
  }, [visible, recent, selectedId, select, ready, active, incidents, showApprox]);

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
    <div className="act-map relative h-full min-h-0">
      <div
        ref={el}
        className="absolute inset-0"
        role="region"
        aria-label="Incident map. Use plus and minus to zoom. Open List for a text version of the pins."
      />
      <p className="sr-only">
        Live is the home view. Map shows street-level pins when available. Approximate town or county
        pins stay hidden unless Approx is turned on. Overlapping pins are clustered.
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {visible.length} incidents on the map for the last {mapHours} hours.
        {!showApprox && approxHidden > 0 ? ` ${approxHidden} approximate pins hidden.` : ""}
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
            onClick={() => setShowApprox((v) => !v)}
            aria-pressed={showApprox}
            className={cn(chip, showApprox ? "bg-accent text-accent-fg" : "text-fg")}
            title="Show town/county approximate pins"
          >
            Approx{!showApprox && approxHidden > 0 ? ` (${approxHidden})` : ""}
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
              {approxHidden > 0 && !showApprox
                ? `No street-level pins in this window. ${approxHidden} approximate town/county pins are hidden — turn on Approx to see them.`
                : "No mapped calls in this window. NYSP blotter pins appear after the 7 AM report. Jump to Live for scanner activity."}
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
        {!listOpen && visible.length === 0 ? (
          <p className="pointer-events-none mt-2 rounded-lg bg-surface/95 px-3 py-2 text-center text-sm leading-snug text-muted">
            {approxHidden > 0 && !showApprox
              ? `No street pins here. ${approxHidden} approx pins hidden — toggle Approx, or open Live.`
              : "No mapped calls in this window. NYSP blotter pins appear after the 7 AM report. Open Live for scanner activity."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
