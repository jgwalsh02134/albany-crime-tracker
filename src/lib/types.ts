export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "violent" | "property" | "other";
export type IncidentStatus = "active" | "developing" | "confirmed" | "closed";
export type Verification = "confirmed" | "developing" | "scanner";
export type ViewId = "feed" | "map" | "scanner" | "chat" | "directory" | "more";
export type HomeMode = "live" | "news";
export type Discipline = "police" | "fire" | "ems";
export type SourceKind = "blotter" | "cfs" | "nixle" | "press" | "scanner" | "news" | "opendata";
export type SourceTier = "official" | "context" | "unconfirmed";
export type SourceLens = "all" | "official" | "scanner" | "news";

export type IncidentSource = {
  kind: SourceKind;
  name: string;
  tier: SourceTier;
  url?: string;
  excerpt?: string;
};

export type Incident = {
  id: string;
  minutesAgo: number;
  occurredAt: string;
  title: string;
  type: string;
  category: Category;
  severity: Severity;
  status: IncidentStatus;
  municipality: string;
  address: string;
  lat: number;
  lng: number;
  agency: string;
  agencyAbbr: string;
  description: string;
  sources: IncidentSource[];
  verification: Verification;
};

export type NewsStory = {
  id: string;
  minutesAgo: number;
  occurredAt: string;
  kicker: string;
  title: string;
  summary: string;
  outlet: string;
  municipality: string;
  url: string;
  category: Category | "other";
};

export type ScannerCall = {
  id: string;
  minutesAgo: number;
  occurredAt: string;
  talkgroup: string;
  discipline: Discipline;
  summary: string;
  durationSec: number;
  priority: "high" | "medium" | "low";
  agency: string;
  channel: string;
  municipality: string;
};

export const MUNICIPALITIES = [
  "Albany",
  "Colonie",
  "Bethlehem",
  "Guilderland",
  "Cohoes",
  "Watervliet",
  "Green Island",
  "Menands",
  "Coeymans",
  "New Scotland",
  "Berne",
  "Knox",
  "Westerlo",
  "Rensselaerville",
  "Altamont",
] as const;

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export const ALBANY_CENTER: [number, number] = [42.6526, -73.7562];
