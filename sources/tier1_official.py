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

        events_rows: list[dict[str, str]] = []
        events_resp = await fetch_with_retry(
            client,
            "https://511ny.org/api/GetEvents",
            params={"format": "json"},
            retries=settings.external_retry_attempts,
            timeout=settings.external_timeout_seconds,
        )
        if events_resp and events_resp.status_code == 200:
            try:
                payload = events_resp.json()
                events = payload.get("events") if isinstance(payload, dict) else payload
                if isinstance(events, list):
                    for ev in events[:limit_per_source]:
                        title = _clean_text(str(ev.get("event_type") or ev.get("title") or "511NY Traffic Event"))
                        link = str(ev.get("url") or "https://511ny.org/")
                        events_rows.append(
                            {
                                "title": title,
                                "link": link,
                                "pubDate": format_datetime(datetime.now(timezone.utc)),
                                "description": _clean_text(str(ev.get("description") or "")),
                                "guid": str(ev.get("id") or link or title),
                            }
                        )
            except Exception:
                pass
        rows.extend(
            _as_incident_rows(
                events_rows,
                source_name="511NY Events API",
                source_url="https://511ny.org/api/GetEvents",
                source_type="official_alerts",
                incident_type="traffic_incident",
                trust_tier="tier_1",
                lane="official_updates",
            )
        )

    # Socrata is fetched through the dedicated structured adapter.
    socrata_rows = await fetch_albany_open_data(
        limit=min(limit_per_source, 250),
        offset=0,
        allow_fallback=(not strict_live_sources),
        strict_live=bool(strict_live_sources),
    )
    rows.extend(socrata_rows[:limit_per_source])
    return rows
