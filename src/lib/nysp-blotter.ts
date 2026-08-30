import type { LiveWireItem } from "./sources";
import { locateCall, placeFromText } from "./geo";

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

const CD_STATION =
  /\b(latham|schodack|brunswick|capital|clifton park|saratoga|wilton|malta|ballston|halfmoon|waterford|mechanicville|princetown|rotterdam|niskayuna|glenville|scotia|albany thruway|loudonville|bethlehem|guilderland|delmar|cohoes|watervliet|menands|east greenbush|north greenbush|castleton|sand lake|hoosick|stephentown|grafton)\b/i;

const CD_PLACE =
  /\b(albany|colonie|latham|loudonville|bethlehem|delmar|selkirk|glenmont|guilderland|altamont|cohoes|watervliet|green island|menands|new scotland|voorheesville|coeymans|ravena|westerlo|berne|knox|rensselaerville|troy|brunswick|schodack|castleton|east greenbush|north greenbush|rensselaer|nassau|sand lake|berlin|stephentown|hoosick|pittstown|poestenkill|grafton|petersburgh|schaghticoke|clifton park|halfmoon|malta|ballston|waterford|mechanicville|stillwater|wilton|milton|greenfield|saratoga|niskayuna|rotterdam|duanesburg|princetown|glenville|scotia|schenectady)\b/i;

const FEEDS: { troop: string; zone: number }[] = [
  { troop: "G", zone: 1 },
  { troop: "G", zone: 2 },
  { troop: "G", zone: 3 },
  { troop: "G", zone: 4 },
  { troop: "T", zone: 1 },
  { troop: "T", zone: 2 },
];

let cache: { at: number; items: LiveWireItem[]; tried: number; failed: number; extractor: "poppler" | "pdf-parse" | "none" } | null = null;
const CACHE_MS = 4 * 60_000;

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
    .replace(/violaon/gi, "violation")
    .replace(/Ulity/g, "Utility")
    .replace(/cket\b/g, "ticket")
    .replace(/Invesgaon/g, "Investigation")
    .replace(/Secon/g, "Section")
    .replace(/Descripon/g, "Description")
    .replace(/Operaon/g, "Operation")
    .replace(/Strangulaon/g, "Strangulation")
    .replace(/Intersecon/g, "Intersection")
    .replace(/Personaon/g, "Personation")
    .replace(/Registraon/g, "Registration")
    .replace(/Possesion/gi, "Possession")
    .replace(/Conservaon/g, "Conservation")
    .replace(/Navigaon/g, "Navigation")
    .replace(/Suspen(?:s)?ion/g, "Suspension")
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
  return placeFromText(text);
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
    "Bad check - insufficient funds": "Bad check",
    "Domestic - dispute": "Domestic",
    "Suspicious vehicle": "Suspicious vehicle",
    "Fraud": "Fraud",
  };
  const mapped = map[c] ?? c.replace(/^Vehicle - /i, "").replace(/^Aid - /i, "").replace(/^Larceny - /i, "Larceny · ");
  return mapped.replace(/^([a-z])/, (ch) => ch.toUpperCase());
}

