/**
 * Home page — Server Component.
 *
 * Fetches incidents from the FastAPI backend at request time (SSR) so the
 * page is pre-rendered with real data. The LiveFeed client component then
 * takes over for real-time polling and interactive filtering.
 */

import { Suspense } from "react";
import { fetchIncidents } from "./lib/api";
import HomeShell from "./components/HomeShell";

// Revalidate every 30 seconds (ISR fallback if SSR is too slow)
export const revalidate = 30;

export default async function HomePage() {
  // Fetch initial incidents server-side for SSR
  const data = await fetchIncidents({
    limit: 120,
    sort_by: "operational",
  });

  const incidents = data.status === "ok" ? data.incidents : [];

  // Filter out scanner-only items (same logic as client)
  const feedIncidents = incidents.filter(
    (r) =>
      !((r.source_type || "").toLowerCase() === "scanner" &&
        r.is_actionable_live !== true)
  );

  return (
    <Suspense fallback={null}>
      <HomeShell initialIncidents={feedIncidents} />
    </Suspense>
  );
}
