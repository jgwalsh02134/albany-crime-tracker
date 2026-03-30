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
    "/api/incidents/summary",
    "/api/incidents/trends",
    "/api/methodology",
    "/api/dev/albany-open-data",
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

        # Priority ordering checks
        try:
            priority_resp = await client.get("/api/incidents", params={"limit": 25, "sort_by": "priority"})
            newest_resp = await client.get("/api/incidents", params={"limit": 25, "sort_by": "newest"})
            print(f"/api/incidents?sort_by=priority: {priority_resp.status_code}")
            print(f"/api/incidents?sort_by=newest: {newest_resp.status_code}")
            if priority_resp.status_code != 200 or newest_resp.status_code != 200:
                failures += 1
            else:
                p_items = priority_resp.json().get("incidents", [])
                n_items = newest_resp.json().get("incidents", [])
                if p_items:
                    p_scores = [float(x.get("priority_score", 0)) for x in p_items if isinstance(x, dict)]
                    if any(p_scores[i] < p_scores[i + 1] for i in range(len(p_scores) - 1)):
                        print("priority sort invalid: priority_score not descending")
                        failures += 1
                    top_flags = [bool(x.get("is_high_priority")) for x in p_items[:5] if isinstance(x, dict)]
                    print(f"priority_top5_high_priority_flags: {top_flags}")
                if p_items and n_items:
                    p_first = str((p_items[0] or {}).get("id"))
                    n_first = str((n_items[0] or {}).get("id"))
                    print(f"priority_first_id: {p_first}")
                    print(f"newest_first_id: {n_first}")
        except Exception as exc:
            print(f"/api/incidents priority sort check: ERROR {exc}")
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

                # Feed/map consistency check on shared IDs and core fields
                feed_resp = await client.get("/api/incidents", params={"limit": 50, "has_coordinates": "true"})
                print(f"/api/incidents?limit=50&has_coordinates=true: {feed_resp.status_code}")
                if feed_resp.status_code != 200:
                    failures += 1
                else:
                    feed_body = feed_resp.json()
                    feed_items = feed_body.get("incidents") if isinstance(feed_body, dict) else None
                    if not isinstance(feed_items, list):
                        print("/api/incidents payload invalid: incidents is not a list")
                        failures += 1
                    else:
                        feed_ids = {str(x.get("id")) for x in feed_items if isinstance(x, dict) and x.get("id")}
                        map_ids = {str(x.get("id")) for x in markers if isinstance(x, dict) and x.get("id")}
                        overlap = sorted(list(feed_ids.intersection(map_ids)))
                        print(f"feed_map_id_overlap_count: {len(overlap)}")
                        if feed_items and markers and len(overlap) == 0:
                            print("feed/map consistency invalid: no shared incident IDs")
                            failures += 1
        except Exception as exc:
            print(f"/api/incidents/map payload check: ERROR {exc}")
            failures += 1

        # Summary + trends payload checks
        try:
            summary = await client.get("/api/incidents/summary", params={"window": "7d"})
            print(f"/api/incidents/summary?window=7d: {summary.status_code}")
            if summary.status_code != 200:
                failures += 1
            else:
                body = summary.json()
                expected_top = {"status", "source", "window", "total", "groups", "trust", "delta_count"}
                missing_top = sorted(list(expected_top - set(body.keys()))) if isinstance(body, dict) else sorted(list(expected_top))
                if missing_top:
                    print(f"/api/incidents/summary payload invalid: missing keys {missing_top}")
                    failures += 1
                groups = body.get("groups") if isinstance(body, dict) else None
                if not isinstance(groups, dict):
                    print("/api/incidents/summary payload invalid: groups is not an object")
                    failures += 1
                else:
                    for key in ("incident_type", "municipality", "source_type", "verification_level"):
                        if not isinstance(groups.get(key), list):
                            print(f"/api/incidents/summary payload invalid: groups.{key} is not a list")
                            failures += 1

            trends = await client.get("/api/incidents/trends", params={"window": "30d"})
            print(f"/api/incidents/trends?window=30d: {trends.status_code}")
            if trends.status_code != 200:
                failures += 1
            else:
                t_body = trends.json()
                series = t_body.get("series") if isinstance(t_body, dict) else None
                daily = series.get("daily_counts") if isinstance(series, dict) else None
                if not isinstance(daily, list):
                    print("/api/incidents/trends payload invalid: series.daily_counts is not a list")
                    failures += 1

            # Empty-window safety (frontend should tolerate this shape)
            empty_summary = await client.get("/api/incidents/summary", params={"window": "24h"})
            print(f"/api/incidents/summary?window=24h: {empty_summary.status_code}")
            if empty_summary.status_code != 200:
                failures += 1
            else:
                e_body = empty_summary.json()
                if not isinstance(e_body.get("groups"), dict):
                    print("/api/incidents/summary 24h payload invalid: groups missing")
                    failures += 1
        except Exception as exc:
            print(f"/api/incidents summary/trends payload check: ERROR {exc}")
            failures += 1

        try:
            meth = await client.get("/api/methodology")
            print(f"/api/methodology: {meth.status_code}")
            if meth.status_code != 200:
                failures += 1
            else:
                body = meth.json()
                if not isinstance(body.get("methodology"), dict):
                    print("/api/methodology payload invalid: methodology missing")
                    failures += 1
                if not isinstance(body.get("planned_hooks"), list):
                    print("/api/methodology payload invalid: planned_hooks missing")
                    failures += 1
        except Exception as exc:
            print(f"/api/methodology check: ERROR {exc}")
            failures += 1

        try:
            src = await client.get("/api/sources")
            print(f"/api/sources: {src.status_code}")
            if src.status_code != 200:
                failures += 1
            else:
                s_body = src.json()
                sources = s_body.get("sources") if isinstance(s_body, dict) else None
                if not isinstance(sources, list) or not sources:
                    print("/api/sources payload invalid: sources missing")
                    failures += 1
                else:
                    required = {"name", "type", "trust_tier", "active_status"}
                    missing = sorted(list(required - set((sources[0] or {}).keys())))
                    if missing:
                        print(f"/api/sources payload invalid: missing keys {missing}")
                        failures += 1
        except Exception as exc:
            print(f"/api/sources check: ERROR {exc}")
            failures += 1

        # Socrata structured-source integration checks
        try:
            soc = await client.get("/api/dev/albany-open-data", params={"limit": 20})
            print(f"/api/dev/albany-open-data?limit=20: {soc.status_code}")
            if soc.status_code != 200:
                failures += 1
            else:
                s_payload = soc.json()
                s_rows = s_payload if isinstance(s_payload, list) else []
                print(f"socrata_fetch_count: {len(s_rows)}")
                if len(s_rows) == 0:
                    print("socrata fetch invalid: no rows returned")
                    failures += 1

            prime = await client.get("/api/crimes", params={"force_refresh": "true"})
            print(f"/api/crimes?force_refresh=true: {prime.status_code}")
            if prime.status_code != 200:
                failures += 1
            else:
                p_body = prime.json()
                structured = (p_body.get("structured_sources") or {}) if isinstance(p_body, dict) else {}
                print(f"socrata_records_in_crimes_payload: {structured.get('socrata_records', 0)}")

            open_data_inc = await client.get("/api/incidents", params={"source_type": "open_data", "limit": 20})
            print(f"/api/incidents?source_type=open_data&limit=20: {open_data_inc.status_code}")
            if open_data_inc.status_code != 200:
                failures += 1
            else:
                body = open_data_inc.json()
                items = body.get("incidents") if isinstance(body, dict) else None
                count = len(items) if isinstance(items, list) else 0
                print(f"open_data_incident_count: {count}")
                if count == 0:
                    print("open_data incident integration invalid: no persisted Socrata-backed incidents")
                    failures += 1

            open_data_map = await client.get(
                "/api/incidents/map",
                params={"source_type": "open_data", "has_coordinates": "true", "limit": 20},
            )
            print("/api/incidents/map?source_type=open_data&has_coordinates=true&limit=20: " + str(open_data_map.status_code))
            if open_data_map.status_code != 200:
                failures += 1
            else:
                m_body = open_data_map.json()
                markers = m_body.get("markers") if isinstance(m_body, dict) else None
                m_count = len(markers) if isinstance(markers, list) else 0
                print(f"open_data_map_marker_count: {m_count}")
                if m_count == 0:
                    print("open_data map integration invalid: no Socrata-backed coordinates in map payload")
                    failures += 1
        except Exception as exc:
            print(f"/api/socrata integration check: ERROR {exc}")
            failures += 1
    if failures:
        print(f"\nValidation failed: {failures} route(s) did not pass.")
        return 1
    print("\nValidation passed for all critical routes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

