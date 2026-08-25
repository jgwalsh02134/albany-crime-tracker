import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ExternalLink } from "lucide-react";
import { Seal } from "@/components/seal";
import { Badge } from "@/components/ui/badge";
import { SOURCES, lastHours } from "@/lib/data";
import { DCJS_NAME_BY_ID } from "@/lib/directory-stats";
import fbi from "@/data/fbi-2025.json";
import dcjs from "@/data/dcjs-albany.json";
import type { Incident } from "@/lib/types";

const ID_BY_DCJS = Object.fromEntries(Object.entries(DCJS_NAME_BY_ID).map(([id, name]) => [name, id]));

export function MoreView({ incidents }: { incidents: Incident[] }) {
  const day = lastHours(incidents, 24);
  const violent = day.filter((i) => i.category === "violent").length;
  const property = day.filter((i) => i.category === "property").length;
  const n = fbi.national;
  const p = fbi.participation;
  const h = fbi.hateCrime;

  return (
    <div className="h-full overflow-y-auto overscroll-y-contain px-3 pb-8 pt-3 scrollbar-thin">
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Last 24 hours</h2>
        <p className="mt-1 text-sm text-muted">NYSP blotter, scanner, 511, and newsroom activity — last 24 hours.</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Pattern n={day.length} l="stories" />
          <Pattern n={violent} l="violent" />
          <Pattern n={property} l="property" />
        </div>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">FBI NIBRS 2025</h2>
          <Badge tone="cyan">Official</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          Reported Crimes in the Nation, released {fbi.released}. {p.nibrsAgencies.toLocaleString()} NIBRS
          agencies covering {p.nibrsPopPct}% of the U.S. population.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <StatCard
            label="Violent crime"
            value={n.violent.toLocaleString()}
            rate={`${n.violentRate} / 100k`}
            delta={`${n.violentYoY}% vs 2024`}
            down={n.violentYoY < 0}
          />
          <StatCard
            label="Property crime"
            value={n.property.toLocaleString()}
            rate={`${n.propertyRate} / 100k`}
            delta={`${n.propertyYoY}% vs 2024`}
            down={n.propertyYoY < 0}
          />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <Mini label="Murder" v={`${n.murderYoY}%`} sub={`${n.murderRate}/100k`} />
          <Mini label="Rape" v={`${n.rapeYoY}%`} sub={`${n.rapeRate}/100k`} />
          <Mini label="Robbery" v={`${n.robberyYoY}%`} sub={`${n.robberyRate}/100k`} />
          <Mini label="Assault" v={`${n.assaultYoY}%`} sub={`${n.assaultRate}/100k`} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Mini label="Burglary" v={`${n.burglaryYoY}%`} sub={`${n.burglaryRate}/100k`} />
          <Mini label="Larceny" v={`${n.larcenyYoY}%`} sub={`${n.larcenyRate}/100k`} />
          <Mini label="Auto theft" v={`${n.autoYoY}%`} sub={`${n.autoRate}/100k`} />
        </div>

        <p className="mt-3 text-xs leading-relaxed text-subtle">{fbi.notes[0]}</p>
        <p className="mt-1 text-xs leading-relaxed text-subtle">{fbi.notes[1]}</p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-border bg-surface px-3 py-3">
            <p className="text-xs text-subtle">Hate crime incidents</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{h.incidents.toLocaleString()}</p>
            <p className="text-xs text-cyan">{h.yoy}% vs 2024</p>
          </div>
          <div className="rounded-xl border border-border bg-surface px-3 py-3">
            <p className="text-xs text-subtle">UCR participation</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{p.totalPopPct}%</p>
            <p className="text-xs text-subtle">{p.totalAgencies.toLocaleString()} agencies</p>
          </div>
        </div>

        <a
          href={fbi.nibrsMap}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex min-h-12 items-center justify-between rounded-xl border border-accent/40 bg-accent/10 px-3"
        >
          <span>
            <span className="block text-sm font-medium">NIBRS 2025 agency map</span>
            <span className="block text-xs text-subtle">Search Albany PD, ACSO, Colonie, NYSP Troop G</span>
          </span>
          <ExternalLink className="size-4 text-subtle" />
        </a>
        <a
          href={fbi.specialReports}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex min-h-11 items-center justify-between rounded-xl border border-border bg-surface px-3"
        >
          <span className="text-sm">Crime Data Explorer · 2025 tables</span>
          <ExternalLink className="size-4 text-subtle" />
        </a>
        <a
          href={fbi.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex min-h-11 items-center justify-between rounded-xl border border-border bg-surface px-3"
        >
          <span className="text-sm">UCR summary PDF</span>
          <ExternalLink className="size-4 text-subtle" />
        </a>
        <a
          href={fbi.pressRelease}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex min-h-11 items-center justify-between rounded-xl border border-border bg-surface px-3"
        >
          <span className="text-sm">FBI press release · Aug 14, 2026</span>
          <ExternalLink className="size-4 text-subtle" />
        </a>
        <p className="mt-2 text-xs leading-relaxed text-subtle">{fbi.notes[2]}</p>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Albany County · DCJS {dcjs.year}
        </h2>
        <p className="mt-1 text-sm text-muted">Official NYS index crimes by agency. Not a live CAD dump.</p>
        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-subtle">
              <tr>
                <th className="px-3 py-2 font-medium">Agency</th>
                <th className="px-2 py-2 font-medium">Violent</th>
                <th className="px-2 py-2 font-medium">Property</th>
              </tr>
            </thead>
            <tbody>
              {dcjs.agencies.map((a) => {
                const id = ID_BY_DCJS[a.agency];
                return (
                  <tr key={a.agency} className="border-t border-border">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {id ? <Seal id={id} label={a.agency} className="size-8" /> : null}
                        <div className="min-w-0">
                          <p className="font-medium leading-snug">{a.agency}</p>
                          <p className="font-mono text-xs text-subtle">{a.total.toLocaleString()} index</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2.5 font-mono tabular-nums">{a.violent.toLocaleString()}</td>
                    <td className="px-2 py-2.5 font-mono tabular-nums">{a.property.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 rounded-xl border border-border bg-surface p-3">
          <h3 className="text-sm font-semibold">County index crime</h3>
          <p className="mb-2 text-xs text-subtle">Albany County total · NYS DCJS</p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dcjs.yearly}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="year" tick={{ fill: "var(--subtle)", fontSize: 11 }} />
                <YAxis tick={{ fill: "var(--subtle)", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--fg)",
                  }}
                />
                <Legend />
                <Bar dataKey="violent" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="property" fill="var(--cyan)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <a
          href={dcjs.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block text-xs text-accent"
        >
          {dcjs.source}
        </a>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Sources</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {SOURCES.map((s) => (
            <li key={s.name} className="rounded-xl border border-border bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{s.name}</p>
                <Badge tone={s.tier === "Official" ? "cyan" : s.tier === "Scanner" ? "accent" : "muted"}>
                  {s.tier}
                </Badge>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{s.detail}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Pattern({ n, l }: { n: number; l: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-center">
      <div className="font-mono text-lg font-semibold tabular-nums">{n}</div>
      <div className="text-xs text-subtle">{l}</div>
    </div>
  );
}

function StatCard({
  label,
  value,
  rate,
  delta,
  down,
}: {
  label: string;
  value: string;
  rate: string;
  delta: string;
  down: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-3">
      <p className="text-xs text-subtle">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-subtle">{rate}</p>
      <p className={down ? "text-xs text-cyan" : "text-xs text-sev-high"}>{delta}</p>
    </div>
  );
}

function Mini({ label, v, sub }: { label: string; v: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-2 text-center">
      <p className="font-mono text-sm font-semibold tabular-nums text-cyan">{v}</p>
      <p className="text-xs text-subtle">{label}</p>
      <p className="text-xs text-subtle">{sub}</p>
    </div>
  );
}
