"use client";

/**
 * LiveFeed — client component that:
 *  1. Renders the SSR-fetched incidents immediately (no flash of empty content).
 *  2. Polls /api/incidents every 45 s for real-time updates.
 *  3. Applies client-side dedup clustering, filtering, and sorting.
 *  4. Renders the freshness banner and incident cards.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Incident, LinkedSource } from "../types";
import IncidentCard from "./IncidentCard";
import { timeAgo, ageHours } from "../lib/utils";

const REFRESH_MS = 45_000;
const HOME_WINDOW_HOURS = 48;

// ─── Dedup / clustering ───────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by",
  "from","as","is","are","was","were","be","been","has","have","had","it","its",
  "this","that","these","those","into","near","over","after","before","during",
  "says","say","said","told","new","york","ny","county","area",
]);

function clusterTokens(title: string): Record<string, 1> {
  const raw = title
    .toLowerCase()
    .replace(/[\[\](){}'"``\u2018\u2019\u201c\u201d]/g, " ")
    .replace(/[—\-–:,.!?;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out: Record<string, 1> = {};
  for (const t of raw.split(" ")) {
    if (!t || t.length < 4 || STOPWORDS.has(t)) continue;
    out[t] = 1;
  }
  return out;
}

function jaccard(a: Record<string, 1>, b: Record<string, 1>): number {
  let inter = 0, uni = 0;
  const seen: Record<string, 1> = {};
  for (const k in a) { seen[k] = 1; if (b[k]) inter++; }
  for (const k in b) { seen[k] = 1; }
  for (const _ in seen) uni++;
  return uni ? inter / uni : 0;
}

interface ClusteredIncident extends Incident {
  _tokens?: Record<string, 1>;
  _linkedSources?: LinkedSource[];
}

function sameEvent(a: ClusteredIncident, b: ClusteredIncident): boolean {
  const muniA = (a.municipality || "").toLowerCase().trim();
  const muniB = (b.municipality || "").toLowerCase().trim();
  if (muniA && muniB && muniA !== muniB) return false;

  const tA = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
  const tB = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
  if (tA && tB && Math.abs(tA - tB) > 6 * 3_600_000) return false;

  const titleA = (a.short_title || a.title || "").toLowerCase().trim();
  const titleB = (b.short_title || b.title || "").toLowerCase().trim();
  if (!titleA || !titleB) return false;
  if (titleA === titleB) return true;

  const shorter = titleA.length <= titleB.length ? titleA : titleB;
  const longer  = titleA.length <= titleB.length ? titleB : titleA;
  if (shorter.length >= 12 && longer.includes(shorter)) return true;

  if (!a._tokens) a._tokens = clusterTokens(titleA);
  if (!b._tokens) b._tokens = clusterTokens(titleB);
  return jaccard(a._tokens, b._tokens) >= 0.5;
}

function dedup(items: ClusteredIncident[]): ClusteredIncident[] {
  const clusters: ClusteredIncident[] = [];
  for (const item of items) {
    const leader = clusters.find((c) => sameEvent(c, item));
    if (!leader) {
      clusters.push(item);
      continue;
    }
    const leaderT = leader.occurred_at ? new Date(leader.occurred_at).getTime() : 0;
    const itemT   = item.occurred_at   ? new Date(item.occurred_at).getTime()   : 0;
    const src = { name: item.source_name || "Unknown", url: item.source_url || "" };
    if (itemT > leaderT) {
      // Promote fresher item
      item._linkedSources = [
        ...(leader._linkedSources || [{ name: leader.source_name || "Unknown", url: leader.source_url || "" }]),
        src,
      ];
      const idx = clusters.indexOf(leader);
      if (idx >= 0) clusters[idx] = item;
    } else {
      if (!leader._linkedSources) {
        leader._linkedSources = [{ name: leader.source_name || "Unknown", url: leader.source_url || "" }];
      }
      const already = leader._linkedSources.some(
        (s) => (src.url && s.url === src.url) || (!src.url && s.name === src.name)
      );
      if (!already) leader._linkedSources.push(src);
    }
  }
  return clusters;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export interface LiveFeedFilters {
  severities: string[];
  municipalities: string[];
}

function applyFilters(
  items: ClusteredIncident[],
  filters: LiveFeedFilters
): ClusteredIncident[] {
  return items.filter((item) => {
    const sev = (item.severity || "low").toLowerCase();
    if (filters.severities.length < 4 && !filters.severities.includes(sev)) return false;

    if (filters.municipalities.length > 0 && filters.municipalities.length < 14) {
      const muni = (item.municipality || "albany county").toLowerCase();
      const match = filters.municipalities.some((m) =>
        muni.includes(m.toLowerCase())
      );
      if (!match) return false;
    }
    return true;
  });
}

// ─── Freshness banner ─────────────────────────────────────────────────────────

function FreshnessBanner({ items }: { items: Incident[] }) {
  if (!items.length) return null;
  const newestMs = Math.max(
    ...items.map((x) => (x.occurred_at ? new Date(x.occurred_at).getTime() : 0))
  );
  if (!newestMs) return null;

  const mins = Math.max(0, Math.round((Date.now() - newestMs) / 60_000));
  const tone = mins >= 60 ? "stale" : mins >= 15 ? "aging" : "fresh";
  const ageText =
    mins < 1 ? "just now" :
    mins === 1 ? "1 min ago" :
    mins < 60 ? `${mins} min ago` :
    `${Math.round(mins / 60)} hr ago`;

  return (
    <div className={`live-freshness live-freshness--${tone}`}>
      <span className={`live-freshness-dot live-freshness-dot--${tone}`} />
      <span className="live-freshness-label">Newest incident</span>
      <span className="live-freshness-value">{ageText}</span>
      <span className="live-freshness-count">{items.length} tracked</span>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonCards() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton skeleton-text" />
          <div className="skeleton skeleton-text short" />
        </div>
      ))}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface LiveFeedProps {
  /** SSR-fetched incidents for immediate render */
  initialIncidents: Incident[];
  filters: LiveFeedFilters;
}

