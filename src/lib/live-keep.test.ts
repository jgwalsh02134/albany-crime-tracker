import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasClearIncidentLanguageForNewsroomSocial,
  keepLiveNewsItem,
  keepNewsTabItem,
  keepSocialItem,
  isCitizenNonIncidentChatter,
  isLiveSoftPost,
  isSoftNonIncident,
  newsFreshnessScore,
  rankNewsItems,
  OUT_OF_AREA,
  CAPITAL_LOCAL,
} from "./live-keep.ts";
import { socialLive, socialNews } from "./social-sources.ts";
import type { LiveWireItem } from "./sources.ts";

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

  it("drops WALB, Effingham, and soft features from Live", () => {
    assert.equal(
      keepLiveNewsItem({
        title: "One hospitalized after crash in Albany - WALB",
        summary: "Albany, Georgia",
        minutesAgo: 20,
      }),
      false,
    );
    assert.equal(
      keepLiveNewsItem({
        title: "Altamont firehouse funding",
        summary: "Effingham Daily News",
        minutesAgo: 30,
      }),
      false,
    );
    assert.equal(
      keepLiveNewsItem({
        title: "Students seek spots in the EMT program",
        summary: "Albany EMS student feature",
        minutesAgo: 46,
      }),
      false,
    );
    assert.equal(isSoftNonIncident("NYSP Forensic Science Week open house"), true);
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

describe("isLiveSoftPost", () => {
  it("drops car-seat PSAs, fire-safety promos, and fundraising from Live", () => {
    const carSeat =
      "Is your child’s car seat installed correctly? Here’s a statistic that parents and caretakers should consider: approximately 80-90% of child seats are installed wrong.";
    const costco =
      "COSTCO FIRE SAFETY SAVINGS Looking to upgrade your home’s fire and carbon monoxide protection? Costco is currently offering savings on several detectors.";
    const wish =
      "Come see our team play this weekend as we go for the win and help raise money for the Make-A-Wish Vermont & Northeast New York";
    const flags = "Please take extra caution on Columbia St. Our members are out fixing the flags.";
    const recovery =
      "The Albany Fire Department Battalion Chief injured in a fuel pump explosion in August is making progress in his recovery.";
    for (const title of [carSeat, costco, wish, flags, recovery]) {
      assert.equal(isLiveSoftPost(title), true, title);
      assert.equal(keepLiveNewsItem({ title, summary: "Albany", minutesAgo: 70, local: true }), false, title);
    }
    assert.equal(
      keepNewsTabItem({ title: carSeat, summary: "NYSP", outlet: "Facebook · NYSP", minutesAgo: 70 }),
      true,
    );
  });

  it("keeps stabbing, crash, structure fire, and manhunt cards", () => {
    const keep = [
      "Colonie Police are investigating a reported stabbing near a CDTA bus stop between Colonie Center and Northway Mall.",
      "Police: Troy murder suspect wounded, captured in Georgia after an exchange of gunfire",
      "Albany Police announced the victim of a fatal rollover crash earlier this week near Krumkill Road has been identified",
      "Structure fire on North Swan Street in Albany",
      "Manhunt ends with arrest after a shooting in Albany",
    ];
    for (const title of keep) {
      assert.equal(isLiveSoftPost(title), false, title);
      assert.equal(keepLiveNewsItem({ title, minutesAgo: 40, local: true }), true, title);
    }
  });

  it("routes soft official posts to News and leaves serious posts on Live", () => {
    const soft: LiveWireItem = {
      id: "fb-nysp-seat",
      title: "Is your child’s car seat installed correctly? Here’s a statistic parents should consider.",
      url: "https://example.test/seat",
      outlet: "Facebook · NYSP",
      summary: "Child car seat inspection checkpoint.",
      publishedAt: new Date().toISOString(),
      minutesAgo: 72,
      kind: "social",
    };
    const costco: LiveWireItem = {
      id: "fb-westmere",
      title: "COSTCO FIRE SAFETY SAVINGS Looking to upgrade your home’s fire and carbon monoxide protection?",
      url: "https://example.test/costco",
      outlet: "Facebook · Westmere Fire",
      summary: "Costco is currently offering savings on detectors.",
      publishedAt: new Date().toISOString(),
      minutesAgo: 1384,
      kind: "social",
    };
    const wish: LiveWireItem = {
      id: "fb-apd-wish",
      title: "Come see our team play this weekend and help raise money for the Make-A-Wish",
      url: "https://example.test/wish",
      outlet: "Facebook · Albany PD",
      summary: "Make-A-Wish Vermont & Northeast New York",
      publishedAt: new Date().toISOString(),
      minutesAgo: 233,
      kind: "social",
    };
    const stab: LiveWireItem = {
      id: "fb-stab",
      title: "Colonie Police are investigating a reported stabbing near Colonie Center",
      url: "https://example.test/stab",
      outlet: "Facebook · Colonie PD",
      summary: "Reported stabbing Thursday afternoon.",
      publishedAt: new Date().toISOString(),
      minutesAgo: 30,
      kind: "social",
    };
    const rows = [soft, costco, wish, stab];
    assert.deepEqual(socialLive(rows).map((r) => r.id), ["fb-stab"]);
    assert.deepEqual(
      socialNews(rows).map((r) => r.id).sort(),
      ["fb-apd-wish", "fb-nysp-seat", "fb-westmere"],
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

  it("drops NYSP PR weeks even on official pages", () => {
    assert.equal(
      keepSocialItem(
        {
          title: "Forensic Science Week at the lab",
          summary: "NYSP public service post",
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
