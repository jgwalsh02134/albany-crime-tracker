import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { NIBRS_AGENCIES, SOURCES, YEARLY_TRENDS, lastHours } from "@/lib/data";
import type { Incident } from "@/lib/types";

export function MoreView({ incidents }: { incidents: Incident[] }) {
  const [ori, setOri] = useState(NIBRS_AGENCIES[0]!.id);
  const agency = NIBRS_AGENCIES.find((a) => a.id === ori) ?? NIBRS_AGENCIES[0]!;
  const day = lastHours(incidents, 24);
  const violent = day.filter((i) => i.category === "violent").length;
  const property = day.filter((i) => i.category === "property").length;

  return (
    <div className="h-full overflow-y-auto overscroll-y-contain px-4 pb-8 pt-3 scrollbar-thin">
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Patterns & trends
        </h2>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Pattern n={day.length} l="24h incidents" />
          <Pattern n={violent} l="violent" />
          <Pattern n={property} l="property" />
        </div>
        <div className="mt-4 rounded-xl border border-border bg-surface p-3">
          <h3 className="text-sm font-semibold">10-year index crime</h3>
          <p className="mb-2 text-xs text-subtle">Albany County composite · via NYS DCJS patterns</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={YEARLY_TRENDS}>
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
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">FBI NIBRS</h2>
        <p className="mt-1 text-sm text-muted">
          Official incident-based reporting for Albany County agencies. Counts are annual, not live.
        </p>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {NIBRS_AGENCIES.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOri(a.id)}
              className={
                ori === a.id
                  ? "h-8 shrink-0 rounded-full bg-accent px-3 text-xs font-semibold text-accent-fg"
                  : "h-8 shrink-0 rounded-full border border-border bg-surface px-3 text-xs font-semibold text-muted"
              }
            >
              {a.name.replace(" Department", "").replace(" Police", " PD")}
            </button>
          ))}
        </div>
        <div className="mt-3 rounded-xl border border-border bg-surface p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{agency.name}</h3>
              <p className="font-mono text-xs text-subtle">
                ORI {agency.ori} · pop {agency.population.toLocaleString()}
              </p>
            </div>
            <Badge tone="muted">{agency.coverage}</Badge>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Pattern n={agency.violent} l="violent" />
            <Pattern n={agency.property} l="property" />
          </div>
          <ul className="mt-3 space-y-1.5">
            {agency.offenses.map((o) => (
              <li key={o.name} className="flex justify-between text-sm">
                <span className="text-muted">{o.name}</span>
                <span className="font-mono tabular-nums">{o.n}</span>
              </li>
            ))}
          </ul>
        </div>
        <a
          href="https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block rounded-xl border border-border bg-surface p-3"
        >
          <p className="text-sm font-medium">Crime Data Explorer</p>
          <p className="text-xs text-subtle">FBI CDE — search by agency, county, or state</p>
        </a>
        <a
          href="https://nibrs.fbi.gov/2024/"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block rounded-xl border border-border bg-surface p-3"
        >
          <p className="text-sm font-medium">NIBRS 2024 interactive map</p>
          <p className="text-xs text-subtle">Official FBI coverage map</p>
        </a>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Sources & methodology
        </h2>
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
        <p className="mt-4 text-xs leading-relaxed text-subtle">
          Scanner audio is unconfirmed. News is context. Official blotters, Socrata, DCJS, and NIBRS
          are the confirmation layers. This rebuild ships a county-pattern dataset so the product is
          usable when open-data portals are unreachable.
        </p>
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
