/** Capital District pins from station, road, and town — not one downtown centroid. */

export type Geo = { lat: number; lng: number };
export type Place = Geo & { name: string };

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

const STREETS: { re: RegExp; geo: Geo; label: string }[] = [
  { re: /\bnorth swan|n\.?\s*swan\b/i, geo: { lat: 42.66, lng: -73.754 }, label: "North Swan St" },
  { re: /\blark\b/i, geo: { lat: 42.655, lng: -73.762 }, label: "Lark St" },
  { re: /\bcentral (ave|avenue)\b/i, geo: { lat: 42.668, lng: -73.79 }, label: "Central Ave" },
  { re: /\bcolony street|colonie street|\bcolony st\b/i, geo: { lat: 42.658, lng: -73.77 }, label: "Colony St" },
  { re: /\bwestern (ave|avenue)\b/i, geo: { lat: 42.66, lng: -73.78 }, label: "Western Ave" },
  { re: /\bpearl\b/i, geo: { lat: 42.65, lng: -73.75 }, label: "Pearl St" },
  { re: /\bwashington (ave|avenue)\b/i, geo: { lat: 42.66, lng: -73.77 }, label: "Washington Ave" },
  { re: /\bmadison\b/i, geo: { lat: 42.652, lng: -73.77 }, label: "Madison Ave" },
  { re: /\bhenry johnson\b/i, geo: { lat: 42.666, lng: -73.76 }, label: "Henry Johnson Blvd" },
  { re: /\bnew scotland\b/i, geo: { lat: 42.65, lng: -73.78 }, label: "New Scotland Ave" },
  { re: /\bdelaware (ave|avenue)\b/i, geo: { lat: 42.64, lng: -73.77 }, label: "Delaware Ave" },
  { re: /\bbroadway\b/i, geo: { lat: 42.65, lng: -73.75 }, label: "Broadway" },
];

const TOWN_NAMES = Object.keys(TOWN).sort((a, b) => b.length - a.length);

function townGeo(name: string): Geo {
  return TOWN[name] ?? { lat: 42.68, lng: -73.82 };
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

export function locateSpoken(text: string, municipality: string): { geo: Geo; road: string } {
  for (const s of STREETS) {
    if (s.re.test(text)) return { geo: s.geo, road: s.label };
  }
  const place = placeFromText(text);
  if (place) return { geo: { lat: place.lat, lng: place.lng }, road: "" };
  return { geo: locateCall({ municipality, station: "", road: "", intersection: "" }), road: "" };
}

/** Spread stacked pins far enough to read at Capital District zoom. */
export function spreadCoord(geo: Geo, key: string, index: number, total: number): Geo {
  if (total <= 1) return geo;
  const angle = (index * 2.39996) % (Math.PI * 2);
  const ring = 0.022 + Math.floor(index / 6) * 0.014;
  const h = hash(key);
  return {
    lat: geo.lat + Math.cos(angle) * ring + ((h % 17) - 8) * 0.0004,
    lng: geo.lng + Math.sin(angle) * ring * 1.35 + (((h >> 4) % 17) - 8) * 0.0004,
  };
}

export function spreadItems<T extends { id: string; lat: number; lng: number }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.lat.toFixed(3)}|${item.lng.toFixed(3)}`;
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
