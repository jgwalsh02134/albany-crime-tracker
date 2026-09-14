import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/wire")({
  server: {
    handlers: {
      GET: async () => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { fetchLiveWire } = await import("../lib/live-sources");
        const body = await fetchLiveWire();
        return Response.json(body);
      },
    },
  },
});