export default function LiveFeed({ initialIncidents, filters }: LiveFeedProps) {
  const [incidents, setIncidents] = useState<ClusteredIncident[]>(
    initialIncidents as ClusteredIncident[]
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);

  const fetchData = useCallback(async () => {
    const myGen = ++generationRef.current;
    const startDate = new Date(
      Date.now() - HOME_WINDOW_HOURS * 3_600_000
    ).toISOString();

    try {
      const res = await fetch(
        `/api/incidents?limit=180&sort_by=operational&start_date=${encodeURIComponent(startDate)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (myGen !== generationRef.current) return;
      if (data.status !== "ok") throw new Error("invalid response");
      const records: Incident[] = Array.isArray(data.incidents)
        ? data.incidents.filter(
            (r: Incident) =>
              // Exclude scanner-only items from the live feed
              !((r.source_type || "").toLowerCase() === "scanner" &&
                r.is_actionable_live !== true)
          )
        : [];
      setIncidents(records as ClusteredIncident[]);
      setError(false);
    } catch {
      if (myGen !== generationRef.current) return;
      setError(true);
    } finally {
      if (myGen === generationRef.current) setLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    // Don't fetch immediately if we have SSR data
    if (initialIncidents.length === 0) {
      setLoading(true);
      fetchData();
    }
    const timer = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchData, initialIncidents.length]);

  // Apply filters + dedup
  const filtered = applyFilters(incidents, filters);
  const clustered = dedup([...filtered]);

  // Sort newest first
  clustered.sort((a, b) => {
    const ta = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
    const tb = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
    return tb - ta;
  });

  if (loading && clustered.length === 0) {
    return (
      <div className="feed-list">
        <SkeletonCards />
      </div>
    );
  }

  if (error && clustered.length === 0) {
    return (
      <div className="feed-error-state">
        <span className="material-icons" style={{ fontSize: 32, opacity: 0.4 }}>
          cloud_off
        </span>
        <p>Could not load incidents right now.</p>
        <p style={{ fontSize: 11, opacity: 0.7 }}>
          Check your connection or try again shortly.
        </p>
        <button
          className="feed-error-retry"
          onClick={() => { setLoading(true); fetchData(); }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (clustered.length === 0) {
    return (
      <div className="empty-state">
        <span className="material-icons" style={{ fontSize: 32, opacity: 0.4 }}>
          shield
        </span>
        <p>No incidents in this window.</p>
      </div>
    );
  }

  return (
    <>
      <FreshnessBanner items={clustered} />
      <div className="feed-list">
        {clustered.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            linkedSources={incident._linkedSources}
          />
        ))}
      </div>
    </>
  );
}
