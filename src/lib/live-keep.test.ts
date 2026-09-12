import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepLiveNewsItem, keepSocialItem, OUT_OF_AREA } from "./live-keep.ts";

const DROP = /\b(hiring|join our team|ice cream)\b/i;
const NOT_OURS = /\b(brooklyn|albany,? georgia)\b/i;
const TITLE_CRIME = /\b(crash|shooting|arrest|fire|police)\b/i;

describe("keepLiveNewsItem", () => {
  it("keeps local crime news", () => {
    assert.equal(
      keepLiveNewsItem({
        title: "Colonie police arrest two after Wolf Road crash",
        summary: "Troopers responded in Albany County.",
        minutesAgo: 40,
      }),
      true,
    );
  });

  it("rejects clear out-of-area national junk", () => {
    assert.equal(
      keepLiveNewsItem({
        title: "Philippines ferry disaster kills dozens",
        summary: "Rescuers search after ferry sinks.",
        minutesAgo: 20,
      }),
      false,
    );
    assert.equal(
      keepLiveNewsItem({
        title: "Mississippi man arrested after shooting",
        summary: "Authorities in Mississippi.",
        minutesAgo: 15,
      }),
      false,
    );
    assert.ok(OUT_OF_AREA.test("Kingston, NY police blotter"));
  });

  it("drops stale items past the live window", () => {
    assert.equal(
      keepLiveNewsItem({
        title: "Albany fire on Central Ave",
        minutesAgo: 30 * 60,
      }),
      false,
    );
  });
});

describe("keepSocialItem", () => {
  it("keeps official social without crime keywords", () => {
    assert.equal(
      keepSocialItem(
        {
          title: "Traffic advisory: Western Ave delays near Crossgates",
          summary: "Expect backups through the evening commute.",
          official: true,
          needsLocal: false,
          localMatch: true,
        },
        DROP,
        NOT_OURS,
        TITLE_CRIME,
      ),
      true,
    );
    assert.equal(
      keepSocialItem(
        {
          title: "Press conference at 3 PM regarding overnight incident",
          official: true,
          needsLocal: false,
          localMatch: true,
        },
        DROP,
        NOT_OURS,
        TITLE_CRIME,
      ),
      true,
    );
  });

  it("still drops hiring spam on official pages", () => {
    assert.equal(
      keepSocialItem(
        {
          title: "Now hiring — join our team",
          official: true,
          needsLocal: false,
          localMatch: true,
        },
        DROP,
        NOT_OURS,
        TITLE_CRIME,
      ),
      false,
    );
  });
});
