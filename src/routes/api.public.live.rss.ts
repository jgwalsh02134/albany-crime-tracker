import { createFileRoute } from "@tanstack/react-router";
import { buildPublicLiveResponseV1 } from "@/lib/public-api";
import { publicCorsHeaders, withCors } from "@/lib/security/cors";

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function escapeXml(input: string): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const Route = createFileRoute("/api/public/live/rss")({
  server: {
    handlers: {
      OPTIONS: async () => {
        const cors = publicCorsHeaders({
          allowOrigin: "*",
          allowMethods: "GET, OPTIONS",
          allowHeaders: "Accept, Content-Type",
          exposeHeaders: "Retry-After, X-RateLimit-Remaining",
          maxAgeSec: 600,
        });
        return new Response(null, { status: 204, headers: cors });
      },
      GET: async ({ request }) => {
        const cors = publicCorsHeaders({
          allowOrigin: "*",
          allowMethods: "GET, OPTIONS",
          allowHeaders: "Accept, Content-Type",
          exposeHeaders: "Retry-After, X-RateLimit-Remaining",
          maxAgeSec: 600,
        });

        try {
          // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
          const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

          const limited = await rateLimitRequest(request, { name: "public-live-rss", limit: 60, windowSec: 60 });
          if (!limited.ok) return withCors(rateLimitResponse(limited), cors);

          const url = new URL(request.url);
          const limit = clampInt(Number(url.searchParams.get("limit") || "50"), 1, 200);

          const { fetchLiveWire } = await import("../lib/live-sources");
          const wire = await fetchLiveWire({ mode: "live" });

          const { wireToIncidents } = await import("../lib/sources");
          const incidents = wireToIncidents(wire.items ?? []).slice(0, limit);
          const publicJson = buildPublicLiveResponseV1(incidents, typeof wire.at === "number" ? wire.at : Date.now());

          const base = "https://albany.watch";
          const feedTitle = "Albany Watch — Live incidents";
          const feedLink = `${base}/`;
          const selfLink = `${base}/api/public/live/rss`;
          const nowUtc = new Date(publicJson.generatedAt).toUTCString();

          const itemsXml = publicJson.incidents
            .map((inc) => {
              const link = `${base}/i/${encodeURIComponent(inc.id)}`;
              const title = `${inc.title} — ${inc.municipality}`;
              const pubDate = new Date(inc.occurredAt).toUTCString();
              const sources = inc.sources
                .slice(0, 6)
                .map((s) => `${s.kind}/${s.tier}: ${s.name}`)
                .join("; ");
              const desc = `${inc.type}. Verification: ${inc.verificationTier}. Geo: ${inc.geoPrecision}. Witness: ${
                inc.witness ? "yes" : "no"
              }. Sources: ${sources || "n/a"}.`;
              return [
                "<item>",
                `<title>${escapeXml(title)}</title>`,
                `<link>${escapeXml(link)}</link>`,
                `<guid isPermaLink="false">${escapeXml(inc.id)}</guid>`,
                `<pubDate>${escapeXml(pubDate)}</pubDate>`,
                `<description>${escapeXml(desc)}</description>`,
                "</item>",
              ].join("");
            })
            .join("");

          const xml =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<rss version="2.0">` +
            `<channel>` +
            `<title>${escapeXml(feedTitle)}</title>` +
            `<link>${escapeXml(feedLink)}</link>` +
            `<description>${escapeXml("Recent Capital Region incident reports fused from multiple sources. Not a CAD feed.")}</description>` +
            `<language>en-us</language>` +
            `<lastBuildDate>${escapeXml(nowUtc)}</lastBuildDate>` +
            `<ttl>1</ttl>` +
            `<atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(selfLink)}" rel="self" type="application/rss+xml" />` +
            itemsXml +
            `</channel>` +
            `</rss>`;

          const res = new Response(xml, {
            status: 200,
            headers: {
              "Content-Type": "application/rss+xml; charset=utf-8",
              "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
            },
          });
          return withCors(res, cors);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "public-live-rss-error";
          const res = Response.json(
            { ok: false, error: String(msg).slice(0, 160) },
            { status: 502, headers: { "Cache-Control": "no-store" } },
          );
          return withCors(res, cors);
        }
      },
    },
  },
});

