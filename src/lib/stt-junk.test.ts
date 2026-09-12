import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSttJunk, STT_JUNK_SAMPLES, STT_KEEP_SAMPLES } from "./stt-junk.ts";

describe("isSttJunk", () => {
  for (const phrase of STT_JUNK_SAMPLES) {
    it(`rejects “${phrase}”`, () => {
      assert.equal(isSttJunk(phrase), true);
    });
  }

  for (const phrase of STT_KEEP_SAMPLES) {
    it(`keeps “${phrase}”`, () => {
      assert.equal(isSttJunk(phrase), false);
    });
  }

  it("rejects Thank you for watching (Whisper hallucination)", () => {
    assert.equal(isSttJunk("Thank you for watching."), true);
    assert.equal(isSttJunk("thank you for watching"), true);
  });

  it("rejects subscribe/music/silence boilerplate", () => {
    assert.equal(isSttJunk("Please subscribe"), true);
    assert.equal(isSttJunk("[Music]"), true);
    assert.equal(isSttJunk("(quiet)"), true);
  });
});
