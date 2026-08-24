import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Drawer } from "vaul";
import { ExternalLink, MapPin, Phone, Star } from "lucide-react";
import { Seal } from "@/components/seal";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import directory from "@/data/directory.json";
import { dcjsFor } from "@/lib/directory-stats";
import { cn } from "@/lib/utils";

type Agency = (typeof directory.agencies)[number];
type Muni = (typeof directory.municipalities)[number];
type Tier = "all" | "federal" | "state" | "county" | "municipal" | "campus" | "specialized";

const TIERS: { id: Tier; label: string }[] = [
  { id: "all", label: "All" },
  { id: "municipal", label: "City / town" },
  { id: "county", label: "County" },
  { id: "state", label: "State" },
  { id: "federal", label: "Federal" },
  { id: "campus", label: "Campus" },
  { id: "specialized", label: "Other" },
];

const TIER_ORDER: Tier[] = ["municipal", "county", "state", "federal", "campus", "specialized"];
const FAV_KEY = "act-fav-agencies";
const NIBRS_MAP = "https://nibrs.fbi.gov/2025/";

function telHref(phone: string): string | null {
  if (/text/i.test(phone)) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 7) return null;
  return `tel:${digits}`;
}

function mapsHref(address: string): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

function loadFavs(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function DirectoryView() {
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<Tier>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [favs, setFavs] = useState<string[]>([]);

  useEffect(() => {
    setFavs(loadFavs());
  }, []);

  const query = q.trim().toLowerCase();

  const agencies = useMemo(() => {
    return directory.agencies.filter((a) => {
      if (tier !== "all" && a.tier !== tier) return false;
      if (!query) return true;
      return `${a.name} ${a.abbreviation ?? ""} ${a.jurisdiction} ${a.tier} ${a.phone} ${a.address} ${a.headOfficial}`.toLowerCase().includes(query);
    });
  }, [query, tier]);

  const groups = useMemo(() => {
    const pinned = agencies.filter((a) => favs.includes(a.id));
    const rest = TIER_ORDER.map((t) => ({
      id: t,
      label: TIERS.find((x) => x.id === t)?.label ?? t,
      items: agencies.filter((a) => a.tier === t && !favs.includes(a.id)),
    })).filter((g) => g.items.length);
    return { pinned, rest };
  }, [agencies, favs]);

  const selected = directory.agencies.find((a) => a.id === openId) ?? null;

  const media = directory.media.filter((m) => {
    if (tier !== "all") return false;
    if (!query) return true;
    return `${m.name} ${m.focus}`.toLowerCase().includes(query);
  });
  const community = directory.community.filter((c) => {
    if (tier !== "all") return false;
    if (!query) return true;
    return `${c.name} ${c.description}`.toLowerCase().includes(query);
  });
  const feeds = query
    ? directory.scanner.feeds.filter((f) => `${f.name} ${f.coverage}`.toLowerCase().includes(query))
    : directory.scanner.feeds;
  const munis = directory.municipalities.filter((m) => {
    if (tier !== "all" && tier !== "municipal") return false;
    if (!query) return true;
    return m.name.toLowerCase().includes(query);
  });

  function toggleFav(id: string) {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev];
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const searching = Boolean(query);
  const empty = agencies.length === 0 && media.length === 0 && community.length === 0 && (!searching || feeds.length === 0);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <h1 className="text-base font-semibold">Directory</h1>
        <p className="mt-0.5 text-xs text-subtle">
          {directory.agencies.length} agencies · official seals · non-emergency numbers
        </p>
        <a
          href="tel:911"
          className="mt-3 flex min-h-12 items-center justify-between rounded-xl border border-sev-high/40 bg-sev-high/10 px-3"
        >
          <span>
            <span className="block text-sm font-semibold text-sev-high">Emergency</span>
            <span className="block text-xs text-muted">Police, fire, EMS</span>
          </span>
          <span className="font-mono text-lg font-semibold tabular-nums text-sev-high">911</span>
        </a>
        <div className="mt-3">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, town, phone…"
            aria-label="Search directory"
            type="search"
            inputMode="search"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain pb-1 scrollbar-none snap-x">
          {TIERS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTier(t.id)}
              className={cn(
                "h-10 shrink-0 snap-start rounded-full border px-4 text-sm font-semibold",
                tier === t.id ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-8 scrollbar-thin">
        {groups.pinned.length ? (
          <Section title="Pinned" count={groups.pinned.length}>
            {groups.pinned.map((a) => (
              <ContactRow
                key={a.id}
                agency={a}
                starred
                onOpen={() => setOpenId(a.id)}
                onStar={() => toggleFav(a.id)}
              />
            ))}
          </Section>
        ) : null}

        {groups.rest.map((g) => (
          <Section key={g.id} title={g.label} count={g.items.length}>
            {g.items.map((a) => (
              <ContactRow
                key={a.id}
                agency={a}
                starred={favs.includes(a.id)}
                onOpen={() => setOpenId(a.id)}
                onStar={() => toggleFav(a.id)}
              />
            ))}
          </Section>
        ))}

        {tier === "all" || tier === "municipal" ? (
          <Section title="Municipalities" count={munis.length}>
            {munis.map((m) => (
              <MuniRow key={m.id} muni={m} onOpenAgency={(id) => setOpenId(id)} />
            ))}
          </Section>
        ) : null}

        {tier === "all" ? (
          <>
            <Section title="Newsrooms" count={media.length}>
              {media.map((m) => (
                <LinkRow key={m.id} id={m.id} title={m.name} subtitle={m.focus} href={m.website} />
              ))}
            </Section>
            <section className="mb-5">
              <h2 className="sticky top-0 z-10 bg-bg/90 py-1.5 text-xs font-semibold uppercase tracking-wide text-subtle backdrop-blur-md">
                Scanner
              </h2>
              <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
                <p className="text-sm font-medium">{directory.scanner.system.name}</p>
                <p className="mt-0.5 text-xs text-subtle">{directory.scanner.system.type}</p>
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {feeds.map((f) => (
                  <li key={f.id}>
                    <LinkRow id={f.id} title={f.name} subtitle={f.coverage || "Broadcastify / RadioReference"} href={f.url} compact />
                  </li>
                ))}
              </ul>
            </section>
            <Section title="Community" count={community.length}>
              {community.map((c) =>
                c.url ? (
                  <LinkRow key={c.id} id={c.id} title={c.name} subtitle={c.description} href={c.url} />
                ) : (
                  <div key={c.id} className="flex min-h-14 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2">
                    <Seal id={c.id} label={c.name} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{c.name}</p>
                      <p className="text-xs leading-snug text-subtle">{c.description}</p>
                    </div>
                  </div>
                ),
              )}
            </Section>
          </>
        ) : null}

        {empty ? (
          <p className="rounded-xl border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
            No contacts match that search.
          </p>
        ) : null}
      </div>

      <AgencySheet
        agency={selected}
        starred={selected ? favs.includes(selected.id) : false}
        onClose={() => setOpenId(null)}
        onStar={() => selected && toggleFav(selected.id)}
      />
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="mb-5">
      <h2 className="sticky top-0 z-10 bg-bg/90 py-1.5 text-xs font-semibold uppercase tracking-wide text-subtle backdrop-blur-md">
        {title}
        <span className="ml-2 font-mono font-normal tabular-nums">{count}</span>
      </h2>
      <ul className="flex flex-col gap-2">
        {Array.isArray(children)
          ? children.map((child, i) => <li key={i}>{child}</li>)
          : children}
      </ul>
    </section>
  );
}

function ContactRow({
  agency,
  starred,
  onOpen,
  onStar,
}: {
  agency: Agency;
  starred: boolean;
  onOpen: () => void;
  onStar: () => void;
}) {
  const title = agency.abbreviation || agency.name;
  return (
    <div className="flex items-stretch overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left active:bg-surface-2"
      >
        <Seal id={agency.id} label={title} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-snug">{agency.name}</p>
          <p className="truncate text-xs text-subtle">{agency.phone || agency.jurisdiction}</p>
        </div>
      </button>
      <button
        type="button"
        onClick={onStar}
        aria-label={starred ? `Unpin ${agency.name}` : `Pin ${agency.name}`}
        className="flex w-11 shrink-0 items-center justify-center text-subtle active:bg-surface-2"
      >
        <Star className={cn("size-4", starred && "fill-gold text-gold")} />
      </button>
      {agency.phone && telHref(agency.phone) ? (
        <a
          href={telHref(agency.phone)!}
          aria-label={`Call ${agency.name}`}
          className="flex w-12 shrink-0 items-center justify-center border-l border-border text-accent active:bg-surface-2"
        >
          <Phone className="size-5" />
        </a>
      ) : null}
    </div>
  );
}

function LinkRow({
  id,
  title,
  subtitle,
  href,
  compact,
}: {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  compact?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 active:bg-surface-2",
        compact ? "min-h-12" : "min-h-14",
      )}
    >
      <Seal id={id} label={title} className={compact ? "size-8" : undefined} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{title}</p>
        {subtitle ? <p className="truncate text-xs text-subtle">{subtitle}</p> : null}
      </div>
      <ExternalLink className="size-4 shrink-0 text-subtle" />
    </a>
  );
}

