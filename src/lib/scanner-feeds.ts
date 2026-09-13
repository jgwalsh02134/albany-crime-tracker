import type { Discipline } from "./types";

export type ScannerFeed = {
  id: string;
  name: string;
  shortName: string;
  coverage: string;
  system: string;
  discipline: Discipline | "all";
  url: string;
  hlsFallback: string;
  /** Specific Live agency labels for this feed (never dual blobs). */
  agencies: string[];
};

export const SCANNER_FEEDS: ScannerFeed[] = [
  {
    id: "3626",
    name: "Albany / Colonie PD",
    shortName: "APD/CPD",
    coverage: "City of Albany & Town of Colonie",
    system: "P25 + analog simulcast",
    discipline: "police",
    url: "https://www.broadcastify.com/listen/feed/3626",
    hlsFallback: "https://hls-o2.broadcastify.com/s0/feed/3626/playlist.m3u8",
    // Dual simulcast — resolve Albany PD vs Colonie PD from talkgroup / speech.
    agencies: ["Albany PD", "Colonie PD"],
  },
  {
    id: "36327",
    name: "Bethlehem PD / Fire / EMS",
    shortName: "Bethlehem",
    coverage: "Bethlehem Police, Delmar / Elsmere / Selkirk / Slingerlands fire, EMS",
    system: "County P25 talkgroups 10921–10931",
    discipline: "all",
    url: "https://www.broadcastify.com/listen/feed/36327",
    hlsFallback: "https://hls-o2.broadcastify.com/s2/feed/36327/playlist.m3u8",
    agencies: ["Bethlehem PD", "Bethlehem Fire", "Bethlehem EMS"],
  },
  {
    id: "1440",
    name: "Albany Fire",
    shortName: "AFD",
    coverage: "City of Albany Fire",
    system: "AFD dispatch",
    discipline: "fire",
    url: "https://www.broadcastify.com/listen/feed/1440",
    hlsFallback: "https://hls-o2.broadcastify.com/s2/feed/1440/playlist.m3u8",
    agencies: ["Albany Fire"],
  },
  {
    id: "37206",
    name: "County volunteer fire",
    shortName: "Vol fire",
    coverage: "Albany County volunteer companies",
    system: "County fire dispatch",
    discipline: "fire",
    url: "https://www.broadcastify.com/listen/feed/37206",
    hlsFallback: "https://hls-o2.broadcastify.com/s2/feed/37206/playlist.m3u8",
    agencies: ["County volunteer fire"],
  },
  {
    id: "21216",
    name: "NYS Thruway",
    shortName: "Thruway",
    coverage: "NYS Thruway — Capital Region",
    system: "NYSTA",
    discipline: "all",
    url: "https://www.broadcastify.com/listen/feed/21216",
    hlsFallback: "https://hls-o2.broadcastify.com/s1/feed/21216/playlist.m3u8",
    agencies: ["NYS Thruway"],
  },
];

export function getScannerFeed(id: string): ScannerFeed | undefined {
  return SCANNER_FEEDS.find((f) => f.id === id);
}

/** Hosts known dead (no DNS). Static fallbacks must never use these. */
export const DEAD_HLS_HOSTS = ["hls-o1.broadcastify.com"] as const;

export function assertScannerFallbacksHealthy(feeds = SCANNER_FEEDS): void {
  for (const feed of feeds) {
    for (const dead of DEAD_HLS_HOSTS) {
      if (feed.hlsFallback.includes(dead)) {
        throw new Error(`Scanner feed ${feed.id} hlsFallback still on dead host ${dead}`);
      }
    }
  }
}

/** Prefer listen-page HLS, then static fallback with o2/o1 host variants. */
export function hlsCandidateUrls(fallback: string, extracted: string[] = []): string[] {
  const hosts = ["hls-o2.broadcastify.com", "hls-o1.broadcastify.com"];
  const fleets = ["s0", "s1", "s2"];
  const out: string[] = [];
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  for (const u of extracted) push(u.split("?")[0]!);
  push(fallback);
  for (const base of [...out]) {
    for (const host of hosts) {
      push(base.replace(/https:\/\/hls-o[12]\.broadcastify\.com/, `https://${host}`));
    }
    for (const fleet of fleets) {
      push(base.replace(/\/s[0-2]\//, `/${fleet}/`));
    }
  }
  // Prefer working host first
  out.sort((a, b) => {
    const ao = a.includes("hls-o2") ? 0 : a.includes("hls-o1") ? 1 : 0;
    const bo = b.includes("hls-o2") ? 0 : b.includes("hls-o1") ? 1 : 0;
    return ao - bo;
  });
  return out;
}

