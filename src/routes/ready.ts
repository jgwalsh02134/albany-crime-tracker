import { createFileRoute } from "@tanstack/react-router";
import { scannerHealth } from "@/lib/scanner-poll";
import { superfeedrHealth, superfeedrSubscribeHealth, ensureSuperfeedrSubscriptions } from "@/lib/superfeedr";

export const Route = createFileRoute("/ready")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const scan = scannerHealth();
        const sf = superfeedrHealth();
        // Kick idempotent hub.subscribe when credentials exist (no-op if already recent).
        void ensureSuperfeedrSubscriptions({ requestUrl: request.url }).catch(() => undefined);
        const subs = superfeedrSubscribeHealth();
        return Response.json({
          ok: true,
          service: "albany-crime-tracker",
          at: new Date().toISOString(),
          stt: {
            xai: Boolean(process.env.XAI_API_KEY),
            openai: Boolean(process.env.OPENAI_API_KEY),
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
          },
        });
      },
    },
  },
});
