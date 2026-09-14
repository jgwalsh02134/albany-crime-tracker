import { createFileRoute } from "@tanstack/react-router";

function escapeXml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > width && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function renderCard(opts: {
  title: string;
  place: string;
  when: string;
  caveat: string;
  kind?: "incident" | "story";
}): string {
  const titleLines = wrap(opts.title, 36);
  const meta = [opts.place, opts.when].filter(Boolean).join(" · ");
  const caveat = opts.caveat || "Capital District public-safety feed";
  const titleTs = titleLines
    .map(
      (line, i) =>
        `<text x="64" y="${188 + i * 52}" fill="#F4F7FF" font-size="42" font-weight="700" font-family="Barlow, Helvetica, Arial, sans-serif">${escapeXml(line)}</text>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0A1128"/>
      <stop offset="100%" stop-color="#152044"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="36" y="36" width="1128" height="558" rx="28" fill="#121A33" stroke="#2A365C" stroke-width="2"/>
  <rect x="36" y="36" width="14" height="558" rx="8" fill="#3D7EFF"/>
  <text x="64" y="100" fill="#8FA0C8" font-size="22" font-weight="600" letter-spacing="2" font-family="Barlow, Helvetica, Arial, sans-serif">ALBANY WATCH · ${escapeXml((opts.kind ?? "incident").toUpperCase())}</text>
  ${titleTs}
  <text x="64" y="${188 + titleLines.length * 52 + 28}" fill="#C5D0EA" font-size="28" font-family="IBM Plex Mono, Menlo, monospace">${escapeXml(meta.slice(0, 80))}</text>
  <text x="64" y="540" fill="#8FA0C8" font-size="24" font-family="Barlow, Helvetica, Arial, sans-serif">${escapeXml(caveat.slice(0, 110))}</text>
  <text x="64" y="580" fill="#3D7EFF" font-size="22" font-weight="600" font-family="Barlow, Helvetica, Arial, sans-serif">app.albany.watch</text>
</svg>`;
}

export const Route = createFileRoute("/api/og/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // Keep server-only imports out of the client bundle: route modules are imported into the route tree.
        const { lookupIncidentCard } = await import("../lib/incident-lookup");
        const meta = await lookupIncidentCard(params.id);
        const svg = renderCard({
          title: meta.title,
          place: meta.place,
          when: meta.when,
          caveat: meta.caveat,
          kind: meta.kind,
        });
        return new Response(svg, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      },
    },
  },
});
