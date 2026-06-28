/**
 * Scanner page — Server Component.
 *
 * Fetches scanner calls and channel presets from the FastAPI backend at
 * request time (SSR). The ScannerCards client component then takes over
 * for real-time polling and interactive filtering.
 */

import { Suspense } from "react";
import { fetchScannerCalls, fetchScannerChannels } from "../lib/api";
import ScannerShell from "./ScannerShell";

// Scanner data is very fresh — revalidate every 15 seconds
export const revalidate = 15;

export default async function ScannerPage() {
  // Fetch both in parallel
  const [callsData, channelsData] = await Promise.all([
    fetchScannerCalls(),
    fetchScannerChannels(),
  ]);

  const calls = callsData.status === "ok" ? callsData.calls : [];
  const channels = channelsData.status === "ok" ? channelsData.channels : [];

  // Sort channels: high priority first
  const rankMap: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortedChannels = [...channels].sort((a, b) => {
    const ra = rankMap[a.priority ?? "low"] ?? 3;
    const rb = rankMap[b.priority ?? "low"] ?? 3;
    return ra - rb;
  });

  return (
    <Suspense fallback={null}>
      <ScannerShell initialCalls={calls} channels={sortedChannels} />
    </Suspense>
  );
}
