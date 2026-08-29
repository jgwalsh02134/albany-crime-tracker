import { PDFParse } from "pdf-parse";
import type { LiveWireItem } from "./sources";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const SKIP_CAT =
  /property check|impounded|repossessed|lost\/stolen plates|vehicle - recovered|property found|^civil$|public appearance/i;

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

type Place = { name: string; lat: number; lng: number };

const PLACES: { re: RegExp; place: Place }[] = [
  { re: /\bnew scotland\b|\bvoorheesville\b/i, place: { name: "New Scotland", lat: 42.6217, lng: -73.9412 } },
  { re: /\bgreen island\b/i, place: { name: "Green Island", lat: 42.7442, lng: -73.6918 } },
  { re: /\bguilderland\b|\baltamont\b/i, place: { name: "Guilderland", lat: 42.7045, lng: -73.9115 } },
  { re: /\bbethlehem\b|\bdelmar\b|\bselkirk\b|\bglenmont\b/i, place: { name: "Bethlehem", lat: 42.5917, lng: -73.824 } },
  { re: /\bwatervliet\b/i, place: { name: "Watervliet", lat: 42.7301, lng: -73.7012 } },
  { re: /\bmenands\b/i, place: { name: "Menands", lat: 42.692, lng: -73.7237 } },
  { re: /\bcolonie\b|\blatham\b|\bloudonville\b/i, place: { name: "Colonie", lat: 42.7179, lng: -73.8373 } },
  { re: /\bcohoes\b/i, place: { name: "Cohoes", lat: 42.7742, lng: -73.7001 } },
  { re: /\bwesterlo\b/i, place: { name: "Westerlo", lat: 42.5145, lng: -74.044 } },
  { re: /\bcoeymans\b|\bravena\b/i, place: { name: "Coeymans", lat: 42.4737, lng: -73.7923 } },
  { re: /\bberne\b/i, place: { name: "Berne", lat: 42.548, lng: -74.134 } },
  { re: /\bknox\b/i, place: { name: "Knox", lat: 42.671, lng: -74.116 } },
  { re: /\brensselaerville\b/i, place: { name: "Rensselaerville", lat: 42.468, lng: -74.186 } },
  { re: /\beast greenbush\b/i, place: { name: "East Greenbush", lat: 42.591, lng: -73.702 } },
  { re: /\bnorth greenbush\b/i, place: { name: "North Greenbush", lat: 42.733, lng: -73.663 } },
  { re: /\bschodack\b|\bcastleton\b|\bnassau\b/i, place: { name: "Schodack", lat: 42.529, lng: -73.693 } },
  { re: /\bbrunswick\b|\bpoestenkill\b|\bgrafton\b/i, place: { name: "Brunswick", lat: 42.736, lng: -73.59 } },
  { re: /\bsand lake\b|\bberlin\b|\bstephentown\b|\bhoosick\b|\bpittstown\b/i, place: { name: "Rensselaer", lat: 42.6209, lng: -73.712 } },
  { re: /\btroy\b/i, place: { name: "Troy", lat: 42.7284, lng: -73.6918 } },
  { re: /\brensselaer\b/i, place: { name: "Rensselaer", lat: 42.6426, lng: -73.7429 } },
  { re: /\bclifton park\b/i, place: { name: "Clifton Park", lat: 42.8586, lng: -73.7709 } },
  { re: /\bhalfmoon\b/i, place: { name: "Halfmoon", lat: 42.843, lng: -73.713 } },
  { re: /\bmalta\b/i, place: { name: "Malta", lat: 42.967, lng: -73.793 } },
  { re: /\bballston\b/i, place: { name: "Ballston", lat: 42.955, lng: -73.879 } },
  { re: /\bmechanicville\b/i, place: { name: "Mechanicville", lat: 42.904, lng: -73.69 } },
  { re: /\bwaterford\b/i, place: { name: "Waterford", lat: 42.791, lng: -73.681 } },
  { re: /\bstillwater\b/i, place: { name: "Stillwater", lat: 42.938, lng: -73.659 } },
  { re: /\bwilton\b/i, place: { name: "Wilton", lat: 43.181, lng: -73.744 } },
  { re: /\bmilton\b/i, place: { name: "Milton", lat: 43.035, lng: -73.853 } },
  { re: /\bgreenfield\b/i, place: { name: "Greenfield", lat: 43.129, lng: -73.846 } },
  { re: /\bsaratoga\b/i, place: { name: "Saratoga Springs", lat: 43.0831, lng: -73.7846 } },
  { re: /\bniskayuna\b/i, place: { name: "Niskayuna", lat: 42.776, lng: -73.831 } },
  { re: /\brotterdam\b|\bduanesburg\b|\bprincetown\b/i, place: { name: "Rotterdam", lat: 42.787, lng: -73.971 } },
  { re: /\bglenville\b|\bscotia\b/i, place: { name: "Glenville", lat: 42.929, lng: -73.996 } },
  { re: /\bschenectady\b/i, place: { name: "Schenectady", lat: 42.8142, lng: -73.9396 } },
  { re: /\b(city of )?albany\b|\bcapitol\b|\bempire state plaza\b|\balbany thruway\b/i, place: { name: "Albany", lat: 42.6526, lng: -73.7562 } },
];

