import { IncidentCard } from "@/components/incident-card";
import { Badge } from "@/components/ui/badge";
import { areaCounts, lastHours, topCategory } from "@/lib/data";
import { compactFromMinutes, relativeTime } from "@/lib/format";
import { SOURCE_LENSES, sourceMix, type LiveWireItem } from "@/lib/sources";
import { incidentVisible, useAppStore } from "@/lib/store";
import type { Incident, NewsStory } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FeedView({
  incidents,
  news,
  wire,
  wireLive,
}: {
  incidents: Incident[];
  news: NewsStory[];
  wire: LiveWireItem[];
  wireLive: boolean;
}) {
  const homeMode = useAppStore((s) => s.homeMode);
  const setHomeMode = useAppStore((s) => s.setHomeMode);
  const select = useAppStore((s) => s.selectIncident);
  const severities = useAppStore((s) => s.severities);
  const municipalities = useAppStore((s) => s.municipalities);
  const areaFilter = useAppStore((s) => s.areaFilter);
  const setAreaFilter = useAppStore((s) => s.setAreaFilter);
  const sourceLens = useAppStore((s) => s.sourceLens);
  const setSourceLens = useAppStore((s) => s.setSourceLens);

  const visible = incidents.filter((i) =>
    incidentVisible(i, { severities, municipalities, areaFilter, sourceLens }),
  );
  const areaVisible = incidents.filter((i) =>
    incidentVisible(i, { severities, municipalities, areaFilter, sourceLens: "all" }),
  );
  const day = lastHours(visible, 24);
  const week = lastHours(visible, 24 * 7);
  const areas = areaCounts(lastHours(areaVisible, 24));
  const mix = sourceMix(lastHours(areaVisible, 24));
  const critical = day.filter((i) => i.severity === "critical").length;
  const active = day.filter((i) => i.status === "active").length;
  const groups = groupIncidents(visible);
  const newest = visible[0];
  const topWire = wire[0];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-bg px-4 pb-2 pt-2">
        <div className="grid grid-cols-2 rounded-lg bg-surface-2 p-1">
          {(["live", "news"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setHomeMode(mode)}
              className={cn(
                "h-11 rounded-md text-sm font-semibold capitalize transition-colors duration-150",
                homeMode === mode ? "bg-surface text-fg" : "text-subtle",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {homeMode === "live" ? (
        <div className="flex-1 overflow-y-auto overscroll-y-contain px-4 pb-8 pt-3 scrollbar-thin">
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="live-dot" />
                <h1 className="text-sm font-semibold">Live county feed</h1>
              </div>
              <p className="font-mono text-xs tabular-nums text-subtle">
                {newest ? compactFromMinutes(newest.minutesAgo) : "—"}
              </p>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <PulseStat value={day.length} label="24 hours" />
              <PulseStat value={critical} label="Critical" accent={critical > 0} />
              <PulseStat value={active} label="Active now" />
            </div>
            <p className="mt-3 text-xs text-subtle">
              {mix.official} official · {mix.scanner} scanner · {mix.news} news
              {wireLive ? " · wire live" : ""}
            </p>
            {topWire ? (
              <a
                href={topWire.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 block rounded-lg bg-surface-2 px-3 py-2.5 active:bg-surface"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-cyan">
                  Live wire · {topWire.outlet}
                </p>
                <p className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug">{topWire.title}</p>
                <p className="mt-1 font-mono text-xs tabular-nums text-subtle">
                  {compactFromMinutes(topWire.minutesAgo)}
                </p>
              </a>
            ) : null}
          </section>

          <div className="sticky top-0 z-10 -mx-4 mt-3 bg-bg px-4 py-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Area</h2>
              <span className="text-xs text-subtle">{day.length} last 24h</span>
            </div>
            <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
              <Chip
                active={areaFilter === "all"}
                onClick={() => setAreaFilter("all")}
                label={`County · ${day.length}`}
              />
              {areas.map((a) => (
                <Chip
                  key={a.name}
                  active={areaFilter === a.name}
                  onClick={() => setAreaFilter(a.name)}
                  label={`${a.name} · ${a.count}`}
                />
              ))}
            </div>
            <h2 className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-subtle">
              Source
            </h2>
            <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
              {SOURCE_LENSES.map((lens) => (
                <Chip
                  key={lens.id}
                  active={sourceLens === lens.id}
                  onClick={() => setSourceLens(lens.id)}
                  label={lens.label}
                />
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="mt-6 rounded-xl border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
              No incidents match these filters. Clear the source or area filter.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-5">
              <FeedSection title="Now" hint="Last 30 minutes or still active" items={groups.now} onSelect={select} />
              <FeedSection title="Last 6 hours" items={groups.recent} onSelect={select} />
              <FeedSection title="Earlier" items={groups.earlier} onSelect={select} />
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overscroll-y-contain px-4 pb-8 pt-3 scrollbar-thin">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat value={String(day.length)} label="24 hours" />
            <Stat value={String(week.length)} label="7 days" />
            <Stat value={topCategory(week)} label="Top type" />
            <Stat value={areas[0]?.name ?? "—"} label="Top area" />
          </div>

          {wire.length ? <NewsSection title="Live wire" items={news.filter((n) => n.kicker === "Live wire")} /> : null}
          <NewsSection title="Top stories" items={news.filter((n) => n.kicker !== "Live wire").slice(0, 3)} />
          <NewsSection title="Developing" items={news.filter((n) => n.kicker === "Developing")} />
          <NewsSection title="Latest headlines" items={news.filter((n) => n.kicker !== "Live wire")} />
        </div>
      )}
    </div>
  );
}

function groupIncidents(incidents: Incident[]) {
  const buckets = {
    now: [] as Incident[],
    recent: [] as Incident[],
    earlier: [] as Incident[],
  };
  for (const inc of incidents) {
    if (inc.minutesAgo <= 30 || inc.status === "active") buckets.now.push(inc);
    else if (inc.minutesAgo <= 360) buckets.recent.push(inc);
    else buckets.earlier.push(inc);
  }
  return buckets;
}

function FeedSection({
  title,
  hint,
  items,
  onSelect,
}: {
  title: string;
  hint?: string;
  items: Incident[];
  onSelect: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
        <span className="font-mono text-xs tabular-nums text-subtle">{items.length}</span>
      </div>
      {hint ? <p className="sr-only">{hint}</p> : null}
      <ul className="flex flex-col gap-2.5">
        {items.map((inc) => (
          <li key={inc.id}>
            <IncidentCard incident={inc} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PulseStat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2 px-2 py-2 text-center">
      <div
        className={cn(
          "font-mono text-lg font-semibold tabular-nums leading-none",
          accent ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </div>
      <div className="mt-1 truncate text-xs text-subtle">{label}</div>
    </div>
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

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface px-3 py-3 text-center">
      <div className="truncate font-mono text-base font-semibold tabular-nums text-fg">{value}</div>
      <div className="mt-0.5 text-xs text-subtle">{label}</div>
    </div>
  );
}

function NewsSection({ title, items }: { title: string; items: NewsStory[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
      <div className="flex flex-col gap-2.5">
        {items.map((n) => (
          <a
            key={n.id + title}
            href={n.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-xl border border-border bg-surface p-4 transition-colors duration-150 active:bg-surface-2"
          >
            <div className="flex items-center justify-between gap-2">
              <Badge tone={n.kicker === "Live wire" ? "cyan" : "accent"}>{n.kicker}</Badge>
              <span className="font-mono text-xs tabular-nums text-subtle">
                {relativeTime(n.occurredAt)}
              </span>
            </div>
            <h3 className="mt-2 text-base font-semibold leading-snug">{n.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">{n.summary}</p>
            <p className="mt-2 text-xs text-subtle">
              {n.outlet} · {n.municipality}
            </p>
          </a>
        ))}
      </div>
    </section>
  );
}
