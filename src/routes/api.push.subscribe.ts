import { createFileRoute } from "@tanstack/react-router";

type SeverityFloor = "high" | "critical";

function isSeverityFloor(v: unknown): v is SeverityFloor {
  return v === "high" || v === "critical";
}

function isRadius(v: unknown): v is 1 | 2 | 3 {
  return v === 1 || v === 2 || v === 3;
}

export const Route = createFileRoute("/api/push/subscribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getPushStatus, upsertPushSubscription } = await import("../lib/push.server");
        const status = getPushStatus();
        if (!status.enabled) {
          return Response.json({ ok: false, enabled: false, reason: status.reason }, { status: 503 });
        }

        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid-json" }, { status: 400 });
        }

        const sub = body?.subscription;
        const endpoint = String(sub?.endpoint || "").trim();
        const p256dh = String(sub?.keys?.p256dh || "").trim();
        const auth = String(sub?.keys?.auth || "").trim();
        const radiusMiles = Number(body?.radiusMiles);
        const severityFloor = body?.severityFloor;

        if (!endpoint || endpoint.length < 12 || !p256dh || !auth) {
          return Response.json({ ok: false, error: "invalid-subscription" }, { status: 400 });
        }
        if (!isRadius(radiusMiles)) {
          return Response.json({ ok: false, error: "invalid-radius" }, { status: 400 });
        }
        if (!isSeverityFloor(severityFloor)) {
          return Response.json({ ok: false, error: "invalid-severity-floor" }, { status: 400 });
        }

        const latRaw = body?.lat;
        const lngRaw = body?.lng;
        const accRaw = body?.accuracyM;
        const lat = typeof latRaw === "number" && Number.isFinite(latRaw) ? latRaw : null;
        const lng = typeof lngRaw === "number" && Number.isFinite(lngRaw) ? lngRaw : null;
        const accuracyM =
          typeof accRaw === "number" && Number.isFinite(accRaw) ? Math.max(0, Math.min(100_000, Math.round(accRaw))) : null;

        const ua = request.headers.get("user-agent") ?? "";
        const { id } = await upsertPushSubscription({
          endpoint,
          p256dh,
          auth,
          radiusMiles,
          severityFloor,
          lat,
          lng,
          accuracyM,
          geoPrecision: body?.geoPrecision ?? null,
          userAgent: ua,
        });

        return Response.json({ ok: true, enabled: true, id }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});

