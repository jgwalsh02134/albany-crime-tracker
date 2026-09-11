/**
 * Resolve specific agency + place labels for Live scanner items.
 * Never emit the dual-feed blob ("Albany / Colonie PD", combined coverage)
 * when a more specific agency or place can be inferred.
 */
import talkgroups from "../data/talkgroups.json";
import { extractSpokenAddress, placeFromText, type Geo } from "./geo";
import { getScannerFeed, type ScannerFeed } from "./scanner-feeds";

export type TalkgroupMeta = {
  agency: string;
  dept: string;
  municipality: string;
  discipline: string;
  channel: string;
  priority: string;
};

const TG = talkgroups as Record<string, TalkgroupMeta>;

/** Short Live-facing agency labels (never dual blobs). */
export type AgencyLabel = {
  /** Display name, e.g. "Colonie PD" */
  agency: string;
  /** Compact abbr for badges */
  abbr: string;
  /** Canonical municipality when known from feed/talkgroup */
  municipalityHint?: string;
  discipline: "police" | "fire" | "ems" | "all";
};

/** Feed-level agency candidates — dual feeds list more than one. */
const FEED_AGENCIES: Record<string, AgencyLabel[]> = {
  "3626": [
    { agency: "Albany PD", abbr: "APD", municipalityHint: "Albany", discipline: "police" },
    { agency: "Colonie PD", abbr: "CPD", municipalityHint: "Colonie", discipline: "police" },
  ],
  "36327": [
    { agency: "Bethlehem PD", abbr: "BPD", municipalityHint: "Bethlehem", discipline: "police" },
    { agency: "Bethlehem Fire", abbr: "BFD", municipalityHint: "Bethlehem", discipline: "fire" },
    { agency: "Bethlehem EMS", abbr: "BEMS", municipalityHint: "Bethlehem", discipline: "ems" },
  ],
  "1440": [{ agency: "Albany Fire", abbr: "AFD", municipalityHint: "Albany", discipline: "fire" }],
  "37206": [
    { agency: "County volunteer fire", abbr: "ACFD", municipalityHint: "Albany", discipline: "fire" },
  ],
  "21216": [{ agency: "NYS Thruway", abbr: "NYSTA", discipline: "all" }],
};

/** Speech cues that point at a specific dual-feed agency. */
const AGENCY_CUES: { re: RegExp; agency: string }[] = [
  // Colonie / Latham
  { re: /\b(colonie|latham|loudonville|latham command|wolf\s*rd|wolf\s*road|route\s*9|ny\s*9|route\s*7|ny\s*7|route\s*2|ny\s*2|route\s*155|airport|albany airport|crossgates|colonie center|siena|troy.?schenectady)\b/i, agency: "Colonie PD" },
  // Albany city streets / units
  { re: /\b(albany\s*(pd|police|city)|central\s*(ave|avenue)|western\s*(ave|avenue)|lark|pearl|madison|henry\s*johnson|new\s*scotland|delaware\s*(ave|avenue)|southern\s*(blvd|boulevard)|quail|ontario|clinton\s*(ave|avenue)|morton|holland|everett|kyler|matilda|second\s*st|2nd\s*st|north\s*swan|south\s*end|arbor\s*hill|pine\s*hills|center\s*square)\b/i, agency: "Albany PD" },
  // Bethlehem
  { re: /\b(bethlehem|delmar|selkirk|glenmont|elsmere|slingerlands)\b/i, agency: "Bethlehem PD" },
  // Fire / EMS overrides on mixed feeds
  { re: /\b(albany\s*fire|afd|engine\s*\d+|truck\s*\d+|ladder\s*\d+)\b/i, agency: "Albany Fire" },
  { re: /\b(colonie\s*fire|latham\s*fire)\b/i, agency: "Colonie Fire" },
  { re: /\b(bethlehem\s*fire|delmar\s*fire)\b/i, agency: "Bethlehem Fire" },
  { re: /\b(guilderland)\b/i, agency: "Guilderland PD" },
  { re: /\b(cohoes)\b/i, agency: "Cohoes PD" },
  { re: /\b(watervliet)\b/i, agency: "Watervliet PD" },
  { re: /\b(troop\s*g|state\s*police|trooper)\b/i, agency: "NYSP Troop G" },
  { re: /\b(thruway|nysta)\b/i, agency: "NYS Thruway" },
];

