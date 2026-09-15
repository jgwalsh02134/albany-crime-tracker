import { createFileRoute } from "@tanstack/react-router";
import { buildPublicLiveResponseV1 } from "@/lib/public-api";
import { publicCorsHeaders, withCors } from "@/lib/security/cors";

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export const Route = createFileRoute("/api/public/live")({
  server: {
    handlers: {
      OPTIONS: async () => {
        const cors = publicCorsHeaders({
          allowOrigin: "*",
          allowMethods: "GET, OPTIONS",
          allowHeaders: "Accept, Content-Type",
          exposeHeaders: "Retry-After, X-RateLimit-Remaining",
          maxAgeSec: 600,
        });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        const cors = publicCorsHeaders({
          allowOrigin: "*",
          allowMethods: "GET, OPTIONS",
          allowHeaders: "Accept, Content-Type",
          exposeHeaders: "Retry-After, X-RateLimit-Remaining",
          maxAgeSec: 600,
        });

        try {
          // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
          const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

          const limited = await rateLimitRequest(request, { name: "public-live", limit: 120, windowSec: 60 });
          if (!limited.ok) return withCors(rateLimitResponse(limited), cors);

          const url = new URL(request.url);
          const limit = clampInt(Number(url.searchParams.get("limit") || "50"), 1, 200);

          const { fetchLiveWire } = await import("../lib/live-sources");
          const wire = await fetchLiveWire({ mode: "live" });

          const { wireToIncidents } = await import("../lib/sources");
          const incidents = wireToIncidents(wire.items ?? []).slice(0, limit);

          const body = buildPublicLiveResponseV1(incidents, typeof wire.at === "number" ? wire.at : Date.now());
          const res = Response.json(body, {
            headers: {
              "Cache-Control": "public, max-age=15, stale-while-revalidate=45",
            },
          });
          return withCors(res, cors);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "public-live-error";
          const res = Response.json(
            { ok: false, error: String(msg).slice(0, 160) },
            { status: 502, headers: { "Cache-Control": "no-store" } },
          );
          return withCors(res, cors);
        }
      },
    },
  },
});

