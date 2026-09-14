/** Capital District pins from station, road, and town — not one downtown centroid. */

export type Geo = { lat: number; lng: number };
export type Place = Geo & { name: string };
/** How precise a pin is — map uses this for approx styling; never fake street precision. */
export type GeoPrecision =
  | "street"
  | "intersection"
  | "landmark"
  | "road"
  | "town"
  | "county"
  | "unknown";

export type LocatedPin = { geo: Geo; road: string; precision: GeoPrecision };

/** Soft Albany County centroid — not downtown Albany City Hall. */
export const COUNTY_CENTROID: Geo = { lat: 42.68, lng: -73.82 };

/** Nominatim / map bias box: Albany County + near neighbors (W,S,E,N). */
export const ALBANY_VIEWBOX = "-74.12,42.40,-73.55,42.85";

export const TOWN: Record<string, Geo> = {
  Albany: { lat: 42.6526, lng: -73.7562 },
  Colonie: { lat: 42.7179, lng: -73.8373 },
  Latham: { lat: 42.747, lng: -73.759 },
  Bethlehem: { lat: 42.5917, lng: -73.824 },
  Guilderland: { lat: 42.7045, lng: -73.9115 },
  Cohoes: { lat: 42.7742, lng: -73.7001 },
  Watervliet: { lat: 42.7301, lng: -73.7012 },
  Menands: { lat: 42.692, lng: -73.7237 },
  "Green Island": { lat: 42.7442, lng: -73.6918 },
  "New Scotland": { lat: 42.6217, lng: -73.9412 },
  Voorheesville: { lat: 42.649, lng: -73.929 },
  Coeymans: { lat: 42.4737, lng: -73.7923 },
  Ravena: { lat: 42.468, lng: -73.816 },
  Westerlo: { lat: 42.5145, lng: -74.044 },
  Berne: { lat: 42.548, lng: -74.134 },
  Knox: { lat: 42.671, lng: -74.116 },
  Rensselaerville: { lat: 42.468, lng: -74.186 },
  Troy: { lat: 42.7284, lng: -73.6918 },
  Rensselaer: { lat: 42.6426, lng: -73.7429 },
  "East Greenbush": { lat: 42.591, lng: -73.702 },
  "North Greenbush": { lat: 42.733, lng: -73.663 },
  Schodack: { lat: 42.529, lng: -73.693 },
  Brunswick: { lat: 42.736, lng: -73.59 },
  "Sand Lake": { lat: 42.629, lng: -73.599 },
  Nassau: { lat: 42.516, lng: -73.61 },
  Stephentown: { lat: 42.546, lng: -73.374 },
  Hoosick: { lat: 42.862, lng: -73.351 },
  "Hoosick Falls": { lat: 42.901, lng: -73.351 },
  Grafton: { lat: 42.77, lng: -73.45 },
  Poestenkill: { lat: 42.69, lng: -73.56 },
  Pittstown: { lat: 42.84, lng: -73.48 },
  Schaghticoke: { lat: 42.9, lng: -73.586 },
  Petersburgh: { lat: 42.75, lng: -73.34 },
  "Clifton Park": { lat: 42.8586, lng: -73.7709 },
  Halfmoon: { lat: 42.843, lng: -73.713 },
  Malta: { lat: 42.967, lng: -73.793 },
  Ballston: { lat: 42.955, lng: -73.879 },
  "Ballston Spa": { lat: 43.001, lng: -73.851 },
  Waterford: { lat: 42.791, lng: -73.681 },
  Mechanicville: { lat: 42.904, lng: -73.69 },
  Stillwater: { lat: 42.938, lng: -73.659 },
  Wilton: { lat: 43.181, lng: -73.744 },
  Milton: { lat: 43.035, lng: -73.853 },
  Greenfield: { lat: 43.129, lng: -73.846 },
  "Saratoga Springs": { lat: 43.0831, lng: -73.7846 },
  Niskayuna: { lat: 42.776, lng: -73.831 },
  Rotterdam: { lat: 42.787, lng: -73.971 },
  Glenville: { lat: 42.929, lng: -73.996 },
  Scotia: { lat: 42.826, lng: -73.964 },
  Schenectady: { lat: 42.8142, lng: -73.9396 },
  Princetown: { lat: 42.8, lng: -74.07 },
  Duanesburg: { lat: 42.762, lng: -74.134 },
  Altamont: { lat: 42.705, lng: -74.033 },
  Loudonville: { lat: 42.705, lng: -73.755 },
  Delmar: { lat: 42.622, lng: -73.832 },
  Selkirk: { lat: 42.545, lng: -73.806 },
  Glenmont: { lat: 42.605, lng: -73.793 },
};

