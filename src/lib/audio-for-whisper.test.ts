import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatProviderErrorBody,
  prepareAudioForWhisper,
  whisperUploadShape,
} from "./audio-for-whisper.ts";
import { preferFallbackError } from "./transcribe.ts";

describe("whisperUploadShape", () => {
  it("rejects raw AAC that OpenAI Whisper does not accept", () => {
    assert.equal(whisperUploadShape("segment.aac", "audio/aac").ok, false);
    assert.equal(whisperUploadShape("segment.aac", "audio/aac").reason, "raw-aac-not-accepted");
  });

  it("accepts mp3 / m4a upload shapes Whisper documents", () => {
    assert.equal(whisperUploadShape("segment.mp3", "audio/mpeg").ok, true);
    assert.equal(whisperUploadShape("segment.m4a", "audio/mp4").ok, true);
  });
});

describe("formatProviderErrorBody", () => {
  it("includes status and truncated body for health / logs", () => {
    const msg = formatProviderErrorBody(400, '{"error":{"message":"Invalid file format"}}', "whisper");
    assert.match(msg, /^whisper-400:/);
    assert.match(msg, /Invalid file format/);
  });
});

describe("preferFallbackError", () => {
  it("surfaces whisper-400 instead of masking as stt-403", () => {
    assert.equal(preferFallbackError("stt-403", "whisper-400:Invalid file format"), "whisper-400:Invalid file format");
  });
});

describe("prepareAudioForWhisper", () => {
  it("remuxes AAC to m4a when ffmpeg is available", async () => {
    const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    if (ff.status !== 0) {
      console.log("# skip remux — ffmpeg missing");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "stt-test-"));
    const wav = join(dir, "t.wav");
    const aac = join(dir, "t.aac");
    try {
      const mkWav = spawnSync(
        "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", wav],
        { encoding: "utf8" },
      );
      assert.equal(mkWav.status, 0, mkWav.stderr);
      const mkAac = spawnSync(
        "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "64k", aac],
        { encoding: "utf8" },
      );
      assert.equal(mkAac.status, 0, mkAac.stderr);
      const bytes = new Uint8Array(readFileSync(aac));
      const prepared = await prepareAudioForWhisper(bytes, "segment.aac", "audio/aac");
      assert.equal(prepared.remuxed, true);
      assert.equal(prepared.filename, "segment.m4a");
      assert.equal(prepared.mime, "audio/mp4");
      assert.ok(prepared.bytes.byteLength > 32);
      assert.equal(whisperUploadShape(prepared.filename, prepared.mime).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes mp3 through unchanged", async () => {
    const sample = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
    const prepared = await prepareAudioForWhisper(sample, "segment.mp3", "audio/mpeg");
    assert.equal(prepared.remuxed, false);
    assert.equal(prepared.filename, "segment.mp3");
  });
});
