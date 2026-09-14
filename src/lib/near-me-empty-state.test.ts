import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectNearMeEmptyState } from "./near-me-empty-state.ts";

describe("selectNearMeEmptyState", () => {
  const pos = { lat: 42.65, lng: -73.75, accM: 25, at: Date.now() };

  it("returns null when Near me is off", () => {
    assert.equal(selectNearMeEmptyState({ nearActive: false, pos: null, locateErrorKind: null }), null);
    assert.equal(selectNearMeEmptyState({ nearActive: false, pos, locateErrorKind: "denied" }), null);
  });

  it("treats denied/unavailable as not-quiet (no location fix)", () => {
    assert.equal(selectNearMeEmptyState({ nearActive: true, pos: null, locateErrorKind: "denied" }), "denied");
    assert.equal(selectNearMeEmptyState({ nearActive: true, pos: null, locateErrorKind: "unavailable" }), "unavailable");
  });

  it("treats no pos + no error as locating", () => {
    assert.equal(selectNearMeEmptyState({ nearActive: true, pos: null, locateErrorKind: null }), "locating");
  });

  it("only returns quiet when a position fix exists", () => {
    assert.equal(selectNearMeEmptyState({ nearActive: true, pos, locateErrorKind: null }), "quiet");
    assert.equal(selectNearMeEmptyState({ nearActive: true, pos, locateErrorKind: "denied" }), "quiet");
    assert.equal(selectNearMeEmptyState({ nearActive: true, pos, locateErrorKind: "unavailable" }), "quiet");
  });
});