const ALIASES: Record<string, string> = {
  "Hoosick Falls": "Hoosick",
  Voorheesville: "New Scotland",
  Ravena: "Coeymans",
  Delmar: "Bethlehem",
  Selkirk: "Bethlehem",
  Glenmont: "Bethlehem",
  Scotia: "Glenville",
  Loudonville: "Colonie",
  Latham: "Colonie",
  "Ballston Spa": "Ballston",
  Altamont: "Guilderland",
};

const STATION: { re: RegExp; geo: Geo; road: string }[] = [
  { re: /latham interstate/i, geo: { lat: 42.748, lng: -73.785 }, road: "I-87" },
  { re: /wilton interstate/i, geo: { lat: 43.118, lng: -73.744 }, road: "I-87" },
  { re: /albany thruway/i, geo: { lat: 42.641, lng: -73.781 }, road: "Thruway" },
  { re: /capital|empire state/i, geo: { lat: 42.652, lng: -73.757 }, road: "Capitol" },
];

type RoadRule = { re: RegExp; at: Record<string, Geo>; fallback: Geo };

const I87: Record<string, Geo> = {
  Albany: { lat: 42.68, lng: -73.808 },
  Colonie: { lat: 42.748, lng: -73.785 },
  Latham: { lat: 42.748, lng: -73.785 },
  Cohoes: { lat: 42.78, lng: -73.76 },
  Watervliet: { lat: 42.76, lng: -73.75 },
  Menands: { lat: 42.7, lng: -73.79 },
  Bethlehem: { lat: 42.58, lng: -73.81 },
  "Clifton Park": { lat: 42.858, lng: -73.778 },
  Halfmoon: { lat: 42.85, lng: -73.76 },
  Malta: { lat: 42.97, lng: -73.785 },
  "Saratoga Springs": { lat: 43.07, lng: -73.78 },
  Wilton: { lat: 43.13, lng: -73.74 },
  Guilderland: { lat: 42.67, lng: -73.88 },
};

const I90: Record<string, Geo> = {
  Albany: { lat: 42.641, lng: -73.781 },
  Bethlehem: { lat: 42.62, lng: -73.8 },
  Schodack: { lat: 42.6, lng: -73.7 },
  Rensselaer: { lat: 42.63, lng: -73.74 },
  "East Greenbush": { lat: 42.61, lng: -73.72 },
  Guilderland: { lat: 42.67, lng: -73.9 },
  Rotterdam: { lat: 42.78, lng: -74.0 },
  Schenectady: { lat: 42.8, lng: -73.96 },
};

