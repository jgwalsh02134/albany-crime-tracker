import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/push/status")({
  server: {
    handlers: {
      GET: async () => {
        const { getPushStatus } = await import("../lib/push.server");
        return Response.json({ ok: true, ...getPushStatus() }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});

