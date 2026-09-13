/** Albany County / Capital Region tax parcels from NYS public FeatureServer. */

export const PARCEL_SOURCE =
  "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1";

export const PARCEL_CREDIT = "NYS ITS / Albany County GIS";

/** Roughly below NYS layer minScale 1:37050 — reveal parcels when close in. */
export const PARCEL_MIN_ZOOM = 15;

export const PARCEL_OUT_FIELDS = [
  "PRINT_KEY",
  "SBL",
  "SWIS_SBL_ID",
  "MUNI_PARCEL_ID",
  "PRIMARY_OWNER",
  "ADD_OWNER",
  "PARCEL_ADDR",
  "LOC_ST_NBR",
  "LOC_STREET",
  "LOC_UNIT",
  "LOC_ZIP",
  "MUNI_NAME",
  "CITYTOWN_NAME",
  "COUNTY_NAME",
].join(",");

export type ParcelAttrs = {
  PRINT_KEY?: string | null;
  SBL?: string | null;
  SWIS_SBL_ID?: string | null;
  MUNI_PARCEL_ID?: string | null;
  PRIMARY_OWNER?: string | null;
  ADD_OWNER?: string | null;
  PARCEL_ADDR?: string | null;
  LOC_ST_NBR?: string | null;
  LOC_STREET?: string | null;
  LOC_UNIT?: string | null;
  LOC_ZIP?: string | null;
  MUNI_NAME?: string | null;
  CITYTOWN_NAME?: string | null;
  COUNTY_NAME?: string | null;
};

export type ParcelSummary = {
  parcelId: string;
  owner: string;
  address: string;
  municipality: string;
  county: string;
};

function clean(s: string | null | undefined): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** Only public assessment fields — never invent owner or address. */
export function summarizeParcel(attrs: ParcelAttrs | null | undefined): ParcelSummary | null {
  if (!attrs) return null;
  const parcelId =
    clean(attrs.PRINT_KEY) ||
    clean(attrs.MUNI_PARCEL_ID) ||
    clean(attrs.SWIS_SBL_ID) ||
    clean(attrs.SBL);
  const owner = clean(attrs.PRIMARY_OWNER) || clean(attrs.ADD_OWNER);
  const situs = [clean(attrs.LOC_ST_NBR), clean(attrs.LOC_STREET), clean(attrs.LOC_UNIT)]
    .filter(Boolean)
    .join(" ");
  const address = clean(attrs.PARCEL_ADDR) || situs;
  const municipality = clean(attrs.MUNI_NAME) || clean(attrs.CITYTOWN_NAME);
  const county = clean(attrs.COUNTY_NAME);
  if (!parcelId && !address && !owner) return null;
  return {
    parcelId: parcelId || "—",
    owner,
    address: address
      ? attrs.LOC_ZIP
        ? `${address}${municipality ? `, ${municipality}` : ""} ${clean(attrs.LOC_ZIP)}`.trim()
        : municipality && !address.toLowerCase().includes(municipality.toLowerCase())
          ? `${address}, ${municipality}`
          : address
      : municipality || "",
    municipality,
    county,
  };
}

export function parcelPopupHtml(attrs: ParcelAttrs): string {
  const s = summarizeParcel(attrs);
  if (!s) return `<div class="act-parcel-tip"><p class="act-tip-meta">No public parcel fields</p></div>`;
  const rows: string[] = [];
  rows.push(`<p class="act-tip-title">Parcel ${escapeHtml(s.parcelId)}</p>`);
  if (s.owner) {
    rows.push(`<p class="act-tip-meta"><span class="act-parcel-k">Owner</span> ${escapeHtml(s.owner)}</p>`);
  } else {
    rows.push(`<p class="act-tip-meta"><span class="act-parcel-k">Owner</span> not in public layer</p>`);
  }
  if (s.address) {
    rows.push(`<p class="act-tip-meta"><span class="act-parcel-k">Address</span> ${escapeHtml(s.address)}</p>`);
  }
  rows.push(
    `<p class="act-tip-kind">${escapeHtml(PARCEL_CREDIT)}${s.county ? ` · ${escapeHtml(s.county)} County` : ""}</p>`,
  );
  return `<div class="act-parcel-tip">${rows.join("")}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildParcelQuery(bbox: [number, number, number, number], counties: string[]): string {
  const [west, south, east, north] = bbox;
  const where =
    counties.length === 1
      ? `COUNTY_NAME='${counties[0]}'`
      : `COUNTY_NAME IN (${counties.map((c) => `'${c}'`).join(",")})`;
  const params = new URLSearchParams({
    where,
    geometry: `${west},${south},${east},${north}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: PARCEL_OUT_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "400",
    f: "geojson",
  });
  return `${PARCEL_SOURCE}/query?${params.toString()}`;
}

export type ParcelFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: unknown;
    properties: ParcelAttrs | null;
  }>;
};

export async function fetchParcelsGeoJson(
  bbox: [number, number, number, number],
  opts?: { counties?: string[]; signal?: AbortSignal; viaProxy?: boolean },
): Promise<ParcelFeatureCollection> {
  const counties = opts?.counties ?? ["Albany", "Rensselaer", "Schenectady"];
  const upstream = buildParcelQuery(bbox, counties);
  const url = opts?.viaProxy
    ? `/api/parcels?bbox=${bbox.join(",")}&counties=${encodeURIComponent(counties.join(","))}`
    : upstream;
  const res = await fetch(url, {
    headers: { Accept: "application/geo+json, application/json" },
    signal: opts?.signal ?? AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`parcels HTTP ${res.status}`);
  const json = (await res.json()) as ParcelFeatureCollection;
  if (!json || json.type !== "FeatureCollection") {
    throw new Error("parcels: expected FeatureCollection");
  }
  return json;
}