const CD_STATION =
  /\b(latham|schodack|brunswick|capital|clifton park|saratoga|wilton|malta|ballston|halfmoon|waterford|mechanicville|princetown|rotterdam|niskayuna|glenville|scotia|albany thruway|loudonville|bethlehem|guilderland|delmar|cohoes|watervliet|menands|east greenbush|north greenbush|castleton|sand lake)\b/i;

const CD_PLACE =
  /\b(albany|colonie|latham|loudonville|bethlehem|delmar|selkirk|glenmont|guilderland|altamont|cohoes|watervliet|green island|menands|new scotland|voorheesville|coeymans|ravena|westerlo|berne|knox|rensselaerville|troy|brunswick|schodack|castleton|east greenbush|north greenbush|rensselaer|nassau|sand lake|berlin|stephentown|hoosick|pittstown|poestenkill|grafton|clifton park|halfmoon|malta|ballston|waterford|mechanicville|stillwater|wilton|milton|greenfield|saratoga|niskayuna|rotterdam|duanesburg|princetown|glenville|scotia|schenectady)\b/i;

const FEEDS: { troop: string; zone: number }[] = [
  { troop: "G", zone: 1 },
  { troop: "G", zone: 2 },
  { troop: "G", zone: 3 },
  { troop: "G", zone: 4 },
  { troop: "T", zone: 1 },
  { troop: "T", zone: 2 },
];

let cache: { at: number; items: LiveWireItem[] } | null = null;
const CACHE_MS = 10 * 60_000;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function clean(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/file:\/\/\/\S+/g, " ")
    .replace(/--\s*\d+\s+of\s+\d+\s+--/g, " ")
    .replace(/Page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/\b\d+\s+of\s+\d+\b/g, " ")
    .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
    .replace(/Locaon/g, "Location")
    .replace(/Staon/g, "Station")
    .replace(/Informaon/g, "Information")
    .replace(/Domesc/g, "Domestic")
    .replace(/oﬀense|offense/gi, "offense")
    .replace(/Traﬃc/g, "Traffic")
    .replace(/ac\u0000vity|acvity/g, "activity")
    .replace(/ciizen|\bcizen\b/g, "citizen")
    .replace(/revocaon/g, "revocation")
    .replace(/identy the\b/gi, "identity theft")
    .replace(/violaon/g, "violation")
    .replace(/Ulity/g, "Utility")
    .replace(/cket\b/g, "ticket")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(i)-(\d+)/g, (_, a, n) => `${a.toUpperCase()}-${n}`)
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function zonedNy(year: number, month: number, day: number, hour: number, minute: number): number {
  const utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
  const asIf = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return utc - (asIf - utc);
}

export function parseNyWhen(raw: string): number | null {
  const s = raw
    .replace(/Sta(?:tion|on):.*/i, "")
    .replace(/Arrestee.*/i, "")
    .replace(/Location.*/i, "")
    .trim();
  const named = s.match(
    /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i,
  );
  const numeric = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  let year: number;
  let month: number;
  let day: number;
  let hour: number;
  let minute: number;
  let ap: string | undefined;
  if (named) {
    month = MONTHS[named[1]!.toLowerCase()] ?? 0;
    if (!month) return null;
    day = Number(named[2]);
    year = Number(named[3]);
    hour = Number(named[4]);
    minute = Number(named[5]);
    ap = named[6];
  } else if (numeric) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    year = Number(numeric[3]);
    hour = Number(numeric[4]);
    minute = Number(numeric[5]);
    ap = numeric[6];
  } else {
    return null;
  }
  if (ap) {
    const mer = ap.toUpperCase();
    if (mer === "PM" && hour < 12) hour += 12;
    if (mer === "AM" && hour === 12) hour = 0;
  }
  if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return zonedNy(year, month, day, hour, minute);
}

