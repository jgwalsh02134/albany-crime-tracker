import test from "node:test";
import assert from "node:assert/strict";

import { deriveGeoPrecisionFromAccuracy } from "@/lib/witness";

test("deriveGeoPrecisionFromAccuracy is conservative", () => {
  assert.equal(deriveGeoPrecisionFromAccuracy(null), "road");
  assert.equal(deriveGeoPrecisionFromAccuracy(undefined), "road");
  assert.equal(deriveGeoPrecisionFromAccuracy(25), "street");
  assert.equal(deriveGeoPrecisionFromAccuracy(120), "road");
  assert.equal(deriveGeoPrecisionFromAccuracy(900), "town");
  assert.equal(deriveGeoPrecisionFromAccuracy(4000), "county");
});

test("witness reports can be inserted and surfaced on wire", async () => {
  const { insertWitnessReport, witnessReportsToWire } = await import("./witness-reports.server");
  const now = Date.now();
  const id = `test-${now}`;
  await insertWitnessReport({
    id,
    kind: "crash",
    note: "Test crash report",
    lat: 42.65,
    lng: -73.76,
    geoPrecision: "road",
    accuracyM: null,
    userAgent: "node-test",
  });
  const wire = await witnessReportsToWire(now + 1000);
  const hit = wire.find((w) => w.id === `citizen-${id}`) ?? null;
  assert.ok(hit, "expected witness item in wire output");
  assert.equal(hit?.outlet, "Citizen · Witness");
  assert.equal(hit?.kind, "social");
  assert.equal(hit?.lat, 42.65);
  assert.equal(hit?.lng, -73.76);
});

