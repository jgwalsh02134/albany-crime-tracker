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
import { wireToIncidents } from "./sources.ts";
import { compareNowLane } from "./live-rank.ts";
import type { Incident } from "./types.ts";

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

  it("does not fuse a Menands civic community event with a nearby Watervliet fire", () => {
    // Regression for production incident evt-c7oxzy:
    // a civic "craft fair" post (event/calendar) must not anchor/fuse into an unrelated nearby fire cluster.
    const civicEvent = item({
      id: "civic-menands-evt",
      title: "Menands St. Patrick’s Club Vendor Craft Fair | September 20th",
      kind: "news",
      outlet: "Civic · Menands",
      municipality: "Menands",
      address: "Broadway",
      // Within the old 1.6km fuse radius, but across a different concrete municipality.
      lat: 42.7072,
      lng: -73.7212,
      minutesAgo: 32,
      // Some WordPress feeds include boilerplate/nav text like "Fire District", which previously caused
      // this to be misclassified as a fire and fuse on proximity alone.
      summary: "Community calendar post. Menands Fire District info may appear in site boilerplate.",
    });
    const watervlietFire = item({
      id: "x-news10-fire",
      title: "Watervliet structure fire developing",
      kind: "social",
      outlet: "X · NEWS10",
      municipality: "Watervliet",
      address: "2nd Avenue",
      lat: 42.7144,
      lng: -73.7148,
      minutesAgo: 28,
      summary: "Fire crews responding to a reported structure fire.",
    });
    assert.equal(shouldFuse(civicEvent, watervlietFire), false);
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
    assert.match(lone.why, /not a CAD/i);
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

  it("treats all FB/X/Reddit as social (never official)", () => {
    assert.equal(sourceFamily("social", "Facebook · CBS6"), "social");
    assert.equal(sourceFamily("social", "X · Times Union"), "social");
    assert.equal(sourceFamily("social", "Facebook · Albany PD"), "social");
    assert.equal(sourceFamily("social", "X · Albany Police"), "social");
    assert.equal(sourceFamily("social", "Reddit · r/Albany"), "social");
  });
});

describe("scanner fusion honesty", () => {
  it("does not dissolve a weak unknown-place scanner into overnight blotter", () => {
    const blotter = item({
      id: "nysp-old",
      title: "Suspicious vehicle — Central Avenue",
      kind: "blotter",
      outlet: "NYSP blotter",
      municipality: "Albany",
      address: "Central Avenue",
      minutesAgo: 520,
      lat: 42.68,
      lng: -73.78,
    });
    const scan = item({
      id: "scan-1",
      title: "Suspicious person",
      summary: "Early report — area unclear",
      kind: "scanner",
      outlet: "Scanner",
      municipality: "Unknown",
      address: "area unknown",
      minutesAgo: 12,
      lat: 42.68,
      lng: -73.82,
    });
    assert.equal(shouldFuse(blotter, scan), false);
    const groups = clusterLiveItems([blotter, scan]);
    assert.equal(groups.length, 2);
  });

  it("still fuses scanner + blotter when street and call-type agree", () => {
    const blotter = item({
      id: "nysp-2",
      title: "Personal injury crash — Wolf Road, Latham",
      kind: "blotter",
      outlet: "NYSP blotter",
      municipality: "Colonie",
      address: "Wolf Road",
      minutesAgo: 90,
    });
    const scan = item({
      id: "scan-2",
      title: "Colonie PD · Wolf Road crash",
      summary: "Personal injury crash on Wolf Road",
      kind: "scanner",
      outlet: "Scanner",
      municipality: "Colonie",
      address: "Wolf Road · Colonie",
      minutesAgo: 20,
    });
    assert.equal(shouldFuse(blotter, scan), true);
  });
});