function MuniRow({ muni, onOpenAgency }: { muni: Muni; onOpenAgency: (id: string) => void }) {
  const coverId = "policeDepartmentId" in muni ? (muni.policeDepartmentId as string | undefined) : muni.primaryCoverageIds[0];
  const cover = directory.agencies.find((a) => a.id === coverId);
  return (
    <button
      type="button"
      onClick={() => coverId && onOpenAgency(coverId)}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-left active:bg-surface-2"
    >
      <Seal id={coverId ?? muni.id} label={muni.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{muni.name}</p>
        <p className="truncate text-xs text-subtle">
          {muni.hasOwnPolice ? cover?.name ?? "Own police" : `Covered by ${cover?.abbreviation || cover?.name || "county / NYSP"}`}
        </p>
      </div>
    </button>
  );
}

function AgencySheet({
  agency,
  starred,
  onClose,
  onStar,
}: {
  agency: Agency | null;
  starred: boolean;
  onClose: () => void;
  onStar: () => void;
}) {
  const stats = agency ? dcjsFor(agency.id) : undefined;
  const maps = agency?.address ? mapsHref(agency.address) : null;
  const tel = agency?.phone ? telHref(agency.phone) : null;

  return (
    <Drawer.Root open={!!agency} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
          {agency ? (
            <div className="overflow-y-auto px-4 pb-6 pt-3 scrollbar-thin">
              <div className="flex items-start gap-3">
                <Seal id={agency.id} label={agency.abbreviation || agency.name} className="size-16" />
                <div className="min-w-0 flex-1">
                  <Drawer.Title className="text-base font-semibold leading-snug">{agency.name}</Drawer.Title>
                  {agency.abbreviation ? <p className="mt-0.5 text-xs text-subtle">{agency.abbreviation}</p> : null}
                </div>
                <button
                  type="button"
                  onClick={onStar}
                  aria-label={starred ? "Unpin" : "Pin"}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border"
                >
                  <Star className={cn("size-4", starred && "fill-gold text-gold")} />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge tone="cyan">{agency.tier}</Badge>
                <Badge tone="muted">{agency.type.replace(/_/g, " ")}</Badge>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted">{agency.jurisdiction}</p>
              {agency.address ? (
                <a
                  href={maps ?? mapsHref(agency.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 flex items-start gap-2 text-sm text-muted"
                >
                  <MapPin className="mt-0.5 size-4 shrink-0" />
                  <span>{agency.address}</span>
                </a>
              ) : null}
              {agency.headOfficial ? (
                <p className="mt-2 text-sm text-muted">
                  {agency.headOfficialTitle}: {agency.headOfficial}
                </p>
              ) : null}
              {agency.notes ? <p className="mt-2 text-xs leading-relaxed text-subtle">{agency.notes}</p> : null}

              {stats ? (
                <div className="mt-4 rounded-xl border border-border bg-surface-2 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
                    NYS DCJS {stats.months === 12 ? "2024" : `2024 · ${stats.months} mo`}
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <MiniStat n={stats.violent} l="violent" />
                    <MiniStat n={stats.property} l="property" />
                    <MiniStat n={stats.total} l="index" />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-subtle">
                    Latest published county-agency file. 2025 NIBRS counts are on the FBI map — not estimated here.
                  </p>
                </div>
              ) : null}

              <a
                href={NIBRS_MAP}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 flex min-h-12 items-center justify-between rounded-xl border border-border bg-surface-2 px-3"
              >
                <span>
                  <span className="block text-sm font-medium">FBI NIBRS 2025 map</span>
                  <span className="block text-xs text-subtle">Look up this agency’s 2025 incidents</span>
                </span>
                <ExternalLink className="size-4 text-subtle" />
              </a>

              <div className="mt-4 flex gap-2">
                {tel ? (
                  <a
                    href={tel}
                    className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-accent-fg"
                  >
                    <Phone className="size-4" />
                    Call
                  </a>
                ) : null}
                {agency.website ? (
                  <a
                    href={agency.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 text-sm font-semibold"
                  >
                    Website
                    <ExternalLink className="size-4" />
                  </a>
                ) : null}
                {maps ? (
                  <a
                    href={maps}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2"
                    aria-label="Open in Maps"
                  >
                    <MapPin className="size-4" />
                  </a>
                ) : null}
              </div>
              {agency.phone ? (
                <p className="mt-2 text-center text-xs text-subtle">{agency.phone} · non-emergency</p>
              ) : null}
            </div>
          ) : null}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function MiniStat({ n, l }: { n: number; l: string }) {
  return (
    <div>
      <p className="font-mono text-base font-semibold tabular-nums">{n.toLocaleString()}</p>
      <p className="text-xs text-subtle">{l}</p>
    </div>
  );
}
