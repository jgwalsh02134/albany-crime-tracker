import { getSql } from "@/lib/db";
import type { GeoPrecision } from "@/lib/geo";
import type { LiveWireItem } from "@/lib/sources";
import { stripHtml } from "@/lib/security/sanitize";
import { deriveGeoPrecisionFromAccuracy } from "@/lib/witness";

export type WitnessKind = "police" | "fire" | "crash" | "other";

export type NewWitnessReport = {
  id: string;
  kind: WitnessKind;
  note?: string;
  lat: number;
  lng: number;
  geoPrecision: GeoPrecision;
  accuracyM?: number | null;
  userAgent?: string | null;
};

type StoredWitnessReport = {
  id: string;
  createdAtMs: number;
  kind: WitnessKind;
  note: string;
  lat: number;
  lng: number;
  geoPrecision: GeoPrecision;
  accuracyM: number | null;
};

function toMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (v instanceof Date) return v.getTime();
  return Date.now();
}

function titleFor(kind: WitnessKind): string {
  switch (kind) {
    case "police":
      return "Witness report — Police activity";
    case "fire":
      return "Witness report — Fire";
    case "crash":
      return "Witness report — Crash";
    case "other":
      return "Witness report — Activity";
  }
}

export async function insertWitnessReport(input: NewWitnessReport): Promise<void> {
  const sql = await getSql();
  const note = stripHtml(input.note ?? "", 240);
  const ua = stripHtml(input.userAgent ?? "", 220);
  const acc =
    typeof input.accuracyM === "number" && Number.isFinite(input.accuracyM)
      ? Math.max(0, Math.min(100_000, Math.round(input.accuracyM)))
      : null;
  await sql.query(
    `
      insert into witness_reports (id, kind, note, lat, lng, geo_precision, accuracy_m, user_agent)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      input.id,
      input.kind,
      note || null,
      input.lat,
      input.lng,
      input.geoPrecision,
      acc,
      ua || null,
    ],
  );
}

export async function listWitnessReports(nowMs: number, windowMs: number): Promise<StoredWitnessReport[]> {
  const sql = await getSql();
  const sinceIso = new Date(nowMs - windowMs).toISOString();
  const rows = await sql.query<{
    id: string;
    created_at: unknown;
    kind: WitnessKind;
    note: string | null;
    lat: number;
    lng: number;
    geo_precision: GeoPrecision;
    accuracy_m: number | null;
  }>(
    `
      select id, created_at, kind, note, lat, lng, geo_precision, accuracy_m
      from witness_reports
      where created_at >= $1::timestamptz
      order by created_at desc
      limit 250
    `,
    [sinceIso],
  );
  return rows.map((r) => ({
    id: String(r.id),
    createdAtMs: toMs(r.created_at),
    kind: r.kind,
    note: stripHtml(r.note ?? "", 240),
    lat: Number(r.lat),
    lng: Number(r.lng),
    geoPrecision: r.geo_precision,
    accuracyM: typeof r.accuracy_m === "number" && Number.isFinite(r.accuracy_m) ? r.accuracy_m : null,
  }));
}

export async function witnessReportsToWire(nowMs: number): Promise<LiveWireItem[]> {
  const windowMs = 24 * 60 * 60_000;
  const reports = await listWitnessReports(nowMs, windowMs);
  return reports.map((r) => {
    const minutesAgo = Math.max(0, Math.round((nowMs - r.createdAtMs) / 60_000));
    const summaryNote = r.note ? `Note: ${r.note}` : "";
    const precision = r.accuracyM != null ? `Geo ±${Math.round(r.accuracyM)}m` : `Geo: ${r.geoPrecision}`;
    const summary = [summaryNote, "Witness report — may be wrong.", precision].filter(Boolean).join(" · ");
    const id = r.id.startsWith("citizen-") ? r.id : `citizen-${r.id}`;
    return {
      id,
      title: titleFor(r.kind),
      url: `/i/${encodeURIComponent(id)}`,
      outlet: "Citizen · Witness",
      summary,
      publishedAt: new Date(r.createdAtMs).toISOString(),
      minutesAgo,
      kind: "social",
      municipality: "Capital District",
      address: "Pinned location",
      agency: "Citizen",
      lat: r.lat,
      lng: r.lng,
      geoPrecision: r.geoPrecision,
      category: r.kind,
      status: "reported",
    } satisfies LiveWireItem;
  });
}

