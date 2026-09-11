import { createFileRoute } from "@tanstack/react-router";
import {
  ingestSuperfeedrItems,
  parseSuperfeedrBody,
  recordSuperfeedrError,
  verifySuperfeedrSignature,
} from "@/lib/superfeedr";

async function readBody(request: Request): Promise<Uint8Array> {
  const buf = await request.arrayBuffer();
  return new Uint8Array(buf);
}

export const Route = createFileRoute("/api/superfeedr/webhook")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const challenge = url.searchParams.get("hub.challenge");
        if (challenge) {
          return new Response(challenge, {
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
        const body = await readBody(request);
        const secret = (process.env.SUPERFEEDR_SECRET || "").trim();
        if (secret) {
          const sig =
            request.headers.get("X-Hub-Signature") ||
            request.headers.get("x-hub-signature") ||
            "";
          if (!verifySuperfeedrSignature(body, sig, secret)) {
            console.error("[superfeedr] signature mismatch");
            recordSuperfeedrError("signature-mismatch");
            return Response.json({ ok: false, error: "signature mismatch" }, { status: 403 });
          }
        }

        const raw = new TextDecoder("utf-8").decode(body);
        const contentType = request.headers.get("content-type") || "";
        let items;
        try {
          items = parseSuperfeedrBody(raw, contentType);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "parse";
          console.error("[superfeedr] parse", msg);
          recordSuperfeedrError(msg);
          return Response.json({ ok: true, articles: 0 });
        }

        const added = ingestSuperfeedrItems(items);
        console.info("[superfeedr] webhook", { parsed: items.length, added });
        return Response.json({ ok: true, articles: items.length, added });
      },
    },
  },
});