const ROADS: RoadRule[] = [
  { re: /\bi-?87\b|\bnorthway\b|\binterstate 87\b/i, at: I87, fallback: I87.Colonie! },
  { re: /\bi-?90\b|\binterstate 90\b|\bthruway\b/i, at: I90, fallback: I90.Albany! },
  {
    re: /\bi-?787\b|\binterstate 787\b/i,
    at: {
      Albany: { lat: 42.66, lng: -73.74 },
      Menands: { lat: 42.69, lng: -73.73 },
      Troy: { lat: 42.72, lng: -73.7 },
      Watervliet: { lat: 42.73, lng: -73.7 },
    },
    fallback: { lat: 42.68, lng: -73.735 },
  },
  { re: /\bhoosick\b/i, at: { Troy: { lat: 42.732, lng: -73.673 }, Brunswick: { lat: 42.74, lng: -73.62 } }, fallback: { lat: 42.732, lng: -73.673 } },
  { re: /\bny\s*7\b|\broute 7\b|\bstate route 7\b/i, at: { Colonie: { lat: 42.75, lng: -73.82 }, Niskayuna: { lat: 42.78, lng: -73.85 }, Troy: { lat: 42.73, lng: -73.68 } }, fallback: { lat: 42.75, lng: -73.82 } },
  { re: /\bny\s*5\b|\broute 5\b|\bcentral (ave|avenue)\b/i, at: { Albany: { lat: 42.668, lng: -73.79 }, Colonie: { lat: 42.73, lng: -73.8 }, Schenectady: { lat: 42.81, lng: -73.94 } }, fallback: { lat: 42.7, lng: -73.8 } },
  { re: /\bus\s*20\b|\bwestern (ave|avenue|tpk|turnpike)\b/i, at: { Albany: { lat: 42.66, lng: -73.78 }, Guilderland: { lat: 42.704, lng: -73.91 } }, fallback: { lat: 42.68, lng: -73.85 } },
  { re: /\bny\s*32\b|\broute 32\b/i, at: { Albany: { lat: 42.64, lng: -73.76 }, "New Scotland": { lat: 42.62, lng: -73.9 }, Coeymans: { lat: 42.5, lng: -73.8 } }, fallback: { lat: 42.6, lng: -73.82 } },
  { re: /\bny\s*43\b|\broute 43\b/i, at: { "Sand Lake": { lat: 42.63, lng: -73.6 }, Stephentown: { lat: 42.55, lng: -73.4 }, "East Greenbush": { lat: 42.59, lng: -73.68 } }, fallback: { lat: 42.61, lng: -73.64 } },
  { re: /\bus\s*9\b|\broute 9\b/i, at: { Albany: { lat: 42.66, lng: -73.75 }, "Clifton Park": { lat: 42.86, lng: -73.78 }, Malta: { lat: 42.97, lng: -73.79 }, "Saratoga Springs": { lat: 43.08, lng: -73.78 }, Wilton: { lat: 43.15, lng: -73.74 } }, fallback: { lat: 42.86, lng: -73.78 } },
  { re: /\bny\s*4\b|\broute 4\b|\brt\.?\s*4\b/i, at: { Colonie: { lat: 42.75, lng: -73.76 }, Latham: { lat: 42.75, lng: -73.76 }, Troy: { lat: 42.73, lng: -73.69 }, "North Greenbush": { lat: 42.74, lng: -73.68 } }, fallback: { lat: 42.75, lng: -73.76 } },
  { re: /\bvischer ferry\b/i, at: { "Clifton Park": { lat: 42.86, lng: -73.82 } }, fallback: { lat: 42.86, lng: -73.82 } },
  { re: /\bkinns\b/i, at: { "Clifton Park": { lat: 42.858, lng: -73.79 } }, fallback: { lat: 42.858, lng: -73.79 } },
  { re: /\bwolf\b/i, at: { Colonie: { lat: 42.74, lng: -73.8 } }, fallback: { lat: 42.74, lng: -73.8 } },
  { re: /\bwashington (ave|avenue)\b/i, at: { Albany: { lat: 42.66, lng: -73.77 } }, fallback: { lat: 42.66, lng: -73.77 } },
  { re: /\bdelaware (ave|avenue)\b/i, at: { Albany: { lat: 42.64, lng: -73.77 }, Bethlehem: { lat: 42.6, lng: -73.82 } }, fallback: { lat: 42.62, lng: -73.79 } },
  { re: /\bnew scotland\b/i, at: { Albany: { lat: 42.65, lng: -73.78 }, "New Scotland": { lat: 42.62, lng: -73.94 } }, fallback: { lat: 42.64, lng: -73.82 } },
  { re: /\bbroadway\b/i, at: { Albany: { lat: 42.65, lng: -73.75 }, Menands: { lat: 42.69, lng: -73.72 }, Schenectady: { lat: 42.81, lng: -73.94 } }, fallback: { lat: 42.65, lng: -73.75 } },
  { re: /\bpearl\b/i, at: { Albany: { lat: 42.65, lng: -73.75 } }, fallback: { lat: 42.65, lng: -73.75 } },
  { re: /\blark\b/i, at: { Albany: { lat: 42.655, lng: -73.762 } }, fallback: { lat: 42.655, lng: -73.762 } },
];

