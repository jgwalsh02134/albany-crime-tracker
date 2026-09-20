// ─────────────────────────────────────────────────────────────────────────────
// Shared TypeScript types for the Albany Crime Tracker Next.js frontend.
// These mirror the shapes returned by the FastAPI backend.
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkedSource {
  name: string;
  url?: string;
  agency_id?: string;
  first_seen_at?: string;
}

export interface IncidentBadge {
  label: string;
  type?: string;
}

export interface Incident {
  id: string;
  title: string;
  short_title?: string;
  description?: string;
  occurred_at?: string;
  published_at?: string;
  human_time?: string;
  municipality?: string;
  address_text?: string;
  latitude?: number;
  longitude?: number;
  coordinate_quality?: "exact" | "approximate" | "missing";
  severity?: "critical" | "high" | "medium" | "low" | "unknown";
  verification_level?: "official" | "multi_source" | "media" | "scanner" | "inferred" | "unknown";
  verification_explanation?: string;
  source_name?: string;
  source_url?: string;
  source_type?: string;
  source_type_explanation?: string;
  responding_agency_id?: string;
  incident_type?: string;
  status?: string;
  confidence_score?: number;
  priority_score?: number;
  is_high_priority?: boolean;
  is_trending?: boolean;
  is_actionable_live?: boolean;
  badges?: string[];
  tags?: string[];
  sources?: LinkedSource[];
}

export interface IncidentsResponse {
  status: "ok" | "error";
  incidents: Incident[];
  total?: number;
  source?: string;
}

export interface ScannerCall {
  id?: string;
  _id?: string;
  time?: string;
  start_time?: string;
  talkgroup_num?: number | string;
  talkgroup?: number | string;
  talkgroup_tag?: string;
  talkgroupTag?: string;
  talkgroup_alpha_tag?: string;
  talkgroup_description?: string;
  talkgroupDescription?: string;
  url?: string;
  audio_url?: string;
  duration?: number;
  len?: number;
  freq?: number;
  source?: string;
}

export interface ScannerCallsResponse {
  status: "ok" | "error";
  calls: ScannerCall[];
  sources_used?: string[];
  timestamp?: string;
}

export interface ScannerChannel {
  channel_id: string;
  label: string;
  priority?: "high" | "medium" | "low";
  disciplines?: string[];
  region?: string;
}

export interface ScannerChannelsResponse {
  status: "ok" | "error";
  channels: ScannerChannel[];
}

export interface ResolvedDept {
  name: string;
  agency: string;
  dept: string;
  location: string;
  cat: "police" | "fire" | "ems";
  priority: "high" | "medium" | "low";
  channel: string;
  agencyId: string | null;
}

export interface FilterState {
  severities: string[];
  municipalities: string[];
  chipFilter: string;
  searchQuery: string;
  sortMode: "newest" | "priority" | "severity";
}
