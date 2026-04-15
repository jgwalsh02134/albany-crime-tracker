from __future__ import annotations

import logging
from email.utils import parsedate_to_datetime
from typing import Any
from typing import Optional

from app.models.incident import IncidentRecord
from app.services.agency_registry import resolve_agency, resolve_agency_from_call

logger = logging.getLogger(__name__)


def _resolve_responding_agency_id(article: dict[str, Any]) -> Optional[str]:
    """Best-effort canonical agency_id for a feed article.

    Two-stage:
      1. Scanner-call attribution via resolve_agency_from_call(), which
         walks talkgroup_tag / talkgroup_description / etc. and falls back
         to numeric talkgroup IDs through data/scanner_aliases.json.
      2. Source-name attribution via resolve_agency() for non-scanner
         items whose `source` field already names an agency
         ("Albany PD" / "Bethlehem Police" / "ACSO" / etc.).

    Returns None when no canonical agency resolves — non-LE sources like
    Times Union / FBI tip line / etc. should not get a fake attribution.
    Defensive: any registry exception is swallowed and treated as no-match
    so the transformer never blocks ingest.
    """
    try:
        a = resolve_agency_from_call(article)
        if a:
            return str(a.get("agency_id") or "") or None
        # source-name path for non-scanner items.
        for key in ("source", "source_name"):
            v = article.get(key)
            if v:
                a = resolve_agency(str(v))
                if a:
                    return str(a.get("agency_id") or "") or None
    except Exception as exc:
        logger.warning("responding_agency_resolve_failed error=%s", exc)
    return None


def _safe_dt(value: Optional[str]):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except Exception:
        return None


def _severity_from_title(title: str) -> str:
    t = (title or "").lower()
    if any(k in t for k in ("active shooter", "homicide", "mass casualty", "swat", "hostage")):
        return "critical"
    if any(k in t for k in ("shooting", "stabbing", "fire", "pursuit", "armed robbery")):
        return "high"
    if any(k in t for k in ("assault", "burglary", "crash", "closure", "missing")):
        return "medium"
    return "low"


def article_to_incident(article: dict[str, Any]) -> IncidentRecord:
    incident = article.get("incident") or {}
    occurred = _safe_dt(article.get("pubDate")) or _safe_dt(incident.get("occurred_at"))
    published = _safe_dt(article.get("pubDate")) or _safe_dt(incident.get("last_updated_at"))
    source_type = (incident.get("source_type") or "unknown").lower()
    if source_type not in {"scanner", "official_alerts", "local_news", "enrichment", "open_data"}:
        source_type = "unknown"
    status = (incident.get("status") or "unknown").lower()
    if status not in {"active", "recent", "cleared", "historical", "unknown"}:
        status = "unknown"
    verification = (incident.get("verification_level") or "unknown").lower()
    if verification not in {"official", "multi_source", "media", "scanner", "inferred", "unknown"}:
        verification = "unknown"
    tags = list(incident.get("operational_badges") or [])
    if article.get("_scanner_call"):
        tags.append("scanner_call")
    return IncidentRecord(
        id=str(article.get("id") or incident.get("id") or article.get("external_id") or article.get("guid") or ""),
        title=str(article.get("title") or incident.get("title") or ""),
        description=str(article.get("summary") or article.get("description") or incident.get("summary") or ""),
        incident_type=str(article.get("event_type") or incident.get("event_type") or "general"),
        severity=_severity_from_title(str(article.get("title") or "")),
        status=status,  # type: ignore[arg-type]
        source_type=source_type,  # type: ignore[arg-type]
        source_name=str(article.get("source") or incident.get("source_name") or ""),
        source_url=str(article.get("link") or incident.get("source_url") or ""),
        occurred_at=occurred,
        published_at=published,
        municipality=str(article.get("municipality") or incident.get("municipality") or ""),
        address_text=str(article.get("matched_location") or incident.get("street_or_area") or ""),
        latitude=article.get("latitude"),
        longitude=article.get("longitude"),
        confidence_score=float(article.get("confidence") or incident.get("confidence_score") or 0.0),
        verification_level=verification,  # type: ignore[arg-type]
        tags=sorted(set(t for t in tags if t)),
        provenance=article.get("provenance") or article.get("_provenance") or {},
        responding_agency_id=_resolve_responding_agency_id(article),
        geom_wkt=None,
        external_ref=str(article.get("external_ref") or article.get("external_id") or article.get("guid") or ""),
    )

