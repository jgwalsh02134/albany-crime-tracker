import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/push/test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = (process.env.PUSH_TEST_TOKEN || "").trim();
        if (!token) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
        const auth = request.headers.get("authorization") || "";
        if (auth !== `Bearer ${token}`) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
        }
        const endpoint = String(body?.endpoint || "").trim();
        const title = String(body?.title || "Albany Watch test").trim();
        const msg = String(body?.body || "This is a test notification.").trim();
        const url = String(body?.url || "").trim();
        if (!endpoint) return Response.json({ ok: false, error: "invalid-endpoint" }, { status: 400 });

        const origin = new URL(request.url).origin;
        const { sendTestPush } = await import("../lib/push.server");
        await sendTestPush({ endpoint, origin, title, body: msg, url: url || origin });
        return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});

