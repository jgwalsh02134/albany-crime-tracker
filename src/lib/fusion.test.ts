import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCall,
  clusterLiveItems,
  compareFused,
  haversineKm,
  scoreCorroboration,
  seenOnFromItems,
  shouldFuse,
  sourceFamily,
} from "./fusion.ts";
import type { LiveWireItem } from "./sources.ts";

function item(partial: Partial<LiveWireItem> & Pick<LiveWireItem, "id" | "title">): LiveWireItem {
  return {
    url: `https://example.test/${partial.id}`,
    outlet: "News10",
    summary: partial.title,
    publishedAt: new Date().toISOString(),
    minutesAgo: 20,
    kind: "news",
    municipality: "Colonie",
    address: "Wolf Road",
    lat: 42.747,
    lng: -73.759,
    ...partial,
  };
}

describe("classifyCall", () => {
  it("maps crash and DWI into the crash family", () => {
    assert.equal(classifyCall("Personal injury crash on Wolf Road").family, "crash");
    assert.equal(classifyCall("DWI arrest after stop on Route 7").family, "crash");
  });
  it("does not treat a fire as a crash", () => {
    assert.equal(classifyCall("Two-alarm fire on Delaware Avenue").family, "fire");
  });
});

describe("shouldFuse", () => {
  it("clusters blotter + 511 + news for the same Wolf Road crash", () => {
    const blotter = item({
      id: "nysp-1",
      title: "Personal injury crash — Wolf Road, Latham",
      kind: "blotter",
      outlet: "NYSP blotter",
      municipality: "Colonie",
      minutesAgo: 80,
    });
    const traffic = item({
      id: "511-1",
      title: "Injury crash — Wolf Road",
      kind: "traffic",
      outlet: "511NY",
      municipality: "Colonie",
      minutesAgo: 25,
    });
    const news = item({
      id: "news-1",
      title: "Two hurt in Wolf Road crash in Latham",
      kind: "news",
      outlet: "News10",
      municipality: "Colonie",
      minutesAgo: 40,
    });
    assert.equal(shouldFuse(blotter, traffic), true);
    assert.equal(shouldFuse(traffic, news), true);
    const groups = clusterLiveItems([blotter, traffic, news]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.length, 3);
  });

  it("does not fuse a Colonie crash with a Bethlehem fire", () => {
    const crash = item({
      id: "a",
      title: "Crash on Wolf Road",
      kind: "traffic",
      outlet: "511NY",
      municipality: "Colonie",
      lat: 42.747,
      lng: -73.759,
    });
    const fire = item({
      id: "b",
      title: "Structure fire on Delaware Avenue",
      kind: "scanner",
      outlet: "Scanner",
      municipality: "Bethlehem",
      address: "Delaware Avenue",
      lat: 42.622,
      lng: -73.832,
      minutesAgo: 22,
    });
    assert.equal(shouldFuse(crash, fire), false);
  });

  it("does not fuse two same-type calls miles apart", () => {
    const colonie = item({
      id: "c1",
      title: "Crash on Wolf Road",
      kind: "traffic",
      outlet: "511NY",
      municipality: "Colonie",
      lat: 42.747,
      lng: -73.759,
    });
    const troy = item({
      id: "c2",
      title: "Crash on Congress Street",
      kind: "traffic",
      outlet: "511NY",
      municipality: "Troy",
      address: "Congress Street",
      lat: 42.7284,
      lng: -73.6918,
    });
    assert.ok(haversineKm({ lat: colonie.lat!, lng: colonie.lng! }, { lat: troy.lat!, lng: troy.lng! }) > 2);
    assert.equal(shouldFuse(colonie, troy), false);
  });
});

describe("corroboration", () => {
  it("scores official families above a lone scanner", () => {
    const scanner = item({
      id: "scan-1",
      title: "Crash on Wolf Road",
      kind: "scanner",
      outlet: "Scanner",
      agency: "Colonie PD",
    });
    const blotter = item({
      id: "nysp-1",
      title: "Personal injury crash — Wolf Road",
      kind: "blotter",
      outlet: "NYSP blotter",
    });
    const news = item({
      id: "news-1",
      title: "Wolf Road crash in Latham",
      kind: "news",
      outlet: "CBS6",
    });
    const lone = scoreCorroboration([scanner]);
    const multi = scoreCorroboration([blotter, scanner, news]);
    assert.ok(lone.score <= 22, `lone scanner score ${lone.score}`);
    assert.ok(multi.score > lone.score, `multi ${multi.score} should beat lone ${lone.score}`);
    assert.ok(multi.independent >= 3);
    assert.match(lone.why, /not CAD/i);
  });

  it("sorts multi-source ahead of a newer lone scanner", () => {
    const multi = { corroborationScore: 70, minutesAgo: 40 };
    const lone = { corroborationScore: 16, minutesAgo: 5 };
    assert.ok(compareFused(multi, lone) < 0);
  });

  it("lists Seen on chips without inventing CAD", () => {
    const chips = seenOnFromItems([
      item({ id: "nysp-1", title: "Crash", kind: "blotter", outlet: "NYSP blotter" }),
      item({ id: "scan-1", title: "Crash", kind: "scanner", outlet: "Broadcastify" }),
      item({ id: "511-1", title: "Crash", kind: "traffic", outlet: "511NY" }),
    ]);
    assert.deepEqual(
      chips.map((c) => c.label),
      ["Blotter", "Scanner", "511"],
    );
    assert.equal(
      chips.some((c) => /cad/i.test(c.label)),
      false,
    );
  });

  it("treats 511 as official traffic, not CAD", () => {
    assert.equal(sourceFamily("traffic", "511NY"), "511");
  });
});
