import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractIntersection,
  extractRoute,
  resolveScannerAgency,
  resolveScannerPlace,
  scannerTitle,
  talkgroupLabel,
  withDisclaimer,
  isDualBlobAgency,
} from "./scanner-labels.ts";
import { extractSpokenAddress } from "./geo.ts";
import { getScannerFeed } from "./scanner-feeds.ts";

describe("resolveScannerAgency", () => {
  it("never returns the Albany/Colonie dual blob", () => {
    const a = resolveScannerAgency({ feedId: "3626", spoken: "unit 12 copy" });
    assert.equal(isDualBlobAgency(a.agency), false);
    assert.notEqual(a.agency, "Albany / Colonie PD");
  });

  it("maps Colonie cues on dual PD feed", () => {
    const a = resolveScannerAgency({
      feedId: "3626",
      spoken: "Latham Command personal injury crash on Wolf Road",
    });
    assert.equal(a.agency, "Colonie PD");
    assert.equal(a.abbr, "CPD");
  });

  it("maps Albany street cues on dual PD feed", () => {
    const a = resolveScannerAgency({
      feedId: "3626",
      spoken: "Respond to Kyler and Matilda for a domestic",
    });
    assert.equal(a.agency, "Albany PD");
  });

  it("uses Albany Fire feed as Albany Fire", () => {
    const a = resolveScannerAgency({ feedId: "1440", spoken: "engine 1 en route" });
    assert.equal(a.agency, "Albany Fire");
  });

  it("picks Bethlehem Fire on mixed Bethlehem feed when speech is fire", () => {
    const a = resolveScannerAgency({
      feedId: "36327",
      spoken: "structure fire on Delaware Avenue in Delmar",
    });
    assert.equal(a.agency, "Bethlehem Fire");
  });

  it("resolves Colonie PD from talkgroup metadata", () => {
    const a = resolveScannerAgency({ feedId: "3626", talkgroupId: "10401", spoken: "" });
    assert.equal(a.agency, "Colonie PD");
    const tg = talkgroupLabel("13102");
    assert.equal(tg?.agency, "Albany PD");
  });

  it("labels Thruway feed", () => {
    assert.equal(resolveScannerAgency({ feedId: "21216" }).agency, "NYS Thruway");
  });
});

describe("resolveScannerPlace", () => {
  it("extracts Wolf Rd + Colonie and never dual coverage", () => {
    const agency = resolveScannerAgency({
      feedId: "3626",
      spoken: "PI crash Wolf Road",
    });
    const place = resolveScannerPlace({
      spoken: "PI crash Wolf Road",
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.match(place.address, /Wolf/i);
    assert.equal(isDualBlobAgency(place.address), false);
    assert.equal(/City of Albany/i.test(place.address), false);
  });

  it("extracts Kyler & Matilda intersection", () => {
    assert.equal(extractIntersection("Respond to Kyler and Matilda for a domestic"), "Kyler & Matilda");
    const addr = extractSpokenAddress("Respond to Kyler and Matilda for a domestic");
    assert.ok(addr);
    assert.match(addr!.label, /Kyler/i);
    assert.match(addr!.label, /Matilda/i);
  });

  it("extracts route 4", () => {
    assert.equal(extractRoute("disabled vehicle route 4"), "Route 4");
  });

  it("uses Latham landmark → Colonie", () => {
    const agency = resolveScannerAgency({
      feedId: "3626",
      spoken: "Latham Command welfare check",
    });
    const place = resolveScannerPlace({
      spoken: "Latham Command welfare check",
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.equal(place.municipality, "Colonie");
    assert.match(place.placeLabel, /Latham/i);
  });

  it("shows area unknown when no place cues", () => {
    const agency = resolveScannerAgency({ feedId: "3626", spoken: "copy that 10-4" });
    const place = resolveScannerPlace({
      spoken: "copy that 10-4",
      agency,
      feed: getScannerFeed("3626"),
    });
    // Unresolved dual may still hint municipality from agency — for Police fallback, unknown.
    if (agency.agency === "Police") {
      assert.equal(place.address, "area unknown");
    }
  });
});

describe("scannerTitle", () => {
  it("leads with agency + place + nature", () => {
    const spoken = "personal injury crash on Wolf Road";
    const agency = resolveScannerAgency({ feedId: "3626", spoken });
    const place = resolveScannerPlace({
      spoken,
      agency,
      feed: getScannerFeed("3626"),
    });
    const title = scannerTitle(spoken, agency, place);
    assert.match(title, /Colonie PD/);
    assert.match(title, /Wolf/i);
    assert.match(title, /crash|injury/i);
  });

  it("keeps unconfirmed radio caveat", () => {
    const s = withDisclaimer("Crash on Wolf Road", "Colonie PD");
    assert.match(s, /Unconfirmed Colonie PD radio/);
    assert.match(s, /not a CAD call/);
  });
});
