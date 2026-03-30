#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_server import app


CRITICAL_ROUTES = [
    "/health",
    "/ready",
    "/api/situation",
    "/api/sources",
    "/api/incidents",
    "/api/incidents/map",
]


async def main() -> int:
    failures = 0
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=20.0) as client:
        for route in CRITICAL_ROUTES:
            try:
                resp = await client.get(route)
                ok = resp.status_code == 200
                print(f"{route}: {resp.status_code}")
                if not ok:
                    failures += 1
            except Exception as exc:
                print(f"{route}: ERROR {exc}")
                failures += 1

        # Filtered incidents route checks
        try:
            filtered = await client.get(
                "/api/incidents",
                params={
                    "limit": 5,
                    "has_coordinates": "true",
                    "sort_by": "severity",
                },
            )
            print(f"/api/incidents?filters: {filtered.status_code}")
            if filtered.status_code != 200:
                failures += 1
        except Exception as exc:
            print(f"/api/incidents?filters: ERROR {exc}")
            failures += 1

        # Map marker payload shape check
        try:
            map_resp = await client.get("/api/incidents/map", params={"limit": 10, "has_coordinates": "true"})
            print(f"/api/incidents/map?limit=10: {map_resp.status_code}")
            if map_resp.status_code != 200:
                failures += 1
            else:
                body = map_resp.json()
                markers = body.get("markers") if isinstance(body, dict) else None
                if not isinstance(markers, list):
                    print("/api/incidents/map payload invalid: markers is not a list")
                    failures += 1
                elif markers:
                    required = {
                        "id",
                        "title",
                        "incident_type",
                        "severity",
                        "status",
                        "municipality",
                        "latitude",
                        "longitude",
                        "occurred_at",
                        "source_type",
                        "verification_level",
                    }
                    missing = sorted(list(required - set(markers[0].keys())))
                    if missing:
                        print(f"/api/incidents/map payload invalid: missing keys {missing}")
                        failures += 1
        except Exception as exc:
            print(f"/api/incidents/map payload check: ERROR {exc}")
            failures += 1
    if failures:
        print(f"\nValidation failed: {failures} route(s) did not pass.")
        return 1
    print("\nValidation passed for all critical routes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