/** Normalize talkgroup agency strings → Live short labels. */
function shortAgencyFromTalkgroup(meta: TalkgroupMeta): AgencyLabel {
  const a = meta.agency;
  const disc = (meta.discipline === "fire" || meta.discipline === "ems" || meta.discipline === "police"
    ? meta.discipline
    : "police") as AgencyLabel["discipline"];
  const muni = meta.municipality.split("/")[0]!.trim();
  const muniHint = /county|capital|downtown/i.test(muni) ? undefined : muni.replace(/\s*\/.*/, "").trim();

  if (/Albany Police/i.test(a)) return { agency: "Albany PD", abbr: "APD", municipalityHint: "Albany", discipline: "police" };
  if (/Colonie Police/i.test(a)) return { agency: "Colonie PD", abbr: "CPD", municipalityHint: "Colonie", discipline: "police" };
  if (/Bethlehem Police/i.test(a)) return { agency: "Bethlehem PD", abbr: "BPD", municipalityHint: "Bethlehem", discipline: "police" };
  if (/Guilderland Police/i.test(a)) return { agency: "Guilderland PD", abbr: "GPD", municipalityHint: "Guilderland", discipline: "police" };
  if (/Cohoes Police/i.test(a)) return { agency: "Cohoes PD", abbr: "COPD", municipalityHint: "Cohoes", discipline: "police" };
  if (/Watervliet Police/i.test(a)) return { agency: "Watervliet PD", abbr: "WPD", municipalityHint: "Watervliet", discipline: "police" };
  if (/Green Island/i.test(a)) return { agency: "Green Island PD", abbr: "GIPD", municipalityHint: "Green Island", discipline: "police" };
  if (/Menands/i.test(a)) return { agency: "Menands PD", abbr: "MPD", municipalityHint: "Menands", discipline: "police" };
  if (/Coeymans/i.test(a)) return { agency: "Coeymans PD", abbr: "CYPD", municipalityHint: "Coeymans", discipline: "police" };
  if (/Altamont/i.test(a)) return { agency: "Altamont PD", abbr: "ALPD", municipalityHint: "Altamont", discipline: "police" };
  if (/Albany Fire/i.test(a)) return { agency: "Albany Fire", abbr: "AFD", municipalityHint: "Albany", discipline: "fire" };
  if (/Colonie Fire/i.test(a)) return { agency: "Colonie Fire", abbr: "CFD", municipalityHint: "Colonie", discipline: "fire" };
  if (/Bethlehem Fire/i.test(a)) return { agency: "Bethlehem Fire", abbr: "BFD", municipalityHint: "Bethlehem", discipline: "fire" };
  if (/Guilderland Fire/i.test(a)) return { agency: "Guilderland Fire", abbr: "GFD", municipalityHint: "Guilderland", discipline: "fire" };
  if (/Albany EMS/i.test(a)) return { agency: "Albany EMS", abbr: "AEMS", municipalityHint: "Albany", discipline: "ems" };
  if (/County EMS|Albany County EMS/i.test(a)) return { agency: "County EMS", abbr: "ACEMS", discipline: "ems" };
  if (/NYSP Troop G/i.test(a)) return { agency: "NYSP Troop G", abbr: "NYSP", municipalityHint: "Latham", discipline: "police" };
  if (/NYSP Capitol/i.test(a)) return { agency: "NYSP Capitol", abbr: "NYSP", municipalityHint: "Albany", discipline: "police" };
  if (/Sheriff/i.test(a)) return { agency: "Albany County Sheriff", abbr: "ACSO", discipline: "police" };
  if (/County Fire|Albany County Fire/i.test(a)) return { agency: "County Fire", abbr: "ACFD", discipline: "fire" };
  if (/Thruway|NYSTA/i.test(a)) return { agency: "NYS Thruway", abbr: "NYSTA", discipline: "all" };

  // Fallback: strip "Police" → "PD"
  const short = a
    .replace(/\bPolice\b/i, "PD")
    .replace(/\bDepartment\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    agency: short || a,
    abbr: short.replace(/[^A-Z]/g, "").slice(0, 4) || "SCAN",
    municipalityHint: muniHint,
    discipline: disc,
  };
}

export function talkgroupLabel(talkgroupId: string | null | undefined): AgencyLabel | null {
  if (!talkgroupId) return null;
  const meta = TG[String(talkgroupId)];
  if (!meta) return null;
  return shortAgencyFromTalkgroup(meta);
}

function feedCandidates(feedId: string): AgencyLabel[] {
  return FEED_AGENCIES[feedId] ?? [];
}

function cueAgency(spoken: string): string | null {
  for (const row of AGENCY_CUES) {
    if (row.re.test(spoken)) return row.agency;
  }
  return null;
}

