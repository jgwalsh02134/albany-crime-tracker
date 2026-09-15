import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/push/unsubscribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { disablePushSubscriptionByEndpoint } = await import("../lib/push.server");
        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
        }
        const endpoint = String(body?.endpoint || "").trim();
        if (!endpoint || endpoint.length < 12) {
          return Response.json({ ok: false, error: "invalid-endpoint" }, { status: 400 });
        }
        await disablePushSubscriptionByEndpoint(endpoint, "user-unsubscribed");
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});

