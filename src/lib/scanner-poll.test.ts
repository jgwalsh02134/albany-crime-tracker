import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { classifyHlsState, classifySttState } from "./scanner-poll.ts";

function stopScannerTimer() {
  const g = globalThis as unknown as {
    __actScanTimer?: ReturnType<typeof setInterval>;
    __actScanTicking?: boolean;
    __actScan?: { ticking?: boolean };
  };
  if (g.__actScanTimer) {
    clearInterval(g.__actScanTimer);
    g.__actScanTimer = undefined;
  }
  if (g.__actScan) g.__actScan.ticking = false;
  g.__actScanTicking = false;
}

afterEach(() => {
  stopScannerTimer();
});

describe("scanner STT UI state", () => {
  it("prefers ok when speech is recent even if last error was 429", () => {
    stopScannerTimer();
    const g = globalThis as unknown as {
      __actScan?: {
        stats: { lastError: string; lastErrorAt: number; lastSpoken: string; lastSpokenAt: number };
        sttBlockedUntil: number;
      };
    };
    assert.ok(g.__actScan);
    const s = g.__actScan!;
    const now = Date.now();
    s.stats.lastError = "whisper-429";
    s.stats.lastErrorAt = now;
    s.stats.lastSpoken = "Central Avenue welfare check";
    s.stats.lastSpokenAt = now;
    s.sttBlockedUntil = 0;
    assert.equal(classifySttState(now), "ok");
  });

  it("reports busy when 429 is present and no recent speech", () => {
    stopScannerTimer();
    const g = globalThis as unknown as {
      __actScan?: {
        stats: { lastError: string; lastErrorAt: number; lastSpoken: string; lastSpokenAt: number };
        sttBlockedUntil: number;
      };
    };
    assert.ok(g.__actScan);
    const s = g.__actScan!;
    const now = Date.now();
    s.stats.lastError = "whisper-429";
    s.stats.lastErrorAt = now;
    s.stats.lastSpoken = "older speech";
    s.stats.lastSpokenAt = now - 10 * 60_000;
    s.sttBlockedUntil = 0;
    assert.equal(classifySttState(now), "busy");
  });
});

describe("scanner HLS UI state", () => {
  it("reports ok when a playlist was fetched recently", () => {
    stopScannerTimer();
    const g = globalThis as unknown as {
      __actScan?: {
        hls: { lastOkAt: number; lastError: string; lastErrorAt: number };
      };
    };
    assert.ok(g.__actScan);
    const s = g.__actScan!;
    const now = Date.now();
    s.hls.lastOkAt = now - 30_000;
    s.hls.lastError = "hls-resolve-failed";
    s.hls.lastErrorAt = now - 10_000;
    assert.equal(classifyHlsState(now), "ok");
  });

  it("reports error when HLS is failing and no recent ok was recorded", () => {
    stopScannerTimer();
    const g = globalThis as unknown as {
      __actScan?: {
        hls: { lastOkAt: number; lastError: string; lastErrorAt: number };
      };
    };
    assert.ok(g.__actScan);
    const s = g.__actScan!;
    const now = Date.now();
    s.hls.lastOkAt = now - 20 * 60_000;
    s.hls.lastError = "hls-resolve-failed";
    s.hls.lastErrorAt = now - 15_000;
    assert.equal(classifyHlsState(now), "error");
  });
});

