import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeHtmlEntities, usableExcerpt } from "./html";

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

describe("usableExcerpt", () => {
  it("falls back to title when excerpt decodes to domain-only junk", () => {
    assert.equal(usableExcerpt("&nbsp;&nbsp; facebook.com", "Troopers investigate crash on I-87"), "Troopers investigate crash on I-87");
    assert.equal(usableExcerpt(" facebook.com ", "Albany PD update"), "Albany PD update");
    assert.equal(usableExcerpt("https://www.facebook.com/", "CBS6 post"), "CBS6 post");
    assert.equal(usableExcerpt("news.google.com", "Google News result title"), "Google News result title");
  });

  it("preserves a real excerpt after decode + whitespace cleanup", () => {
    assert.equal(usableExcerpt("Line&nbsp;&nbsp;1 &#32; Line&#32;2", "Fallback title"), "Line 1 Line 2");
  });

  it("treats pure whitespace as unusable (e.g. &#32;)", () => {
    assert.equal(usableExcerpt("&#32;", "Title wins"), "Title wins");
    assert.equal(usableExcerpt("   \n\t", "Title wins"), "Title wins");
  });
});

