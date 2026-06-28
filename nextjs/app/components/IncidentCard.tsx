"use client";

import type { Incident, LinkedSource } from "../types";
import {
  timeAgo,
  ageHours,
  agencyDisplayName,
  dotClass,
} from "../lib/utils";

interface IncidentCardProps {
  incident: Incident;
  /** Client-side linked sources (from dedup clustering) */
  linkedSources?: LinkedSource[];
}

export default function IncidentCard({
  incident,
  linkedSources,
}: IncidentCardProps) {
  const r = incident;
  const pub = r.occurred_at || r.published_at || "";
  const ta = r.human_time || timeAgo(pub);
  const ageH = ageHours(pub);

  const title = r.short_title || r.title || "Untitled";
  const summary = r.description || "";
  const link = r.source_url || "";
  const sourceName = r.source_name || "";
  const area = r.municipality || r.address_text || "Albany County";
  const sev = (r.severity || "").toLowerCase();
  const verify = (r.verification_level || "").toLowerCase();

  // Determine crime type for dot color
  const dot = dotClass(r.incident_type);

  // LIVE badge: fresh + high severity + active status
  const incStatus = (r.status || "").toLowerCase();
  const isLive =
    ageH !== null &&
    ageH <= 2 &&
    (sev === "critical" || sev === "high" || incStatus === "active");

  // CSS classes
  let cls = `feed-item feed-item--${dot}`;
  if (isLive) cls += " feed-item--live";
  if (sev === "critical") cls += " feed-item--sev-critical";
  else if (sev === "high") cls += " feed-item--sev-high";
  if (sev === "low" && verify === "inferred") cls += " feed-item--quiet";
  if (ageH !== null && ageH > 12) cls += " feed-item--aged";

  // Time class
  const timeClass =
    ageH !== null && ageH <= 1
      ? "feed-time--mono feed-time--fresh"
      : "feed-time--mono";

  // Linked sources: prefer backend-persisted sources, fall back to client-side
  const linked =
    Array.isArray(r.sources) && r.sources.length > 0
      ? r.sources
      : linkedSources || null;

  const agencyDisplay = agencyDisplayName(r.responding_agency_id);

  const inner = (
    <>
      {/* Left indicator strip */}
      <div className="feed-indicator">
        <span className={`feed-dot ${dot}`} />
      </div>

      <div className="feed-body">
        {/* Headline */}
        <div className="feed-title">
          {isLive && (
            <span className="feed-live-badge" style={{ marginRight: 6 }}>
              <span className="feed-live-dot" />
              LIVE
            </span>
          )}
          {title}
        </div>

        {/* Summary */}
        {summary && (
          <div className="feed-summary-line">{summary}</div>
        )}

        {/* Meta row */}
        <div className="feed-meta">
          {agencyDisplay && (
            <span
              className="feed-meta-pill feed-meta-pill--agency"
              title="Responding agency"
            >
              {agencyDisplay}
            </span>
          )}
          <span className="feed-meta-pill feed-meta-pill--area">
            <span
              className="material-icons feed-meta-icon"
              style={{ fontSize: 11, marginRight: 2 }}
            >
              location_on
            </span>
            {area}
          </span>
          {sourceName && (
            <span className="feed-meta-pill feed-meta-pill--source">
              {sourceName}
            </span>
          )}
          {linked && linked.length > 1 && (
            <span
              className="feed-meta-pill feed-meta-pill--corroborated"
              title={linked.map((s) => s.name).filter(Boolean).join(", ")}
            >
              +{linked.length - 1} source{linked.length - 1 === 1 ? "" : "s"}
            </span>
          )}
          <span className={timeClass} style={{ marginLeft: "auto" }}>
            {ta}
          </span>
        </div>
      </div>
    </>
  );

  if (link) {
    return (
      <a
        className={cls}
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        id={`feed-card-${r.id}`}
      >
        {inner}
      </a>
    );
  }

  return (
    <div className={cls} id={`feed-card-${r.id}`}>
      {inner}
    </div>
  );
}