/**
 * Map Broadcastify feed id (+ optional talkgroup + speech) → specific agency.
 * Never returns the dual blob "Albany / Colonie PD".
 */
export function resolveScannerAgency(input: {
  feedId: string;
  spoken?: string;
  talkgroupId?: string | null;
}): AgencyLabel {
  const feed = getScannerFeed(input.feedId);
  const spoken = input.spoken || "";
  const fromTg = talkgroupLabel(input.talkgroupId);
  if (fromTg) return fromTg;

  const candidates = feedCandidates(input.feedId);
  const cue = cueAgency(spoken);

  if (candidates.length) {
    // Discipline from speech can refine multi-agency feeds (Bethlehem PD/Fire/EMS).
    const wantFire = /\b(fire|engine|truck|ladder|structure|smoke|blaze)\b/i.test(spoken);
    const wantEms = /\b(ems|ambulance|medic|rescue|overdose|unconscious|medical)\b/i.test(spoken);
    if (wantFire) {
      const fire = candidates.find((c) => c.discipline === "fire");
      if (fire) return fire;
    }
    if (wantEms) {
      const ems = candidates.find((c) => c.discipline === "ems");
      if (ems) return ems;
    }
  }

  if (cue && candidates.length) {
    const hit = candidates.find((c) => c.agency === cue || c.agency.startsWith(cue.split(" ")[0]!));
    if (hit) return hit;
    // Cue names an agency outside the feed candidates (e.g. NYSP on PD feed) — still use it.
    const abbr =
      /Colonie/i.test(cue) ? "CPD"
        : /Albany PD/i.test(cue) ? "APD"
          : /Bethlehem PD/i.test(cue) ? "BPD"
            : /Fire/i.test(cue) ? "FD"
              : /EMS/i.test(cue) ? "EMS"
                : /NYSP/i.test(cue) ? "NYSP"
                  : "SCAN";
    return { agency: cue, abbr, discipline: /Fire/i.test(cue) ? "fire" : /EMS/i.test(cue) ? "ems" : "police" };
  }

  if (cue && !candidates.length) {
    return {
      agency: cue,
      abbr: "SCAN",
      discipline: /Fire/i.test(cue) ? "fire" : /EMS/i.test(cue) ? "ems" : "police",
    };
  }

  // Single-agency feed → that label.
  if (candidates.length === 1) return candidates[0]!;

  // Dual feed with no cue: prefer discipline from feed, avoid dual blob.
  if (candidates.length > 1) {
    if (feed?.discipline === "fire") {
      const fire = candidates.find((c) => c.discipline === "fire");
      if (fire) return fire;
    }
    // Speech nature may still imply fire/ems on a PD feed.
    if (/\b(fire|engine|truck|ladder|structure)\b/i.test(spoken)) {
      const fire = candidates.find((c) => c.discipline === "fire");
      if (fire) return fire;
    }
    if (/\b(ems|ambulance|medic|rescue)\b/i.test(spoken)) {
      const ems = candidates.find((c) => c.discipline === "ems");
      if (ems) return ems;
    }
    // Unresolved dual PD — generic "Police" (not "Albany / Colonie PD").
    return { agency: "Police", abbr: "PD", discipline: "police" };
  }

  // Unknown feed id — derive a short label from feed metadata, stripping dual blobs.
  if (feed) {
    const name = feed.name
      .replace(/\s*\/\s*/g, " / ")
      .trim();
    if (/\/| & /.test(name)) {
      // Dual-style feed name without candidates — discipline-only fallback.
      if (feed.discipline === "fire") return { agency: "Fire", abbr: "FD", discipline: "fire" };
      if (feed.discipline === "ems") return { agency: "EMS", abbr: "EMS", discipline: "ems" };
      return { agency: "Police", abbr: "PD", discipline: "police" };
    }
    const short = name
      .replace(/\bPolice\b/i, "PD")
      .replace(/\bDepartment\b/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      agency: short,
      abbr: feed.shortName.slice(0, 6).toUpperCase(),
      discipline: feed.discipline === "all" ? "police" : feed.discipline,
    };
  }

  return { agency: "Scanner", abbr: "SCAN", discipline: "police" };
}

