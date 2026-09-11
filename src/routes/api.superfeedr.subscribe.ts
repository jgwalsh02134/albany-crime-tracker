import { createFileRoute } from "@tanstack/react-router";
import {
  ensureSuperfeedrSubscriptions,
  superfeedrSubscribeHealth,
} from "@/lib/superfeedr";

function authorized(request: Request): boolean {
  const expected = (process.env.SUPERFEEDR_ADMIN_TOKEN || process.env.SUPERFEEDR_SECRET || "").trim();
  if (!expected) return true; // no secret configured — allow ops on private deploy
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const query = new URL(request.url).searchParams.get("token") || "";
  return bearer === expected || query === expected;
}

export const Route = createFileRoute("/api/superfeedr/subscribe")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json({
          ok: true,
          ...superfeedrSubscribeHealth(),
          detail: "POST to run idempotent hub.subscribe for intended newsroom/civic feeds",
        });
      },
      POST: async ({ request }) => {
        if (!authorized(request)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        const report = await ensureSuperfeedrSubscriptions({
          force: true,
          requestUrl: request.url,
        });
        return Response.json(report, { status: report.ok || report.skipped ? 200 : 502 });
      },
    },
  },
});
