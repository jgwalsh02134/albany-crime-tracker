/**
 * Next.js Route Handler: GET /api/incidents
 *
 * Proxies to the FastAPI backend's /api/incidents endpoint.
 * This allows client components to fetch incidents via a relative URL
 * (/api/incidents) without needing to know the FastAPI service URL.
 *
 * The Next.js rewrite in next.config.js handles all other /api/* routes
 * that don't have a matching route handler here.
 */

import { type NextRequest, NextResponse } from "next/server";

const FASTAPI_URL = process.env.FASTAPI_URL || "http://localhost:8080";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const qs = searchParams.toString();
  const upstreamUrl = `${FASTAPI_URL}/api/incidents${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        // Forward any auth headers if needed in the future
      },
      // Don't cache at the fetch level — Next.js route handlers handle caching
      cache: "no-store",
    });

    const data = await res.json();

    return NextResponse.json(data, {
      status: res.status,
      headers: {
        // Allow client-side polling to work
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err) {
    console.error("[/api/incidents proxy] error:", err);
    return NextResponse.json(
      { status: "error", incidents: [], message: "Upstream unavailable" },
      { status: 503 }
    );
  }
}
