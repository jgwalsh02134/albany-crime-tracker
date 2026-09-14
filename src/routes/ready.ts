import { createFileRoute } from "@tanstack/react-router";
import { scannerHealth } from "@/lib/scanner-poll";
import {
  superfeedrHealth,
  superfeedrSubscribeHealth,
  ensureSuperfeedrSubscriptions,
} from "@/lib/superfeedr";
import { isAdminAuthorized } from "@/lib/security/admin-token.server";
import { rateLimitRequest, rateLimitResponse } from "@/lib/security/rate-limit.server";
import { pipeHealth } from "@/lib/pipe-health";

/**
 * Public health: minimal `{ ok: true }`.
 * Rich diagnostics + optional subscribe kick: Bearer / ?token= admin token
 * (constant-time compare). Unauthenticated GET never triggers hub.subscribe.
 */
export const Route = createFileRoute("/ready")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const limited = await rateLimitRequest(request, {
          name: "ready",
          limit: 120,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        if (!isAdminAuthorized(request, false)) {
          return Response.json({ ok: true });
        }

        const scan = scannerHealth();
        const sf = superfeedrHealth();
        // Privileged ops only — never on anonymous probes.
        void ensureSuperfeedrSubscriptions({ requestUrl: request.url }).catch(() => undefined);
        const subs = superfeedrSubscribeHealth();
        return Response.json({
          ok: true,
          service: "albany-crime-tracker",
          at: new Date().toISOString(),
          stt: {
            xai: Boolean(process.env.XAI_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY),
            groq: Boolean(process.env.GROQ_API_KEY),
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
          },
          pipes: pipeHealth(),
        });
      },
    },
  },
});
