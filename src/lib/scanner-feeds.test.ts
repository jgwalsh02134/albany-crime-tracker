import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCANNER_FEEDS,
  assertScannerFallbacksHealthy,
  DEAD_HLS_HOSTS,
  hlsCandidateUrls,
} from "./scanner-feeds.ts";

describe("scanner HLS fallbacks", () => {
  it("does not point static fallbacks at known-dead hls-o1", () => {
    assert.doesNotThrow(() => assertScannerFallbacksHealthy());
    for (const feed of SCANNER_FEEDS) {
      for (const dead of DEAD_HLS_HOSTS) {
        assert.equal(feed.hlsFallback.includes(dead), false, feed.id);
      }
      assert.match(feed.hlsFallback, /hls-o2\.broadcastify\.com/);
    }
  });

  it("prefers o2 host variants ahead of o1", () => {
    const urls = hlsCandidateUrls("https://hls-o2.broadcastify.com/s0/feed/3626/playlist.m3u8");
    assert.ok(urls[0]!.includes("hls-o2"));
    assert.ok(urls.some((u) => u.includes("hls-o1"))); // still tried as last resort
  });
});
