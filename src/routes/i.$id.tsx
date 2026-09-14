import { useEffect, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { ogMetaTags } from "@/lib/og-meta";
import { clockTime } from "@/lib/format";
import { incidentDeepLink, sourceCaveat } from "@/lib/share";
import { wireToIncidents, type LiveWireItem } from "@/lib/sources";
import { useAppStore } from "@/lib/store";

type IncidentCardMeta = {
  id: string;
  title: string;
  description: string;
  place: string;
  when: string;
  caveat: string;
  imagePath: string;
  found: boolean;
  incident: import("@/lib/types").Incident | null;
  originalUrl?: string;
  kind?: "incident" | "story";
};

const FALLBACK: IncidentCardMeta = {
  id: "",
  title: "Albany County Crime Tracker",
  description: "Live crime intelligence for Albany County, NY.",
  place: "Albany County, NY",
  when: "",
  caveat: "",
  imagePath: "/og.jpg",
  found: false,
  incident: null,
  kind: "incident",
};

function looksLikeExternalUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim());
}

function safeDecodeMaybe(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const once = decodeURIComponent(s);
    return once.includes("%") ? decodeURIComponent(once) : once;
  } catch {
    return s;
  }
}

function cardMetaFromIncident(incident: import("@/lib/types").Incident, id: string): IncidentCardMeta {
  const place = incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
    ? incident.address
    : `${incident.address}, ${incident.municipality}`;
  const when = clockTime(incident.occurredAt);
  const caveat = sourceCaveat(incident);
  const description = [place, when, caveat].filter(Boolean).join(" · ");
  return {
    id,
    title: incident.title,
    description,
    place,
    when,
    caveat,
    imagePath: `/api/og/${encodeURIComponent(id)}`,
    found: true,
    incident,
    kind: "incident",
  };
}

function cardMetaFromStory(opts: {
  id: string;
  url: string;
  title: string;
  outlet: string;
  summary?: string;
  municipality?: string;
  occurredAt?: string;
}): IncidentCardMeta {
  const when = opts.occurredAt ? clockTime(opts.occurredAt) : "";
  const place = [opts.municipality, opts.outlet].filter(Boolean).join(" · ") || opts.outlet || "News story";
  const description =
    (opts.summary || "").trim().slice(0, 360) ||
    `Newsroom coverage from ${opts.outlet || "a local outlet"}. Open Albany Watch for context and the source for the full story.`;
  return {
    id: opts.id,
    title: opts.title || "News story on Albany Watch",
    description,
    place,
    when,
    caveat: "Newsroom coverage — open the source for the full story.",
    imagePath: `/api/og/${encodeURIComponent(opts.id)}`,
    found: true,
    incident: null,
    originalUrl: opts.url,
    kind: "story",
  };
}

export const Route = createFileRoute("/i/$id")({
  loader: async ({ params }) => {
    const raw = safeDecodeMaybe(String(params.id ?? ""));
    if (!raw) return { ...FALLBACK, id: raw };
    try {
      const r = await fetch("/api/wire", { headers: { Accept: "application/json" } });
      if (!r.ok) return { ...FALLBACK, id: raw, imagePath: `/api/og/${encodeURIComponent(raw)}` };
      const wire = (await r.json()) as { ok?: boolean; items?: LiveWireItem[]; stories?: LiveWireItem[] };
      if (!wire?.ok) return { ...FALLBACK, id: raw, imagePath: `/api/og/${encodeURIComponent(raw)}` };

      if (looksLikeExternalUrl(raw)) {
        const all = [...(wire.stories ?? []), ...(wire.items ?? [])];
        const hit = all.find((w) => w.id === raw || w.url === raw) ?? null;
        if (hit) {
          return cardMetaFromStory({
            id: raw,
            url: hit.url || raw,
            title: hit.title,
            outlet: hit.outlet,
            summary: hit.summary,
            municipality: hit.municipality,
            occurredAt: hit.publishedAt,
          });
        }
        return {
          ...FALLBACK,
          id: raw,
          title: "Story on Albany Watch",
          description: "This story may have aged off the live feed. Open Albany Watch for the current headlines.",
          imagePath: `/api/og/${encodeURIComponent(raw)}`,
          found: false,
          incident: null,
          originalUrl: raw,
          kind: "story",
        };
      }

      const incidents = wireToIncidents(wire.items ?? []);
      const hit =
        incidents.find((i) => i.id === raw) ??
        incidents.find((i) => i.memberIds?.includes(raw)) ??
        incidents.find((i) => i.id.endsWith(raw) || raw.endsWith(i.id)) ??
        null;
      if (!hit) {
        return {
          ...FALLBACK,
          id: raw,
          title: "Incident on Albany Watch",
          description: "This item may have aged off Live. Open Albany County Crime Tracker for the current feed.",
          imagePath: `/api/og/${encodeURIComponent(raw)}`,
        };
      }
      return cardMetaFromIncident(hit, hit.id);
    } catch {
      return { ...FALLBACK, id: raw, imagePath: `/api/og/${encodeURIComponent(raw)}` };
    }
  },
  head: ({ loaderData, params }) => {
    const id = params.id;
    const meta = loaderData ?? {
      id,
      title: "Albany County Crime Tracker",
      description: "Live crime intelligence for Albany County, NY.",
      place: "Albany County, NY",
      when: "",
      caveat: "",
      imagePath: `/api/og/${encodeURIComponent(id)}`,
      found: false,
      incident: null,
    };
    const canonical = incidentDeepLink(meta.incident?.id ?? id, "https://app.albany.watch");
    return {
      meta: ogMetaTags(meta, canonical),
      links: [{ rel: "canonical", href: canonical }],
    };
  },
  component: DeepLinkPage,
});

function DeepLinkPage() {
  const { id } = Route.useParams();
  const meta = Route.useLoaderData();
  const setView = useAppStore((s) => s.setView);
  const setHomeMode = useAppStore((s) => s.setHomeMode);
  const select = useAppStore((s) => s.selectIncident);

  const isStory = Boolean(meta.originalUrl) || meta.kind === "story" || /^https?:\/\//i.test(String(id ?? ""));
  const original = meta.originalUrl || (typeof id === "string" && /^https?:\/\//i.test(id) ? id : "");

  const openAppHref = useMemo(() => "/", []);

  useEffect(() => {
    if (isStory) return;
    const target = meta.incident?.id ?? id;
    select(target);
    setView("map");
    setHomeMode("live");
  }, [id, isStory, meta.incident?.id, select, setView, setHomeMode]);

  if (isStory) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col bg-bg px-4 pb-10 pt-8 text-fg">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Albany Watch</p>
        <h1 className="mt-2 text-2xl font-semibold leading-tight tracking-tight">{meta.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{meta.description}</p>
        <div className="mt-4 rounded-xl border border-border bg-surface p-3">
          <p className="text-xs text-subtle">
            {[meta.place, meta.when].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{meta.caveat}</p>
        </div>
        <div className="mt-6 flex flex-col gap-2">
          {original ? (
            <a
              href={original}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg"
            >
              Open original story
            </a>
          ) : null}
          <a
            href={openAppHref}
            className="inline-flex min-h-12 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold text-fg"
          >
            Open Albany Watch
          </a>
        </div>
        <p className="mt-6 text-xs leading-relaxed text-subtle">
          Albany Watch shows live public-safety signals and links out to news sources for full coverage.
        </p>
      </div>
    );
  }

  return <AppShell />;
}
