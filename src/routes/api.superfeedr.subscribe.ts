import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/superfeedr/subscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

        const limited = await rateLimitRequest(request, {
          name: "superfeedr-subscribe",
          limit: 30,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        // Public: minimal. Rich health only with admin token.
        const { isAdminAuthorized } = await import("../lib/security/admin-token.server");
        if (!isAdminAuthorized(request, false)) {
          return Response.json({
            ok: true,
            detail: "POST with admin token to run idempotent hub.subscribe",
          });
        }
        const { superfeedrSubscribeHealth } = await import("../lib/superfeedr");
        return Response.json({
          ok: true,
          ...superfeedrSubscribeHealth(),
          detail: "POST to run idempotent hub.subscribe for intended newsroom/civic feeds",
        });
      },
      POST: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

        const limited = await rateLimitRequest(request, {
          name: "superfeedr-subscribe",
          limit: 10,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        // Allow if unset only on private deploys with no token configured.
        const { isAdminAuthorized } = await import("../lib/security/admin-token.server");
        if (!isAdminAuthorized(request, true)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        const { ensureSuperfeedrSubscriptions } = await import("../lib/superfeedr");
        const report = await ensureSuperfeedrSubscriptions({
          force: true,
          requestUrl: request.url,
        });
        return Response.json(report, { status: report.ok || report.skipped ? 200 : 502 });
      },
    },
  },
});
