import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNixleRelativeMinutes, parseNixleWireHtml } from "./nixle-sources.ts";

const HTML = `
<ol id="wire">
  <li id="pub_12688417" class="first">
    <div class="wire_content">
      <h2 class="time">Entered: 22 hours, 37 minutes ago</h2>
      <p class="headline_agency">Upcoming Emergency No Parking Restrictions in Albany.  <a href="https://nixle.us/HMY99">More&nbsp;&raquo;</a></p>
    </div>
  </li>
  <li id="pub_9">
    <div class="wire_content">
      <h2 class="time">Entered: 4 minutes ago</h2>
      <p class="headline_agency">Colonie PD: crash on Wolf Road. <a href="https://nixle.us/ABC12">More</a></p>
    </div>
  </li>
</ol>
<script>var alerts = [];</script>
`;

describe("nixle html wire", () => {
  it("parses relative times", () => {
    assert.equal(parseNixleRelativeMinutes("Entered: 22 hours, 37 minutes ago"), 22 * 60 + 37);
    assert.equal(parseNixleRelativeMinutes("Entered: 1 day, 23 hours ago"), 1 * 24 * 60 + 23 * 60);
    assert.equal(parseNixleRelativeMinutes("Entered: 4 minutes ago"), 4);
  });

  it("reads alerts from the HTML wire when the script array is empty", () => {
    const now = Date.parse("2026-09-24T14:00:00Z");
    const rows = parseNixleWireHtml(HTML, now);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, "nixle-12688417");
    assert.match(rows[0]!.title, /No Parking/i);
    assert.equal(rows[0]!.url, "https://nixle.us/HMY99");
    assert.equal(rows[0]!.minutesAgo, 22 * 60 + 37);
    assert.equal(rows[1]!.minutesAgo, 4);
    assert.match(rows[1]!.title, /Wolf Road/i);
  });
});
