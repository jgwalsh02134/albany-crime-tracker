import type { Incident, IncidentSource } from "./types";
import { verificationWhy } from "./sources";
import { decodeHtmlEntities } from "./html";

export type PublicLiveSchemaId = "albany.watch/public-live/v1";

export type PublicIncidentSourceV1 = {
  kind: IncidentSource["kind"];
  tier: IncidentSource["tier"];
  name: string;
  url?: string;
  excerpt?: string;
};

export type PublicLiveIncidentV1 = {
  id: string;
  occurredAt: string;
  minutesAgo: number;
  title: string;
  type: string;
  category: Incident["category"];
  severity: Incident["severity"];
  status: Incident["status"];
  municipality: string;
  address: string;
  lat: number;
  lng: number;
  geoPrecision: NonNullable<Incident["geoPrecision"]> | "unknown";
  verificationTier: Incident["verification"];
  verificationWhy: string;
  sources: PublicIncidentSourceV1[];
  witness: boolean;
};

export type PublicLiveResponseV1 = {
  ok: true;
  schema: PublicLiveSchemaId;
  generatedAt: string;
  incidents: PublicLiveIncidentV1[];
};

export function incidentToPublicV1(inc: Incident): PublicLiveIncidentV1 {
  const witness =
    (inc.memberIds?.some((id) => id.startsWith("citizen-")) ?? false) ||
    inc.sources.some((s) => /citizen/i.test(s.name)) ||
    inc.sources.some((s) => /citizen/i.test(s.url ?? ""));

  return {
    id: inc.id,
    occurredAt: inc.occurredAt,
    minutesAgo: inc.minutesAgo,
    title: decodeHtmlEntities(inc.title),
    type: inc.type,
    category: inc.category,
    severity: inc.severity,
    status: inc.status,
    municipality: inc.municipality,
    address: inc.address,
    lat: inc.lat,
    lng: inc.lng,
    geoPrecision: inc.geoPrecision ?? "unknown",
    verificationTier: inc.verification,
    verificationWhy: verificationWhy(inc),
    sources: inc.sources.map((s) => ({
      kind: s.kind,
      tier: s.tier,
      name: decodeHtmlEntities(s.name),
      url: s.url,
      excerpt: s.excerpt ? decodeHtmlEntities(s.excerpt) : s.excerpt,
    })),
    witness,
  };
}

export function buildPublicLiveResponseV1(incidents: Incident[], generatedAtMs = Date.now()): PublicLiveResponseV1 {
  return {
    ok: true,
    schema: "albany.watch/public-live/v1",
    generatedAt: new Date(generatedAtMs).toISOString(),
    incidents: incidents.map(incidentToPublicV1),
  };
}