/** Known Capital District streets — midpoints only, never invented house pins. */
const STREETS: { re: RegExp; geo: Geo; label: string; stems?: string[] }[] = [
  { re: /\bwatervliet\s*(ave|avenue)\b/i, geo: { lat: 42.68, lng: -73.74 }, label: "Watervliet Ave", stems: ["watervliet ave"] },
  { re: /\bcentral(?:\s+(?:ave|avenue))?\b(?!\s+(?:park|district|region|ny|new york))/i, geo: { lat: 42.668, lng: -73.79 }, label: "Central Ave", stems: ["central"] },
  { re: /\bwolf(?:\s+(?:rd|road))?\b/i, geo: { lat: 42.728, lng: -73.812 }, label: "Wolf Rd", stems: ["wolf"] },
  { re: /\bnew\s*scotland(?:\s+(?:ave|avenue))?\b/i, geo: { lat: 42.652, lng: -73.784 }, label: "New Scotland Ave", stems: ["new scotland"] },
  { re: /\bdelaware(?:\s+(?:ave|avenue))?\b/i, geo: { lat: 42.642, lng: -73.776 }, label: "Delaware Ave", stems: ["delaware"] },
  { re: /\bwestern(?:\s+(?:ave|avenue|tpk|turnpike))?\b/i, geo: { lat: 42.658, lng: -73.79 }, label: "Western Ave", stems: ["western"] },
  { re: /\bbroadway\b/i, geo: { lat: 42.652, lng: -73.75 }, label: "Broadway", stems: ["broadway"] },
  { re: /\bfuller\s*(rd|road)\b/i, geo: { lat: 42.685, lng: -73.855 }, label: "Fuller Rd", stems: ["fuller"] },
  { re: /\bwashington(?:\s+(?:ave|avenue))?\b/i, geo: { lat: 42.66, lng: -73.775 }, label: "Washington Ave", stems: ["washington"] },
  { re: /\bmadison(?:\s+(?:ave|avenue))?\b/i, geo: { lat: 42.652, lng: -73.772 }, label: "Madison Ave", stems: ["madison"] },
  { re: /\bhenry\s*johnson\b/i, geo: { lat: 42.668, lng: -73.758 }, label: "Henry Johnson Blvd", stems: ["henry johnson"] },
  { re: /\bquail\b/i, geo: { lat: 42.662, lng: -73.766 }, label: "Quail St", stems: ["quail"] },
  { re: /\bontario\b/i, geo: { lat: 42.67, lng: -73.774 }, label: "Ontario St", stems: ["ontario"] },
  { re: /\bclinton\s*(ave|avenue)\b/i, geo: { lat: 42.67, lng: -73.752 }, label: "Clinton Ave", stems: ["clinton"] },
  { re: /\blivingston\b/i, geo: { lat: 42.67, lng: -73.748 }, label: "Livingston Ave", stems: ["livingston"] },
  { re: /\bmorton\b/i, geo: { lat: 42.645, lng: -73.762 }, label: "Morton Ave", stems: ["morton"] },
  { re: /\bholland\b/i, geo: { lat: 42.648, lng: -73.762 }, label: "Holland Ave", stems: ["holland"] },
  { re: /\beverett\b/i, geo: { lat: 42.682, lng: -73.782 }, label: "Everett Rd", stems: ["everett"] },
  { re: /\bsand\s*creek\b/i, geo: { lat: 42.732, lng: -73.785 }, label: "Sand Creek Rd", stems: ["sand creek"] },
  { re: /\balbany\.?shaker|shaker\s*(rd|road)\b/i, geo: { lat: 42.742, lng: -73.79 }, label: "Albany Shaker Rd", stems: ["albany shaker", "shaker"] },
  { re: /\btroy.?schenectady|troy\s*schenectady\b/i, geo: { lat: 42.742, lng: -73.79 }, label: "Troy-Schenectady Rd", stems: ["troy schenectady"] },
  { re: /\bnorthway\s*(exit|mile)?\b|\bi-?87\b/i, geo: { lat: 42.748, lng: -73.785 }, label: "I-87", stems: ["northway", "i-87"] },
  { re: /\brussell\s*(rd|road)\b/i, geo: { lat: 42.72, lng: -73.82 }, label: "Russell Rd", stems: ["russell"] },
  { re: /\bmaxwell\b/i, geo: { lat: 42.72, lng: -73.81 }, label: "Maxwell Rd", stems: ["maxwell"] },
  { re: /\balbany\s*(st|street)\b/i, geo: { lat: 42.65, lng: -73.752 }, label: "Albany St", stems: ["albany st"] },
  { re: /\bjay\s*(st|street)\b/i, geo: { lat: 42.652, lng: -73.752 }, label: "Jay St", stems: ["jay"] },
  { re: /\beagle\b/i, geo: { lat: 42.651, lng: -73.754 }, label: "Eagle St", stems: ["eagle"] },
  { re: /\bnorth\s*pearl|n\.?\s*pearl\b/i, geo: { lat: 42.658, lng: -73.75 }, label: "N Pearl St", stems: ["north pearl"] },
  { re: /\bsouth\s*pearl|s\.?\s*pearl\b/i, geo: { lat: 42.642, lng: -73.758 }, label: "S Pearl St", stems: ["south pearl"] },
  { re: /\bkyler\b/i, geo: { lat: 42.641, lng: -73.76 }, label: "Kyler St", stems: ["kyler"] },
  { re: /\bmatilda\b/i, geo: { lat: 42.642, lng: -73.761 }, label: "Matilda St", stems: ["matilda"] },
  { re: /\bspringsteen\b|\bspring\s+(?:st|street)\b/i, geo: { lat: 42.655, lng: -73.755 }, label: "Spring St", stems: ["spring", "springsteen"] },
  { re: /\bmorris\b/i, geo: { lat: 42.655, lng: -73.78 }, label: "Morris St", stems: ["morris"] },
  { re: /\blark\b/i, geo: { lat: 42.655, lng: -73.762 }, label: "Lark St", stems: ["lark"] },
  { re: /\bpearl\b/i, geo: { lat: 42.65, lng: -73.75 }, label: "Pearl St", stems: ["pearl"] },
  { re: /\bcolony\s*(?:street|st\b)|\bcolonie\s*(?:street|st\b)/i, geo: { lat: 42.658, lng: -73.77 }, label: "Colony St", stems: ["colony st", "colonie st"] },
  { re: /\bnorth\s*swan|n\.?\s*swan\b/i, geo: { lat: 42.66, lng: -73.754 }, label: "North Swan St", stems: ["swan"] },
  { re: /\bsouthern\s*(blvd|boulevard)\b/i, geo: { lat: 42.642, lng: -73.773 }, label: "Southern Blvd", stems: ["southern"] },
  { re: /\bstate\s*(st|street)\b/i, geo: { lat: 42.651, lng: -73.755 }, label: "State St", stems: ["state"] },
  { re: /\bsecond\s*(st|street)|\b2nd\s*(st|street)\b/i, geo: { lat: 42.655, lng: -73.748 }, label: "2nd St", stems: ["second", "2nd"] },
  { re: /\bfirst\s*(st|street)|\b1st\s*(st|street)\b/i, geo: { lat: 42.654, lng: -73.749 }, label: "1st St", stems: ["first", "1st"] },
  { re: /\bthird\s*(st|street)|\b3rd\s*(st|street)\b/i, geo: { lat: 42.656, lng: -73.747 }, label: "3rd St", stems: ["third", "3rd"] },
  { re: /\bfourth\s*(st|street)|\b4th\s*(st|street)\b/i, geo: { lat: 42.657, lng: -73.746 }, label: "4th St", stems: ["fourth", "4th"] },
  { re: /\bfifth\s*(st|street)|\b5th\s*(st|street)\b/i, geo: { lat: 42.658, lng: -73.745 }, label: "5th St", stems: ["fifth", "5th"] },
];



