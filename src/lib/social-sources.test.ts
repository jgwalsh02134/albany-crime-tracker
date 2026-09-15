import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectSocial } from "./social-sources";

function rss(items: { title: string; link: string; desc?: string; pubDate?: string }[]): string {
  const body = items
    .map(
      (i) => `
      <item>
        <title>${i.title}</title>
        <link>${i.link}</link>
        <description>${i.desc ?? ""}</description>
        <pubDate>${i.pubDate ?? new Date().toUTCString()}</pubDate>
      </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" ?>
    <rss version="2.0">
      <channel>
        <title>test</title>
        ${body}
      </channel>
    </rss>`;
}

describe("collectSocial newsroom noise gate", () => {
  it("drops soft-news/policy posts from newsroom outlets but keeps incident posts and official agency social", async () => {
    const realFetch = globalThis.fetch;
    const now = Date.now();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      // Newsroom feed: include one policy/feature post that previously could pass on generic "police/crime" language,
      // plus one clear incident post that must stay.
      if (/site:facebook\.com\/NewsChannel13|site:x\.com\/wnyt/i.test(url)) {
        return new Response(
          rss([
            {
              title: "Albany police leaders react to Raise the Age policy shift",
              link: "https://example.test/wnyt-policy",
              desc: "A policy story about youth justice. (No discrete incident.)",
            },
            {
              title: "Albany crash closes Central Avenue",
              link: "https://example.test/wnyt-crash",
              desc: "Emergency crews responded to a collision.",
            },
          ]),
          { status: 200, headers: { "content-type": "application/rss+xml" } },
        );
      }

      // Official agency social should remain aggressive even without incident keywords.
      if (/site:facebook\.com\/ColoniePD/i.test(url)) {
        return new Response(
          rss([
            {
              title: "Traffic advisory: delays near Wolf Road",
              link: "https://example.test/coloniepd-traffic",
              desc: "Expect backups this afternoon.",
            },
          ]),
          { status: 200, headers: { "content-type": "application/rss+xml" } },
        );
      }

      // Default: empty but successful.
      return new Response(rss([]), { status: 200, headers: { "content-type": "application/rss+xml" } });
    }) as typeof fetch;

    try {
      const out = await collectSocial(now);
      const titles = out.items.map((i) => i.title);
      assert.ok(titles.includes("Albany crash closes Central Avenue"), "incident newsroom post must stay");
      assert.ok(!titles.includes("Albany police leaders react to Raise the Age policy shift"), "policy newsroom post must drop");
      assert.ok(
        titles.includes("Traffic advisory: delays near Wolf Road"),
        "official agency social must stay even without incident keywords",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

