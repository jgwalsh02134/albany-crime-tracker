import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveWindowHonesty } from "./live-honesty.ts";
import type { Incident } from "./types.ts";
import type { WireHealth } from "./sources.ts";

function inc(partial: Partial<Incident> & Pick<Incident, "id" | "title">): Incident {
  return {
    minutesAgo: 30,
    occurredAt: new Date().toISOString(),
    type: "crash",
    category: "other",
    severity: "high",
    status: "active",
    municipality: "Colonie",
    address: "Wolf Road",
    lat: 42.7,
    lng: -73.7,
    agency: "Scanner",
    agencyAbbr: "SCAN",
    description: partial.title,
    sources: [{ kind: "scanner", name: "Scanner", tier: "unconfirmed", url: "https://example.test" }],
    verification: "scanner",
    origin: "live",
    ...partial,
  };
}

const dryHealth: WireHealth = {
  blotter: 40,
  blotterFailed: 0,
  scanner: 0,
  traffic: 0,
  news: 0,
  captions: true,
  civic: 0,
  nws: 0,
  daytimePipesDry: true,
  daytimePipesFailing: false,
};

describe("liveWindowHonesty", () => {
  it("does not claim quiet when daytime pipes are dry", () => {
    const h = liveWindowHonesty({ health: dryHealth, nowItems: [], liveItems: [] });
    assert.equal(h.tone, "pipes-dry");
    assert.match(h.last3hCopy, /feed gap|empty|not/i);
    assert.doesNotMatch(h.last3hCopy, /^Quiet/i);
  });

  it("flags pipe failures explicitly", () => {
    const h = liveWindowHonesty({
      health: { ...dryHealth, daytimePipesFailing: true },
      nowItems: [],
      liveItems: [],
    });
    assert.equal(h.tone, "pipes-failing");
    assert.match(h.last3hCopy, /error/i);
  });

  it("distinguishes blotter-only daytime gap", () => {
    const h = liveWindowHonesty({
      health: { ...dryHealth, daytimePipesDry: false, blotter: 45, scanner: 0, news: 2 },
      nowItems: [],
      liveItems: [
        inc({
          id: "b1",
          title: "Blotter row",
          minutesAgo: 500,
          sources: [{ kind: "blotter", name: "NYSP blotter", tier: "official", url: "https://example.test" }],
          verification: "confirmed",
        }),
      ],
    });
    assert.equal(h.tone, "blotter-only");
    assert.match(h.last3hCopy, /7 AM dump/i);
  });

  it("mentions radio elsewhere when wire has scanner but window does not", () => {
    const radio = inc({ id: "s1", title: "Wolf Road crash", minutesAgo: 400 });
    const h = liveWindowHonesty({
      health: { ...dryHealth, scanner: 2, daytimePipesDry: false },
      nowItems: [],
      liveItems: [radio],
    });
    assert.equal(h.tone, "radio-elsewhere");
    assert.match(h.last3hCopy, /radio/i);
  });
});
