// ─────────────────────────────────────────────────────────────────────────────
// Server-side API helpers — fetch data from FastAPI backend.
// These run only on the server (in Server Components or Route Handlers).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  IncidentsResponse,
  ScannerCallsResponse,
  ScannerChannelsResponse,
} from "../types";
import { getApiBase, toQueryString } from "./utils";

const DEFAULT_REVALIDATE = 30; // seconds

/**
 * Fetches the persisted incidents from the FastAPI backend.
 * Used in Server Components for SSR.
 */
export async function fetchIncidents(params?: {
  limit?: number;
  offset?: number;
  sort_by?: string;
  start_date?: string;
  q?: string;
  severity?: string;
  municipality?: string;
}): Promise<IncidentsResponse> {
  const base = getApiBase();
  const qs = toQueryString({
    limit: params?.limit ?? 120,
    offset: params?.offset ?? 0,
    sort_by: params?.sort_by ?? "operational",
    start_date: params?.start_date ?? homeWindowStartIso(48),
    ...(params?.q ? { q: params.q } : {}),
    ...(params?.severity ? { severity: params.severity } : {}),
    ...(params?.municipality ? { municipality: params.municipality } : {}),
  });

  try {
    const res = await fetch(`${base}/api/incidents${qs}`, {
      next: { revalidate: DEFAULT_REVALIDATE },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as IncidentsResponse;
  } catch (err) {
    console.error("[fetchIncidents] error:", err);
    return { status: "error", incidents: [] };
  }
}

/**
 * Fetches scanner calls from the FastAPI backend.
 */
export async function fetchScannerCalls(params?: {
  channel?: string;
}): Promise<ScannerCallsResponse> {
  const base = getApiBase();
  const qs = params?.channel
    ? `?channel=${encodeURIComponent(params.channel)}`
    : "";

  try {
    const res = await fetch(`${base}/api/scanner/calls${qs}`, {
      next: { revalidate: 15 }, // scanner refreshes faster
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ScannerCallsResponse;
  } catch (err) {
    console.error("[fetchScannerCalls] error:", err);
    return { status: "error", calls: [] };
  }
}

/**
 * Fetches scanner channel presets from the FastAPI backend.
 */
export async function fetchScannerChannels(): Promise<ScannerChannelsResponse> {
  const base = getApiBase();
  try {
    const res = await fetch(`${base}/api/scanner/channels`, {
      next: { revalidate: 300 }, // channels rarely change
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ScannerChannelsResponse;
  } catch (err) {
    console.error("[fetchScannerChannels] error:", err);
    return { status: "error", channels: [] };
  }
}

/**
 * Returns an ISO timestamp for N hours ago (used as start_date filter).
 */
function homeWindowStartIso(hours = 48): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}
