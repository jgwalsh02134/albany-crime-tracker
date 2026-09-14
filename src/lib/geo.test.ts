import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COUNTY_CENTROID,
  extractSpokenAddress,
  isApproxPrecision,
  isLowConfidencePlace,
  locateSpoken,
  normalizeScannerSpeech,
  placeFromText,
} from "./geo.ts";
import { resolveScannerAgency, resolveScannerPlace } from "./scanner-labels.ts";
import { getScannerFeed } from "./scanner-feeds.ts";

describe("street-level locateSpoken", () => {
  it("pins Central Ave to a street midpoint, not downtown City Hall", () => {
    const pin = locateSpoken("PI crash on Central Avenue", "Albany");
    assert.equal(pin.precision, "street");
    assert.match(pin.road, /Central/i);
    assert.ok(Math.abs(pin.geo.lat - 42.6526) > 0.005 || Math.abs(pin.geo.lng - -73.7562) > 0.01);
    assert.ok(pin.geo.lat > 42.65 && pin.geo.lat < 42.72);
  });

  it("pins Wolf Rd in Colonie corridor", () => {
    const pin = locateSpoken("personal injury crash on Wolf Road", "Colonie");
    assert.equal(pin.precision, "street");
    assert.match(pin.road, /Wolf/i);
    assert.ok(pin.geo.lat > 42.70 && pin.geo.lat < 42.76);
    assert.ok(pin.geo.lng > -73.84 && pin.geo.lng < -73.78);
  });

  it("averages Kyler & Matilda as intersection precision", () => {
    const addr = extractSpokenAddress("Respond to Kyler and Matilda for a domestic");
    assert.ok(addr);
    assert.equal(addr!.precision, "intersection");
    const pin = locateSpoken("Respond to Kyler and Matilda for a domestic", "Albany");
    assert.equal(pin.precision, "intersection");
    assert.match(pin.road, /Kyler/i);
    assert.match(pin.road, /Matilda/i);
  });

  it("keeps Broadway / New Scotland / Delaware / Western as street pins", () => {
    for (const [spoken, re] of [
      ["shots fired Broadway near Livingston", /Broadway/i],
      ["structure fire New Scotland Avenue", /New Scotland/i],
      ["alarm Delaware Avenue Delmar", /Delaware/i],
      ["domestic 1400 Western Avenue", /Western/i],
    ] as const) {
      const pin = locateSpoken(spoken, "Albany");
      assert.equal(pin.precision, "street", spoken);
      assert.match(pin.road, re, spoken);
    }
  });

  it("uses county centroid + unknown precision when no place cues", () => {
    const pin = locateSpoken("copy that 10-4", "");
    assert.equal(pin.precision, "county");
    assert.equal(pin.geo.lat, COUNTY_CENTROID.lat);
    assert.equal(pin.geo.lng, COUNTY_CENTROID.lng);
    assert.equal(isApproxPrecision(pin.precision), true);
  });

  it("town-only speech is approx town precision, not street", () => {
    const pin = locateSpoken("Bethlehem units staging", "Bethlehem");
    assert.equal(pin.precision, "town");
    assert.equal(isApproxPrecision(pin.precision), true);
  });

  it("maps Crossgates landmark", () => {
    const pin = locateSpoken("disturbance at Crossgates", "Guilderland");
    assert.equal(pin.precision, "landmark");
    assert.match(pin.road, /Crossgates/i);
  });

  it("STT Centeral → Central", () => {
    assert.match(normalizeScannerSpeech("Centeral Avenue crash"), /Central/i);
    const addr = extractSpokenAddress("Centeral Avenue crash");
    assert.ok(addr);
    assert.match(addr!.label, /Central/i);
  });
});

describe("geocode fallbacks stay honest", () => {
  it("treats somewhere/take/area as low-confidence place stems", () => {
    assert.equal(isLowConfidencePlace("Somewhere"), true);
    assert.equal(isLowConfidencePlace("Take"), true);
    assert.equal(isLowConfidencePlace("area unknown"), true);
    assert.equal(isLowConfidencePlace("please"), true);
  });

  it("rejects Triumph Street garbage", () => {
    assert.equal(extractSpokenAddress("Across This Triumph Street"), null);
    assert.equal(isLowConfidencePlace("Across This Triumph Street"), true);
    const pin = locateSpoken("Across This Triumph Street", "Albany");
    assert.ok(pin.precision === "town" || pin.precision === "county");
  });

  it("placeFromText still finds Colonie", () => {
    const p = placeFromText("Colonie PD Latham Command");
    assert.ok(p);
    assert.equal(p!.name, "Colonie");
  });

  it("scanner place + locate agree on Wolf Rd Colonie", () => {
    const spoken = "PI crash Wolf Road";
    const agency = resolveScannerAgency({ feedId: "3626", spoken });
    const place = resolveScannerPlace({ spoken, agency, feed: getScannerFeed("3626") });
    const pin = locateSpoken(spoken, place.municipality || "Colonie");
    assert.match(place.placeLabel, /Wolf/i);
    assert.equal(place.municipality, "Colonie");
    assert.equal(pin.precision, "street");
  });
});


describe("Central Ave STT normalize", () => {
  it("maps sentral / on the central to Central Avenue", () => {
    const a = normalizeScannerSpeech("respond sentral for a crash");
    assert.match(a, /Central/i);
    const b = normalizeScannerSpeech("on the central welfare check");
    assert.match(b, /Central Avenue/i);
    const addr = extractSpokenAddress("92 Central Avenue welfare check");
    assert.ok(addr);
    assert.match(addr!.label, /Central/i);
  });
});
