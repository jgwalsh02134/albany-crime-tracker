import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractNyspText } from "./nysp-blotter.ts";

describe("NYSP blotter Live summaries", () => {
  it("includes defendant name and municipality for DWI-style arrests", () => {
    const text = `
Incident Number: NY2601105450 Incident Category: Vehicle - DWI
Date/Time Reported: September 06, 2026 01:06 AM Station: NEW SCOTLAND
Location Code: CITY - ALBANY - 0101 Incident Status: Arrest adult
Defendant Information:
Defendant (1) Name: HECTOR J SIVIRA ARICUCO Age: 38
Defendant Address: ORANGE, New Jersey
Date/Time of Arrest: 09/06/2026 01:14 AM Arrestee Status: Appearance ticket
Location of Arrest: CITY - ALBANY - 0101 Bail Amount:
Arrest Information:
VTL 1192 03 U Misdemeanor Driving While Intoxicated- 1st Offense 1
`;
    const now = Date.parse("2026-09-06T06:00:00.000Z");
    const items = extractNyspText(text, "G", 1, "https://example.test/pdf", now);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.match(item.title, /DWI/i);
    assert.match(item.title, /Hector/i);
    assert.match(item.title, /\bAlbany\b/i);
    assert.match(item.summary, /Hector/i);
    assert.match(item.summary, /\bin Albany\b/i);
    assert.doesNotMatch(item.summary, /Orange,\s*New Jersey/i);
  });

  it("does not surface juvenile placeholder names", () => {
    const text = `
Incident Number: NY2601107913 Incident Category: Kidnapping
Date/Time Reported: September 06, 2026 07:12 PM Station: NEW SCOTLAND
Location Code: CITY - ALBANY - 0101 Incident Status: Arrest adult
Defendant Information:
Defendant (1) Name: [JUVENILE] Age: 14
Defendant Address: ALBANY, New York
Date/Time of Arrest: 09/06/2026 07:17 PM Arrestee Status: Other
Location of Arrest: CITY - ALBANY - 0101 Bail Amount:
Arrest Information:
PL 135.20 00 D Felony Kidnapping in the second degree 1
`;
    const now = Date.parse("2026-09-07T00:00:00.000Z");
    const items = extractNyspText(text, "G", 1, "https://example.test/pdf", now);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.match(item.title, /\bAlbany\b/i);
    assert.doesNotMatch(item.title, /\[JUVENILE\]/i);
    assert.doesNotMatch(item.summary, /\[JUVENILE\]/i);
    assert.doesNotMatch(item.summary, /\bjuvenile\b/i);
  });
});

