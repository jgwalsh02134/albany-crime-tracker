import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/wire")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { fetchLiveWire } = await import("../lib/live-sources");
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode") === "full" || url.searchParams.get("full") === "1" ? "full" : "live";
        try {
          const body = await fetchLiveWire({ mode });
          return Response.json(body, { headers: { "Cache-Control": "no-store" } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "wire-error";
          return Response.json(
            { ok: false, error: msg.slice(0, 160) },
            { status: 502, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
