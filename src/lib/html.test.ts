import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeHtmlEntities } from "./html";

describe("decodeHtmlEntities", () => {
  it("decodes named and numeric entities", () => {
    assert.equal(decodeHtmlEntities("St. Patrick&#8217;s Club &#124; Sep 20"), "St. Patrick’s Club | Sep 20");
    assert.equal(decodeHtmlEntities("A &amp; B &lt; C"), "A & B < C");
    assert.equal(decodeHtmlEntities("&#x2014;"), "—");
    assert.equal(decodeHtmlEntities("A&nbsp;&nbsp;B"), "A B");
    assert.equal(decodeHtmlEntities("A&#160;&#160;B"), "A B");
  });

  it("leaves unknown entities untouched", () => {
    assert.equal(decodeHtmlEntities("x &madeup; y"), "x &madeup; y");
  });

  it("handles double-escaped entities (e.g. &amp;nbsp;)", () => {
    assert.equal(decodeHtmlEntities("A&amp;nbsp;&amp;nbsp;B"), "A B");
    assert.equal(decodeHtmlEntities("A&amp;#160;&amp;#160;B"), "A B");
  });
});

