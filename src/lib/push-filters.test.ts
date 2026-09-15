import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { distanceMiles, incidentInRadiusMiles, severityFloorMeets } from "./push-filters";

describe("push-filters", () => {
  test("severityFloorMeets enforces high/critical", () => {
    assert.equal(severityFloorMeets("critical", "critical"), true);
    assert.equal(severityFloorMeets("high", "critical"), false);
    assert.equal(severityFloorMeets("high", "high"), true);
    assert.equal(severityFloorMeets("medium", "high"), false);
  });

  test("distanceMiles is reasonable for short distances", () => {
    // Albany City Hall-ish to Capitol Building-ish: roughly half a mile.
    const a = { lat: 42.6526, lng: -73.7562 };
    const b = { lat: 42.6529, lng: -73.7549 };
    const mi = distanceMiles(a, b);
    assert.ok(mi > 0.05);
    assert.ok(mi < 2);
  });

  test("incidentInRadiusMiles matches within radius and falls back when geo missing", () => {
    const user = { lat: 42.6526, lng: -73.7562 };
    const near = { lat: 42.6529, lng: -73.7549, geoPrecision: "street" as const, address: "State St" };
    const far = { lat: 42.73, lng: -73.67, geoPrecision: "street" as const, address: "Somewhere else" };
    assert.equal(incidentInRadiusMiles(near, user, 1), true);
    assert.equal(incidentInRadiusMiles(far, user, 1), false);

    // Subscriber with no location: county-wide fallback.
    assert.equal(incidentInRadiusMiles(far, null, 1), true);
    // Incident with no reliable geo: county-wide fallback.
    const unknown = { lat: 42.6, lng: -73.7, geoPrecision: "county" as const, address: "area unknown" };
    assert.equal(incidentInRadiusMiles(unknown, user, 1), true);
  });
});