/** Major Capital District landmarks — honest midpoints, not parcel pins. */
const LANDMARKS: { re: RegExp; geo: Geo; label: string; muni?: string }[] = [
  { re: /\bcrossgates\b/i, geo: { lat: 42.7105, lng: -73.8185 }, label: "Crossgates Mall", muni: "Guilderland" },
  { re: /\bcolonie\s*center\b/i, geo: { lat: 42.7108, lng: -73.818 }, label: "Colonie Center", muni: "Colonie" },
  { re: /\balbany\s*airport|albany\s*international\s*airport\b/i, geo: { lat: 42.7483, lng: -73.8017 }, label: "Albany Airport", muni: "Colonie" },
  { re: /\bempire\s*state\s*plaza|the\s*plaza\b/i, geo: { lat: 42.6503, lng: -73.7597 }, label: "Empire State Plaza", muni: "Albany" },
  { re: /\bmvp\s*arena|times\s*union\s*center|tu\s*center\b/i, geo: { lat: 42.6486, lng: -73.7546 }, label: "MVP Arena", muni: "Albany" },
  { re: /\buniversity\s*at\s*albany|\bualbany\b|\bsuny\s*albany\b/i, geo: { lat: 42.6862, lng: -73.8235 }, label: "UAlbany", muni: "Albany" },
  { re: /\balbany\s*medical|amc\b/i, geo: { lat: 42.6535, lng: -73.7742 }, label: "Albany Med", muni: "Albany" },
  { re: /\bst\.?\s*peter'?s\s*hospital\b/i, geo: { lat: 42.6558, lng: -73.7995 }, label: "St. Peter's Hospital", muni: "Albany" },
  { re: /\bcapitol\b|\bstate\s*capitol\b/i, geo: { lat: 42.6528, lng: -73.7573 }, label: "State Capitol", muni: "Albany" },
  { re: /\bpalace\s*theatre\b/i, geo: { lat: 42.6547, lng: -73.7506 }, label: "Palace Theatre", muni: "Albany" },
  { re: /\bproctors?\b/i, geo: { lat: 42.8135, lng: -73.9408 }, label: "Proctors", muni: "Schenectady" },
  { re: /\bsiena\b/i, geo: { lat: 42.7186, lng: -73.7536 }, label: "Siena College", muni: "Colonie" },
  { re: /\bnanotech|\bcny\s*nano\b/i, geo: { lat: 42.685, lng: -73.835 }, label: "NY Nano", muni: "Albany" },
  { re: /\bharrison\s*place|\bharriman\s*(campus|state\s*office)\b/i, geo: { lat: 42.679, lng: -73.81 }, label: "Harriman Campus", muni: "Albany" },
];

const TOWN_NAMES = Object.keys(TOWN).sort((a, b) => b.length - a.length);

const GEOCODE_UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch; contact@albany.watch)";
const geocodeCache = new Map<string, { geo: Geo; road: string; at: number } | null>();
const GEOCODE_TTL = 6 * 60 * 60_000;
let geocodeLastAt = 0;

function townGeo(name: string): Geo {
  return TOWN[name] ?? COUNTY_CENTROID;
}

export function canonicalTown(name: string): string {
  return ALIASES[name] ?? name;
}

export function placeFromText(text: string): Place | null {
  const hay = text.replace(/[-_]/g, " ");
  for (const name of TOWN_NAMES) {
    const re = new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (!re.test(hay)) continue;
    const canon = canonicalTown(name);
    const geo = TOWN[canon] ?? TOWN[name]!;
    return { name: canon === name ? name : canon, lat: geo.lat, lng: geo.lng };
  }
  return null;
}

export function locateCall(input: {
  municipality: string;
  station: string;
  road: string;
  intersection: string;
}): Geo {
  const muni = canonicalTown(input.municipality);
  const hay = `${input.road} ${input.intersection} ${input.station}`;
  for (const rule of ROADS) {
    if (!rule.re.test(hay) && !rule.re.test(input.road)) continue;
    return rule.at[muni] ?? rule.at[input.municipality] ?? rule.fallback;
  }
  const highwayStation = STATION.find((row) => row.re.test(input.station) && row.road);
  if (highwayStation) return highwayStation.geo;
  return townGeo(muni);
}

