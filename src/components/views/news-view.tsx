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
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-2">
        <Stat value={String(stories.length)} label="Stories" />
        <Stat value={String(outlets.length)} label="Outlets" />
        <Stat value={String(hour)} label="Last hour" />
      </div>

      {featured ? <Hero story={featured} /> : null}

      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Outlet</h2>
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
          <Chip active={outlet === "all"} onClick={() => setOutlet("all")} label="All" />
          {outlets.map((o) => (
            <Chip key={o} active={outlet === o} onClick={() => setOutlet(o)} label={o} />
          ))}
        </div>
        <h2 className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-subtle">Desk</h2>
        <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
          <Chip active={kicker === "all"} onClick={() => setKicker("all")} label="All" />
          {kickers.map((k) => (
            <Chip key={k} active={kicker === k} onClick={() => setKicker(k)} label={k} />
          ))}
        </div>
      </div>

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
                className="w-[78%] shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-surface active:bg-surface-2"
              >
                <Thumb src={s.image} label={s.outlet} className="aspect-[16/9] w-full" />
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
      <div className="flex flex-col gap-2.5">
        {items.map((s) => (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex gap-3 overflow-hidden rounded-xl border border-border bg-surface p-2.5 active:bg-surface-2"
          >
            <Thumb src={s.image} label={s.outlet} className="h-[4.75rem] w-[6.5rem] shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 py-0.5">
              <div className="flex items-center gap-2">
                <Badge tone={s.kicker === "Crime" || s.kicker === "Fire" ? "high" : "cyan"}>{s.kicker}</Badge>
                <span className="font-mono text-xs tabular-nums text-subtle">{relativeTime(s.occurredAt)}</span>
              </div>
              <h3 className="mt-1 line-clamp-3 text-sm font-semibold leading-snug">{s.title}</h3>
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
        <Thumb src={story.image} label={story.outlet} className="aspect-[16/10] w-full" />
        <span className="absolute left-3 top-3">
          <Badge tone="accent">{story.kicker}</Badge>
        </span>
      </div>
      <div className="p-4">
        <h2 className="text-xl font-semibold leading-snug tracking-tight">{story.title}</h2>
        {story.summary ? (
          <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted">{story.summary}</p>
        ) : null}
        <p className="mt-2 text-xs text-subtle">
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
        <span className="px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-subtle">
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
        "h-11 shrink-0 snap-start rounded-full border px-4 text-sm font-medium",
        active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
      )}
    >
      {label}
    </button>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface px-3 py-3 text-center">
      <div className="truncate font-mono text-base font-semibold tabular-nums text-fg">{value}</div>
      <div className="mt-0.5 text-xs text-subtle">{label}</div>
    </div>
  );
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