/** Landmarks / hamlets that imply a municipality. */
const LANDMARKS: { re: RegExp; place: string; muni: string }[] = [
  { re: /\blatham\s*command\b/i, place: "Latham Command", muni: "Colonie" },
  { re: /\blatham\b/i, place: "Latham", muni: "Colonie" },
  { re: /\bloudonville\b/i, place: "Loudonville", muni: "Colonie" },
  { re: /\bcrossgates\b/i, place: "Crossgates Mall", muni: "Guilderland" },
  { re: /\bcolonie\s*center\b/i, place: "Colonie Center", muni: "Colonie" },
  { re: /\balbany\s*airport|airport\b/i, place: "Albany Airport", muni: "Colonie" },
  { re: /\bsiena\b/i, place: "Siena College", muni: "Colonie" },
  { re: /\bdelmar\b/i, place: "Delmar", muni: "Bethlehem" },
  { re: /\bselkirk\b/i, place: "Selkirk", muni: "Bethlehem" },
  { re: /\bglenmont\b/i, place: "Glenmont", muni: "Bethlehem" },
  { re: /\belsmere\b/i, place: "Elsmere", muni: "Bethlehem" },
  { re: /\bslingerlands\b/i, place: "Slingerlands", muni: "Bethlehem" },
  { re: /\bpine\s*hills\b/i, place: "Pine Hills", muni: "Albany" },
  { re: /\barbor\s*hill\b/i, place: "Arbor Hill", muni: "Albany" },
  { re: /\bcenter\s*square\b/i, place: "Center Square", muni: "Albany" },
  { re: /\bsouth\s*end\b/i, place: "South End", muni: "Albany" },
];

const INTER_STOP = new Set(
  "respond copy unit car engine truck medic ambulance officer dispatch command en route for a the an to on in at of with from please check check welfare domestic crash collision accident".split(
    " ",
  ),
);