export type SpokenAddress = {
  house?: string;
  street: string;
  label: string;
  geo: Geo;
  precision?: GeoPrecision;
};

/** Common STT garbling → Capital District street phrasing before gazetteer match. */
const STT_STREET_FIXES: [RegExp, string][] = [
  [/\bwest\s+granite\b/gi, "Western Avenue"],
  [/\bwestern\s+granite\b/gi, "Western Avenue"],
  [/\bwest\s+granit\b/gi, "Western Avenue"],
  [/\bsandwich\b/gi, "Sand Creek"],
  [/\bsand\s+wich\b/gi, "Sand Creek"],
  [/\bspringsteen\b/gi, "Spring Street"],
  [/\bwest\s+rn\b/gi, "Western"],
  [/\bcenteral\b/gi, "Central"],
  [/\bsentral\b/gi, "Central"],
  [/\bcentrall?\b/gi, "Central"],
  [/\bcentral\s+av(?:e\.?|enue)?\b/gi, "Central Avenue"],
  [/\bon\s+(?:the\s+)?central\b/gi, "on Central Avenue"],
  [/\bwestern\s+av(?:e\.?|enue)?\b/gi, "Western Avenue"],
  [/\bworshington\b/gi, "Washington"],
  [/\bnew\s+scotlan[dt]\b/gi, "New Scotland"],
  [/\bwolf\s+road\b/gi, "Wolf Road"],
  [/\bwolf\s+rd\b/gi, "Wolf Road"],
  [/\bdelware\b/gi, "Delaware"],
  [/\bbroad\s+way\b/gi, "Broadway"],
  [/\bhenry\s+johnson\s+b(?:ou)?l(?:e)?v(?:ar)?d\b/gi, "Henry Johnson"],
];

/** Function words / STT nonsense that must never become a street title. */
const PLACE_STOP_STEMS = new Set(
  "this is that the a an across for to on in at of with from unit car copy respond please check triumph trion en route quarters service somewhere take area unknown something somehow anywhere nowhere whoever whatever".split(
    " ",
  ),
);

const GARBAGE_PLACE_RE =
  /\b(across\s+(this|is|the|a|an)\b|triumph\s+street|trion\s+street|across\s+this\s+triumph|across\s+is\s+trion)\b/i;

/** Normalize STT street garbling for place extraction. */
export function normalizeScannerSpeech(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (const [re, rep] of STT_STREET_FIXES) t = t.replace(re, rep);
  return t;
}

/** True when a candidate place phrase is STT garbage / low confidence. */
export function isLowConfidencePlace(label: string): boolean {
  const s = label.replace(/\s+/g, " ").trim();
  if (!s) return true;
  if (GARBAGE_PLACE_RE.test(s)) return true;
  if (/^across\b/i.test(s)) return true;
  const stem = s
    .replace(/^\d{1,5}\s+/, "")
    .replace(/\b(north|south|east|west|n\.?|s\.?|e\.?|w\.?)\s+/i, "")
    .replace(/\s+(street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|place|pl\.?|drive|dr\.?|lane|ln\.?|court|ct\.?|parkway|pkwy\.?)$/i, "")
    .trim()
    .toLowerCase();
  if (!stem || PLACE_STOP_STEMS.has(stem)) return true;
  // Multi-word stems that are all stop-ish ("this triumph")
  const parts = stem.split(/\s+/);
  if (parts.every((p) => PLACE_STOP_STEMS.has(p) || p.length <= 2)) return true;
  if (/\b(triumph|trion)\b/i.test(stem)) return true;
  return false;
}

/** Match a spoken stem against the Capital Region street gazetteer. */
export function streetByStem(name: string) {
  return STREETS.find(
    (s) =>
      s.re.test(name) ||
      (s.stems || []).some((stem) => new RegExp(`^${stem.replace(/\s+/g, "\\s+")}$`, "i").test(name)),
  );
}

