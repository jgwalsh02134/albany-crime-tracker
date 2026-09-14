import test from "node:test";
import assert from "node:assert/strict";

import { deriveGeoPrecisionFromAccuracy, isWitnessIncident } from "@/lib/witness";

test("deriveGeoPrecisionFromAccuracy is conservative", () => {
  assert.equal(deriveGeoPrecisionFromAccuracy(null), "road");
  assert.equal(deriveGeoPrecisionFromAccuracy(undefined), "road");
  assert.equal(deriveGeoPrecisionFromAccuracy(25), "street");
  assert.equal(deriveGeoPrecisionFromAccuracy(120), "road");
  assert.equal(deriveGeoPrecisionFromAccuracy(900), "town");
  assert.equal(deriveGeoPrecisionFromAccuracy(4000), "county");
});

test("isWitnessIncident detects Citizen · Witness sources", () => {
  const inc = {
    id: "x",
    minutesAgo: 1,
    occurredAt: new Date().toISOString(),
    title: "Witness report — Crash",
    type: "crash",
    category: "other",
    severity: "low",
    status: "active",
    municipality: "Capital District",
    address: "Pinned location",
    lat: 42.65,
    lng: -73.76,
    agency: "Citizen",
    agencyAbbr: "TIP",
    description: "Witness report — may be wrong.",
    sources: [{ kind: "social", name: "Citizen · Witness", tier: "unconfirmed", url: "/i/citizen-x", excerpt: "x" }],
    verification: "developing",
    origin: "live",
  } as const;
  assert.equal(isWitnessIncident(inc as any), true);
});