function field(chunk: string, label: string, until: string): string {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?:${until}|$)`, "i");
  return clean(chunk.match(re)?.[1] ?? "");
}

function prettyStatus(status: string): string {
  const s = status.replace(/Incident Information.*/i, "").replace(/file:.*/i, "").trim();
  if (/arrest adult/i.test(s)) return "Adult arrested";
  if (/closed\/cleared|closed/i.test(s)) return "Closed";
  if (/investigation pending/i.test(s)) return "Investigation pending";
  if (/unfounded/i.test(s)) return "Unfounded";
  return s.slice(0, 48);
}

function prettyArrest(raw: string): string {
  const s = clean(raw);
  if (/held/i.test(s) && /\bno\b/i.test(s)) return "Held without bail";
  if (/no bail/i.test(s)) return "Held without bail";
  if (/appearance/i.test(s)) return "Appearance ticket issued";
  if (/\bror\b|released on/i.test(s)) return "Released";
  if (/held/i.test(s)) return "Held";
  return "";
}

function prettyRoad(raw: string): string {
  const s = clean(raw);
  if (!s) return "";
  if (/^parking lot$/i.test(s)) return "parking lot";
  return titleCase(
    s
      .replace(/^INTERSTATE\s+/i, "I-")
      .replace(/^STATE ROUTE\s+/i, "NY ")
      .replace(/^US ROUTE\s+/i, "US ")
      .replace(/^ROUTE\s+/i, "Route ")
      .replace(/\bRD\b/g, "Rd")
      .replace(/\bST\b/g, "St")
      .replace(/\bDR\b/g, "Dr")
      .replace(/\bAVE\b/g, "Ave")
      .replace(/\bBLVD\b/g, "Blvd")
      .replace(/\bPKWY\b/g, "Pkwy")
      .replace(/\bLN\b/g, "Ln"),
  );
}

function extractRoad(chunk: string): { road: string; intersection: string } {
  const roadRaw =
    chunk.match(
      /Road\/Highway:\s*([^:]{2,48}?)(?=\s+(?:Intersection|Location|Number|Defendant|Driver|Incident)|$)/i,
    )?.[1] ?? "";
  const interRaw =
    chunk.match(
      /Intersection:\s*([^:]{2,48}?)(?=\s+(?:Location|Number|Defendant|Incident)|$)/i,
    )?.[1] ?? "";
  return { road: prettyRoad(roadRaw).slice(0, 42), intersection: prettyRoad(interRaw).slice(0, 36) };
}

function shortenCharge(desc: string): string {
  let d = desc.trim();
  if (/aggravated dwi|\.18/i.test(d)) return "Aggravated DWI";
  if (/intoxicat|\.08 of 1%|alcohol or more/i.test(d)) return "DWI";
  if (/unlicensed/i.test(d)) return "Aggravated unlicensed operation";
  if (/false person/i.test(d)) return "False personation";
  if (/stolen property/i.test(d)) return "Criminal possession of stolen property";
  if (/controlled substance/i.test(d)) return "Criminal possession of a controlled substance";
  if (/weapon/i.test(d)) return "Criminal possession of a weapon";
  if (/forged instrument/i.test(d)) return "Possession of a forged instrument";
  if (/family offense/i.test(d)) return "Aggravated family offense";
  if (/pet(?:it)?\s+larceny/i.test(d)) return "Petit larceny";
  if (/crim(?:inal)?\s+contempt/i.test(d)) return "Criminal contempt";
  if (/registration (suspended|violation)|vehicle violation/i.test(d)) return "Suspended registration";
  d = d
    .replace(/-\s*\d+(st|nd|rd|th).*/i, "")
    .replace(/-?\s*More Than.*/i, "")
    .replace(/:.*/, "")
    .trim();
  const head = d.split(/[:]/)[0]!.trim();
  if (head.length >= 6 && head.length <= 72) return head;
  return d.slice(0, 72);
}

function extractCharges(chunk: string): string[] {
  const out: string[] = [];
  const re =
    /\b(PL|VTL|ABC|ECL|AM|TL|TAX|PHL)\s+[\d.]+(?:\s+\S+)?\s+([A-Z])\s+(Felony|Misdemeanor|Infraction|Violation)\s+(.+?)\s+(\d+)(?=\s+(?:PL|VTL|ABC|ECL|AM|TL|TAX|PHL|Incident|$))/gi;
  for (const m of chunk.matchAll(re)) {
    const desc = shortenCharge(clean(m[4] ?? "").replace(/\s*\d+\s*$/, "").replace(/:+$/, "").trim());
    if (desc.length < 3) continue;
    if (out.some((x) => x.toLowerCase() === desc.toLowerCase())) continue;
    out.push(desc);
    if (out.length >= 3) break;
  }
  return out;
}

function impliedRoad(station: string, road: string): string {
  if (road) return road;
  if (/interstate patrol/i.test(station)) return "I-87";
  if (/thruway/i.test(station)) return "Thruway";
  return "";
}

function buildSummary(input: {
  titleCat: string;
  charges: string[];
  status: string;
  arrestee: string;
  road: string;
  intersection: string;
  injured?: string;
  killed?: string;
  age?: string;
  where: string;
}): string {
  const parts: string[] = [];
  const place = [input.road, input.intersection ? `at ${input.intersection}` : ""].filter(Boolean).join(" ");
  if (input.charges.length) {
    const who = input.age
      ? `${input.age}-year-old arrested for `
      : /arrest/i.test(input.status)
        ? "Adult arrested for "
        : "Charged with ";
    parts.push(who + input.charges.join("; "));
    const hold = prettyArrest(input.arrestee);
    if (hold) parts.push(hold);
    if (place) parts.push(place);
  } else {
    const st = prettyStatus(input.status);
    const whereBit = place ? `on ${place}` : input.where ? `in ${input.where}` : "";
    parts.push(`${input.titleCat}${whereBit ? ` ${whereBit}` : ""}`);
    if (st) parts.push(st);
  }
  if (input.killed && input.killed !== "0") parts.push(`${input.killed} killed`);
  if (input.injured && input.injured !== "0") parts.push(`${input.injured} injured`);
  return parts.join(". ").replace(/\s+\./g, ".").replace(/\.{2,}/g, ".").slice(0, 320);
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
  const chunks = body.split(/Incident\s*Number:\s*(?=NY\d+)/i);
  for (const chunk of chunks) {
    const idm = chunk.match(/^(NY\d+)/i);
    if (!idm) continue;
    const id = idm[1]!;
    const cat = field(chunk, "Incident Category", "Date\\/Time Reported:|Station:|Location Code:");
    if (!cat || SKIP_CAT.test(cat) || (/Incident Status/i.test(cat) && cat.length < 24)) continue;
    const reportedRaw = field(chunk, "Date\\/Time Reported", "Station:|Location Code:|Incident Status:");
    const arrestRaw = chunk.match(/Date\/Time of Arrest:\s*([0-9\/, APapM:]+)/i)?.[1] ?? "";
    const loc = field(chunk, "Location Code", "Incident Status:|Defendant|Driver|Road\\/Highway:");
    const status = field(chunk, "Incident Status", "Defendant|Driver|Incident Number:|Road\\/Highway:|Incident Information");
    const station = field(chunk, "Station", "Location Code:|Incident Status:|Date\\/Time");
    const { road, intersection } = extractRoad(chunk);
    const charges = extractCharges(chunk);
    const arrestee = clean(
      chunk.match(
        /Arrestee Status:\s*([^:]{3,80}?)(?=\s+(?:Location of Arrest|Bail Amount|Arrest Information|Incident Number)|$)/i,
      )?.[1] ?? "",
    );
    const injured = chunk.match(/Number Injured:\s*(\d+)/i)?.[1];
    const killed = chunk.match(/Number Killed:\s*(\d+)/i)?.[1];
    const ageYrs = chunk.match(/\bAge:\s*(\d{1,3})\b/i)?.[1];
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
    const route = impliedRoad(station, road);
    const roadPretty = prettyRoad(route);
    const interPretty = prettyRoad(intersection);
    const address =
      roadPretty && interPretty
        ? `${roadPretty} at ${interPretty} · ${where}`
        : roadPretty
          ? `${roadPretty} · ${where}`
          : where || place.name;
    const pin = locateCall({ municipality: place.name, station, road: route, intersection });
    const summary = buildSummary({
      titleCat,
      charges,
      status,
      arrestee,
      road: roadPretty,
      intersection: interPretty,
      injured,
      killed,
      age: ageYrs,
      where,
    });
    const title = roadPretty
      ? `${titleCat} on ${roadPretty}${interPretty ? ` at ${interPretty}` : ""} — ${where}`
      : `${titleCat} — ${where}`;
    out.push({
      id: `nysp-${id}`,
      title,
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
      status: prettyStatus(status) || status,
      lat: pin.lat,
      lng: pin.lng,
    });
  }
  return out;
}

async function textWithPoppler(buf: Uint8Array, extra: string[] = ["-layout"]): Promise<string | null> {
  try {
    const { spawn } = await import("node:child_process");
    const { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "nysp-"));
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, buf);
    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn("pdftotext", [...extra, "-enc", "UTF-8", pdfPath, "-"]);
      const chunks: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("pdftotext-timeout"));
      }, 20000);
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr.on("data", (c: Buffer) => err.push(c));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(Buffer.concat(err).toString("utf8") || `pdftotext-${code}`));
      });
    });
    try {
      unlinkSync(pdfPath);
      rmdirSync(dir);
    } catch {
      /* ignore */
    }
    return text;
  } catch {
    return null;
  }
}

async function textWithPdfCli(buf: Uint8Array): Promise<string | null> {
  try {
    const { spawn } = await import("node:child_process");
    const { writeFileSync, unlinkSync, mkdtempSync, rmdirSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cli = join(process.cwd(), "node_modules/pdf-parse/bin/cli.mjs");
    if (!existsSync(cli)) return null;
    const dir = mkdtempSync(join(tmpdir(), "nysp-cli-"));
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, buf);
    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, [cli, "text", pdfPath], { cwd: process.cwd() });
      const chunks: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("pdf-cli-timeout"));
      }, 25000);
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr.on("data", (c: Buffer) => err.push(c));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(Buffer.concat(err).toString("utf8") || `pdf-cli-${code}`));
      });
    });
    try {
      unlinkSync(pdfPath);
      rmdirSync(dir);
    } catch {
      /* ignore */
    }
    return text;
  } catch {
    return null;
  }
}

async function textWithPdfParse(buf: Uint8Array): Promise<string> {
  const mod = await import("pdf-parse");
  const PDFParse = mod.PDFParse;
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy();
  }
}

function incidentHits(text: string): number {
  return (text.match(/Incident\s*Number:\s*NY\d+/gi) || []).length;
}

async function fetchPdf(url: string): Promise<{ text: string; how: "poppler" | "pdf-parse" }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/pdf,*/*",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`pdf-${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 32) throw new Error("pdf-empty");

  const candidates: { text: string; how: "poppler" | "pdf-parse"; n: number }[] = [];
  const cli = await textWithPdfCli(buf);
  if (cli) candidates.push({ text: cli, how: "pdf-parse", n: incidentHits(cli) });
  const layout = await textWithPoppler(buf, ["-layout"]);
  if (layout) candidates.push({ text: layout, how: "poppler", n: incidentHits(layout) });
  const raw = await textWithPoppler(buf, []);
  if (raw) candidates.push({ text: raw, how: "poppler", n: incidentHits(raw) });
  try {
    const parsed = await textWithPdfParse(buf);
    if (parsed) candidates.push({ text: parsed, how: "pdf-parse", n: incidentHits(parsed) });
  } catch (err) {
    console.error("[nysp] pdf-parse", url, err instanceof Error ? err.message : err);
  }
  candidates.sort((a, b) => b.n - a.n);
  const best = candidates.find((c) => c.n > 0) ?? candidates.find((c) => c.text.length > 80);
  if (!best) throw new Error("pdf-no-text");
  return { text: best.text, how: best.how };
}

export type BlotterReport = {
  items: LiveWireItem[];
  tried: number;
  failed: number;
  extractor: "poppler" | "pdf-parse" | "none";
};

export async function fetchNyspBlotter(now = Date.now()): Promise<BlotterReport> {
  if (cache && now - cache.at < CACHE_MS) {
    return { items: cache.items, tried: cache.tried, failed: cache.failed, extractor: cache.extractor };
  }
  const days = nyWeekdays(new Date(now));
  let failed = 0;
  let extractor: BlotterReport["extractor"] = "none";
  const jobs = FEEDS.flatMap((f) =>
    days.map(async (dow) => {
      const url = pdfUrl(f.troop, dow, f.zone);
      try {
        const { text, how } = await fetchPdf(url);
        extractor = how;
        return extractNyspText(text, f.troop, f.zone, url, now);
      } catch (err) {
        failed += 1;
        console.error("[nysp]", url, err instanceof Error ? err.message : err);
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
  const tried = jobs.length;
  if (items.length > 0 || failed === 0) {
    cache = { at: now, items, tried, failed, extractor };
  }
  return { items, tried, failed, extractor };
}