/** Pull a spoken street / house number without inventing locations. */
export function extractSpokenAddress(text: string): SpokenAddress | null {
  const t = normalizeScannerSpeech(text);
  if (GARBAGE_PLACE_RE.test(t)) {
    // Still try gazetteer hits elsewhere in the utterance; strip garbage clause first.
  }
  const cleaned = t
    .replace(/\bacross\s+(this|is|the|a|an)\s+[A-Za-z']+(?:\s+[A-Za-z']+)?\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Intersection of two known stems ("Kyler and Matilda", "Wolf and Central")
  const inter = cleaned.match(
    /\b([A-Za-z][A-Za-z']+)\s+(?:and|&|at)\s+([A-Za-z][A-Za-z']+)\b/i,
  );
  if (inter) {
    const a = inter[1]!;
    const b = inter[2]!;
    const sa = streetByStem(a);
    const sb = streetByStem(b);
    if (sa && sb) {
      const label = `${sa.label.replace(/\s+(St|Ave|Rd|Blvd|Pl)$/, "")} & ${sb.label.replace(/\s+(St|Ave|Rd|Blvd|Pl)$/, "")}`;
      const geo = { lat: (sa.geo.lat + sb.geo.lat) / 2, lng: (sa.geo.lng + sb.geo.lng) / 2 };
      return { street: label, label, geo, precision: "intersection" };
    }
  }

  // House number + known stem ("92 Central", "1400 Western Avenue", "1225 West Granite"→Western)
  const numbered = cleaned.match(
    /\b(\d{1,5})\s+((?:north|south|east|west|n\.?|s\.?|e\.?|w\.?)\s+)?([A-Za-z][A-Za-z']+(?:\s+[A-Za-z][A-Za-z']+){0,2})(?:\s+(street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|place|pl\.?|drive|dr\.?|lane|ln\.?|court|ct\.?|parkway|pkwy\.?))?\b/i,
  );
  if (numbered) {
    const house = numbered[1]!;
    const dir = (numbered[2] || "").trim();
    const name = numbered[3]!.trim();
    const suffix = (numbered[4] || "").trim();
    const stemHay = `${dir} ${name}`.replace(/\s+/g, " ").trim();
    for (const s of STREETS) {
      const hit =
        s.re.test(`${stemHay} ${suffix}`) ||
        s.re.test(`${house} ${stemHay}`) ||
        s.re.test(stemHay) ||
        (s.stems || []).some((stem) => new RegExp(`\\b${stem.replace(/\s+/g, "\\s+")}\\b`, "i").test(stemHay));
      if (!hit) continue;
      const label = `${house} ${s.label}`;
      return { house, street: s.label, label, geo: s.geo, precision: "street" };
    }
    // Numbered + unknown street suffix: only keep if stem is not garbage (still un-pinned).
    if (suffix && !isLowConfidencePlace(`${house} ${stemHay} ${suffix}`)) {
      const pretty = `${house} ${dir ? dir + " " : ""}${name} ${suffix}`
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
      // Prefer known streets only for Live titles — unmarked generics stay null for place resolution.
      // Keep a weak pin only when house+suffix look like a real address phrase.
      if (name.length >= 4 && !PLACE_STOP_STEMS.has(name.toLowerCase())) {
        return { house, street: pretty, label: pretty, geo: { lat: 0, lng: 0 } };
      }
    }
  }

  // Ordinal / named street without house number — gazetteer only (never invent Triumph St).
  for (const s of STREETS) {
    if (s.re.test(cleaned)) return { street: s.label, label: s.label, geo: s.geo, precision: "street" };
    const stemHit = (s.stems || []).some((stem) => {
      const major =
        /^(wolf|central|western|broadway|delaware|madison|pearl|lark|quail|ontario|clinton|livingston|everett|fuller|russell|maxwell|kyler|matilda)$/i.test(
          stem,
        );
      if (stem.length < 5 && !/\s/.test(stem) && !major) {
        // Short single-token stems need a street suffix nearby ("Spring Street").
        return new RegExp(
          `\\b${stem.replace(/\s+/g, "\\s+")}\\s+(?:street|st\\.?|avenue|ave\\.?|road|rd\\.?|boulevard|blvd\\.?)\\b`,
          "i",
        ).test(cleaned);
      }
      return new RegExp(`\\b${stem.replace(/\s+/g, "\\s+")}\\b`, "i").test(cleaned);
    });
    if (stemHit) return { street: s.label, label: s.label, geo: s.geo, precision: "street" };
  }

  // Generic "… Street/Ave" without gazetteer hit — reject (was source of hallucinated titles).
  return null;
}

function inCapitalDistrict(lat: number, lng: number): boolean {
  return lat > 42.35 && lat < 43.35 && lng > -74.35 && lng < -73.3;
}

