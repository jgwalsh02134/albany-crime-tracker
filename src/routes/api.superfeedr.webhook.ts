import { createFileRoute } from "@tanstack/react-router";
import { isAllowedWebhookContentType, MAX_WEBHOOK_BODY_BYTES } from "@/lib/security/sanitize";

async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) return null;
  return new Uint8Array(buf);
}

export const Route = createFileRoute("/api/superfeedr/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

        const limited = await rateLimitRequest(request, {
          name: "share-ingest-get",
          limit: 60,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        const url = new URL(request.url);
        const challenge = url.searchParams.get("hub.challenge");
        if (challenge) {
          // Hub verification challenge — echo as plain text (capped).
          return new Response(challenge.slice(0, 2048), {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return Response.json({
          status: "ok",
          method: "POST",
          detail: "Superfeedr webhook endpoint",
        });
      },
      POST: async ({ request }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { rateLimitRequest, rateLimitResponse } = await import("../lib/security/rate-limit.server");

        // Feed / share ingest — IP rate limit (external hub; no same-origin check).
        const limited = await rateLimitRequest(request, {
          name: "share-ingest",
          limit: 90,
          windowSec: 60,
        });
        if (!limited.ok) return rateLimitResponse(limited);

        const contentType = request.headers.get("content-type") || "";
        if (!isAllowedWebhookContentType(contentType)) {
          return Response.json({ ok: false, error: "unsupported content-type" }, { status: 415 });
        }

        const body = await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES);
        if (!body) {
          return Response.json({ ok: false, error: "body too large" }, { status: 413 });
        }

        const secret = (process.env.SUPERFEEDR_SECRET || "").trim();
        if (secret) {
          const sig =
            request.headers.get("X-Hub-Signature") ||
            request.headers.get("x-hub-signature") ||
            "";
          const { verifySuperfeedrSignature, recordSuperfeedrError } = await import("../lib/superfeedr");
          if (!verifySuperfeedrSignature(body, sig, secret)) {
            console.error("[superfeedr] signature mismatch");
            recordSuperfeedrError("signature-mismatch");
            return Response.json({ ok: false, error: "signature mismatch" }, { status: 403 });
          }
        }

        const raw = new TextDecoder("utf-8").decode(body);
        let items;
        try {
          const { parseSuperfeedrBody } = await import("../lib/superfeedr");
          items = parseSuperfeedrBody(raw, contentType);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "parse";
          console.error("[superfeedr] parse", msg);
          const { recordSuperfeedrError } = await import("../lib/superfeedr");
          recordSuperfeedrError(msg);
          return Response.json({ ok: true, articles: 0 });
        }

        const { ingestSuperfeedrItems } = await import("../lib/superfeedr");
        const added = ingestSuperfeedrItems(items);
        console.info("[superfeedr] webhook", { parsed: items.length, added });
        return Response.json({ ok: true, articles: items.length, added });
      },
    },
  },
});
