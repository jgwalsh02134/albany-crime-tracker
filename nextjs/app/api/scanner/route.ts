/**
 * Next.js Route Handler: GET /api/scanner/calls
 *
 * Proxies to the FastAPI backend's /api/scanner/calls endpoint.
 * Supports the optional ?channel= query parameter for channel filtering.
 */

import { type NextRequest, NextResponse } from "next/server";

const FASTAPI_URL = process.env.FASTAPI_URL || "http://localhost:8080";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const qs = searchParams.toString();
  const upstreamUrl = `${FASTAPI_URL}/api/scanner/calls${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    const data = await res.json();

    return NextResponse.json(data, {
      status: res.status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err) {
    console.error("[/api/scanner/calls proxy] error:", err);
    return NextResponse.json(
      { status: "error", calls: [], message: "Upstream unavailable" },
      { status: 503 }
    );
  }
}
