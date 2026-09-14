import { useEffect, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { lookupIncidentCard, ogMetaTags } from "@/lib/incident-lookup";
import { incidentDeepLink } from "@/lib/share";
import { useAppStore } from "@/lib/store";

export const Route = createFileRoute("/i/$id")({
  loader: async ({ params }) => lookupIncidentCard(params.id),
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
