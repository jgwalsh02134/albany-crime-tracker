"""National Weather Service (api.weather.gov) emergency alert adapter.

Real-time, government-issued CAP alerts (no API key — just a User-Agent).
Weather emergencies — severe thunderstorms, tornadoes, flash floods, winter
storms, high wind — are a primary driver of police/fire/EMS activity, road
closures, and evacuations, so they belong in an emergency-activity tracker.

Reliability: api.weather.gov is a stable federal API. We scope alerts to
Albany County + the immediate Capital Region and surface only actionable
severities (Moderate and above, or any Warning/Emergency event).
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Any, Optional

import httpx

from app.models.incident import build_provenance

logger = logging.getLogger(__name__)

NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
# Albany NWS forecast zones (ALY office) + Albany County UGC/SAME.
# NYZ052 = western Albany County (Hilltowns); NYC001 = Albany County (county code).
_ALBANY_ZONE_CODES = frozenset({"NYZ052", "NYC001", "NYZ053"})
# County names we treat as in-area for a Capital Region tracker.
_CAPITAL_REGION_COUNTIES = (
    "albany", "rensselaer", "schenectady", "saratoga",
)
_PRIMARY_COUNTY = "albany"

# CAP severity → app severity.
_SEV_MAP = {
    "Extreme": "critical",
    "Severe": "high",
    "Moderate": "medium",
    "Minor": "low",
    "Unknown": "low",
}

# Actionable event keywords — anything matching is surfaced regardless of
# severity (e.g. "Tornado Warning" is always relevant).
_ACTIONABLE_EVENTS = (
    "warning", "emergency", "tornado", "flash flood", "evacuation",
)

# Routine/low-value events to skip even if they appear (reduce noise).
_SKIP_EVENTS = (
    "special weather statement", "air quality alert", "beach hazards",
    "rip current statement", "small craft advisory", "marine weather",
    "hydrologic outlook", "frost advisory",
)

_HEADERS = {"User-Agent": "albany.watch crime/emergency tracker (contact@albany.watch)"}

_last_status: dict[str, Any] = {"last_run": "", "active": 0, "in_area": 0}


def nws_runtime_status() -> dict[str, Any]:
    return dict(_last_status)


def _alert_in_area(props: dict) -> tuple[bool, str]:
    """Return (in_area, matched_county). Matches by UGC zone code or areaDesc."""
    geocode = props.get("geocode") or {}
    ugc = geocode.get("UGC") or []
    if any(code in _ALBANY_ZONE_CODES for code in ugc):
        return True, "Albany County"
    area_desc = (props.get("areaDesc") or "").lower()
    for county in _CAPITAL_REGION_COUNTIES:
        if county in area_desc:
            label = "Albany County" if county == _PRIMARY_COUNTY else county.title() + " County"
            return True, label
    return False, ""


def _should_surface(props: dict) -> bool:
    event = (props.get("event") or "").lower()
    if any(skip in event for skip in _SKIP_EVENTS):
        return False
    severity = props.get("severity") or "Unknown"
    if severity in ("Extreme", "Severe", "Moderate"):
        return True
    return any(kw in event for kw in _ACTIONABLE_EVENTS)


def _to_incident_row(feature: dict) -> Optional[dict[str, Any]]:
    props = feature.get("properties") or {}
    in_area, county = _alert_in_area(props)
    if not in_area or not _should_surface(props):
        return None

    event = props.get("event") or "Weather Alert"
    headline = props.get("headline") or event
    desc = (props.get("description") or "").strip()
    severity = _SEV_MAP.get(props.get("severity") or "Unknown", "low")
    area_desc = props.get("areaDesc") or county
    sent = props.get("sent") or props.get("effective") or ""
    onset = props.get("onset") or sent
    aid = props.get("id") or headline

    try:
        dt = datetime.fromisoformat(str(onset).replace("Z", "+00:00")) if onset else datetime.now(timezone.utc)
        pub = format_datetime(dt)
    except Exception:
        pub = format_datetime(datetime.now(timezone.utc))

    rid = f"nws:{hashlib.sha256(str(aid).encode()).hexdigest()[:16]}"
    title = headline if len(headline) <= 160 else event + " — " + area_desc[:80]
    summary = desc[:300] if desc else headline
    web = props.get("web") or "https://www.weather.gov/aly/"

    return {
        "id": rid,
        "guid": rid,
        "title": title,
        "summary": summary,
        "description": summary,
        "link": web,
        "source": "NWS Alert",
        "source_name": "NWS Alert",
        "source_url": web,
        "pubDate": pub,
        "confidence": 1.0,
        "event_type": "weather_emergency",
        "municipality": county,
        "severity": severity,
        "crime_type": "hazard",
        "_nws_alert": True,
        "incident": {
            "id": rid,
            "event_type": "weather_emergency",
            "status": "active",
            "severity": severity,
            "source_type": "official",
            "source_name": "NWS Alert",
            "source_url": web,
            "verification_level": "official",
            "confidence_score": 1.0,
            "municipality": county,
            "operational_badges": ["nws", "official", "weather", "real_time"],
        },
        "raw_payload": {
            "source_class": "official_structured_or_press",
            "platform": "nws",
            "event": event,
            "cap_severity": props.get("severity"),
            "ingestion": "nws_alerts",
        },
        "provenance": build_provenance(
            source_class="official_structured_or_press",
            source_id="nws-alerts",
            trust_tier="tier_1",
            lane="official_updates",
            ingestion_method="nws_cap_api",
            feed_url=NWS_ALERTS_URL,
            captured_at=datetime.now(timezone.utc).isoformat(),
            raw_fields_hash=hashlib.sha256((title + str(aid)).encode("utf-8", errors="ignore")).hexdigest()[:16],
            content_type="cap_alert",
            capture_method="weather_gov_api",
        ),
    }


async def fetch_nws_alerts(limit: int = 25) -> list[dict[str, Any]]:
    """Fetch active NWS alerts for Albany County + Capital Region. No API key."""
    rows: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(
                NWS_ALERTS_URL,
                params={"area": "NY", "status": "actual", "message_type": "alert,update"},
                headers=_HEADERS,
                timeout=12.0,
            )
            if resp.status_code != 200:
                logger.debug("nws_alerts_non200 status=%s", resp.status_code)
                _last_status.update(last_run=datetime.now(timezone.utc).isoformat(), active=0, in_area=0)
                return []
            data = resp.json()
    except Exception as exc:
        logger.debug("nws_alerts_error: %s", exc)
        return []

    features = data.get("features") or []
    for f in features:
        row = _to_incident_row(f)
        if row:
            rows.append(row)
        if len(rows) >= limit:
            break

    _last_status.update(
        last_run=datetime.now(timezone.utc).isoformat(),
        active=len(features),
        in_area=len(rows),
    )
    logger.info("nws_alerts_fetch active=%d in_area=%d", len(features), len(rows))
    return rows
