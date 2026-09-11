import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callFingerprint,
  extractIntersection,
  extractRoute,
  isUnitStatusOnly,
  resolveScannerAgency,
  resolveScannerPlace,
  scannerTitle,
  talkgroupLabel,
  withDisclaimer,
  isDualBlobAgency,
} from "./scanner-labels.ts";
import {
  extractSpokenAddress,
  isLowConfidencePlace,
  normalizeScannerSpeech,
} from "./geo.ts";
import { getScannerFeed } from "./scanner-feeds.ts";

describe("resolveScannerAgency", () => {
  it("never returns the Albany/Colonie dual blob", () => {
    const a = resolveScannerAgency({ feedId: "3626", spoken: "unit 12 copy" });
    assert.equal(isDualBlobAgency(a.agency), false);
    assert.notEqual(a.agency, "Albany / Colonie PD");
  });

  it("never falls back to bare Police on known dual PD feed", () => {
    const a = resolveScannerAgency({ feedId: "3626", spoken: "unit 12 copy" });
    assert.notEqual(a.agency, "Police");
    assert.equal(a.agency, "Albany PD");
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
    assert.notEqual(a.agency, "Police");
  });

  it("picks Bethlehem Fire on mixed Bethlehem feed when speech is fire", () => {
    const a = resolveScannerAgency({
      feedId: "36327",
      spoken: "structure fire on Delaware Avenue in Delmar",
    });
    assert.equal(a.agency, "Bethlehem Fire");
  });

  it("defaults Bethlehem feed without cue to Bethlehem PD not Police", () => {
    const a = resolveScannerAgency({ feedId: "36327", spoken: "unit copy" });
    assert.notEqual(a.agency, "Police");
    assert.match(a.agency, /Bethlehem/);
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

  it("maps Sandwich/Sand Creek cue to Colonie PD", () => {
    const a = resolveScannerAgency({
      feedId: "3626",
      spoken: "respond Sandwich for a welfare check",
    });
    assert.equal(a.agency, "Colonie PD");
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

  it("shows area unknown when no place cues but keeps specific agency", () => {
    const agency = resolveScannerAgency({ feedId: "3626", spoken: "copy that 10-4" });
    assert.notEqual(agency.agency, "Police");
    const place = resolveScannerPlace({
      spoken: "copy that 10-4",
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.equal(place.address, "area unknown");
    assert.equal(place.known, false);
  });

  it("maps 1225 West Granite → 1225 Western Ave", () => {
    const spoken = "Respond to 1225 West Granite for a domestic";
    assert.match(normalizeScannerSpeech(spoken), /Western/i);
    const addr = extractSpokenAddress(spoken);
    assert.ok(addr);
    assert.match(addr!.label, /1225/);
    assert.match(addr!.label, /Western/i);
    const agency = resolveScannerAgency({ feedId: "3626", spoken });
    const place = resolveScannerPlace({
      spoken,
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.match(place.placeLabel, /Western/i);
    assert.notEqual(place.address, "area unknown");
  });

  it("maps Sandwich → Sand Creek Rd", () => {
    const spoken = "welfare check on Sandwich";
    const agency = resolveScannerAgency({ feedId: "3626", spoken });
    const place = resolveScannerPlace({
      spoken,
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.match(place.placeLabel, /Sand Creek/i);
    assert.equal(place.municipality, "Colonie");
  });

  it("maps Springsteen → Spring St", () => {
    const spoken = "suspicious on Springsteen";
    const addr = extractSpokenAddress(spoken);
    assert.ok(addr);
    assert.match(addr!.label, /Spring/i);
  });

  it("rejects Across This Triumph Street garbage", () => {
    const spoken = "Across This Triumph Street";
    assert.equal(extractSpokenAddress(spoken), null);
    assert.equal(isLowConfidencePlace("Across This Triumph Street"), true);
    const agency = resolveScannerAgency({ feedId: "3626", spoken });
    const place = resolveScannerPlace({
      spoken,
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.equal(place.known, false);
    assert.equal(place.address, "area unknown");
    const title = scannerTitle(spoken, agency, place);
    assert.equal(/Triumph|Trion|Across/i.test(title), false);
    assert.match(title, /Albany PD/);
    assert.match(title, /radio/);
  });

  it("rejects Across Is Trion Street garbage", () => {
    const spoken = "Across Is Trion Street for a check";
    assert.equal(isLowConfidencePlace("Across Is Trion Street"), true);
    const agency = resolveScannerAgency({ feedId: "3626", spoken });
    const place = resolveScannerPlace({
      spoken,
      agency,
      feed: getScannerFeed("3626"),
    });
    assert.equal(place.address, "area unknown");
    const title = scannerTitle(spoken, agency, place);
    assert.equal(/Trion|Across/i.test(title), false);
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

describe("dedupe fingerprints + unit status", () => {
  it("fingerprints garbled Western Ave variants as the same call", () => {
    const a = callFingerprint("domestic at 1225 West Granite");
    const b = callFingerprint("domestic at 1225 Western Avenue");
    assert.equal(a, b);
  });

  it("demotes in quarters / en route with no place", () => {
    assert.equal(isUnitStatusOnly("engine 1 in quarters"), true);
    assert.equal(isUnitStatusOnly("unit 12 en route"), true);
    assert.equal(isUnitStatusOnly("en route to Wolf Road crash"), false);
  });
});
