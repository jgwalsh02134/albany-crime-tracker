import { createFileRoute } from "@tanstack/react-router";
import {
  ensureSuperfeedrSubscriptions,
  superfeedrSubscribeHealth,
} from "@/lib/superfeedr";
import { isAdminAuthorized } from "@/lib/security/admin-token.server";
import { rateLimitRequest, rateLimitResponse } from "@/lib/security/rate-limit.server";

export const Route = createFileRoute("/api/superfeedr/subscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const limited = await rateLimitRequest(request, {
          name: "superfeedr-subscribe",
          limit: 30,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        // Public: minimal. Rich health only with admin token.
        if (!isAdminAuthorized(request, false)) {
          return Response.json({
            ok: true,
            detail: "POST with admin token to run idempotent hub.subscribe",
          });
        }
        return Response.json({
          ok: true,
          ...superfeedrSubscribeHealth(),
          detail: "POST to run idempotent hub.subscribe for intended newsroom/civic feeds",
        });
      },
      POST: async ({ request }) => {
        const limited = await rateLimitRequest(request, {
          name: "superfeedr-subscribe",
          limit: 10,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        // Allow if unset only on private deploys with no token configured.
        if (!isAdminAuthorized(request, true)) {
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
