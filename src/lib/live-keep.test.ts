import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasClearIncidentLanguageForNewsroomSocial,
  keepLiveNewsItem,
  keepNewsTabItem,
  keepSocialItem,
  isCitizenNonIncidentChatter,
  newsFreshnessScore,
  rankNewsItems,
  OUT_OF_AREA,
  CAPITAL_LOCAL,
} from "./live-keep.ts";

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
    assert.equal(
      keepLiveNewsItem({
        title: "Louisiana State Police press release on shooting",
        summary: "New Orleans area investigation continues.",
        minutesAgo: 10,
      }),
      false,
    );
    assert.equal(
      keepLiveNewsItem({
        title: "Portland police seek suspect after downtown stabbing",
        summary: "PortlandPolice.com released photos.",
        minutesAgo: 5,
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

  it("drops non-local public-safety without Capital Region cue", () => {
    assert.equal(
      keepLiveNewsItem({
        title: "Police arrest suspect after overnight shooting",
        summary: "Investigation ongoing.",
        minutesAgo: 20,
      }),
      false,
    );
  });
});

describe("keepNewsTabItem", () => {
  it("keeps Capital Region headlines", () => {
    assert.equal(
      keepNewsTabItem({
        title: "Bethlehem firefighters battle garage fire in Delmar",
        outlet: "Times Union",
        minutesAgo: 90,
      }),
      true,
    );
    assert.ok(CAPITAL_LOCAL.test("Delmar garage fire"));
  });

  it("keeps local-outlet stories even with thin geo", () => {
    assert.equal(
      keepNewsTabItem({
        title: "County officials update overnight incident",
        outlet: "News10",
        minutesAgo: 120,
      }),
      true,
    );
  });

  it("rejects Louisiana / Portland / Brooklyn on News tab", () => {
    assert.equal(
      keepNewsTabItem({
        title: "Louisiana deputies arrest three after crash",
        outlet: "AP",
        minutesAgo: 30,
      }),
      false,
    );
    assert.equal(
      keepNewsTabItem({
        title: "Portland police news conference",
        outlet: "Wire",
        minutesAgo: 15,
      }),
      false,
    );
    assert.equal(
      keepNewsTabItem({
        title: "Brooklyn shooting leaves one dead",
        outlet: "NY Post",
        minutesAgo: 20,
      }),
      false,
    );
  });
});

describe("newsFreshnessScore / rankNewsItems", () => {
  it("ranks fresher crime above stale blotter", () => {
    const rows = rankNewsItems([
      {
        id: "1",
        title: "NYSP overnight: petty larceny in Colonie",
        outlet: "NYSP blotter",
        minutesAgo: 600,
      },
      {
        id: "2",
        title: "Albany crash closes Central Avenue",
        outlet: "CBS6",
        minutesAgo: 25,
        image: "https://example.com/a.jpg",
      },
    ]);
    assert.equal(rows[0]!.id, "2");
    assert.ok(
      newsFreshnessScore({
        minutesAgo: 25,
        title: "Albany crash closes Central Avenue",
        hasImage: true,
        outlet: "CBS6",
      }) >
        newsFreshnessScore({
          minutesAgo: 600,
          title: "NYSP overnight: petty larceny in Colonie",
          outlet: "NYSP blotter",
        }),
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

describe("hasClearIncidentLanguageForNewsroomSocial", () => {
  it("keeps clear incident posts", () => {
    assert.equal(
      hasClearIncidentLanguageForNewsroomSocial({
        title: "Colonie crash on Wolf Road sends 2 to hospital",
        summary: "Police and EMS responded.",
      }),
      true,
    );
    assert.equal(
      hasClearIncidentLanguageForNewsroomSocial({
        title: "Albany police investigating shooting on Central Ave",
        summary: "No arrests yet.",
      }),
      true,
    );
    assert.equal(
      hasClearIncidentLanguageForNewsroomSocial({
        title: "Fire crews battle structure fire in Latham",
        summary: "Heavy smoke reported.",
      }),
      true,
    );
  });

  it("drops policy / feature posts that mention crime/police generically", () => {
    assert.equal(
      hasClearIncidentLanguageForNewsroomSocial({
        title: "Raise the Age policy story draws debate at the Capitol",
        summary: "Lawmakers discuss youth justice changes.",
      }),
      false,
    );
    assert.equal(
      hasClearIncidentLanguageForNewsroomSocial({
        title: "Crime trends shift in the Capital Region, officials say",
        summary: "A new report breaks down year-over-year changes.",
      }),
      false,
    );
    assert.equal(
      hasClearIncidentLanguageForNewsroomSocial({
        title: "VA outpatient clinic politics divide voters in Schenectady",
        summary: "Candidates spar over healthcare spending.",
      }),
      false,
    );
  });
});

describe("keepSocialItem Reddit/citizen chatter gate", () => {
  it("drops camera/footage requests (Erie Blvd regression)", () => {
    const title = "URGENT HELP NEEDED! Cameras facing Erie Blvd and Liberty St intersection?";
    const summary = "Looking for camera footage/video from last night's crash — please DM.";
    assert.equal(isCitizenNonIncidentChatter({ title, summary }), true);
    assert.equal(
      keepSocialItem(
        {
          title,
          summary,
          official: false,
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

  it("keeps real early Reddit crash reports (must stay)", () => {
    const title = "Crash on I-90 near Everett Rd — traffic backed up";
    const summary = "Unconfirmed but multiple cars involved. Police and EMS on scene.";
    assert.equal(isCitizenNonIncidentChatter({ title, summary }), false);
    assert.equal(
      keepSocialItem(
        {
          title,
          summary,
          official: false,
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
});
