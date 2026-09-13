import { createFileRoute } from "@tanstack/react-router";
import { buildParcelQuery, PARCEL_CREDIT, PARCEL_SOURCE } from "@/lib/parcels";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch; contact@albany.watch)";

export const Route = createFileRoute("/api/parcels")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const bboxRaw = url.searchParams.get("bbox") || "";
        const parts = bboxRaw.split(",").map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
          return Response.json(
            { ok: false, error: "bbox=west,south,east,north required (WGS84)" },
            { status: 400 },
          );
        }
        const [west, south, east, north] = parts as [number, number, number, number];
        if (east <= west || north <= south) {
          return Response.json({ ok: false, error: "invalid bbox order" }, { status: 400 });
        }
        // Cap request size — parcels only make sense at street zoom.
        if (east - west > 0.08 || north - south > 0.08) {
          return Response.json(
            { ok: false, error: "bbox too large — zoom in for parcels", credit: PARCEL_CREDIT },
            { status: 400 },
          );
        }
        const counties = (url.searchParams.get("counties") || "Albany,Rensselaer,Schenectady")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 4);
        const upstream = buildParcelQuery([west, south, east, north], counties);
        try {
          const res = await fetch(upstream, {
            headers: { "User-Agent": UA, Accept: "application/geo+json, application/json" },
            signal: AbortSignal.timeout(12000),
          });
          if (!res.ok) {
            return Response.json(
              { ok: false, error: `upstream ${res.status}`, source: PARCEL_SOURCE, credit: PARCEL_CREDIT },
              { status: 502 },
            );
          }
          const body = await res.text();
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "application/geo+json; charset=utf-8",
              "Cache-Control": "public, max-age=120",
              "X-Parcel-Credit": PARCEL_CREDIT,
              "X-Parcel-Source": PARCEL_SOURCE,
            },
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: err instanceof Error ? err.message : "parcels-proxy-error",
              source: PARCEL_SOURCE,
              credit: PARCEL_CREDIT,
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