async function nominatimGeocode(query: string): Promise<Geo | null> {
  const key = query.toLowerCase().replace(/\s+/g, " ").trim();
  const cached = geocodeCache.get(key);
  if (cached !== undefined && cached && Date.now() - cached.at < GEOCODE_TTL) return cached.geo;
  if (cached === null && Date.now() - (geocodeCache.get(`$${key}`)?.at ?? 0) < 30 * 60_000) return null;

  const wait = Math.max(0, 1100 - (Date.now() - geocodeLastAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  geocodeLastAt = Date.now();

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    // Prefer Albany County NY street/intersection hits over other US Centrals.
    url.searchParams.set("q", query.includes("NY") ? query : `${query}, Albany County, NY`);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "3");
    url.searchParams.set("countrycodes", "us");
    url.searchParams.set("viewbox", ALBANY_VIEWBOX);
    url.searchParams.set("bounded", "0");
    url.searchParams.set("addressdetails", "1");
    const res = await fetch(url, {
      headers: { "User-Agent": GEOCODE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      geocodeCache.set(key, null);
      return null;
    }
    const rows = (await res.json()) as Array<{
      lat?: string;
      lon?: string;
      type?: string;
      class?: string;
      importance?: number;
      display_name?: string;
    }>;
    const ranked = rows
      .map((row) => {
        const lat = Number(row.lat);
        const lng = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inCapitalDistrict(lat, lng)) return null;
        const hay = `${row.display_name || ""}`.toLowerCase();
        const albanyBias =
          (hay.includes("albany") ? 2 : 0) +
          (hay.includes("colonie") || hay.includes("bethlehem") || hay.includes("guilderland") ? 1 : 0);
        const streetBias = row.class === "highway" || row.type === "residential" || row.type === "primary" ? 1 : 0;
        return { geo: { lat, lng }, score: albanyBias + streetBias + (row.importance || 0) };
      })
      .filter(Boolean) as { geo: Geo; score: number }[];
    ranked.sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) {
      geocodeCache.set(key, null);
      return null;
    }
    geocodeCache.set(key, { geo: best.geo, road: query, at: Date.now() });
    return best.geo;
  } catch {
    geocodeCache.set(key, null);
    return null;
  }
}

/**
 * Sync path: local street / landmark gazetteer only. Centroid only when no street found.
 */
export function locateSpoken(text: string, municipality: string): LocatedPin {
  const addr = extractSpokenAddress(text);
  if (addr && addr.geo.lat !== 0) {
    return {
      geo: addr.geo,
      road: addr.label,
      precision: addr.precision || (addr.house ? "street" : "street"),
    };
  }
  for (const lm of LANDMARKS) {
    if (lm.re.test(text)) return { geo: lm.geo, road: lm.label, precision: "landmark" };
  }
  const place = placeFromText(text);
  if (place) {
    return {
      geo: { lat: place.lat, lng: place.lng },
      road: addr?.label || "",
      precision: "town",
    };
  }
  if (addr?.label) {
    // Street phrase recognized but no local pin — town until async geocode; not fake street precision.
    return {
      geo: townGeo(canonicalTown(municipality)),
      road: addr.label,
      precision: "town",
    };
  }
  const muni = canonicalTown(municipality);
  if (muni && TOWN[muni]) {
    return { geo: townGeo(muni), road: "", precision: "town" };
  }
  return { geo: COUNTY_CENTROID, road: "", precision: municipality ? "town" : "county" };
}

/**
 * Prefer real OSM pins when speech has a house number / unknown street. Centroid last.
 */
export async function geocodeSpoken(text: string, municipality: string): Promise<LocatedPin> {
  const local = locateSpoken(text, municipality);
  const addr = extractSpokenAddress(text);
  if (!addr) return local;

  const muni = placeFromText(text)?.name || canonicalTown(municipality) || "Albany";
  const wantsPrecise = Boolean(addr.house) || addr.geo.lat === 0 || addr.precision === "intersection";
  // Known street midpoints are honest-but-coarse; still try OSM for house numbers.
  if (!wantsPrecise && addr.geo.lat !== 0 && !addr.house) {
    return { geo: addr.geo, road: addr.label, precision: addr.precision || "street" };
  }

  const query = `${addr.label}, ${muni}, NY`;
  const geo = await nominatimGeocode(query);
  if (geo) {
    return {
      geo,
      road: addr.label,
      precision: addr.precision === "intersection" ? "intersection" : "street",
    };
  }
  if (addr.geo.lat !== 0) {
    return { geo: addr.geo, road: addr.label, precision: addr.precision || "street" };
  }
  return local;
}

/** True when the pin is town/county/unknown — map should show approx styling. */
export function isApproxPrecision(p?: GeoPrecision | null): boolean {
  return !p || p === "town" || p === "county" || p === "unknown";
}

/** Spread stacked pins far enough to read at Capital District zoom. */
export function spreadCoord(geo: Geo, key: string, index: number, total: number): Geo {
  if (total <= 1) return geo;
  // Tight spiral — readable at street zoom without scattering across the county.
  const angle = (index * 2.39996) % (Math.PI * 2);
  const ring = 0.0018 + Math.floor(index / 8) * 0.0012;
  const h = hash(key);
  return {
    lat: geo.lat + Math.cos(angle) * ring + ((h % 11) - 5) * 0.00008,
    lng: geo.lng + Math.sin(angle) * ring * 1.25 + (((h >> 4) % 11) - 5) * 0.00008,
  };
}

export function spreadItems<T extends { id: string; lat: number; lng: number }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.lat.toFixed(4)}|${item.lng.toFixed(4)}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const out: T[] = [];
  for (const list of groups.values()) {
    list.forEach((item, i) => {
      const next = spreadCoord({ lat: item.lat, lng: item.lng }, item.id, i, list.length);
      out.push({ ...item, lat: next.lat, lng: next.lng });
    });
  }
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
