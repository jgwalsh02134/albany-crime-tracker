import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ShareButton } from "@/components/share-button";
import { relativeTime } from "@/lib/format";
import { decodeHtmlEntities } from "@/lib/html";
import { newsSharePayload } from "@/lib/share";
import type { NewsStory } from "@/lib/types";
import { cn } from "@/lib/utils";

function isBlotterStory(s: NewsStory): boolean {
  return /\b(NYSP blotter|blotter)\b/i.test(s.outlet) || /\bnotable\s+dwi|week in review\b/i.test(decodeHtmlEntities(s.title));
}

function timeLabel(minutesAgo: number, occurredAt: string): string {
  if (minutesAgo <= 45) return relativeTime(occurredAt);
  if (minutesAgo <= 180) return relativeTime(occurredAt);
  if (minutesAgo <= 24 * 60) return relativeTime(occurredAt);
  return relativeTime(occurredAt);
}

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

  const { headlines, blotter } = useMemo(() => {
    const h: NewsStory[] = [];
    const b: NewsStory[] = [];
    for (const s of filtered) {
      if (isBlotterStory(s)) b.push(s);
      else h.push(s);
    }
    return { headlines: h, blotter: b };
  }, [filtered]);

  const featured = headlines.find((s) => s.image) ?? headlines[0];
  const rest = headlines.filter((s) => s.id !== featured?.id);
  const top = rest.filter((s) => s.image).slice(0, 4);
  const used = new Set([featured?.id, ...top.map((s) => s.id)]);
  const developing = rest.filter((s) => !used.has(s.id) && s.minutesAgo <= 12 * 60);
  const latest = rest.filter((s) => !used.has(s.id) && s.minutesAgo > 12 * 60);
  const hour = headlines.filter((s) => s.minutesAgo <= 60).length;

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
          <span className="font-semibold text-fg">{headlines.length}</span> headlines
          {blotter.length ? <span> · {blotter.length} blotter</span> : null}
          <span> · {outlets.length} outlets</span>
          {hour ? <span> · {hour} last hour</span> : null}
        </p>
        <p className="mb-2 text-xs leading-relaxed text-muted">
          Capital Region coverage only. Out-of-area wires are dropped. Overnight NYSP blotter is listed separately so it does not drown newsroom updates.
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
              <div
                key={s.id}
                className="relative w-4/5 shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-surface"
              >
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="block active:bg-surface-2">
                  <Thumb src={s.image} label={s.outlet} className="aspect-video w-full" />
                  <div className="p-3 pr-12">
                    <p className="text-xs font-semibold uppercase tracking-wide text-cyan">{s.kicker}</p>
                    <h3 className="mt-1 line-clamp-3 text-sm font-semibold leading-snug">{decodeHtmlEntities(s.title)}</h3>
                    <p className="mt-1.5 text-xs text-subtle">
                      {s.outlet} · {timeLabel(s.minutesAgo, s.occurredAt)}
                      {s.municipality && s.municipality !== "Albany County" ? ` · ${s.municipality}` : ""}
                    </p>
                  </div>
                </a>
                <div className="absolute right-2 top-2 z-10">
                  <ShareButton
                    payload={newsSharePayload(s)}
                    size="icon"
                    variant="secondary"
                    className="size-9 rounded-full shadow-md"
                    label="Share story"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <StoryList title="Developing" items={developing} />
      <StoryList title="Latest headlines" items={latest} />
      <StoryList
        title="NYSP overnight blotter"
        items={blotter}
        note="Official overnight dump — not live dispatch. Capped so it does not crowd newsroom stories."
      />
    </div>
  );
}

function StoryList({
  title,
  items,
  note,
}: {
  title: string;
  items: NewsStory[];
  note?: string;
}) {
  if (!items.length) return null;
  return (
    <section>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      {note ? <p className="mb-2 text-xs text-muted">{note}</p> : null}
      <div className="flex flex-col gap-2">
        {items.map((s) => (
          <div key={s.id} className="relative overflow-hidden rounded-lg border border-border bg-surface">
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex gap-3 p-2.5 pr-12 active:bg-surface-2"
            >
              <Thumb src={s.image} label={s.outlet} className="h-16 w-24 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 py-0.5">
                <div className="flex items-center gap-2">
                  <Badge tone={s.kicker === "Crime" || s.kicker === "Fire" ? "high" : "cyan"}>{s.kicker}</Badge>
                  <span className="font-mono text-xs tabular-nums text-subtle">
                    {timeLabel(s.minutesAgo, s.occurredAt)}
                  </span>
                </div>
                <h3 className="mt-1 line-clamp-2 text-sm font-semibold leading-snug">{decodeHtmlEntities(s.title)}</h3>
                <p className="mt-1 truncate text-xs text-subtle">
                  {s.outlet}
                  {s.municipality && s.municipality !== "Albany County" ? ` · ${s.municipality}` : ""}
                </p>
              </div>
            </a>
            <div className="absolute right-1.5 top-1.5">
              <ShareButton payload={newsSharePayload(s)} label="Share story" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Hero({ story }: { story: NewsStory }) {
  const title = decodeHtmlEntities(story.title);
  const summary = story.summary ? decodeHtmlEntities(story.summary) : "";
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface">
      <a
        href={story.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block active:bg-surface-2"
      >
        <div className="relative">
          <Thumb src={story.image} label={story.outlet} className="aspect-video w-full" />
          <span className="absolute left-3 top-3">
            <Badge tone="accent">{story.kicker}</Badge>
          </span>
        </div>
        <div className="p-3 pr-12">
          <h2 className="text-lg font-semibold leading-snug tracking-tight">{title}</h2>
          {summary ? (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">{summary}</p>
          ) : null}
          <p className="mt-1.5 text-xs text-subtle">
            {story.outlet} · {timeLabel(story.minutesAgo, story.occurredAt)}
            {story.municipality && story.municipality !== "Albany County" ? ` · ${story.municipality}` : ""}
          </p>
        </div>
      </a>
      <div className="absolute right-2 top-2 z-10">
        <ShareButton
          payload={newsSharePayload(story)}
          size="icon"
          variant="secondary"
          className="size-10 rounded-full shadow-md"
          label="Share story"
        />
      </div>
    </div>
  );
}

/** Client-side mirror of server generic-stock filter — prefer outlet chip over logo/seal. */
function looksGenericThumb(url: string): boolean {
  return /(?:logo|seal|favicon|site[-_]?icon|placeholder|default[-_]?(?:og|share|image)?|generic|firegeneric|ambulance\.webp|gnews\/logo|cropped-[^/]*icon)(?:[./?]|$)/i.test(
    url,
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
  if (!src || broken || looksGenericThumb(src)) {
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
        "h-10 shrink-0 snap-start rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
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
