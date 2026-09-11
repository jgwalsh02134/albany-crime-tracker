import { createFileRoute } from "@tanstack/react-router";
import { scannerHealth } from "@/lib/scanner-poll";
import { superfeedrHealth } from "@/lib/superfeedr";

export const Route = createFileRoute("/ready")({
  server: {
    handlers: {
      GET: async () => {
        const scan = scannerHealth();
        const sf = superfeedrHealth();
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
            notifications: sf.notifications,
            buffered: sf.buffered,
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
