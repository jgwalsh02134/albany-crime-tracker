import type { Category, Incident, Severity } from "./types";

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

export const SOURCES = [
  {
    name: "News10, CBS6, WNYT",
    tier: "Newsroom",
    detail: "Live RSS. Every Live/News card is a real article with a link to the original story.",
  },
  {
    name: "Google News · Capital Region",
    tier: "Newsroom",
    detail: "Public-safety query for Albany County. Used when local desks syndicate a story.",
  },
  {
    name: "Broadcastify",
    tier: "Scanner",
    detail: "Live Albany County P25 audio. Captions are from the stream. No sample CAD log.",
  },
  {
    name: "Agency directory",
    tier: "Reference",
    detail: "Real Albany County departments, phones, and coverage areas. Not incident records.",
  },
  {
    name: "FBI CDE / NYS DCJS",
    tier: "Official",
    detail: "Linked out. Annual crime tables are not invented in this app.",
  },
];
