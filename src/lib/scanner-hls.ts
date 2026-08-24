export type HlsSegment = { seq: number; url: string; duration: number };

export function parseM3u8(text: string, playlistUrl: string): HlsSegment[] {
  const lines = text.split(/\r?\n/);
  let seq = 0;
  let duration = 4;
  const segs: HlsSegment[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      seq = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      duration = Number.parseFloat(line.slice("#EXTINF:".length)) || 4;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    segs.push({ seq, url: new URL(line, playlistUrl).href, duration });
    seq += 1;
  }
  return segs;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/** Pull elementary MP3/AAC from a Broadcastify MPEG-TS segment. */
export function extractAudioFromMpegTs(ts: Uint8Array): {
  bytes: Uint8Array;
  mime: string;
  filename: string;
} | null {
  const start = findTsSync(ts);
  if (start < 0) return null;

  const chunks: number[] = [];
  let audioPid: number | null = null;

  for (let i = start; i + 188 <= ts.length; i += 188) {
    if (ts[i] !== 0x47) continue;
    const pusi = (ts[i + 1] & 0x40) !== 0;
    const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
    if (pid === 0 || pid === 0x1fff) continue;
    const adapt = (ts[i + 3] >> 4) & 0x3;
    let off = 4;
    if (adapt === 2 || adapt === 3) {
      const alen = ts[i + off] ?? 0;
      off += 1 + alen;
    }
    if ((adapt & 1) === 0 || off >= 188) continue;
    const payload = ts.subarray(i + off, i + 188);

    if (pusi) {
      if (payload.length < 9) continue;
      if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) continue;
      const streamId = payload[3]!;
      const isAudio = streamId >= 0xc0 && streamId <= 0xdf;
      if (!isAudio) {
        if (audioPid === pid) audioPid = null;
        continue;
      }
      if (audioPid == null) audioPid = pid;
      if (pid !== audioPid) continue;
      const hdrLen = payload[8]!;
      const dataStart = 9 + hdrLen;
      if (dataStart > payload.length) continue;
      for (let k = dataStart; k < payload.length; k++) chunks.push(payload[k]!);
    } else if (audioPid === pid) {
      for (let k = 0; k < payload.length; k++) chunks.push(payload[k]!);
    }
  }

  if (chunks.length < 64) return null;
  const bytes = new Uint8Array(chunks);
  const kind = sniffAudio(bytes);
  if (!kind) return null;
  return { bytes, mime: kind.mime, filename: kind.filename };
}

function findTsSync(ts: Uint8Array): number {
  for (let i = 0; i + 376 <= ts.length; i++) {
    if (ts[i] === 0x47 && ts[i + 188] === 0x47 && ts[i + 376] === 0x47) return i;
  }
  for (let i = 0; i + 188 <= ts.length; i++) {
    if (ts[i] === 0x47) return i;
  }
  return -1;
}

function sniffAudio(bytes: Uint8Array): { mime: string; filename: string } | null {
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    i = 10 + size;
  }
  while (i + 2 < bytes.length && bytes[i] !== 0xff) i++;
  if (i + 2 >= bytes.length) return null;
  const b1 = bytes[i + 1]!;
  if ((b1 & 0xe0) !== 0xe0) return null;
  const layer = (b1 >> 1) & 0x3;
  if (layer === 0) return { mime: "audio/aac", filename: "segment.aac" };
  return { mime: "audio/mpeg", filename: "segment.mp3" };
}
