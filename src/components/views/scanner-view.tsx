import { useEffect, useRef, useState } from "react";
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
import { clockTimeSec, compactFromMinutes } from "@/lib/format";
import { SCANNER_FEEDS } from "@/lib/scanner-feeds";
import { getScannerCaptions, getScannerPlaylist, getScannerStatuses } from "@/lib/transcribe";
import type { ScannerCall } from "@/lib/types";
import { cn } from "@/lib/utils";

type TranscriptLine = {
  id: string;
  at: number;
  text: string;
  feedId?: string;
  feedName: string;
};

const TEN: Record<string, string> = {
  "10-4": "acknowledged",
  "10-6": "busy",
  "10-7": "out of service",
  "10-8": "in service",
  "10-10": "fight",
  "10-13": "officer needs help",
  "10-16": "domestic",
  "10-33": "emergency",
  "10-50": "crash",
  "10-52": "ambulance",
  "10-54": "possible fatality",
  "10-55": "DWI",
  "10-57": "hit and run",
  "10-78": "backup",
  "10-80": "pursuit",
};

function tenHint(text: string): string | null {
  const found = [...text.matchAll(/\b10-\d{1,2}\b/gi)].map((m) => m[0]!.toLowerCase());
  const hints = [...new Set(found)].map((c) => TEN[c]).filter(Boolean);
  return hints.length ? hints.join(" · ") : null;
}

function natureChip(text: string): string | null {
  if (/shots? fired|shoot/i.test(text)) return "Shots";
  if (/panic/i.test(text)) return "Panic";
  if (/hold.?up|robbery/i.test(text)) return "Robbery";
  if (/domestic/i.test(text)) return "Domestic";
  if (/welfare/i.test(text)) return "Welfare";
  if (/personal injury|\bpi\b/i.test(text)) return "Injury crash";
  if (/crash|collision|accident|mva|10-50/i.test(text)) return "Crash";
  if (/structure fire|building fire/i.test(text)) return "Structure fire";
  if (/\bfire\b|engine|ladder|truck/i.test(text)) return "Fire";
  if (/ems|ambulance|medical|overdose|unconscious/i.test(text)) return "EMS";
  if (/dwi|intoxicated|10-55/i.test(text)) return "DWI";
  if (/pursuit|10-80/i.test(text)) return "Pursuit";
  if (/suspicious/i.test(text)) return "Suspicious";
  if (/\balarm\b/i.test(text)) return "Alarm";
  return null;
}