/** Spoken "X and Y" / "X & Y" intersections (street stems). */
export function extractIntersection(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  // Prefer single-token stems: "Kyler and Matilda", "Wolf and Central".
  const re =
    /\b([A-Za-z][A-Za-z']+)(?:\s+(street|st|avenue|ave|road|rd|boulevard|blvd))?\s+(?:and|&)\s+([A-Za-z][A-Za-z']+)(?:\s+(street|st|avenue|ave|road|rd|boulevard|blvd))?\b/gi;
  let best: string | null = null;
  for (const m of t.matchAll(re)) {
    const a = m[1]!.trim();
    const b = m[3]!.trim();
    if (INTER_STOP.has(a.toLowerCase()) || INTER_STOP.has(b.toLowerCase())) continue;
    if (a.length < 3 || b.length < 3) continue;
    // Skip number chatter like "car 12 and car 14".
    if (/^\d/.test(a) || /^\d/.test(b)) continue;
    best = `${titleCase(a)} & ${titleCase(b)}`;
  }
  return best;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

const ROUTE_RE =
  /\b(?:route|rt\.?|ny|us)\s*(4|5|7|9|9[Ww]|20|32|43|85|155|787|87|90)\b|\bi-?(87|90|787)\b|\bnorthway\b|\bthruway\b/i;

export function extractRoute(text: string): string | null {
  const m = text.match(ROUTE_RE);
  if (!m) return null;
  const raw = m[0]!.replace(/\s+/g, " ").trim();
  if (/northway/i.test(raw)) return "I-87";
  if (/thruway/i.test(raw) && !/i-?90/i.test(raw)) return "Thruway";
  if (/^i-?/i.test(raw)) return raw.toUpperCase().replace(/^I(?=\d)/, "I-");
  const num = m[1] || m[2];
  if (num) {
    if (/^787|87|90$/.test(num)) return `I-${num}`;
    return `Route ${num.toUpperCase()}`;
  }
  return titleCase(raw);
}

export type ScannerPlace = {
  /** Municipality for the card (canonical town), or "" when unknown */
  municipality: string;
  /** Human address line — never dual coverage blob; "area unknown" when nothing found */
  address: string;
  /** Short place fragment for titles (Wolf Rd, Latham, Kyler & Matilda) */
  placeLabel: string;
  /** Whether we have a usable place cue (not centroid-only guess) */
  known: boolean;
};

/**
 * Extract location from caption. Prefer streets / intersections / landmarks /
 * town names. Do not invent dual-feed coverage as the address.
 */
export function resolveScannerPlace(input: {
  spoken: string;
  agency?: AgencyLabel;
  feed?: ScannerFeed | null;
}): ScannerPlace {
  const spoken = input.spoken || "";
  const addr = extractSpokenAddress(spoken);
  const intersection = extractIntersection(spoken);
  const route = extractRoute(spoken);
  const town = placeFromText(spoken);
  const landmark = LANDMARKS.find((row) => row.re.test(spoken));

  let municipality =
    landmark?.muni ||
    town?.name ||
    input.agency?.municipalityHint ||
    "";

  // Street gazetteer often implies Albany city; override when town/landmark clearer.
  if (!municipality && addr && addr.geo.lat !== 0) {
    // Known Capital District street midpoints default to Albany unless cue says otherwise.
    municipality = "Albany";
  }

  // Colonie-leaning roads when agency is Colonie.
  if (!town && !landmark && input.agency?.agency === "Colonie PD") {
    if (/\bwolf\b|\broute\s*9\b|\broute\s*7\b|\blatham\b/i.test(spoken)) municipality = "Colonie";
  }

  let placeLabel = "";
  if (addr?.label) placeLabel = addr.label;
  else if (intersection) placeLabel = intersection;
  else if (route) placeLabel = route;
  else if (landmark) placeLabel = landmark.place;
  else if (town) placeLabel = town.name;

  const known = Boolean(placeLabel || municipality);

  let address: string;
  if (placeLabel && municipality) {
    address = placeLabel.toLowerCase().includes(municipality.toLowerCase())
      ? placeLabel
      : `${placeLabel} · ${municipality}`;
  } else if (placeLabel) {
    address = placeLabel;
  } else if (municipality) {
    address = municipality;
  } else {
    address = "area unknown";
  }

  // Never pass through dual coverage strings.
  if (/City of Albany\s*&\s*Town of Colonie|Albany\s*\/\s*Colonie/i.test(address)) {
    address = placeLabel || "area unknown";
    if (!municipality) municipality = "";
  }

  return {
    municipality: municipality || (address === "area unknown" ? "" : municipality),
    address,
    placeLabel,
    known,
  };
}

export function natureOf(text: string): string {
  if (/panic/i.test(text)) return "panic alarm";
  if (/hold.?up|robbery/i.test(text)) return "robbery";
  if (/shots? fired|shoot/i.test(text)) return "shots fired";
  if (/domestic/i.test(text)) return "domestic";
  if (/welfare/i.test(text)) return "welfare check";
  if (/personal injury|\bpi\b|injury crash/i.test(text)) return "injury crash";
  if (/crash|collision|accident|mva/i.test(text)) return "crash";
  if (/structure fire|building fire/i.test(text)) return "structure fire";
  if (/\bfire\b/i.test(text)) return "fire";
  if (/ems|ambulance|medical|overdose|unconscious/i.test(text)) return "EMS";
  if (/burglar/i.test(text)) return "burglar alarm";
  if (/\balarm\b/i.test(text)) return "alarm";
  if (/suspicious/i.test(text)) return "suspicious";
  if (/dwi|intoxicated/i.test(text)) return "DWI";
  return "";
}

/**
 * Title leads with agency + place when known.
 * e.g. "Colonie PD · Wolf Rd crash"
 */
export function scannerTitle(spoken: string, agency: AgencyLabel, place: ScannerPlace): string {
  const nature = natureOf(spoken);
  const placeBit = place.placeLabel || "";
  const agencyBit = agency.agency;

  if (nature && placeBit) {
    // "Wolf Rd crash" / "Latham crash"
    const natureWord = nature;
    if (new RegExp(natureWord.replace(/\s+/g, "\\s+"), "i").test(placeBit)) {
      return `${agencyBit} · ${placeBit}`;
    }
    return `${agencyBit} · ${placeBit} ${natureWord}`;
  }
  if (nature) return `${agencyBit} · ${nature}`;
  if (placeBit) return `${agencyBit} · ${placeBit}`;

  const t = spoken.replace(/\s+/g, " ").trim();
  const clip = t.length <= 56 ? t : `${t.slice(0, 52).replace(/\s+\S*$/, "")}…`;
  return `${agencyBit} · ${clip || "radio"}`;
}

export function withDisclaimer(spoken: string, agency: string): string {
  const clip = spoken.replace(/\s+/g, " ").trim().slice(0, 220);
  const body = clip.length < spoken.trim().length ? `${clip.replace(/\s+\S*$/, "")}…` : clip;
  const punct = /[.!?…]$/.test(body) ? "" : ".";
  return `${body}${punct} Unconfirmed ${agency} radio — not a CAD call.`;
}

/** Sync geo hint for place — caller still runs geocodeSpoken when a road exists. */
export function placeGeoHint(place: ScannerPlace, spoken: string): { geo?: Geo; road: string } {
  const addr = extractSpokenAddress(spoken);
  if (addr && addr.geo.lat !== 0) return { geo: addr.geo, road: addr.label };
  return { road: place.placeLabel || "" };
}

export function isDualBlobAgency(name: string): boolean {
  return /Albany\s*\/\s*Colonie|City of Albany\s*&\s*Town of Colonie/i.test(name);
}
