#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import os
import sys
import re

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_server import app

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel_path: str) -> str:
    try:
        with open(os.path.join(ROOT, rel_path), "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


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
    "/api/home/news",
    "/api/dev/albany-open-data",
]


async def main() -> int:
    failures = 0
    index_html = _read("index.html")
    app_js = _read("app.js")

    # Frontend shell checks.
    # The stable contract is the set of routable views (data-view targets), not the
    # label text — the v7 redesign renamed the mobile Home tab to "Live" and moved AI
    # into a slide-up "More" sheet, while desktop tabs still read Home/Map/Scanner/AI/Directory.
    required_views = ["feed", "map", "scanner", "chat", "directory"]
    for view in required_views:
        if f'data-view="{view}"' not in index_html:
            print(f'nav invalid: no control routes to data-view="{view}"')
            failures += 1
    desktop_tabs = re.findall(r'<button class="desktop-tab[^"]*"[^>]*>([^<]+)</button>', index_html)
    print(f"desktop_tab_labels: {desktop_tabs}")
    if desktop_tabs != ["Home", "Map", "Scanner", "AI", "Directory"]:
        print("desktop nav invalid: expected exactly Home, Map, Scanner, AI, Directory")
        failures += 1
    bottom_labels = re.findall(r'<span class="tab-bar-label">([^<]+)</span>', index_html)
    print(f"bottom_nav_labels: {bottom_labels}")
    if bottom_labels != ["Live", "Map", "Scanner", "Directory", "More"]:
        print("bottom nav invalid: expected exactly Live, Map, Scanner, Directory, More (AI lives under More)")
        failures += 1
    # incidentListUnified is the v7 live-feed container (replaced the old
    # feedSummaryGrid + per-tier incidentList{Verified,Developing,Official} lists).
    required_home_ids = ["homePanelLive", "homePanelNews", "incidentListUnified", "homeMajorStories", "homeDevelopingStories", "homeRecaps"]
    for rid in required_home_ids:
        if f'id="{rid}"' not in index_html:
            print(f"home shell invalid: missing {rid}")
            failures += 1
    if 'data-home-mode="live"' not in index_html or 'data-home-mode="news"' not in index_html:
        print("home invalid: Live/News segmented control missing")
        failures += 1
    if "home-cta-panel" in index_html or "home-cta-btn" in index_html:
        print("home invalid: CTA buttons still present on Home")
        failures += 1
    if "initHomeModeTabs" not in app_js:
        print("home invalid: mode tab init missing from JS")
        failures += 1
    for scanner_label in ["All", "Police", "Fire", "EMS"]:
        if f'data-scanner-filter="{scanner_label.lower()}"' not in index_html and scanner_label != "All":
            print(f"scanner shell invalid: missing {scanner_label} filter")
            failures += 1
    if 'data-scanner-filter="all"' not in index_html:
        print("scanner shell invalid: missing All filter")
        failures += 1
    if "window.ACTFocusIncident = focusIncidentCard;" not in app_js:
        print("map/feed sync invalid: focusIncidentCard hook missing")
        failures += 1
    if "loadScannerAliases" not in app_js:
        print("scanner invalid: alias registry loader missing")
        failures += 1
    if "sc-card-agency" not in app_js:
        print("scanner invalid: agency-first card structure missing")
        failures += 1
    if "sc-pill--conf" in app_js:
        print("scanner invalid: confidence pills still in card render")
        failures += 1
    if "sc-row-play" not in app_js:
        print("scanner invalid: per-row play button missing")
        failures += 1
    if "selectScannerRow" not in app_js:
        print("scanner invalid: row selection handler missing")
        failures += 1

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
        # Route availability is a hard failure; data-level emptiness is a
        # non-blocking warning because data.albanyny.gov may be decommissioned.
        socrata_warnings = 0
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
                    print("socrata fetch: no rows (portal may be decommissioned — non-blocking)")
                    socrata_warnings += 1

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
                    print("open_data incidents: 0 persisted (non-blocking if Socrata portal is offline)")
                    socrata_warnings += 1

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
                    print("open_data map markers: 0 (non-blocking if Socrata portal is offline)")
                    socrata_warnings += 1
        except Exception as exc:
            print(f"/api/socrata integration check: ERROR {exc}")
            failures += 1
        if socrata_warnings:
            print(f"  socrata_warnings: {socrata_warnings} (non-blocking — data.albanyny.gov may be decommissioned)")

        # Provenance schema validation
        try:
            prov_check = await client.get("/api/incidents", params={"limit": 5})
            if prov_check.status_code == 200:
                prov_body = prov_check.json()
                prov_items = prov_body.get("incidents") if isinstance(prov_body, dict) else []
                prov_found = 0
                prov_total = 0
                for it in (prov_items or []):
                    prov_total += 1
                    p = it.get("provenance") or {}
                    if p and isinstance(p, dict) and p.get("origin"):
                        prov_found += 1
                print(f"provenance_present: {prov_found}/{prov_total} incidents have provenance.origin")
                if prov_total > 0 and prov_found == 0:
                    print("  provenance: none found (non-blocking — may need ingestion cycle)")
        except Exception as exc:
            print(f"provenance check: ERROR {exc}")

        # Upstream source resilience summary
        upstream_blockers = []
        try:
            src_resp = await client.get("/api/sources")
            if src_resp.status_code == 200:
                src_body = src_resp.json()
                upstream = src_body.get("upstream_status") or {}

                rr_status = upstream.get("radioreference") or {}
                rr_label = rr_status.get("status", "unknown")
                print(f"upstream_radioreference: {rr_label}")
                if rr_status.get("soap_blocked"):
                    upstream_blockers.append(f"RadioReference SOAP blocked (cooldown {rr_status.get('soap_cooldown_seconds', '?')}s)")

                gn_status = upstream.get("google_news") or {}
                gn_label = gn_status.get("status", "unknown")
                print(f"upstream_google_news: {gn_label}")
                if gn_status.get("blocked"):
                    upstream_blockers.append(f"Google News blocked (remaining {gn_status.get('block_remaining_seconds', '?')}s)")

                socrata_rt = src_body.get("socrata_runtime") or {}
                portal_label = socrata_rt.get("portal_status", "unknown")
                print(f"upstream_socrata_portal: {portal_label}")
                if not socrata_rt.get("portal_reachable"):
                    upstream_blockers.append("Socrata portal unreachable (using fallback)")

                uof = socrata_rt.get("use_of_force_discovery") or {}
                uof_label = uof.get("status", "unknown")
                print(f"upstream_socrata_uof_discovery: {uof_label} (optional={uof.get('optional', True)})")
        except Exception as exc:
            print(f"upstream status check: ERROR {exc}")

        if upstream_blockers:
            print(f"\n  expected_upstream_blockers ({len(upstream_blockers)}):")
            for b in upstream_blockers:
                print(f"    - {b}")
            print("  (these are external service issues, not app failures)")

        # Scanner resilience check (scanner calls should work even with RR down)
        try:
            scanner_resp = await client.get("/api/scanner/calls")
            print(f"/api/scanner/calls: {scanner_resp.status_code}")
            if scanner_resp.status_code != 200:
                failures += 1
        except Exception as exc:
            print(f"/api/scanner/calls: ERROR {exc}")
            failures += 1

    if failures:
        print(f"\nValidation failed: {failures} route(s) did not pass.")
        return 1
    print("\nValidation passed for all critical routes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

