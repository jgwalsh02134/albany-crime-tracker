import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { classifySttState } from "./scanner-poll.ts";

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