function nyWeekdays(now = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
  const today = fmt.format(now);
  const y = new Date(now.getTime() - 24 * 3600_000);
  const yesterday = fmt.format(y);
  const map: Record<string, string> = Object.fromEntries(DOW.map((d) => [d, d]));
  return [...new Set([map[today] ?? DOW[now.getDay()], map[yesterday] ?? DOW[y.getDay()]])].filter(
    Boolean,
  ) as string[];
}

function pdfUrl(troop: string, dow: string, zone: number): string {
  return `https://publicapps.troopers.ny.gov/media/Troop${troop}/Media${dow}${zone}.pdf`;
}

function placeOf(text: string): Place | null {
  for (const row of PLACES) {
    if (row.re.test(text)) return row.place;
  }
  return null;
}

function inCapitalDistrict(station: string, loc: string): boolean {
  if (CD_PLACE.test(loc)) return true;
  if (!loc.trim()) return CD_STATION.test(station);
  return false;
}

function prettyCat(cat: string): string {
  const c = cat.replace(/\s+/g, " ").trim();
  const map: Record<string, string> = {
    "Accident - property damage": "Property-damage crash",
    "Accident - personal injury": "Injury crash",
    "Accident - hit & run": "Hit-and-run crash",
    "Accident - fatal": "Fatal crash",
    "Vehicle - DWI": "DWI",
    "Vehicle - disabled": "Disabled vehicle",
    "Vehicle - V&T complaint": "Traffic stop",
    "Vehicle - abandoned": "Abandoned vehicle",
    "Vehicle - illegally parked": "Illegal parking",
    "Vehicle - motorcycle complaint": "Motorcycle complaint",
    "Vehicle - DMV suspension/revocation": "Suspended license",
    "Aid - assist other agency": "Assist other agency",
    "Aid - assist PD-other": "Assist police",
    "Aid - assist citizen": "Assist citizen",
    "Aid - assist EMS": "Assist EMS",
    "Aid - 911 hang-up": "911 hang-up",
    "Welfare check": "Welfare check",
    "Suspicious activity": "Suspicious activity",
    "Suspicious person": "Suspicious person",
    "Disturbance - neighborhood": "Disturbance",
    "Drug/Alcohol - possession": "Drug possession",
    "Drug/Alcohol - ABC law violation": "ABC violation",
    "Domestic - family offense": "Domestic",
    "Alarm - burglary": "Burglary alarm",
    "Road - blocked": "Road blocked",
    "Road - all other": "Road hazard",
    "Gun/Weapon - possession": "Weapon possession",
    "Trespass in-progress": "Trespass",
    "Animal - complaint": "Animal complaint",
    "Animal - dog complaint": "Dog complaint",
    "Aid - locate person": "Locate person",
    "Aid - ambulance": "Assist ambulance",
    "Aid - aided case": "Aided person",
    "Screaming person": "Screaming person",
    "Disturbance - disorderly": "Disorderly",
    "Disturbance - criminal mischief": "Criminal mischief",
    "Child - endangering the welfare": "Child welfare",
    "Missing - child": "Missing child",
    "Larceny - from building": "Larceny · building",
    "Larceny - from vehicle": "Larceny · vehicle",
    "Larceny - of a vehicle": "Stolen vehicle",
    "Larceny - other": "Larceny",
    "TERPO/ERPO": "Protection order",
    "Utility - odor of gas": "Gas odor",
    "Menacing": "Menacing",
  };
  const mapped = map[c] ?? c.replace(/^Vehicle - /i, "").replace(/^Aid - /i, "").replace(/^Larceny - /i, "Larceny · ");
  return mapped.replace(/^([a-z])/, (ch) => ch.toUpperCase());
}

