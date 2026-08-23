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
