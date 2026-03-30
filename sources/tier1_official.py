from __future__ import annotations

import re
from datetime import datetime
from datetime import timezone
from email.utils import format_datetime
from typing import Any
from typing import Optional
from urllib.parse import urljoin

import httpx

from app.core.config import get_settings
from app.services.http_client import fetch_with_retry
from sources.albany_open_data import fetch_albany_open_data

settings = get_settings()


def _clean_text(value: str) -> str:
    s = (value or "").strip()
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _rss_items(xml_text: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not xml_text:
        return out
    chunks = re.findall(r"<item[\s\S]*?</item>", xml_text, flags=re.I)
    for item in chunks:
        def _extract(tag: str) -> str:
            m = re.search(rf"<{tag}[^>]*>([\s\S]*?)</{tag}>", item, flags=re.I)
            return _clean_text(m.group(1)) if m else ""

        title = _extract("title")
        link = _extract("link")
        pub = _extract("pubDate")
        desc = _extract("description")
        guid = _extract("guid") or link or title
        if title:
            out.append({"title": title, "link": link, "pubDate": pub, "description": desc, "guid": guid})
    return out


def _html_links_as_items(html: str, base_url: str, source_name: str, max_items: int = 40) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for m in re.finditer(r"<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</a>", html or "", flags=re.I):
        href = m.group(1).strip()
        txt = _clean_text(m.group(2))
        if not txt or len(txt) < 8:
            continue
        link = urljoin(base_url, href)
        blob = (link + " " + txt).lower()
        if not any(k in blob for k in ("press", "release", "news", "report", "alert", "incident", "arrest", "safety")):
            continue
        out.append(
            {
                "title": txt[:220],
                "link": link,
                "pubDate": format_datetime(datetime.now(timezone.utc)),
                "description": f"{source_name} update",
                "guid": link,
            }
        )
        if len(out) >= max_items:
            break
    return out


def _as_incident_rows(items: list[dict[str, str]], *, source_name: str, source_url: str, source_type: str, incident_type: str, trust_tier: str, lane: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for it in items:
        title = it.get("title") or source_name
        link = it.get("link") or source_url
        guid = it.get("guid") or link or title
        rid = f"{source_name}:{guid}"
        rows.append(
            {
                "id": rid,
                "guid": rid,
                "title": title,
                "summary": it.get("description") or "",
                "description": it.get("description") or "",
                "link": link,
                "source": source_name,
                "source_name": source_name,
                "source_url": source_url,
                "pubDate": it.get("pubDate") or format_datetime(datetime.now(timezone.utc)),
                "confidence": 0.94,
                "event_type": incident_type,
                "municipality": "Albany",
                "incident": {
                    "id": rid,
                    "event_type": incident_type,
                    "status": "recent",
                    "severity": "medium",
                    "source_type": source_type,
                    "source_name": source_name,
                    "source_url": source_url,
                    "verification_level": "official",
                    "confidence_score": 0.94,
                    "municipality": "Albany",
                    "operational_badges": ["tier1", "official", lane, trust_tier],
                },
                "raw_payload": {
                    "source_class": "official_structured_or_press",
                    "trust_tier": trust_tier,
                    "lane": lane,
                    "ingestion": "tier1_official",
                },
            }
        )
    return rows


async def _fetch_rss(client: httpx.AsyncClient, url: str, headers: Optional[dict[str, str]] = None) -> list[dict[str, str]]:
    resp = await fetch_with_retry(
        client,
        url,
        headers=headers or {},
        retries=settings.external_retry_attempts,
        timeout=settings.external_timeout_seconds,
    )
    if not resp or resp.status_code != 200:
        return []
    return _rss_items(resp.text)


async def _fetch_html_links(client: httpx.AsyncClient, url: str, source_name: str) -> list[dict[str, str]]:
    resp = await fetch_with_retry(
        client,
        url,
        retries=settings.external_retry_attempts,
        timeout=settings.external_timeout_seconds,
    )
    if not resp or resp.status_code != 200:
        return []
    return _html_links_as_items(resp.text, url, source_name)


async def fetch_tier1_sources(limit_per_source: int = 60, *, strict_live_sources: bool = False) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=settings.external_timeout_seconds, follow_redirects=True) as client:
        civic_rss = await _fetch_rss(client, "https://www.albanyny.gov/rss.aspx")
        rows.extend(
            _as_incident_rows(
                civic_rss[:limit_per_source],
                source_name="City of Albany CivicAlerts",
                source_url="https://www.albanyny.gov/CivicAlerts.aspx?CID=10",
                source_type="official_alerts",
                incident_type="official_update",
                trust_tier="tier_1",
                lane="official_updates",
            )
        )

        da_items = await _fetch_html_links(
            client,
            "https://www.albanycountyny.gov/government/albany-county-district-attorney/press-office",
            "Albany County DA Press Office",
        )
        rows.extend(
            _as_incident_rows(
                da_items[:limit_per_source],
                source_name="Albany County DA Press Office",
                source_url="https://www.albanycountyny.gov/government/albany-county-district-attorney/press-office",
                source_type="official_alerts",
                incident_type="prosecution_update",
                trust_tier="tier_1",
                lane="official_updates",
            )
        )

        nysp_news = await _fetch_html_links(client, "https://troopers.ny.gov/nysp-newsroom", "NYSP Newsroom")
        nysp_media = await _fetch_html_links(client, "https://publicapps.troopers.ny.gov/Media_Reports/", "NYSP Media Reports")
        rows.extend(
            _as_incident_rows(
                (nysp_news + nysp_media)[:limit_per_source],
                source_name="NYSP Newsroom / Media Reports",
                source_url="https://troopers.ny.gov/nysp-newsroom",
                source_type="official_alerts",
                incident_type="state_police_update",
                trust_tier="tier_1",
                lane="official_updates",
            )
        )

        ndny_rss = await _fetch_rss(client, "https://www.justice.gov/usao-ndny/pr/rss")
        rows.extend(
            _as_incident_rows(
                ndny_rss[:limit_per_source],
                source_name="USAO NDNY Press",
                source_url="https://www.justice.gov/usao-ndny/pr",
                source_type="official_alerts",
                incident_type="federal_prosecution_update",
                trust_tier="tier_1",
                lane="official_updates",
            )
        )

        # 511NY Events API — traffic incidents with coordinates
        ny_511_key = settings.ny_511_api_key
        events_params: dict[str, str] = {"format": "json"}
        if ny_511_key:
            events_params["key"] = ny_511_key
        events_resp = await fetch_with_retry(
            client,
            "https://511ny.org/api/GetEvents",
            params=events_params,
            retries=settings.external_retry_attempts,
            timeout=settings.external_timeout_seconds,
        )
        if events_resp and events_resp.status_code == 200:
            try:
                payload = events_resp.json()
                events = payload if isinstance(payload, list) else (payload.get("events") or payload.get("Events") or [])
                if isinstance(events, list):
                    _albany_counties = {"albany", "albany county"}
                    _albany_roadways = {"i-90", "i-87", "i-787", "i-88", "route 9w", "route 20", "route 5",
                                        "us-9", "us-20", "ny-5", "ny-7", "ny-85", "thruway", "northway"}
                    for ev in events:
                        # Filter to Albany County area
                        county = str(ev.get("CountyName") or ev.get("county") or "").strip().lower()
                        region = str(ev.get("RegionName") or ev.get("region") or "").strip().lower()
                        roadway = str(ev.get("RoadwayName") or ev.get("roadway") or "").strip().lower()
                        lat_raw = ev.get("Latitude") or ev.get("latitude")
                        lon_raw = ev.get("Longitude") or ev.get("longitude")
                        # Accept if county is Albany or if roadway is in Albany area
                        is_albany = county in _albany_counties
                        if not is_albany and roadway:
                            is_albany = any(r in roadway for r in _albany_roadways)
                        if not is_albany:
                            # Geo-fence check: Albany County roughly 42.4-42.85 lat, -74.1 to -73.55 lon
                            try:
                                lat_f = float(lat_raw) if lat_raw is not None else None
                                lon_f = float(lon_raw) if lon_raw is not None else None
                                if lat_f and lon_f and 42.4 <= lat_f <= 42.85 and -74.1 <= lon_f <= -73.55:
                                    is_albany = True
                            except (TypeError, ValueError):
                                pass
                        if not is_albany:
                            continue

                        event_type = _clean_text(str(ev.get("EventType") or ev.get("event_type") or ""))
                        title_parts = []
                        if event_type:
                            title_parts.append(event_type)
                        road = str(ev.get("RoadwayName") or ev.get("roadway") or "")
                        direction = str(ev.get("DirectionOfTravel") or ev.get("direction") or "")
                        if road:
                            road_label = road
                            if direction:
                                road_label += " " + direction
                            title_parts.append(road_label)
                        title = " — ".join(title_parts) if title_parts else "511NY Traffic Event"
                        desc = _clean_text(str(ev.get("Description") or ev.get("description") or ""))
                        location = _clean_text(str(ev.get("Location") or ev.get("PrimaryLocation") or ""))
                        severity_raw = str(ev.get("Severity") or "").lower()
                        event_id = str(ev.get("ID") or ev.get("id") or title)
                        link = f"https://511ny.org/map#EventId={event_id}" if event_id else "https://511ny.org/"
                        reported = str(ev.get("Reported") or ev.get("StartDate") or "")
                        pub_date = reported if reported else format_datetime(datetime.now(timezone.utc))

                        row: dict[str, Any] = {
                            "title": title,
                            "link": link,
                            "pubDate": pub_date,
                            "description": desc or location,
                            "guid": f"511ny-{event_id}",
                            "_511_incident": True,
                        }
                        # Attach coordinates if available
                        try:
                            lat_v = float(lat_raw) if lat_raw is not None else None
                            lon_v = float(lon_raw) if lon_raw is not None else None
                            if lat_v and lon_v:
                                row["latitude"] = lat_v
                                row["longitude"] = lon_v
                                row["coordinate_quality"] = "exact"
                        except (TypeError, ValueError):
                            pass

                        # Attach location metadata
                        if location:
                            row["matched_location"] = location
                        municipality = county.replace(" county", "").title() if county else ""
                        if municipality:
                            row["municipality"] = municipality

                        rows.append({
                            **row,
                            "id": f"511NY Events API:511ny-{event_id}",
                            "source": "511NY Events API",
                            "source_name": "511NY Events API",
                            "source_url": "https://511ny.org/api/GetEvents",
                            "confidence": 0.96,
                            "event_type": "traffic_incident",
                            "incident": {
                                "id": f"511NY Events API:511ny-{event_id}",
                                "event_type": "traffic_incident",
                                "status": "active" if severity_raw in ("major", "critical") else "recent",
                                "severity": "high" if severity_raw in ("major", "critical") else "medium",
                                "source_type": "official_alerts",
                                "source_name": "511NY Events API",
                                "source_url": "https://511ny.org/api/GetEvents",
                                "verification_level": "official",
                                "confidence_score": 0.96,
                                "municipality": municipality or "Albany",
                                "operational_badges": ["tier1", "official", "official_updates", "tier_1", "511"],
                            },
                            "raw_payload": {
                                "source_class": "official_structured_or_press",
                                "trust_tier": "tier_1",
                                "lane": "official_updates",
                                "ingestion": "tier1_official",
                                "511_raw": {k: str(v)[:200] for k, v in ev.items() if v},
                            },
                        })
            except Exception:
                pass

    # Socrata is fetched through the dedicated structured adapter.
    socrata_rows = await fetch_albany_open_data(
        limit=min(limit_per_source, 250),
        offset=0,
        allow_fallback=(not strict_live_sources),
        strict_live=bool(strict_live_sources),
    )
    rows.extend(socrata_rows[:limit_per_source])
    return rows