function field(chunk: string, label: string, until: string): string {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?:${until}|$)`, "i");
  return clean(chunk.match(re)?.[1] ?? "");
}

export function extractNyspText(
  text: string,
  troop: string,
  zone: number,
  pdf: string,
  now: number,
): LiveWireItem[] {
  const body = clean(text);
  const out: LiveWireItem[] = [];
  const chunks = body.split(/Incident Number:\s*(?=NY\d+)/i);
  for (const chunk of chunks) {
    const idm = chunk.match(/^(NY\d+)/i);
    if (!idm) continue;
    const id = idm[1]!;
    const cat = field(chunk, "Incident Category", "Date\\/Time Reported:|Station:|Location Code:");
    if (!cat || SKIP_CAT.test(cat) || (/Incident Status/i.test(cat) && cat.length < 24)) continue;
    const reportedRaw = field(chunk, "Date\\/Time Reported", "Station:|Location Code:|Incident Status:");
    const arrestRaw = chunk.match(/Date\/Time of Arrest:\s*([0-9\/, APapM:]+)/i)?.[1] ?? "";
    const loc = field(chunk, "Location Code", "Incident Status:|Defendant|Driver|Road\\/Highway:");
    const status = field(chunk, "Incident Status", "Defendant|Driver|Incident Number:|Road\\/Highway:");
    const station = field(chunk, "Station", "Location Code:|Incident Status:|Date\\/Time");
    const road = field(chunk, "Road\\/Highway", "Number of|Driver|Incident |Defendant");
    const injured = chunk.match(/Number Injured:\s*(\d+)/i)?.[1];
    const killed = chunk.match(/Number Killed:\s*(\d+)/i)?.[1];
    const reportedAt = parseNyWhen(reportedRaw);
    const arrestAt = parseNyWhen(clean(arrestRaw));
    const at = [arrestAt, reportedAt]
      .filter((n): n is number => n != null)
      .sort((a, b) => b - a)[0];
    if (at == null) continue;
    const age = now - at;
    if (age > 72 * 3600_000 || age < -2 * 3600_000) continue;
    const locName = titleCase(
      loc
        .replace(/^(TOWN|CITY|VILLAGE|CITY OF)\s*-\s*/i, "")
        .replace(/\s*-\s*\d{3,5}\s*$/, "")
        .trim(),
    );
    if (!inCapitalDistrict(station, `${loc} ${locName} ${road}`)) continue;
    const place =
      placeOf(loc) ||
      placeOf(locName) ||
      placeOf(`${station} ${road}`) ||
      placeOf(`${loc} ${station} ${locName} ${road} ${cat}`) || {
        name: locName || "Capital District",
        lat: 42.68,
        lng: -73.82,
      };
    const titleCat = prettyCat(cat).replace(/\s+\d+\s*$/, "").trim();
    if (!titleCat || /file:|--/.test(titleCat)) continue;
    const where = locName || place.name;
    const extra =
      killed && killed !== "0"
        ? ` · ${killed} killed`
        : injured && injured !== "0"
          ? ` · ${injured} injured`
          : "";
    const roadBit = road && road.length < 48 ? road.replace(/^INTERSTATE\s+/i, "I-") : "";
    const address = roadBit && where && roadBit.toLowerCase() !== where.toLowerCase()
      ? `${roadBit} · ${where}`
      : where || place.name;
    const summary = [
      `NYSP Troop ${troop} Zone ${zone}`,
      station,
      status,
      extra.trim(),
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 220);
    out.push({
      id: `nysp-${id}`,
      title: `${titleCat} — ${where || place.name}`,
      url: pdf,
      outlet: "NYSP blotter",
      summary,
      publishedAt: new Date(at).toISOString(),
      minutesAgo: Math.max(0, Math.round(age / 60_000)),
      kind: "blotter",
      municipality: place.name,
      address,
      agency: `NYSP Troop ${troop}`,
      category: cat,
      status,
      lat: place.lat,
      lng: place.lng,
    });
  }
  return out;
}

async function fetchPdf(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/pdf" },
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`pdf-${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

export async function fetchNyspBlotter(now = Date.now()): Promise<LiveWireItem[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.items;
  const days = nyWeekdays(new Date(now));
  const jobs = FEEDS.flatMap((f) =>
    days.map(async (dow) => {
      const url = pdfUrl(f.troop, dow, f.zone);
      try {
        const text = await fetchPdf(url);
        return extractNyspText(text, f.troop, f.zone, url, now);
      } catch {
        return [] as LiveWireItem[];
      }
    }),
  );
  const batches = await Promise.all(jobs);
  const seen = new Set<string>();
  const items: LiveWireItem[] = [];
  for (const batch of batches) {
    for (const row of batch) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(row);
    }
  }
  items.sort((a, b) => a.minutesAgo - b.minutesAgo);
  cache = { at: now, items };
  return items;
}