function agoLabel(ms: number | null, now: number): string | null {
  if (!ms) return null;
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

export function ScannerView({ calls, active = true }: { calls: ScannerCall[]; active?: boolean }) {
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
  const [thisFeedOnly, setThisFeedOnly] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [online, setOnline] = useState<Record<string, boolean>>({});

  const [transcribing, setTranscribing] = useState(true);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [lastSpokenAt, setLastSpokenAt] = useState<number | null>(null);
  const [lastFeed, setLastFeed] = useState("");
  const [lastError, setLastError] = useState("");
  const [ticks, setTicks] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());

  const feed = SCANNER_FEEDS.find((f) => f.id === feedId) ?? SCANNER_FEEDS[0]!;
  const visible = thisFeedOnly ? transcript.filter((l) => l.feedName === feed.name || l.feedId === feedId) : transcript;
  const liveCalls = calls.filter((c) => c.minutesAgo <= 180).slice(0, 12);

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
      try {
        await audio.play();
      } catch {
        audio.muted = true;
        try {
          await audio.play();
        } catch {
          /* Captions still run without audible playback. */
        }
      }
      setPlaying(!audio.paused);
      setPlayerError(null);
      return;
    }

    if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = url;
      try {
        await audio.play();
      } catch {
        audio.muted = true;
        try {
          await audio.play();
        } catch {
          /* Captions still run without audible playback. */
        }
      }
      setPlaying(!audio.paused);
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
      setPlayerError("Speaker blocked here — captions still run from the live stream.");
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
    setPlayerError(null);
    playlistUrlsRef.current = [];
  }

  function toggleTranscribe() {
    setTranscribing((on) => !on);
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
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!transcribing || !active) {
      void getScannerCaptions({ data: { feedId, listen: false } });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (cancelled) return;
      try {
        const res = await getScannerCaptions({ data: { feedId, listen: true } });
        if (cancelled || !res.ok) return;
        setTranscript(
          res.lines.map((line) => ({
            id: line.id,
            at: line.at,
            text: line.text,
            feedId: line.feedId,
            feedName: line.feedName,
          })),
        );
        setLastSpokenAt(res.lastSpokenAt || null);
        setLastFeed(res.lastFeed || "");
        setLastError(res.lastError || "");
        setTicks(res.ticks || 0);
      } catch {
        /* next poll */
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [transcribing, feedId, active]);

  const live = playing && !connecting;
  const heardAgo = agoLabel(lastSpokenAt, nowTick);
  const statusLabel = connecting
    ? "Connecting speaker"
    : live
      ? "Speaker live"
      : online[feedId] === false
        ? "Feed idle"
        : "Speaker ready";

  let captionStatus = "Captions paused";
  if (transcribing) {
    if (lastError === "no-key") captionStatus = "Captions unavailable in this environment";
    else if (lastError.includes("429")) captionStatus = "Speech API busy — retrying";
    else if (ticks === 0) captionStatus = "Connecting to Broadcastify…";
    else if (heardAgo) {
      const from = SCANNER_FEEDS.find((f) => f.id === lastFeed)?.shortName;
      captionStatus = `Heard ${heardAgo}${from ? ` · ${from}` : ""}`;
    }
    else captionStatus = "Listening — dispatch is often quiet between calls";
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 pb-2.5 pt-2">
        <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain scrollbar-none snap-x">
          {SCANNER_FEEDS.map((f) => {
            const on = feedId === f.id;
            const isLive = online[f.id];
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFeed(f.id)}
                className={cn(
                  "flex h-10 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 text-sm font-semibold",
                  on ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
                )}
              >
                <span
                  className={cn("size-2 rounded-full", on ? "bg-accent-fg" : isLive ? "live-dot" : "bg-subtle")}
                  aria-hidden
                />
                {f.shortName}
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface p-2.5">
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
            aria-label={transcribing ? "Pause captions" : "Resume captions"}
            aria-pressed={transcribing}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full",
              transcribing ? "bg-cyan text-accent-fg" : "text-muted",
            )}
          >
            {transcribing ? <Captions className="size-5" /> : <CaptionsOff className="size-5" />}
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
        {playerError ? <p className="mt-1.5 text-xs text-muted">{playerError}</p> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-6 pt-2">
        <div className="flex items-start justify-between gap-2">
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
            <p className="mt-0.5 line-clamp-2 text-xs text-subtle">{captionStatus}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setThisFeedOnly(false)}
              className={cn(
                "h-9 rounded-full px-3 text-xs font-semibold",
                !thisFeedOnly ? "bg-accent text-accent-fg" : "text-muted",
              )}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setThisFeedOnly(true)}
              className={cn(
                "h-9 rounded-full px-3 text-xs font-semibold",
                thisFeedOnly ? "bg-accent text-accent-fg" : "text-muted",
              )}
            >
              This feed
            </button>
            <a
              href={feed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex size-9 items-center justify-center text-subtle"
              aria-label="Open on Broadcastify"
            >
              <ExternalLink className="size-4" />
            </a>
          </div>
        </div>

        {liveCalls.length ? (
          <div className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
            {liveCalls.map((c) => (
              <article
                key={c.id}
                className="w-52 shrink-0 snap-start rounded-lg border border-border bg-surface px-3 py-2"
              >
                <p className="flex items-center justify-between gap-2 text-xs text-subtle">
                  <span className="truncate font-semibold uppercase tracking-wide">{c.discipline}</span>
                  <time className="font-mono tabular-nums">{compactFromMinutes(c.minutesAgo)}</time>
                </p>
                <p className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug">{c.summary}</p>
              </article>
            ))}
          </div>
        ) : null}

        <div
          className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-y-contain rounded-xl border border-border bg-surface px-3 py-3 scrollbar-thin"
          aria-live="polite"
        >
          {visible.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-muted">
              {transcribing
                ? ticks === 0
                  ? "Connecting to Albany-area radio…"
                  : "Quiet right now. Short unit chatter will show as soon as dispatch talks."
                : "Captions paused. Tap the caption button to listen again."}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((line) => {
                const hint = tenHint(line.text);
                const nature = natureChip(line.text);
                const on = line.feedId === feedId || line.feedName === feed.name;
                return (
                  <li key={line.id} className={cn("border-l-2 pl-3", on ? "border-cyan" : "border-border")}>
                    <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs uppercase tracking-wide text-subtle">
                      <span>{clockTimeSec(line.at)}</span>
                      <span>{line.feedName}</span>
                      {nature ? (
                        <Badge tone={/shots|panic|pursuit|robbery/i.test(nature) ? "high" : "cyan"}>{nature}</Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-fg">{line.text}</p>
                    {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-subtle">
          Unconfirmed radio. 10-codes and names can be wrong. Play is optional — captions run from the stream
          even if the speaker is blocked.
        </p>
      </div>

      <audio
        ref={audioRef}
        playsInline
        preload="none"
        onEnded={() => setPlaying(false)}
        onError={() => {
          if (!connecting) {
            setPlaying(false);
            setPlayerError("Speaker unavailable. Captions still run.");
          }
        }}
      />
    </div>
  );
}
