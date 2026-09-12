/**
 * Normalize Broadcastify-extracted audio for OpenAI / Groq Whisper.
 * Raw ADTS AAC (audio/aac + .aac) is rejected with 400 — remux to m4a.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type PreparedAudio = {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  remuxed: boolean;
};

/** Formats Whisper documents as accepted uploads. */
export const WHISPER_OK_EXT = new Set([
  "flac",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "ogg",
  "wav",
  "webm",
]);

export function whisperUploadShape(
  filename: string,
  mime: string,
): { ok: boolean; reason?: string } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "aac" || mime === "audio/aac" || mime === "audio/aacp") {
    return { ok: false, reason: "raw-aac-not-accepted" };
  }
  if (!WHISPER_OK_EXT.has(ext)) {
    return { ok: false, reason: `ext-${ext || "none"}` };
  }
  return { ok: true };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg-${code}:${err.slice(-240)}`));
    });
  });
}

async function remuxAacToM4a(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "stt-aac-"));
  const inPath = join(dir, "in.aac");
  const outPath = join(dir, "out.m4a");
  try {
    await writeFile(inPath, bytes);
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inPath,
      "-c:a",
      "copy",
      "-f",
      "ipod",
      outPath,
    ]);
    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Returns Whisper-safe bytes/filename/mime.
 * MP3/MPEG pass through; AAC is remuxed to m4a via ffmpeg.
 */
export async function prepareAudioForWhisper(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<PreparedAudio> {
  const shape = whisperUploadShape(filename, mime);
  if (shape.ok) {
    return { bytes, filename, mime, remuxed: false };
  }
  if (
    shape.reason === "raw-aac-not-accepted" ||
    mime.includes("aac") ||
    filename.toLowerCase().endsWith(".aac")
  ) {
    const remuxed = await remuxAacToM4a(bytes);
    return { bytes: remuxed, filename: "segment.m4a", mime: "audio/mp4", remuxed: true };
  }
  try {
    const remuxed = await remuxAacToM4a(bytes);
    return { bytes: remuxed, filename: "segment.m4a", mime: "audio/mp4", remuxed: true };
  } catch {
    throw new Error(`whisper-unsupported-audio:${shape.reason ?? mime}`);
  }
}

/** Truncate provider error bodies for logs / health without dumping secrets. */
export function formatProviderErrorBody(status: number, body: string, prefix: string): string {
  const slim = body.replace(/\s+/g, " ").trim().slice(0, 160);
  return slim ? `${prefix}-${status}:${slim}` : `${prefix}-${status}`;
}
