import incidentsRaw from "@/data/incidents.json";
import newsRaw from "@/data/news.json";
import callsRaw from "@/data/calls.json";
import talkgroups from "@/data/talkgroups.json";
import { deriveVerification, enrichSources } from "./sources";
import type {
  Category,
  Incident,
  NewsStory,
  ScannerCall,
  Severity,
} from "./types";

type Tg = {
  agency: string;
  dept: string;
  municipality: string;
  discipline: string;
  channel: string;
  priority: string;
};

const TG = talkgroups as Record<string, Tg>;

export function hydrateIncidents(now = Date.now()): Incident[] {
  return (incidentsRaw as (Omit<Incident, "occurredAt" | "sources"> & {
    sources: { kind: string; name: string; tier: string }[];
  })[])
    .map((row) => {
      const sources = enrichSources(row.sources, row.agencyAbbr, row.description);
      return {
        ...row,
        occurredAt: new Date(now - row.minutesAgo * 60_000).toISOString(),
        sources,
        verification: deriveVerification(sources, row.verification),
        origin: "snapshot" as const,
      };
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function hydrateNews(now = Date.now()): NewsStory[] {
  return (newsRaw as Omit<NewsStory, "occurredAt">[])
    .map((row) => ({
      ...row,
      occurredAt: new Date(now - row.minutesAgo * 60_000).toISOString(),
    }))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function hydrateCalls(now = Date.now()): ScannerCall[] {
  return (callsRaw as Omit<ScannerCall, "occurredAt" | "agency" | "channel" | "municipality">[])
    .map((row) => {
      const tg = TG[row.talkgroup];
      const discipline = (tg?.discipline as ScannerCall["discipline"] | undefined) ?? row.discipline;
      return {
        ...row,
        discipline,
        occurredAt: new Date(now - row.minutesAgo * 60_000).toISOString(),
        agency: tg?.agency ?? "Unknown agency",
        channel: tg?.channel ?? `TG ${row.talkgroup}`,
        municipality: tg?.municipality ?? "County-wide",
      };
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export function areaCounts(incidents: Incident[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const inc of incidents) {
    map.set(inc.municipality, (map.get(inc.municipality) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function lastHours(incidents: Incident[], hours: number, now = Date.now()): Incident[] {
  const cut = now - hours * 3600_000;
  return incidents.filter((i) => new Date(i.occurredAt).getTime() >= cut);
}

export function topCategory(incidents: Incident[]): string {
  const map = new Map<string, number>();
  for (const inc of incidents) {
    map.set(inc.type, (map.get(inc.type) ?? 0) + 1);
  }
  const top = [...map.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0].replace(/-/g, " ") : "—";
}

export function matchesFilters(
  inc: Incident,
  severities: Severity[],
  municipalities: string[],
  category: Category | "all",
): boolean {
  if (severities.length && !severities.includes(inc.severity)) return false;
  if (municipalities.length && !municipalities.includes(inc.municipality)) return false;
  if (category !== "all" && inc.category !== category) return false;
  return true;
}

export const YEARLY_TRENDS = [
  { year: "2016", violent: 1184, property: 5620 },
  { year: "2017", violent: 1211, property: 5488 },
  { year: "2018", violent: 1096, property: 5210 },
  { year: "2019", violent: 1042, property: 4984 },
  { year: "2020", violent: 1128, property: 4612 },
  { year: "2021", violent: 1246, property: 4430 },
  { year: "2022", violent: 1188, property: 4298 },
  { year: "2023", violent: 1074, property: 4016 },
  { year: "2024", violent: 996, property: 3788 },
  { year: "2025", violent: 952, property: 3610 },
];

export const NIBRS_AGENCIES = [
  {
    id: "apd",
    name: "Albany Police Department",
    ori: "NY0010100",
    population: 99224,
    violent: 842,
    property: 3104,
    coverage: "2024 full year",
    offenses: [
      { name: "Aggravated assault", n: 412 },
      { name: "Robbery", n: 188 },
      { name: "Rape", n: 46 },
      { name: "Murder", n: 12 },
      { name: "Burglary", n: 486 },
      { name: "Larceny", n: 2140 },
      { name: "Motor vehicle theft", n: 478 },
    ],
  },
  {
    id: "colonie",
    name: "Colonie Police",
    ori: "NY0010200",
    population: 85600,
    violent: 164,
    property: 1842,
    coverage: "2024 full year",
    offenses: [
      { name: "Aggravated assault", n: 92 },
      { name: "Robbery", n: 38 },
      { name: "Rape", n: 18 },
      { name: "Murder", n: 1 },
      { name: "Burglary", n: 214 },
      { name: "Larceny", n: 1410 },
      { name: "Motor vehicle theft", n: 218 },
    ],
  },
  {
    id: "bethlehem",
    name: "Bethlehem Police",
    ori: "NY0010300",
    population: 35100,
    violent: 28,
    property: 412,
    coverage: "2024 full year",
    offenses: [
      { name: "Aggravated assault", n: 16 },
      { name: "Robbery", n: 4 },
      { name: "Larceny", n: 322 },
      { name: "Burglary", n: 48 },
      { name: "Motor vehicle theft", n: 42 },
    ],
  },
  {
    id: "guilderland",
    name: "Guilderland Police",
    ori: "NY0010400",
    population: 32800,
    violent: 22,
    property: 508,
    coverage: "2024 full year",
    offenses: [
      { name: "Aggravated assault", n: 12 },
      { name: "Robbery", n: 6 },
      { name: "Larceny", n: 398 },
      { name: "Burglary", n: 54 },
      { name: "Motor vehicle theft", n: 56 },
    ],
  },
  {
    id: "acso",
    name: "Albany County Sheriff",
    ori: "NY0010000",
    population: 31400,
    violent: 48,
    property: 266,
    coverage: "2024 full year",
    offenses: [
      { name: "Aggravated assault", n: 28 },
      { name: "Robbery", n: 8 },
      { name: "Larceny", n: 176 },
      { name: "Burglary", n: 52 },
      { name: "Motor vehicle theft", n: 38 },
    ],
  },
];

export const SOURCES = [
  {
    name: "Albany Open Data (Socrata)",
    tier: "Official",
    detail: "Crimes, arrests, and calls-for-service by neighborhood. Fused when the portal is reachable.",
  },
  {
    name: "Agency blotters & Nixle",
    tier: "Official",
    detail: "APD, Colonie, Bethlehem, Guilderland, Cohoes, Watervliet, and ACSO public alerts.",
  },
  {
    name: "OpenMHz / Broadcastify",
    tier: "Scanner",
    detail: "Albany/Schenectady P25 talkgroups and live analog/digital radio streams. Not confirmed incidents.",
  },
  {
    name: "News10 live wire",
    tier: "Context",
    detail: "Public-safety headlines pulled from News10 RSS when the feed is reachable. Used as context, not confirmation.",
  },
  {
    name: "Capital Region newsrooms",
    tier: "Context",
    detail: "Times Union, CBS6, News10, Spectrum — used for developing context, never as the sole confirmation.",
  },
  {
    name: "NYS DCJS / FBI NIBRS",
    tier: "Official",
    detail: "Annual index-crime and incident-based reporting. Lagged, high confidence.",
  },
];
