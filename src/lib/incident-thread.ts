import type { LiveWireItem } from "@/lib/sources";
import type { Incident, IncidentSource, SourceTier } from "@/lib/types";
import { familyChip, sourceFamily } from "@/lib/fusion";

export type IncidentThreadUpdate = {
  /** Raw wire identity that was fused into the incident. */
  memberId: string;
  /** Reporter timestamp for this update. */
  publishedAt: string;
  /** Convenience for UI. */
  minutesAgo: number;
  title: string;
  summary: string;
  url: string;
  outlet: string;
  kind?: LiveWireItem["kind"];
  /** Derived from fusion source-family rules. */
  tier: SourceTier;
  /** Canonical incident-source representation (kind/tier). */
  source: IncidentSource;
  /** Chip describing the family ("Scanner", "Nixle", etc.). */
  chip: { key: string; label: string };
};

function tierRank(t: SourceTier): number {
  // Keep the UI report-first: when timestamps collide, show unconfirmed before official.
  if (t === "unconfirmed") return 0;
  if (t === "context") return 1;
  return 2;
}

function toTier(family: string): SourceTier {
  if (
    family === "blotter" ||
    family === "nixle" ||
    family === "tinc" ||
    family === "511" ||
    family === "nws" ||
    family === "civic" ||
    family === "press"
  ) {
    return "official";
  }
  if (family === "scanner" || family === "social") return "unconfirmed";
  return "context";
}

function kindFromFamily(family: string): IncidentSource["kind"] {
  if (family === "blotter") return "blotter";
  if (family === "nixle") return "nixle";
  if (family === "tinc") return "cfs";
  if (family === "scanner") return "scanner";
  if (family === "511") return "cfs";
  if (family === "social") return "social";
  if (family === "civic" || family === "press" || family === "nws") return "press";
  return "news";
}

function updateSource(item: LiveWireItem): { family: string; tier: SourceTier; source: IncidentSource; chip: { key: string; label: string } } {
  const family = sourceFamily(item.kind as any, item.outlet || "");
  const tier = toTier(family);
  const source: IncidentSource = {
    kind: kindFromFamily(family),
    name: item.outlet || "Source",
    tier,
    url: item.url,
    excerpt: (item.summary || item.title || "").trim().slice(0, 240) || item.title,
  };
  const chip = familyChip(family);
  // More human-friendly for witness reports (still "social" family).
  if (/citizen\s*·\s*witness/i.test(item.outlet || "")) return { family, tier, source, chip: { key: "witness", label: "Witness" } };
  return { family, tier, source, chip };
}

function parseAt(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function buildIncidentThread(incident: Incident, wireItems: LiveWireItem[] | null | undefined): IncidentThreadUpdate[] {
  const memberIds = incident.memberIds?.filter(Boolean) ?? [];
  if (!memberIds.length) return [];
  const byId = new Map((wireItems ?? []).map((w) => [w.id, w] as const));

  const out: IncidentThreadUpdate[] = memberIds.map((memberId) => {
    const item = byId.get(memberId);
    if (!item) {
      const publishedAt = incident.occurredAt;
      const fallbackSource: IncidentSource = {
        kind: "news",
        name: "Provenance",
        tier: "context",
        url: `/i/${encodeURIComponent(incident.id)}`,
        excerpt: `Fused memberId: ${memberId}`,
      };
      return {
        memberId,
        publishedAt,
        minutesAgo: incident.minutesAgo,
        title: "Update",
        summary: "This source update aged off the current wire refresh.",
        url: `/i/${encodeURIComponent(incident.id)}`,
        outlet: "Wire",
        kind: undefined,
        tier: "context",
        source: fallbackSource,
        chip: { key: "wire", label: "Wire" },
      };
    }
    const meta = updateSource(item);
    return {
      memberId,
      publishedAt: item.publishedAt,
      minutesAgo: item.minutesAgo,
      title: item.title,
      summary: item.summary || "",
      url: item.url,
      outlet: item.outlet,
      kind: item.kind,
      tier: meta.tier,
      source: meta.source,
      chip: meta.chip,
    };
  });

  return out.sort((a, b) => {
    const ta = parseAt(a.publishedAt);
    const tb = parseAt(b.publishedAt);
    if (ta !== tb) return ta - tb;
    const ra = tierRank(a.tier);
    const rb = tierRank(b.tier);
    if (ra !== rb) return ra - rb;
    return a.memberId.localeCompare(b.memberId);
  });
}

