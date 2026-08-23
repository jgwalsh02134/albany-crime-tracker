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
};

export const SCANNER_FEEDS: ScannerFeed[] = [
  {
    id: "3626",
    name: "Albany / Colonie PD",
    shortName: "PD",
    coverage: "City of Albany & Town of Colonie",
    system: "P25 + analog simulcast",
    discipline: "police",
    url: "https://www.broadcastify.com/listen/feed/3626",
    hlsFallback: "https://hls-o1.broadcastify.com/s0/feed/3626/playlist.m3u8",
  },
  {
    id: "1440",
    name: "Albany Fire",
    shortName: "Fire",
    coverage: "City of Albany Fire",
    system: "AFD dispatch",
    discipline: "fire",
    url: "https://www.broadcastify.com/listen/feed/1440",
    hlsFallback: "https://hls-o1.broadcastify.com/s2/feed/1440/playlist.m3u8",
  },
  {
    id: "37206",
    name: "County volunteer fire",
    shortName: "Vol. fire",
    coverage: "Albany County volunteer companies",
    system: "County fire dispatch",
    discipline: "fire",
    url: "https://www.broadcastify.com/listen/feed/37206",
    hlsFallback: "https://hls-o1.broadcastify.com/s2/feed/37206/playlist.m3u8",
  },
  {
    id: "21216",
    name: "NYS Thruway",
    shortName: "Thruway",
    coverage: "NYS Thruway — Capital Region",
    system: "NYSTA",
    discipline: "all",
    url: "https://www.broadcastify.com/listen/feed/21216",
    hlsFallback: "https://hls-o1.broadcastify.com/s1/feed/21216/playlist.m3u8",
  },
];

export function getScannerFeed(id: string): ScannerFeed | undefined {
  return SCANNER_FEEDS.find((f) => f.id === id);
}
