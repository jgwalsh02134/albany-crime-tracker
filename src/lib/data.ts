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
    name: "NYSP Troop G / T blotter",
    tier: "Official",
    detail: "Daily public information reports. Crashes, DWI, arrests, and calls for service — not a news rewrite.",
  },
  {
    name: "Broadcastify Albany/Colonie PD",
    tier: "Scanner",
    detail: "Live P25 radio. Captions and Live cards from the stream are unconfirmed until a blotter or newsroom matches.",
  },
  {
    name: "511NY",
    tier: "Official",
    detail: "NYSDOT crashes and incidents on Capital Region roads when NY posts them.",
  },
  {
    name: "News10, CBS6, WNYT, WAMC",
    tier: "Newsroom",
    detail: "Journalism. Breaking crime under 24h also appears on Live. Older significant stories stay on News.",
  },
  {
    name: "Agency directory",
    tier: "Reference",
    detail: "Real Albany County departments with official seals, phones, and coverage. Not incident records.",
  },
  {
    name: "FBI NIBRS 2025",
    tier: "Official",
    detail: "Reported Crimes in the Nation, 2025 (released Aug 14, 2026) and the NIBRS agency map at nibrs.fbi.gov/2025.",
  },
  {
    name: "NYS DCJS index crimes",
    tier: "Official",
    detail: "Albany County agency counts (latest published year) via Open NY.",
  },
];
