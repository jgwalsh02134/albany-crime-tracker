import { useEffect } from "react";
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
  component: IncidentDeepLinkPage,
});

function IncidentDeepLinkPage() {
  const { id } = Route.useParams();
  const meta = Route.useLoaderData();
  const select = useAppStore((s) => s.selectIncident);
  const setView = useAppStore((s) => s.setView);
  const setHomeMode = useAppStore((s) => s.setHomeMode);

  useEffect(() => {
    const target = meta.incident?.id ?? id;
    select(target);
    setView("map");
    setHomeMode("live");
  }, [id, meta.incident?.id, select, setView, setHomeMode]);

  return <AppShell />;
}
