import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NEWS_FEEDS } from "./news-feeds";
import { SUPERFEEDR_TOPICS } from "./superfeedr";

describe("news feeds registry", () => {
  it("has unique URLs", () => {
    const seen = new Set<string>();
    for (const f of NEWS_FEEDS) {
      assert.ok(f.url.startsWith("http"), f.url);
      assert.equal(seen.has(f.url), false, `duplicate NEWS_FEEDS url: ${f.url}`);
      seen.add(f.url);
    }
  });

  it("is fully covered by Superfeedr subscriptions", () => {
    const topics = new Set(SUPERFEEDR_TOPICS.map((t) => t.topic));
    for (const f of NEWS_FEEDS) {
      assert.equal(topics.has(f.url), true, `missing SUPERFEEDR topic for ${f.outlet}: ${f.url}`);
    }
  });
});

