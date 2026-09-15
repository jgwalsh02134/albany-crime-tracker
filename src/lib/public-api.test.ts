import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicLiveResponseV1, incidentToPublicV1 } from "./public-api";
import type { Incident } from "./types";

function baseIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "evt-abc",
    minutesAgo: 5,
    occurredAt: new Date("2026-09-14T18:40:00.000Z").toISOString(),
    title: "Test incident",
    type: "Other",
    category: "other",
    severity: "low",
    status: "developing",
    municipality: "Albany",
    address: "area unknown",
    lat: 42.6526,
    lng: -73.7562,
    geoPrecision: undefined,
    agency: "Scanner",
    agencyAbbr: "SCAN",
    description: "Test incident",
    sources: [
      {
        kind: "scanner",
        name: "Broadcastify P25",
        tier: "unconfirmed",
        url: "https://example.com/scanner",
        excerpt: "call",
      },
    ],
    verification: "scanner",
    origin: "live",
    ...overrides,
  };
}

test("incidentToPublicV1 sets geoPrecision=unknown when missing", () => {
  const pub = incidentToPublicV1(baseIncident({ geoPrecision: undefined }));
  assert.equal(pub.geoPrecision, "unknown");
});

test("incidentToPublicV1 marks witness when a citizen memberId is present", () => {
  const pub = incidentToPublicV1(baseIncident({ memberIds: ["citizen-123"] }));
  assert.equal(pub.witness, true);
});

test("buildPublicLiveResponseV1 emits stable schema id", () => {
  const res = buildPublicLiveResponseV1([baseIncident()], Date.parse("2026-09-14T18:40:00.000Z"));
  assert.equal(res.ok, true);
  assert.equal(res.schema, "albany.watch/public-live/v1");
  assert.equal(res.incidents.length, 1);
});

test("incidentToPublicV1 decodes HTML entities in title and source excerpts", () => {
  const pub = incidentToPublicV1(
    baseIncident({
      title: "A&nbsp;&nbsp;B &#32; C",
      sources: [
        {
          kind: "news",
          name: "News&nbsp;10",
          tier: "context",
          url: "https://example.com/story",
          excerpt: "Line&nbsp;&nbsp;1 &#32; Line&#32;2",
        },
      ],
    }),
  );
  assert.equal(pub.title, "A B C");
  assert.equal(pub.sources[0]!.name, "News 10");
  assert.equal(pub.sources[0]!.excerpt, "Line 1 Line 2");
});

