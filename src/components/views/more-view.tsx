import { Badge } from "@/components/ui/badge";
import { SOURCES, lastHours } from "@/lib/data";
import type { Incident } from "@/lib/types";

export function MoreView({ incidents }: { incidents: Incident[] }) {
  const day = lastHours(incidents, 24);
  const violent = day.filter((i) => i.category === "violent").length;
  const property = day.filter((i) => i.category === "property").length;

  return (
    <div className="h-full overflow-y-auto overscroll-y-contain px-4 pb-8 pt-3 scrollbar-thin">
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Last 24 hours
        </h2>
        <p className="mt-1 text-sm text-muted">From live newsroom reports only. Not CAD.</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Pattern n={day.length} l="stories" />
          <Pattern n={violent} l="violent" />
          <Pattern n={property} l="property" />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">Official stats</h2>
        <p className="mt-1 text-sm text-muted">
          Annual FBI / DCJS tables are not hosted here. Open the official explorers:
        </p>
        <a
          href="https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block rounded-xl border border-border bg-surface p-3"
        >
          <p className="text-sm font-medium">FBI Crime Data Explorer</p>
          <p className="text-xs text-subtle">Search by agency, county, or state</p>
        </a>
        <a
          href="https://www.criminaljustice.ny.gov/crimnet/ojsa/indexcrimes/county_listings.htm"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block rounded-xl border border-border bg-surface p-3"
        >
          <p className="text-sm font-medium">NYS DCJS county crime</p>
          <p className="text-xs text-subtle">Official New York index-crime listings</p>
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
          This app does not invent incidents. Live and News are newsroom articles. Scanner is live
          radio. Directory is reference. If a card cannot be opened to a source, it does not ship.
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
