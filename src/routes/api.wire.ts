import { createFileRoute } from "@tanstack/react-router";
import { fetchLiveWire } from "@/lib/live-sources";

export const Route = createFileRoute("/api/wire")({
  server: {
    handlers: {
      GET: async () => {
        const body = await fetchLiveWire();
        return Response.json(body);
      },
    },
  },
});
