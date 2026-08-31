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
    detail: "Daily public information reports covering 7:01 AM yesterday through 7:00 AM today. Crashes, DWI, arrests, and calls — not a news rewrite.",
  },
  {
    name: "Broadcastify radio",
    tier: "Scanner",
    detail: "Albany/Colonie PD, Bethlehem PD/Fire/EMS, Albany Fire, volunteer fire, Thruway. Captions are unconfirmed. OpenMHz is blocked (403).",
  },
  {
    name: "511NY crashes",
    tier: "Official",
    detail: "NYSDOT accidentsAndIncidents in Albany, Rensselaer, Schenectady, Saratoga. Construction is not shown as crime. Often empty overnight.",
  },
  {
    name: "Department Facebook / X",
    tier: "Official",
    detail: "Albany, Colonie, Bethlehem, Cohoes, Watervliet, Guilderland PD pages plus NYSP and Albany Fire on X. APD posts on Facebook, not X.",
  },
  {
    name: "Town civic alerts",
    tier: "Official",
    detail: "Bethlehem, Guilderland, and Albany CivicPlus news flashes when they are crashes, arrests, or fires — not hiring or parking. Alert Center RSS is empty unless the city posts.",
  },
  {
    name: "Newsrooms",
    tier: "Newsroom",
    detail: "News10, CBS6, WNYT, WAMC, Patch, Times Union, Spotlight, Daily Gazette, FOX23. Breaking crime under 24h also appears on Live.",
  },
  {
    name: "Citizens",
    tier: "Unconfirmed",
    detail: "Reddit r/Albany, r/Troy, r/Schenectady and in-app ‘Saw something’ notes. Not 911. Citizen App, Ring, and Nextdoor have no public feed.",
  },
  {
    name: "NWS warnings",
    tier: "Official",
    detail: "Tornado, flash flood, severe thunderstorm, blizzard, and civil-emergency warnings for the Capital District. Advisories are skipped.",
  },
  {
    name: "Not public",
    tier: "Blocked",
    detail: "No live CAD from Albany, Colonie, or Bethlehem. PulsePoint, OpenMHz, SpotCrime, CrimeMapping, Nixle, jail bookings, NY-Alert, Waze, and Meta Graph are closed or empty.",
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
