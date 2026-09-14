import { createFileRoute } from "@tanstack/react-router";

/**
 * Public health: minimal `{ ok: true }`.
 * Rich diagnostics + optional subscribe kick: Bearer / ?token= admin token
 * (constant-time compare). Unauthenticated GET never triggers hub.subscribe.
 */
export const Route = createFileRoute("/ready")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

        const limited = await rateLimitRequest(request, {
          name: "ready",
          limit: 120,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        const { isAdminAuthorized } = await import("../lib/security/admin-token.server");
        if (!isAdminAuthorized(request, false)) {
          return Response.json({ ok: true });
        }

        const { scannerHealth } = await import("../lib/scanner-poll");
        const { sttBackoffHealth } = await import("../lib/transcribe");
        const {
          superfeedrHealth,
          superfeedrSubscribeHealth,
          ensureSuperfeedrSubscriptions,
        } = await import("../lib/superfeedr");
        const { pipeHealth } = await import("../lib/pipe-health");

        const scan = scannerHealth();
        const sf = superfeedrHealth();
        // Privileged ops only — never on anonymous probes.
        void ensureSuperfeedrSubscriptions({ requestUrl: request.url }).catch(() => undefined);
        const subs = superfeedrSubscribeHealth();
        const sttBackoff = sttBackoffHealth();
        return Response.json({
          ok: true,
          service: "albany-crime-tracker",
          at: new Date().toISOString(),
          stt: {
            xai: Boolean(process.env.XAI_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY),
            groq: Boolean(process.env.GROQ_API_KEY),
            backoff: sttBackoff,
          },
          superfeedr: {
            secretConfigured: Boolean((process.env.SUPERFEEDR_SECRET || "").trim()),
            authConfigured: subs.authConfigured,
            callbackConfigured: subs.callbackConfigured,
            notifications: sf.notifications,
            buffered: sf.buffered,
            subscriptions: {
              topics: subs.topics,
              subscribed: subs.subscribed,
              failed: subs.failed,
              lastRunAt: subs.lastRunAt || undefined,
            },
          },
          scanner: {
            ticks: scan.ticks,
            kept: scan.kept,
            captions: scan.captions,
            ageSec: scan.ageSec,
            lastError: scan.lastError || undefined,
            sttState: scan.sttState,
            sttBlockedSec: scan.sttBlockedSec,
            lastSpoken: scan.lastSpoken || undefined,
            lastSpokenAt: scan.lastSpokenAt || undefined,
            lastFeed: scan.lastFeed || undefined,
            hlsState: scan.hlsState,
            hlsAgeSec: scan.hlsAgeSec,
            hlsLastError: scan.hlsLastError || undefined,
            hlsLastErrorAt: scan.hlsLastErrorAt || undefined,
            hlsLastFeed: scan.hlsLastFeed || undefined,
          },
          pipes: pipeHealth(),
        });
      },
    },
  },
});
