// ─────────────────────────────────────────────────────────────────────────────
// Shared utility functions — safe for both server and client components.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable "time ago" string from a Date or ISO string.
 */
export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin === 1) return "1 min ago";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH === 1) return "1 hr ago";
  if (diffH < 24) return `${diffH} hr ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

/**
 * Returns the age of a date in hours, or null if unparseable.
 */
export function ageHours(date: string | null | undefined): number | null {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3_600_000;
}

/**
 * Clamps a number between min and max.
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * Returns the severity CSS class suffix for a given severity string.
 */
export function severityClass(severity: string | undefined): string {
  const s = (severity || "").toLowerCase();
  if (s === "critical") return "sev-critical";
  if (s === "high") return "sev-high";
  if (s === "medium") return "sev-medium";
  return "sev-low";
}

/**
 * Maps an incident_type string to a broad crime category.
 */
export function crimeCategory(incidentType: string | undefined): "violent" | "property" | "other" {
  const v = (incidentType || "").toLowerCase();
  if (/violent|shooting|stabbing|homicide|assault/.test(v)) return "violent";
  if (/property|burglary|theft|robbery/.test(v)) return "property";
  return "other";
}

/**
 * Returns the dot color class for a crime category.
 */
export function dotClass(incidentType: string | undefined): string {
  const cat = crimeCategory(incidentType);
  if (cat === "violent") return "violent";
  if (cat === "property") return "property";
  return "other";
}

/**
 * Formats a frequency in Hz to MHz string.
 */
export function formatFreqMHz(hz: number | undefined): string {
  if (!hz) return "";
  const mhz = hz > 1e6 ? hz / 1e6 : hz;
  return `${mhz.toFixed(4)} MHz`;
}

/**
 * Returns the base API URL for server-side fetches.
 * Uses FASTAPI_URL env var (internal Railway URL) on the server.
 * Falls back to empty string (relative URL) on the client.
 */
export function getApiBase(): string {
  if (typeof window === "undefined") {
    // Server-side: use internal FastAPI URL
    return process.env.FASTAPI_URL || "http://localhost:8080";
  }
  // Client-side: use relative URL (Next.js rewrites proxy to FastAPI)
  return process.env.NEXT_PUBLIC_API_URL || "";
}

/**
 * Builds a query string from a params object, omitting null/undefined/empty values.
 */
export function toQueryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Returns the canonical display name for a responding agency ID.
 */
const AGENCY_DISPLAY_NAMES: Record<string, string> = {
  apd: "APD",
  acso: "ACSO",
  bethlehem_pd: "Bethlehem PD",
  colonie_pd: "Colonie PD",
  guilderland_pd: "Guilderland PD",
  cohoes_pd: "Cohoes PD",
  watervliet_pd: "Watervliet PD",
  coeymans_pd: "Coeymans PD",
  green_island_pd: "Green Island PD",
  menands_pd: "Menands PD",
  altamont_pd: "Altamont PD",
  nysp_troop_g: "NYSP Troop G",
  nysp_troop_t: "NYSP Troop T",
  nysp_capitol_x: "NYSP Capitol",
  nys_park_police: "NYS Park Police",
  dec_le: "DEC ECO",
  csx_police: "CSX Police",
  fbi_albany: "FBI",
  uapd: "UAPD",
};

export function agencyDisplayName(agencyId: string | null | undefined): string {
  if (!agencyId) return "";
  const aid = agencyId.trim().toLowerCase();
  if (!aid) return "";
  if (AGENCY_DISPLAY_NAMES[aid]) return AGENCY_DISPLAY_NAMES[aid];
  // Fallback: turn "some_new_pd" into "Some New PD"
  return aid
    .split("_")
    .map((w) => {
      if (!w) return "";
      if (w === "pd" || w === "po" || w === "le") return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * Returns 2-letter initials for a source name (e.g. "Times Union" → "TU").
 */
export function sourceInitials(sourceName: string | undefined): string {
  const s = (sourceName || "").trim();
  if (!s) return "·";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Infers the discipline (police/fire/ems) from a text blob.
 */
export function inferDiscipline(blob: string): "police" | "fire" | "ems" {
  const t = (blob || "").toLowerCase();
  if (/\b(fire|fd|rescue|brush|blaze|smoke|structure fire|alarm)\b/.test(t)) return "fire";
  if (/\b(ems|medic|ambulance|medical|cardiac)\b/.test(t)) return "ems";
  return "police";
}

/**
 * Infers the municipality from a text blob.
 */
export function inferMunicipality(blob: string): string {
  if (/colonie|latham/i.test(blob)) return "Colonie / Latham";
  if (/bethlehem|delmar|slingerlands|glenmont/i.test(blob)) return "Bethlehem / Delmar";
  if (/guilderland|altamont|westmere/i.test(blob)) return "Guilderland";
  if (/cohoes/i.test(blob)) return "Cohoes";
  if (/watervliet/i.test(blob)) return "Watervliet";
  if (/menands/i.test(blob)) return "Menands";
  if (/green island/i.test(blob)) return "Green Island";
  if (/ravena|coeymans|selkirk/i.test(blob)) return "Coeymans / Ravena";
  if (/voorheesville/i.test(blob)) return "Voorheesville";
  if (/sheriff|\bacso\b|county law|law dispatch|county-wide|countywide/i.test(blob)) return "County-wide";
  if (/albany\s*pd|\bapd\b|city of albany/i.test(blob)) return "Albany";
  if (/state\s*police|nysp|troop\s*[gG]/i.test(blob)) return "Latham / County-wide";
  if (/capitol|plaza|empire state/i.test(blob)) return "Downtown Albany";
  return "";
}
