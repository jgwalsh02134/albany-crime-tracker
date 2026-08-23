import { useMemo, useState } from "react";
import { ExternalLink, Phone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import directory from "@/data/directory.json";
import { cn } from "@/lib/utils";

type Agency = (typeof directory.agencies)[number];
type Tier = "all" | "federal" | "state" | "county" | "municipal" | "campus" | "specialized";

const TIERS: { id: Tier; label: string }[] = [
  { id: "all", label: "All" },
  { id: "federal", label: "Federal" },
  { id: "state", label: "State" },
  { id: "county", label: "County" },
  { id: "municipal", label: "Municipal" },
  { id: "campus", label: "Campus" },
];

export function DirectoryView() {
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<Tier>("all");

  const agencies = useMemo(() => {
    return directory.agencies.filter((a) => {
      if (tier !== "all" && a.tier !== tier) return false;
      if (!q) return true;
      const hay = `${a.name} ${a.abbreviation} ${a.jurisdiction} ${a.tier}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    });
  }, [q, tier]);

  return (
    <div className="h-full overflow-y-auto overscroll-y-contain px-4 pb-8 pt-3 scrollbar-thin">
      <div className="rounded-xl border border-border bg-surface p-3">
        <h2 className="text-base font-semibold">Law enforcement directory</h2>
        <p className="mt-1 text-xs text-muted">
          Agencies, coverage, scanner feeds, media, and community alerts for Albany County.
        </p>
        <div className="mt-3 grid grid-cols-4 gap-2">
          <Stat n={directory.agencies.length} l="Agencies" />
          <Stat n={directory.municipalities.length} l="Municipalities" />
          <Stat n={directory.media.length} l="Media" />
          <Stat n={directory.community.length} l="Community" />
        </div>
      </div>

      <div className="mt-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search agencies, jurisdiction, type…"
          aria-label="Search directory"
        />
      </div>
      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
        {TIERS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTier(t.id)}
            className={cn(
              "h-8 shrink-0 rounded-full border px-3 text-xs font-semibold",
              tier === t.id ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Agencies</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {agencies.map((a) => (
          <AgencyCard key={a.id} agency={a} />
        ))}
      </ul>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-subtle">
        Municipalities
      </h3>
      <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {directory.municipalities.map((m) => (
          <li key={m.id} className="rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-sm font-medium">{m.name}</p>
            <p className="text-xs text-subtle">
              {m.type}
              {m.hasOwnPolice ? " · own PD" : " · covered by county / neighbors"}
            </p>
          </li>
        ))}
      </ul>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-subtle">
        Scanner ecosystem
      </h3>
      <div className="mt-2 rounded-xl border border-border bg-surface p-3 text-sm">
        <p className="font-medium">{directory.scanner.system.name}</p>
        <p className="mt-1 text-xs text-muted">
          {directory.scanner.system.type} · {directory.scanner.system.dispatchCenter}
        </p>
        <ul className="mt-3 space-y-1.5">
          {directory.scanner.feeds.map((f) => (
            <li key={f.id}>
              <a
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent"
              >
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-subtle">Media</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {directory.media.map((m) => (
          <li key={m.id} className="rounded-lg border border-border bg-surface p-3">
            <a href={m.website} target="_blank" rel="noopener noreferrer" className="text-sm font-medium">
              {m.name}
            </a>
            <p className="mt-1 text-xs text-muted">{m.focus}</p>
          </li>
        ))}
      </ul>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-subtle">
        Community & alerts
      </h3>
      <ul className="mt-2 flex flex-col gap-2">
        {directory.community.map((c) => (
          <li key={c.id} className="rounded-lg border border-border bg-surface p-3">
            {c.url ? (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium"
              >
                {c.name}
              </a>
            ) : (
              <p className="text-sm font-medium">{c.name}</p>
            )}
            <p className="mt-1 text-xs text-muted">{c.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <div className="text-center">
      <div className="font-mono text-base font-semibold tabular-nums">{n}</div>
      <div className="text-xs text-subtle">{l}</div>
    </div>
  );
}

function AgencyCard({ agency }: { agency: Agency }) {
  return (
    <li className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold leading-snug">{agency.name}</p>
          <p className="mt-0.5 text-xs text-subtle">{agency.jurisdiction}</p>
        </div>
        <Badge tone="muted">{agency.abbreviation}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge tone="cyan">{agency.tier}</Badge>
        <Badge tone="muted">{agency.type}</Badge>
      </div>
      {agency.phone ? (
        <a href={`tel:${agency.phone}`} className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <Phone className="size-3" />
          {agency.phone}
          <span className="text-subtle">non-emergency</span>
        </a>
      ) : null}
      {agency.website ? (
        <a
          href={agency.website}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-xs text-accent"
        >
          Website <ExternalLink className="size-3" />
        </a>
      ) : null}
    </li>
  );
}
