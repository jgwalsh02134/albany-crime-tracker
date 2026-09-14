import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { stripHtml } from "@/lib/security/sanitize";
import type { GeoPrecision } from "@/lib/geo";

const MAX_BODY_BYTES = 6 * 1024;

function isSameSitePost(request: Request): boolean {
  const site = (request.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (!site || site === "same-origin" || site === "none") return true;
  return false;
}

async function readJsonCapped(request: Request, maxBytes: number): Promise<unknown | null> {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) return null;
  const text = new TextDecoder("utf-8").decode(new Uint8Array(buf));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const WitnessSchema = z.object({
  kind: z.enum(["police", "fire", "crash", "other"]),
  note: z.string().optional(),
  lat: z.number().finite(),
  lng: z.number().finite(),
  geoPrecision: z.enum(["street", "intersection", "landmark", "road", "town", "county", "unknown"]).optional(),
  accuracyM: z.number().finite().optional(),
});

export const Route = createFileRoute("/api/witness")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json({ ok: true, endpoint: "witness-reports" }, { headers: { "Cache-Control": "no-store" } });
      },
      POST: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");
        const { insertWitnessReport } = await import("../lib/witness-reports.server");
        const { deriveGeoPrecisionFromAccuracy } = await import("../lib/witness");
        const { randomUUID } = await import("node:crypto");

        if (!isSameSitePost(request)) {
          return Response.json({ ok: false, error: "Forbidden." }, { status: 403 });
        }

        const limited = await rateLimitRequest(request, {
          name: "witness-report",
          limit: 10,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        const contentType = (request.headers.get("content-type") || "").toLowerCase();
        if (!contentType.includes("application/json")) {
          return Response.json({ ok: false, error: "unsupported content-type" }, { status: 415 });
        }

        const body = await readJsonCapped(request, MAX_BODY_BYTES);
        const parsed = WitnessSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ ok: false, error: "invalid payload" }, { status: 400 });
        }

        const { kind, lat, lng } = parsed.data;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return Response.json({ ok: false, error: "invalid lat/lng" }, { status: 400 });
        }

        const note = stripHtml(parsed.data.note ?? "", 240);
        const ua = stripHtml(request.headers.get("user-agent") || "", 220);
        const accuracyM =
          typeof parsed.data.accuracyM === "number" && Number.isFinite(parsed.data.accuracyM)
            ? Math.max(0, Math.min(100_000, parsed.data.accuracyM))
            : null;
        const geoPrecision = (parsed.data.geoPrecision || deriveGeoPrecisionFromAccuracy(accuracyM)) as GeoPrecision;

        const id = randomUUID();
        await insertWitnessReport({
          id,
          kind,
          note,
          lat,
          lng,
          geoPrecision,
          accuracyM,
          userAgent: ua,
        });

        return Response.json(
          { ok: true, id: `citizen-${id}` },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});

