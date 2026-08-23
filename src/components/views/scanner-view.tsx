import { useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  CaptionsOff,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import channels from "@/data/channels.json";
import { compactFromMinutes } from "@/lib/format";
import { bytesToBase64, parseM3u8 } from "@/lib/scanner-hls";
import { SCANNER_FEEDS } from "@/lib/scanner-feeds";
import { getScannerPlaylist, getScannerStatuses, transcribeAudioChunk } from "@/lib/transcribe";
import type { Discipline, ScannerCall } from "@/lib/types";
import { cn } from "@/lib/utils";

const TRANSCRIBE_MAX_MS = 8 * 60_000;
const TRANSCRIBE_TICK_MS = 5500;
const TRANSCRIBE_MAX_LINES = 40;

type TranscriptLine = {
  id: string;
  at: number;
  text: string;
  feedName: string;
};

type Panel = "traffic" | "captions";

const CHANNELS = channels as { id: string; label: string; priority: string; talkgroups: string[] }[];

const CHANNEL_CHIPS: { id: string; label: string }[] = [
  { id: "apd", label: "APD" },
  { id: "albany_fire", label: "AFD" },
  { id: "colonie_pd", label: "Colonie" },
  { id: "acso", label: "Sheriff" },
  { id: "bethlehem_pd", label: "Bethlehem" },
  { id: "guilderland_pd", label: "Guilderland" },
  { id: "nysp_troop_g", label: "NYSP" },
];

export function ScannerView({ calls }: { calls: ScannerCall[] }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<{ destroy: () => void; startLoad?: () => void; recoverMediaError?: () => void } | null>(
    null,
  );
  const playGen = useRef(0);
  const resumePlay = useRef(false);
  const playlistUrlsRef = useRef<string[]>([]);

  const [feedId, setFeedId] = useState(SCANNER_FEEDS[0]!.id);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [disc, setDisc] = useState<Discipline | "all">("all");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [panel, setPanel] = useState<Panel>("traffic");
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState<Record<string, boolean>>({});

  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [transcriptStatus, setTranscriptStatus] = useState("Off");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [lastHeardAt, setLastHeardAt] = useState<number | null>(null);

  const feed = SCANNER_FEEDS.find((f) => f.id === feedId) ?? SCANNER_FEEDS[0]!;

  const filtered = useMemo(() => {
    const ch = CHANNELS.find((c) => c.id === channel);
    const query = q.trim().toLowerCase();
    return calls.filter((c) => {
      if (disc !== "all" && c.discipline !== disc) return false;
      if (ch && !ch.talkgroups.includes(c.talkgroup)) return false;
      if (query) {
        const hay = `${c.agency} ${c.channel} ${c.summary} ${c.municipality}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [calls, disc, channel, q]);

  const groups = useMemo(() => groupCalls(filtered), [filtered]);

  function destroyHls() {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }

  async function startHls(url: string) {
    const audio = audioRef.current;
    if (!audio) throw new Error("no-audio");
    destroyHls();
    audio.volume = volume;
    audio.muted = muted;
    audio.crossOrigin = "anonymous";

    const { default: Hls } = await import("hls.js");
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        maxBufferLength: 20,
        xhrSetup(xhr) {
          xhr.withCredentials = false;
        },
      });
      hlsRef.current = hls;
      const parsed = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          hls.off(Hls.Events.MANIFEST_PARSED, onParsed);
          hls.off(Hls.Events.ERROR, onError);
          fn();
        };
        const onParsed = () => finish(() => resolve());
        const onError = (_event: unknown, data: { fatal?: boolean; details?: string }) => {
          if (!data.fatal) return;
          finish(() => reject(new Error(data.details || "hls")));
        };
        const timer = window.setTimeout(() => finish(() => reject(new Error("timeout"))), 12000);
        hls.on(Hls.Events.MANIFEST_PARSED, onParsed);
        hls.on(Hls.Events.ERROR, onError);
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
      await parsed;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try {
            hls.startLoad();
          } catch {
            /* ignore */
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hls.recoverMediaError();
          } catch {
            /* ignore */
          }
          return;
        }
        setPlaying(false);
        setPlayerError("Stream dropped. Hit play to reconnect.");
      });
      await audio.play();
      setPlaying(true);
      setPlayerError(null);
      return;
    }

    if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = url;
      await audio.play();
      setPlaying(true);
      setPlayerError(null);
      return;
    }

    throw new Error("unsupported");
  }

  async function startPlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    const gen = ++playGen.current;
    setConnecting(true);
    setPlayerError(null);
    try {
      const res = await getScannerPlaylist({ data: { feedId } });
      if (gen !== playGen.current) return;
      if (!res.ok) {
        setPlayerError(res.error);
        setPlaying(false);
        return;
      }
      setOnline((prev) => ({ ...prev, [feedId]: res.online }));
      playlistUrlsRef.current = res.candidates.length ? res.candidates : [res.hlsUrl];
      const urls = playlistUrlsRef.current;
      let lastErr: unknown;
      for (const url of urls) {
        if (gen !== playGen.current) return;
        try {
          await startHls(url);
          if (gen !== playGen.current) {
            destroyHls();
            return;
          }
          return;
        } catch (err) {
          lastErr = err;
          destroyHls();
        }
      }
      throw lastErr ?? new Error("stream");
    } catch {
      if (gen !== playGen.current) return;
      setPlaying(false);
      destroyHls();
      setPlayerError("Could not start this stream. Try another feed or open Broadcastify.");
    } finally {
      if (gen === playGen.current) setConnecting(false);
    }
  }

  function stopPlayback() {
    playGen.current += 1;
    const audio = audioRef.current;
    audio?.pause();
    destroyHls();
    setPlaying(false);
    setConnecting(false);
  }

  function togglePlay() {
    if (playing || connecting) {
      resumePlay.current = false;
      stopPlayback();
      return;
    }
    void startPlayback();
  }

  function selectFeed(id: string) {
    if (id === feedId) return;
    resumePlay.current = playing || connecting;
    stopPlayback();
    setFeedId(id);
    setTranscript([]);
    setLastHeardAt(null);
    setTranscriptError(null);
    setPlayerError(null);
    playlistUrlsRef.current = [];
    if (transcribing) setTranscriptStatus("Switching feed…");
  }

  function toggleTranscribe() {
    if (transcribing) {
      setTranscribing(false);
      setTranscriptStatus("Off");
      return;
    }
    setTranscriptError(null);
    setTranscript([]);
    setLastHeardAt(null);
    setTranscribing(true);
    setTranscriptStatus("Connecting…");
    setPanel("captions");
    if (!playing && !connecting) void startPlayback();
  }

  useEffect(() => {
    if (!resumePlay.current) return;
    resumePlay.current = false;
    void startPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    let cancelled = false;
    void getScannerStatuses().then((res) => {
      if (cancelled || !res.ok) return;
      const next: Record<string, boolean> = {};
      for (const row of res.feeds) next[row.id] = row.online;
      setOnline(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      playGen.current += 1;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!transcribing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let afterSeq: number | null = null;
    let playlistUrl = playlistUrlsRef.current[0] ?? "";
    const started = Date.now();

    async function resolvePlaylist() {
      if (playlistUrl) return playlistUrl;
      const res = await getScannerPlaylist({ data: { feedId } });
      if (!res.ok) throw new Error(res.error);
      playlistUrlsRef.current = res.candidates.length ? res.candidates : [res.hlsUrl];
      playlistUrl = res.hlsUrl;
      return playlistUrl;
    }

    async function readLatestSegment(): Promise<{ seq: number; b64: string } | { idle: true; reason: string }> {
      const url = await resolvePlaylist();
      const candidates = playlistUrlsRef.current.length ? playlistUrlsRef.current : [url];
      let text = "";
      let used = url;
      for (const candidate of candidates) {
        const pl = await fetch(candidate, { cache: "no-store" });
        if (!pl.ok) continue;
        const body = await pl.text();
        if (!body.includes("#EXTM3U")) continue;
        text = body;
        used = candidate;
        playlistUrl = candidate;
        break;
      }
      if (!text) return { idle: true, reason: "playlist" };
      const segs = parseM3u8(text, used);
      if (segs.length === 0) return { idle: true, reason: "idle" };
      const newest = segs[segs.length - 1]!;
      if (afterSeq != null && newest.seq <= afterSeq) return { idle: true, reason: "caught-up" };
      const segRes = await fetch(newest.url, { cache: "no-store" });
      if (!segRes.ok) return { idle: true, reason: "segment" };
      const buf = new Uint8Array(await segRes.arrayBuffer());
      if (buf.byteLength < 400) {
        afterSeq = newest.seq;
        return { idle: true, reason: "tiny" };
      }
      return { seq: newest.seq, b64: bytesToBase64(buf) };
    }

    async function tick() {
      if (cancelled) return;
      const elapsed = Date.now() - started;
      if (elapsed > TRANSCRIBE_MAX_MS) {
        setTranscribing(false);
        setTranscriptStatus("Stopped after 8 minutes.");
        return;
      }
      const remainMin = Math.max(0, Math.ceil((TRANSCRIBE_MAX_MS - elapsed) / 60000));
      setTranscriptStatus(`Listening · ${remainMin}m left`);
      try {
        const pulled = await readLatestSegment();
        if (cancelled) return;
        if ("idle" in pulled) {
          if (pulled.reason === "idle" || pulled.reason === "playlist") {
            setTranscriptStatus("No audio on this feed right now");
          } else {
            setTranscriptStatus(`Squelch · ${remainMin}m left`);
          }
        } else {
          afterSeq = pulled.seq;
          const res = await transcribeAudioChunk({ data: { feedId, b64: pulled.b64 } });
          if (cancelled) return;
          if (!res.ok) {
            setTranscriptError(res.error);
            setTranscriptStatus("Paused");
            setTranscribing(false);
            return;
          }
          if (res.text) {
            const line: TranscriptLine = {
              id: `${pulled.seq}-${Date.now()}`,
              at: Date.now(),
              text: res.text,
              feedName: feed.name,
            };
            setTranscript((prev) => [line, ...prev].slice(0, TRANSCRIBE_MAX_LINES));
            setLastHeardAt(Date.now());
            setTranscriptError(null);
            setTranscriptStatus(`Voice · ${remainMin}m left`);
          } else {
            setTranscriptStatus(`Squelch · ${remainMin}m left`);
          }
        }
      } catch {
        if (!cancelled) {
          setTranscriptError("Could not read the live feed.");
          setTranscribing(false);
          setTranscriptStatus("Paused");
        }
        return;
      }
      if (!cancelled) timer = setTimeout(tick, TRANSCRIBE_TICK_MS);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [transcribing, feedId, feed.name]);

  const live = playing && !connecting;
  const statusLabel = connecting ? "Connecting" : live ? "Live" : online[feedId] === false ? "Idle" : "Ready";

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Scanner</p>
            <h1 className="text-lg font-semibold tracking-tight">Albany County P25</h1>
          </div>
          <a
            href={feed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-1.5 text-xs font-semibold text-accent"
          >
            Broadcastify
            <ExternalLink className="size-3.5" />
          </a>
        </div>

        <div className="mt-3 flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
          {SCANNER_FEEDS.map((f) => {
            const on = feedId === f.id;
            const isLive = online[f.id];
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFeed(f.id)}
                className={cn(
                  "flex h-11 shrink-0 snap-start items-center gap-2 rounded-full border px-4 text-sm font-semibold",
                  on ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
                )}
              >
                <span
                  className={cn(
                    "size-2 rounded-full",
                    on ? "bg-accent-fg" : isLive ? "live-dot" : "bg-subtle",
                  )}
                  aria-hidden
                />
                {f.shortName}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
          <button
            type="button"
            onClick={togglePlay}
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg"
            aria-label={playing || connecting ? "Stop live feed" : "Play live feed"}
          >
            {connecting ? (
              <Loader2 className="size-5 animate-spin" />
            ) : playing ? (
              <Pause className="size-5" />
            ) : (
              <Play className="ml-0.5 size-5" />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{feed.name}</p>
            <p className="truncate text-xs text-subtle">
              {statusLabel}
              <span className="mx-1.5">·</span>
              {feed.coverage}
            </p>
          </div>
          {live ? (
            <span className="hidden items-end gap-px sm:flex" aria-hidden>
              <span className="viz-bar" />
              <span className="viz-bar" />
              <span className="viz-bar" />
              <span className="viz-bar" />
              <span className="viz-bar" />
            </span>
          ) : null}
          <button
            type="button"
            onClick={toggleTranscribe}
            aria-label={transcribing ? "Stop captions" : "Start captions"}
            aria-pressed={transcribing}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full",
              transcribing ? "bg-cyan text-accent-fg" : "text-muted",
            )}
          >
            {transcribing ? <CaptionsOff className="size-5" /> : <Captions className="size-5" />}
          </button>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? "Unmute" : "Mute"}
            className="flex size-11 shrink-0 items-center justify-center rounded-full"
          >
            {muted ? <VolumeX className="size-5 text-muted" /> : <Volume2 className="size-5 text-muted" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="hidden w-24 accent-accent sm:block"
            aria-label="Volume"
          />
        </div>
        {playerError ? <p className="mt-2 text-sm text-sev-high">{playerError}</p> : null}

        <div className="mt-3 grid grid-cols-2 rounded-lg bg-surface-2 p-1">
          {([
            ["traffic", "Traffic"],
            ["captions", "Captions"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPanel(id)}
              className={cn(
                "h-11 rounded-md text-sm font-semibold transition-colors duration-150",
                panel === id ? "bg-surface text-fg" : "text-subtle",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {panel === "captions" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-8 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Live captions</h2>
                {transcribing ? (
                  <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-cyan">
                    <span className="live-dot" />
                    On
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-subtle">{transcriptStatus}</p>
            </div>
            <button
              type="button"
              onClick={toggleTranscribe}
              className={cn(
                "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold",
                transcribing ? "bg-accent text-accent-fg" : "border border-border bg-surface text-fg",
              )}
              aria-pressed={transcribing}
            >
              {transcribing ? <CaptionsOff className="size-4" /> : <Captions className="size-4" />}
              {transcribing ? "Stop" : "Start"}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Grok captions this Broadcastify feed. 10-codes and names can be wrong. Stops after 8
            minutes.
          </p>
          {transcriptError ? <p className="mt-2 text-sm text-sev-high">{transcriptError}</p> : null}
          <div
            className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-xl border border-border bg-surface px-3 py-3 scrollbar-thin"
            aria-live="polite"
          >
            {transcript.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted">
                {transcribing
                  ? lastHeardAt
                    ? "Waiting for the next transmission…"
                    : "Listening — dispatch is often quiet between calls."
                  : "Start captions to transcribe this feed."}
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {transcript.map((line) => (
                  <li key={line.id} className="border-l-2 border-cyan pl-3">
                    <p className="font-mono text-xs uppercase tracking-wide text-subtle">
                      {new Date(line.at).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                      <span className="mx-1.5">·</span>
                      {line.feedName}
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-fg">{line.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-8 pt-3 scrollbar-thin">
          <div className="grid grid-cols-4 gap-1.5">
            {(["all", "police", "fire", "ems"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDisc(d)}
                className={cn(
                  "h-11 rounded-full text-sm font-semibold capitalize",
                  disc === d ? "bg-accent text-accent-fg" : "border border-border bg-surface text-muted",
                )}
              >
                {d}
              </button>
            ))}
          </div>

          <div className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
            <Chip active={channel === ""} onClick={() => setChannel("")} label="All" />
            {CHANNEL_CHIPS.map((c) => (
              <Chip
                key={c.id}
                active={channel === c.id}
                onClick={() => setChannel(c.id)}
                label={c.label}
              />
            ))}
          </div>

          <div className="mt-3">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search agency or traffic…"
              aria-label="Search scanner traffic"
            />
          </div>

          <p className="mt-3 text-xs text-subtle">
            Raw P25 dispatch — not confirmed incidents. {filtered.length} calls.
          </p>

          {filtered.length === 0 ? (
            <p className="mt-4 rounded-xl border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
              No transmissions match these filters.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-5">
              <CallSection title="Now" items={groups.now} />
              <CallSection title="Last hour" items={groups.hour} />
              <CallSection title="Earlier" items={groups.earlier} />
            </div>
          )}
        </div>
      )}

      <audio
        ref={audioRef}
        playsInline
        preload="none"
        onEnded={() => setPlaying(false)}
        onError={() => {
          if (!connecting) {
            setPlaying(false);
            setPlayerError("Stream unavailable. Try another feed.");
          }
        }}
      />
    </div>
  );
}

function groupCalls(calls: ScannerCall[]) {
  const now: ScannerCall[] = [];
  const hour: ScannerCall[] = [];
  const earlier: ScannerCall[] = [];
  for (const c of calls) {
    if (c.minutesAgo <= 15) now.push(c);
    else if (c.minutesAgo <= 60) hour.push(c);
    else earlier.push(c);
  }
  return { now, hour, earlier };
}

function CallSection({ title, items }: { title: string; items: ScannerCall[] }) {
  if (!items.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
        <span className="font-mono text-xs tabular-nums text-subtle">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {items.map((c) => (
          <li key={c.id}>
            <CallCard call={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CallCard({ call }: { call: ScannerCall }) {
  const tone = call.discipline === "police" ? "accent" : call.discipline === "fire" ? "high" : "cyan";
  const hot = call.priority === "high";
  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-4",
        hot ? "border-accent/40" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{call.agency}</p>
          <p className="truncate text-xs text-subtle">
            {call.channel}
            <span className="mx-1.5">·</span>
            {call.municipality}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={tone}>{call.discipline}</Badge>
          <time className="font-mono text-xs font-semibold tabular-nums text-muted">
            {compactFromMinutes(call.minutesAgo)}
          </time>
        </div>
      </div>
      <p className="mt-2 text-sm leading-snug text-fg">{call.summary}</p>
      <p className="mt-2 font-mono text-xs text-subtle">
        TG {call.talkgroup}
        <span className="mx-1.5">·</span>
        {call.durationSec}s
      </p>
    </article>
  );
}

function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-11 shrink-0 snap-start rounded-full border px-4 text-sm font-medium",
        active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
      )}
    >
      {label}
    </button>
  );
}
