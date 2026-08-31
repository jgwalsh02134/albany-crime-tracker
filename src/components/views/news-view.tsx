import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/format";
import type { NewsStory } from "@/lib/types";
import { cn } from "@/lib/utils";

export function NewsView({ stories }: { stories: NewsStory[] }) {
  const [outlet, setOutlet] = useState("all");
  const [kicker, setKicker] = useState("all");
  const outlets = unique(stories.map((s) => s.outlet));
  const kickers = unique(stories.map((s) => s.kicker));
  const filtered = stories.filter((s) => {
    if (outlet !== "all" && s.outlet !== outlet) return false;
    if (kicker !== "all" && s.kicker !== kicker) return false;
    return true;
  });
  const featured = filtered.find((s) => s.image) ?? filtered[0];
  const rest = filtered.filter((s) => s.id !== featured?.id);
  const top = rest.filter((s) => s.image).slice(0, 4);
  const used = new Set([featured?.id, ...top.map((s) => s.id)]);
  const developing = rest.filter((s) => !used.has(s.id) && s.minutesAgo <= 12 * 60);
  const latest = rest.filter((s) => !used.has(s.id) && s.minutesAgo > 12 * 60);
  const hour = stories.filter((s) => s.minutesAgo <= 60).length;

  if (!stories.length) {
    return (
      <p className="mt-6 rounded-xl border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
        Waiting on Capital Region newsrooms.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1.5 text-xs text-subtle">
          <span className="font-semibold text-fg">{stories.length}</span> stories
          <span> · {outlets.length} outlets</span>
          {hour ? <span> · {hour} last hour</span> : null}
        </p>
        <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5 scrollbar-none snap-x">
          <Chip active={kicker === "all" && outlet === "all"} onClick={() => { setKicker("all"); setOutlet("all"); }} label="All" />
          {kickers.map((k) => (
            <Chip key={k} active={kicker === k} onClick={() => setKicker(kicker === k ? "all" : k)} label={k} />
          ))}
          <span className="mx-0.5 h-5 w-px shrink-0 self-center bg-border" />
          {outlets.map((o) => (
            <Chip key={o} active={outlet === o} onClick={() => setOutlet(outlet === o ? "all" : o)} label={o} />
          ))}
        </div>
      </div>

      {featured ? <Hero story={featured} /> : null}

      {top.length ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Top stories</h2>
          <div className="flex gap-3 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
            {top.map((s) => (
              <a
                key={s.id}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="w-4/5 shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-surface active:bg-surface-2"
              >
                <Thumb src={s.image} label={s.outlet} className="aspect-video w-full" />
                <div className="p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-cyan">{s.kicker}</p>
                  <h3 className="mt-1 line-clamp-3 text-sm font-semibold leading-snug">{s.title}</h3>
                  <p className="mt-1.5 text-xs text-subtle">
                    {s.outlet} · {relativeTime(s.occurredAt)}
                  </p>
                </div>
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <StoryList title="Developing" items={developing} />
      <StoryList title="Latest headlines" items={latest} />
    </div>
  );
}

function StoryList({ title, items }: { title: string; items: NewsStory[] }) {
  if (!items.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      <div className="flex flex-col gap-2">
        {items.map((s) => (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex gap-3 overflow-hidden rounded-lg border border-border bg-surface p-2.5 active:bg-surface-2"
          >
            <Thumb src={s.image} label={s.outlet} className="h-16 w-24 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 py-0.5">
              <div className="flex items-center gap-2">
                <Badge tone={s.kicker === "Crime" || s.kicker === "Fire" ? "high" : "cyan"}>{s.kicker}</Badge>
                <span className="font-mono text-xs tabular-nums text-subtle">{relativeTime(s.occurredAt)}</span>
              </div>
              <h3 className="mt-1 line-clamp-2 text-sm font-semibold leading-snug">{s.title}</h3>
              <p className="mt-1 truncate text-xs text-subtle">{s.outlet}</p>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function Hero({ story }: { story: NewsStory }) {
  return (
    <a
      href={story.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block overflow-hidden rounded-xl border border-border bg-surface active:bg-surface-2"
    >
      <div className="relative">
        <Thumb src={story.image} label={story.outlet} className="aspect-video w-full" />
        <span className="absolute left-3 top-3">
          <Badge tone="accent">{story.kicker}</Badge>
        </span>
      </div>
      <div className="p-3">
        <h2 className="text-lg font-semibold leading-snug tracking-tight">{story.title}</h2>
        {story.summary ? (
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">{story.summary}</p>
        ) : null}
        <p className="mt-1.5 text-xs text-subtle">
          {story.outlet} · {relativeTime(story.occurredAt)}
        </p>
      </div>
    </a>
  );
}

function Thumb({
  src,
  label,
  className,
}: {
  src?: string;
  label: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className={cn("flex items-center justify-center bg-surface-2", className)}>
        <span className="px-2 text-center text-xs font-semibold uppercase tracking-wide text-subtle">
          {label}
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={cn("bg-surface-2 object-cover", className)}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-10 shrink-0 snap-start rounded-full border px-3 text-xs font-medium",
        active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
      )}
    >
      {label}
    </button>
  );
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
