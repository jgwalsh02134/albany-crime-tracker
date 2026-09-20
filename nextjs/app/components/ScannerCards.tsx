"use client";

/**
 * ScannerCards — client component that:
 *  1. Renders SSR-fetched scanner calls immediately.
 *  2. Polls /api/scanner/calls every 20 s for real-time updates.
 *  3. Applies category filter, search, and dedup.
 *  4. Renders scanner call cards with audio playback.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ScannerCall, ScannerChannel, ResolvedDept } from "../types";
import { timeAgo, inferDiscipline, inferMunicipality, formatFreqMHz } from "../lib/utils";

const SCANNER_REFRESH_MS = 20_000;

// ─── Talkgroup resolution ─────────────────────────────────────────────────────

function resolveDept(call: ScannerCall): ResolvedDept {
  const tgRaw = call.talkgroup_num ?? call.talkgroup;
  const tgStr = String(tgRaw ?? "").trim();
  const alpha = (
    call.talkgroup_tag ||
    call.talkgroupTag ||
    call.talkgroup_alpha_tag ||
    ""
  ).trim();
  const desc = (call.talkgroup_description || call.talkgroupDescription || "").trim();
  const blob = [alpha, desc, tgStr].join(" ");

  const cat = inferDiscipline(blob);
  const location = inferMunicipality(blob) || "Albany County";
  const agencyName = alpha || desc || (tgStr ? `Ch ${tgStr}` : "Radio traffic");

  return {
    name: agencyName,
    agency: agencyName,
    dept: "",
    location,
    cat,
    priority: "medium",
    channel: alpha || tgStr,
    agencyId: null,
  };
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function dedupCalls(calls: ScannerCall[]): ScannerCall[] {
  const seen: Record<string, boolean> = {};
  const out: ScannerCall[] = [];
  for (const c of calls) {
    const tg = String(c.talkgroup_num ?? c.talkgroup ?? "");
    const t = c.time ? new Date(c.time).getTime() : 0;
    const key = `${tg}_${Math.floor(t / 30_000)}`;
    if (seen[key]) continue;
    seen[key] = true;
    out.push(c);
  }
  return out;
}

// ─── Single scanner card ──────────────────────────────────────────────────────

interface ScannerCardProps {
  call: ScannerCall;
  index: number;
  isSelected: boolean;
  onSelect: (idx: number) => void;
  onPlay: (url: string) => void;
}

function ScannerCard({ call, index, isSelected, onSelect, onPlay }: ScannerCardProps) {
  const dept = resolveDept(call);
  const len = call.duration != null ? parseFloat(String(call.duration)) : (call.len ? parseFloat(String(call.len)) : 0);
  const startTime = call.time ? new Date(call.time) : null;
  const ta = startTime ? timeAgo(startTime) : "";
  const audioUrl = call.url || call.audio_url || "";
  const freqMHz = formatFreqMHz(call.freq);
  const cat = dept.cat;

  return (
    <div
      className={`sc-card sc-card--${cat}${isSelected ? " sc-card--active" : ""}`}
      onClick={() => onSelect(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSelect(index)}
      aria-pressed={isSelected}
    >
      <div className="sc-card-head">
        <span className="sc-card-dept">{dept.name}</span>
        <span className="sc-card-time">{ta}</span>
      </div>

      <div className="sc-card-summary">
        {dept.location && dept.location !== dept.name && (
          <span style={{ color: "var(--text-3)", marginRight: 6 }}>
            {dept.location}
          </span>
        )}
        {len > 0 && (
          <span style={{ color: "var(--text-3)" }}>{Math.round(len)}s</span>
        )}
        {freqMHz && (
          <span style={{ color: "var(--text-3)", marginLeft: 6 }}>{freqMHz}</span>
        )}
      </div>

      <div className="sc-card-meta">
        <span className={`sc-badge sc-badge--${cat}`}>
          {cat === "police" ? "Police" : cat === "fire" ? "Fire" : "EMS"}
        </span>
        {audioUrl && (
          <button
            className="sc-badge"
            style={{ cursor: "pointer", background: "var(--accent-dim)", color: "var(--accent)" }}
            onClick={(e) => {
              e.stopPropagation();
              onPlay(audioUrl);
            }}
            aria-label="Play audio"
          >
            <span className="material-icons" style={{ fontSize: 12, marginRight: 2 }}>
              play_arrow
            </span>
            Play
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ScannerCardsProps {
  initialCalls: ScannerCall[];
  channels: ScannerChannel[];
}

export default function ScannerCards({ initialCalls, channels }: ScannerCardsProps) {
  const [calls, setCalls] = useState<ScannerCall[]>(initialCalls);
  const [filterCat, setFilterCat] = useState<"all" | "police" | "fire" | "ems">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
  const generationRef = useRef(0);

  const fetchCalls = useCallback(async () => {
    const myGen = ++generationRef.current;
    const qs = activeChannel ? `?channel=${encodeURIComponent(activeChannel)}` : "";
    try {
      const res = await fetch(`/api/scanner/calls${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (myGen !== generationRef.current) return;
      if (data.status === "ok" && Array.isArray(data.calls)) {
        setCalls(data.calls);
      }
    } catch {
      // Silently fail — keep showing last known calls
    }
  }, [activeChannel]);

  // Polling
  useEffect(() => {
    const timer = setInterval(fetchCalls, SCANNER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchCalls]);

  // Re-fetch when channel changes
  useEffect(() => {
    fetchCalls();
  }, [activeChannel, fetchCalls]);

  function handlePlay(url: string) {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = "";
    }
    const audio = new Audio(url);
    audio.volume = 1;
    audio.play().catch(() => {});
    setCurrentAudio(audio);
  }

  // Filter + dedup
  const now = new Date();
  const recent = calls.filter((c) => {
    const t = c.time ? new Date(c.time) : null;
    return !t || now.getTime() - t.getTime() < 6 * 3_600_000;
  });

  const filtered = recent.filter((c) => {
    const dept = resolveDept(c);
    if (filterCat !== "all" && dept.cat !== filterCat) return false;
    if (searchQuery) {
      const blob = [
        dept.name, dept.agency, dept.location, dept.channel,
        String(c.talkgroup_num ?? c.talkgroup ?? ""),
        c.talkgroup_tag ?? "",
        c.talkgroup_description ?? "",
      ].join(" ").toLowerCase();
      if (!blob.includes(searchQuery)) return false;
    }
    return true;
  });

  const deduped = dedupCalls(filtered).slice(0, 30);

  return (
    <div>
      {/* Channel chips */}
      {channels.length > 0 && (
        <div className="sc-channel-row" role="tablist" aria-label="Scanner channel">
          <button
            type="button"
            className={`sc-channel-chip${activeChannel === null ? " active" : ""}`}
            onClick={() => setActiveChannel(null)}
            role="tab"
            aria-selected={activeChannel === null}
          >
            All channels
          </button>
          {channels.map((ch) => (
            <button
              key={ch.channel_id}
              type="button"
              className={`sc-channel-chip${activeChannel === ch.channel_id ? " active" : ""}`}
              onClick={() => setActiveChannel(ch.channel_id)}
              role="tab"
              aria-selected={activeChannel === ch.channel_id}
              title={[...(ch.disciplines || []), ch.region || ""].filter(Boolean).join(" · ")}
            >
              {ch.label}
            </button>
          ))}
        </div>
      )}

      {/* Category filter chips */}
      <div className="sc-filters" role="group" aria-label="Filter by service">
        {(["all", "police", "fire", "ems"] as const).map((cat) => (
          <button
            key={cat}
            type="button"
            className={`sc-filter${cat !== "all" ? ` sc-filter--${cat}` : ""}${filterCat === cat ? " active" : ""}`}
            onClick={() => setFilterCat(cat)}
          >
            {cat === "all" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="sc-search-row">
        <span className="material-icons" style={{ fontSize: 16, color: "var(--text-3)" }} aria-hidden="true">
          search
        </span>
        <input
          type="search"
          className="sc-search-input"
          placeholder="Search agency, talkgroup…"
          autoComplete="off"
          aria-label="Search scanner traffic"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value.toLowerCase())}
        />
      </div>

      {/* Note */}
      <div className="sc-note">
        <strong>Live radio traffic</strong> from Albany County&apos;s P25 system. This is raw
        dispatch audio — not confirmed incidents. Tap any card to listen.
      </div>

      {/* Call list */}
      <div id="scannerCallsList">
        {deduped.length === 0 ? (
          <div className="empty-state" style={{ padding: "24px 16px" }}>
            {calls.length === 0
              ? "Loading radio traffic…"
              : "No transmissions match your filters."}
          </div>
        ) : (
          deduped.map((call, idx) => (
            <ScannerCard
              key={call.id || call._id || `${call.talkgroup_num}_${call.time}_${idx}`}
              call={call}
              index={idx}
              isSelected={idx === selectedIdx}
              onSelect={setSelectedIdx}
              onPlay={handlePlay}
            />
          ))
        )}
      </div>

      {/* External links */}
      <div className="sc-links">
        <a
          href="https://openmhz.com/system/albanycony"
          target="_blank"
          rel="noopener noreferrer"
          className="link-btn"
        >
          OpenMHz full scanner
        </a>
        <a
          href="https://www.broadcastify.com/listen/feed/3626"
          target="_blank"
          rel="noopener noreferrer"
          className="link-btn"
        >
          Broadcastify feed 3626
        </a>
      </div>
    </div>
  );
}