describe("fusion upgrade QA", () => {
  it("upgrades scanner-first into newsroom coverage (shared memberIds, one incident)", () => {
    const scan = item({
      id: "scan-early",
      title: "Wolf Road crash with injuries",
      summary: "Early report: Wolf Road crash with injuries",
      kind: "scanner",
      outlet: "Scanner",
      agency: "Colonie PD",
      municipality: "Unknown",
      address: "area unknown",
      minutesAgo: 12,
      lat: 42.747,
      lng: -73.759,
      geoPrecision: "town",
    });
    const news = item({
      id: "news-later",
      title: "Two hurt in Wolf Road crash in Latham",
      summary: "Police investigating a crash on Wolf Road in Latham.",
      kind: "news",
      outlet: "CBS6",
      municipality: "Colonie",
      address: "Wolf Road",
      minutesAgo: 75,
      lat: 42.748,
      lng: -73.758,
      geoPrecision: "street",
    });

    const incidents = wireToIncidents([scan, news]);
    assert.equal(incidents.length, 1);
    assert.ok(incidents[0]!.memberIds?.includes("scan-early"));
    assert.ok(incidents[0]!.memberIds?.includes("news-later"));
  });

  it("fuses weak-place scanner + later news when a corridor street is shared (even if muni is unknown)", () => {
    const scan = item({
      id: "scan-weak",
      title: "Crash on Wolf Road with injuries",
      summary: "Early report — location unclear",
      kind: "scanner",
      outlet: "Scanner",
      municipality: "Unknown",
      address: "area unknown",
      minutesAgo: 18,
      lat: 42.7179, // town-ish centroid (approx)
      lng: -73.8373,
      geoPrecision: "town",
    });
    const news = item({
      id: "news-wolf",
      title: "Wolf Road crash backs up traffic in Latham",
      summary: "Police say a crash happened on Wolf Road in Latham.",
      kind: "news",
      outlet: "CBS6",
      municipality: "Colonie",
      address: "Wolf Road",
      minutesAgo: 75,
      lat: 42.747,
      lng: -73.759,
      geoPrecision: "street",
    });
    assert.equal(shouldFuse(scan, news), true);
  });
});

function incident(partial: Partial<Incident> & Pick<Incident, "id" | "title">): Incident {
  const { id, title, ...rest } = partial;
  return {
    id,
    minutesAgo: 30,
    occurredAt: new Date().toISOString(),
    title,
    type: "public-safety",
    category: "other",
    severity: "medium",
    status: "active",
    municipality: "Albany",
    address: "Central Avenue",
    lat: 42.65,
    lng: -73.75,
    agency: "Albany Police",
    agencyAbbr: "APD",
    description: partial.title,
    sources: [],
    verification: "developing",
    origin: "live",
    corroborationScore: 10,
    ...rest,
  };
}

describe("compareNowLane", () => {
  it("prefers recent place-specific agency social in Now lane (still unconfirmed)", () => {
    const generic = incident({
      id: "generic",
      title: "Traffic alert",
      sources: [{ kind: "news", name: "News10", tier: "context", url: "https://example.test" }],
    });
    const official = incident({
      id: "official",
      title: "Traffic alert",
      sources: [{ kind: "social", name: "Facebook · Albany PD", tier: "unconfirmed", url: "https://example.test" }],
      geoPrecision: "street",
    });
    const sorted = [generic, official].sort(compareNowLane);
    assert.equal(sorted[0]!.id, "official");
  });
});

describe("provenance regression", () => {
  it("never upgrades agency Facebook posts to Official verification/tier", () => {
    const inc = wireToIncidents([
      item({
        id: "fb-apd-1",
        title: "Police investigating reported shots fired",
        kind: "social",
        outlet: "Facebook · Albany PD",
        municipality: "Albany",
        address: "Central Avenue",
        minutesAgo: 12,
      }),
    ])[0]!;
    assert.ok(inc, "expected an incident");
    assert.equal(inc.verification, "developing");
    assert.equal(inc.sources.some((s) => s.tier === "official"), false);
    assert.equal(inc.sources.some((s) => s.kind === "social"), true);
  });

  it("falls back to the title when a social summary is only a domain", () => {
    const title = "WNYT reports crash on Central Avenue";
    const inc = wireToIncidents([
      item({
        id: "fb-wnyt-1",
        title,
        summary: "&nbsp;&nbsp; facebook.com",
        kind: "social",
        outlet: "Facebook · WNYT",
        municipality: "Albany",
        address: "Central Avenue",
        minutesAgo: 22,
      }),
    ])[0]!;
    assert.ok(inc, "expected an incident");
    assert.equal(inc.description, title);
    assert.equal(inc.sources.length, 1);
    assert.equal(inc.sources[0]!.excerpt, title);
  });
});
