from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from typing import Any
from typing import Optional

from sqlalchemy import and_
from sqlalchemy import or_
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db.models import IncidentORM
from app.db.session import get_session_factory
from app.models.incident import IncidentRecord
from app.services.postgres_text_sanitize import sanitize_incident_inputs

logger = logging.getLogger(__name__)

_MEMORY_INCIDENTS: dict[str, dict[str, Any]] = {}


def _is_scanner_conventional_stored_row(raw_payload: Optional[dict[str, Any]]) -> bool:
    """True for persisted le_directory conventional-frequency rows (legacy or otherwise).

    These stay in Postgres for audit but are omitted from /api/incidents and /api/incidents/summary.
    Live scanner calls do not set _scanner_conventional.
    """
    if not raw_payload or not isinstance(raw_payload, dict):
        return False
    v = raw_payload.get("_scanner_conventional")
    if v is True:
        return True
    if isinstance(v, (int, float)) and int(v) == 1:
        return True
    if isinstance(v, str) and v.strip().lower() in ("1", "true", "yes", "on"):
        return True
    return False


_LAST_QUERY_BACKEND = "memory"
_LAST_UPSERT_STATS: dict[str, Any] = {
    "inserted": 0,
    "updated": 0,
    "skipped_as_duplicate": 0,
    "processed": 0,
    "backend": "memory",
}


def _norm_text(value: str) -> str:
    return " ".join((value or "").lower().strip().split())


def _time_bucket(dt: Optional[datetime], minutes: int) -> str:
    if dt is None:
        return ""
    ts = int(dt.timestamp())
    bucket = max(1, minutes * 60)
    return str(ts // bucket)


def _is_fused(record: IncidentRecord, raw_payload: dict[str, Any]) -> bool:
    rid = (record.id or "").lower()
    raw_id = str(raw_payload.get("id") or "").lower()
    return rid.startswith("fused_") or raw_id.startswith("fused_")


def _is_scanner(record: IncidentRecord, raw_payload: dict[str, Any]) -> bool:
    return bool(raw_payload.get("_scanner_call")) or record.source_type == "scanner"


def _candidate_fingerprints(record: IncidentRecord, raw_payload: dict[str, Any]) -> list[str]:
    occurred = record.occurred_at or record.published_at
    source_name = _norm_text(record.source_name)
    title = _norm_text(record.title)
    municipality = _norm_text(record.municipality)
    incident_type = _norm_text(record.incident_type)
    address_text = _norm_text(record.address_text)
    source_url = _norm_text(record.source_url)
    external_ref = _norm_text(record.external_ref or "")
    candidates: list[str] = []

    # Strong external identity keys (preferred when stable)
    if external_ref:
        candidates.append(f"extref:{source_name}|{external_ref}")
    if source_url:
        candidates.append(f"source_url:{source_name}|{source_url}")

    # Keep non-fused IDs as signal; fused/scanner ids drift between refreshes.
    if record.id and not _is_fused(record, raw_payload) and not _is_scanner(record, raw_payload):
        candidates.append(f"id:{_norm_text(record.id)}")

    if _is_scanner(record, raw_payload):
        # Scanner duplicate control: same source/title/locality in short time window.
        candidates.append(
            "scanner_window:"
            + "|".join(
                [
                    source_name,
                    municipality,
                    incident_type,
                    title[:180],
                    _time_bucket(occurred, 20),
                ]
            )
        )
        if address_text:
            candidates.append(
                "scanner_loc_window:"
                + "|".join(
                    [
                        source_name,
                        municipality,
                        address_text[:160],
                        _time_bucket(occurred, 20),
                    ]
                )
            )
    elif _is_fused(record, raw_payload):
        # Fused duplicate control: broader clustering over medium windows.
        candidates.append(
            "fused_window:"
            + "|".join(
                [
                    source_name,
                    municipality,
                    incident_type,
                    title[:180],
                    _time_bucket(occurred, 45),
                ]
            )
        )
    else:
        # Generic duplicate control for same title/source/municipality near in time.
        candidates.append(
            "near_title_src_muni:"
            + "|".join(
                [
                    source_name,
                    municipality,
                    incident_type,
                    title[:180],
                    _time_bucket(occurred, 60),
                ]
            )
        )

    # Always keep a low-collision fallback candidate.
    candidates.append(
        "fallback:"
        + "|".join(
            [
                source_name,
                municipality,
                incident_type,
                title[:220],
                _time_bucket(occurred, 120),
            ]
        )
    )
    return [c for c in candidates if c]


def _stable_fingerprint(record: IncidentRecord, raw_payload: dict[str, Any]) -> str:
    basis = _candidate_fingerprints(record, raw_payload)[0]
    return hashlib.sha256(basis.encode("utf-8", errors="ignore")).hexdigest()


def _all_fingerprint_hashes(record: IncidentRecord, raw_payload: dict[str, Any]) -> list[str]:
    hashes: list[str] = []
    for candidate in _candidate_fingerprints(record, raw_payload):
        fp = hashlib.sha256(candidate.encode("utf-8", errors="ignore")).hexdigest()
        if fp not in hashes:
            hashes.append(fp)
    return hashes


def _safe_str(value: str, max_len: int) -> str:
    s = str(value or "")
    return s[:max_len] if len(s) > max_len else s


def _record_log_context(record: IncidentRecord, raw_payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_id": str(record.id or "")[:160],
        "source_name": str(record.source_name or "")[:160],
        "source_type": str(record.source_type or "")[:80],
        "title": str(record.title or "")[:200],
        "source_url": str(record.source_url or raw_payload.get("link") or "")[:240],
    }


def _to_orm(record: IncidentRecord, raw_payload: dict[str, Any]) -> IncidentORM:
    rid = str(record.id or "").strip()
    if not rid:
        rid = str(record.external_ref or "").strip()
    if not rid:
        rid = str(uuid.uuid4())
    return IncidentORM(
        id=rid,
        external_id=str(record.external_ref or rid or ""),
        source_fingerprint=_stable_fingerprint(record, raw_payload),
        title=str(record.title or ""),
        description=str(record.description or ""),
        incident_type=_safe_str(record.incident_type, 120),
        severity=_safe_str(record.severity, 32),
        status=_safe_str(record.status, 32),
        source_type=_safe_str(record.source_type, 64),
        source_name=str(record.source_name or ""),
        source_url=str(record.source_url or ""),
        occurred_at=record.occurred_at,
        published_at=record.published_at,
        municipality=_safe_str(record.municipality, 200),
        address_text=str(record.address_text or ""),
        latitude=record.latitude,
        longitude=record.longitude,
        confidence_score=record.confidence_score,
        verification_level=_safe_str(record.verification_level, 64),
        tags=record.tags,
        raw_payload=raw_payload,
        provenance=record.provenance or {},
    )


def _to_public_dict(record: IncidentRecord, raw_payload: dict[str, Any], *, created_at: Optional[datetime] = None) -> dict[str, Any]:
    now = created_at or datetime.utcnow()
    return {
        "id": record.id,
        "external_id": record.external_ref or record.id,
        "title": record.title,
        "description": record.description,
        "incident_type": record.incident_type,
        "severity": record.severity,
        "status": record.status,
        "source_type": record.source_type,
        "source_name": record.source_name,
        "source_url": record.source_url,
        "occurred_at": record.occurred_at.isoformat() if record.occurred_at else None,
        "published_at": record.published_at.isoformat() if record.published_at else None,
        "municipality": record.municipality,
        "address_text": record.address_text,
        "latitude": record.latitude,
        "longitude": record.longitude,
        "confidence_score": record.confidence_score,
        "verification_level": record.verification_level,
        "tags": record.tags or [],
        "raw_payload": raw_payload or {},
        "provenance": record.provenance or {},
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }


def _diff_minutes(a: Optional[datetime], b: Optional[datetime]) -> float:
    if a is None or b is None:
        return 10e6
    return abs((a - b).total_seconds()) / 60.0


def _near_duplicate(existing: IncidentORM, record: IncidentRecord, raw_payload: dict[str, Any]) -> bool:
    if _norm_text(existing.title) != _norm_text(record.title):
        return False
    if _norm_text(existing.source_name) != _norm_text(record.source_name):
        return False
    if _norm_text(existing.municipality) != _norm_text(record.municipality):
        return False
    existing_dt = existing.occurred_at or existing.published_at
    new_dt = record.occurred_at or record.published_at
    window_minutes = 25 if _is_scanner(record, raw_payload) else 60
    return _diff_minutes(existing_dt, new_dt) <= window_minutes


def _apply_updates(existing: IncidentORM, record: IncidentRecord) -> bool:
    changed = False

    def _set(attr: str, value: Any) -> None:
        nonlocal changed
        if getattr(existing, attr) != value:
            setattr(existing, attr, value)
            changed = True

    _set("title", record.title)
    _set("description", record.description)
    _set("incident_type", record.incident_type)
    _set("severity", record.severity)
    _set("status", record.status)
    existing_source_type = (existing.source_type or "").lower()
    incoming_source_type = (record.source_type or "").lower()
    if not (existing_source_type == "open_data" and incoming_source_type != "open_data"):
        _set("source_type", record.source_type)
    _set("source_name", record.source_name)
    _set("source_url", record.source_url)
    _set("occurred_at", record.occurred_at)
    _set("published_at", record.published_at)
    _set("municipality", record.municipality)
    _set("address_text", record.address_text)
    # Preserve highest-trust structured coordinates unless a better open-data value arrives.
    if record.latitude is not None and record.longitude is not None:
        if existing.latitude is None or existing.longitude is None:
            _set("latitude", record.latitude)
            _set("longitude", record.longitude)
        elif incoming_source_type == "open_data" and existing_source_type != "open_data":
            _set("latitude", record.latitude)
            _set("longitude", record.longitude)
    _set("confidence_score", record.confidence_score)
    if not (existing_source_type == "open_data" and incoming_source_type != "open_data"):
        _set("verification_level", record.verification_level)
    _set("tags", record.tags)
    if record.provenance:
        _set("provenance", record.provenance)
    return changed


async def _find_existing_row(
    session: Any,
    record: IncidentRecord,
    raw_payload: dict[str, Any],
    fps: list[str],
) -> Optional[IncidentORM]:
    if record.id:
        by_id = (await session.execute(select(IncidentORM).where(IncidentORM.id == record.id).limit(1))).scalar_one_or_none()
        if by_id is not None:
            return by_id
    ext = (record.external_ref or "").strip()
    if ext:
        by_external = (
            await session.execute(select(IncidentORM).where(IncidentORM.external_id == ext).limit(1))
        ).scalar_one_or_none()
        if by_external is not None:
            return by_external

    q = select(IncidentORM).where(IncidentORM.source_fingerprint.in_(fps)).limit(1)
    existing = (await session.execute(q)).scalar_one_or_none()
    if existing is not None:
        return existing

    ref_dt = record.occurred_at or record.published_at
    if not ref_dt:
        return None
    window_minutes = 25 if _is_scanner(record, raw_payload) else 60
    low = ref_dt - timedelta(minutes=window_minutes)
    high = ref_dt + timedelta(minutes=window_minutes)
    near_q = (
        select(IncidentORM)
        .where(
            and_(
                IncidentORM.title == record.title,
                IncidentORM.source_name == record.source_name,
                IncidentORM.municipality == record.municipality,
                or_(
                    and_(IncidentORM.occurred_at.is_not(None), IncidentORM.occurred_at >= low, IncidentORM.occurred_at <= high),
                    and_(IncidentORM.published_at.is_not(None), IncidentORM.published_at >= low, IncidentORM.published_at <= high),
                ),
            )
        )
        .limit(1)
    )
    return (await session.execute(near_q)).scalar_one_or_none()


async def upsert_incidents(records: list[IncidentRecord], raw_payloads: list[dict[str, Any]]) -> dict[str, Any]:
    global _LAST_UPSERT_STATS
    if not records:
        _LAST_UPSERT_STATS = {
            "inserted": 0,
            "updated": 0,
            "skipped_as_duplicate": 0,
            "processed": 0,
            "backend": "memory",
        }
        return dict(_LAST_UPSERT_STATS)
    session_factory = get_session_factory()
    inserted = 0
    updated = 0
    skipped = 0
    processed = len(records)
    if session_factory is None:
        for idx, record in enumerate(records):
            raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
            record, raw_payload, _ = sanitize_incident_inputs(record, raw_payload)
            fp = _stable_fingerprint(record, raw_payload)
            existing = _MEMORY_INCIDENTS.get(fp)
            if existing:
                existing_dt = None
                new_dt = record.occurred_at or record.published_at
                try:
                    if existing.get("occurred_at"):
                        existing_dt = datetime.fromisoformat(str(existing.get("occurred_at")).replace("Z", "+00:00"))
                except Exception:
                    existing_dt = None
                if _norm_text(str(existing.get("title") or "")) == _norm_text(record.title) and _diff_minutes(existing_dt, new_dt) <= 25:
                    skipped += 1
                    continue
                _MEMORY_INCIDENTS[fp] = _to_public_dict(record, raw_payload)
                updated += 1
            else:
                _MEMORY_INCIDENTS[fp] = _to_public_dict(record, raw_payload)
                inserted += 1
        _LAST_UPSERT_STATS = {
            "inserted": inserted,
            "updated": updated,
            "skipped_as_duplicate": skipped,
            "processed": processed,
            "backend": "memory",
        }
        return dict(_LAST_UPSERT_STATS)

    try:
        async with session_factory() as session:
            for idx, record in enumerate(records):
                raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
                record, raw_payload, _ = sanitize_incident_inputs(record, raw_payload)
                try:
                    async with session.begin_nested():
                        fps = _all_fingerprint_hashes(record, raw_payload)
                        existing = await _find_existing_row(session, record, raw_payload, fps)
                        if existing is None:
                            session.add(_to_orm(record, raw_payload))
                            await session.flush()
                            inserted += 1
                            continue

                        if _near_duplicate(existing, record, raw_payload):
                            skipped += 1
                            continue
                        if _apply_updates(existing, record):
                            existing.raw_payload = raw_payload
                            await session.flush()
                            updated += 1
                        else:
                            skipped += 1
                except IntegrityError as exc:
                    ctx = _record_log_context(record, raw_payload)
                    exc_text = str(exc.orig) if hasattr(exc, "orig") else str(exc)
                    if "uq_incidents_source_fingerprint" in exc_text:
                        logger.info(
                            "incident_upsert_fingerprint_dup source_name=%s title=%s",
                            ctx["source_name"],
                            ctx["title"],
                        )
                    else:
                        logger.warning(
                            "incident_upsert_integrity_error record_id=%s source_name=%s title=%s constraint=%s",
                            ctx["record_id"],
                            ctx["source_name"],
                            ctx["title"],
                            exc_text[:300],
                        )
                    skipped += 1
                    continue
                except Exception as exc:
                    ctx = _record_log_context(record, raw_payload)
                    logger.warning(
                        "incident_upsert_record_error record_id=%s source_name=%s source_type=%s title=%s source_url=%s error=%s type=%s",
                        ctx["record_id"],
                        ctx["source_name"],
                        ctx["source_type"],
                        ctx["title"],
                        ctx["source_url"],
                        str(exc)[:500],
                        type(exc).__name__,
                    )
                    skipped += 1
                    continue

            await session.commit()
        _LAST_UPSERT_STATS = {
            "inserted": inserted,
            "updated": updated,
            "skipped_as_duplicate": skipped,
            "processed": processed,
            "backend": "postgres",
        }
        return dict(_LAST_UPSERT_STATS)
    except Exception as exc:
        logger.warning(
            "incident_upsert_db_error fallback_to_memory error=%s type=%s",
            str(exc)[:500],
            type(exc).__name__,
        )
        inserted = 0
        skipped = 0
        for idx, record in enumerate(records):
            raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
            record, raw_payload, _ = sanitize_incident_inputs(record, raw_payload)
            fp = _stable_fingerprint(record, raw_payload)
            existing = _MEMORY_INCIDENTS.get(fp)
            if existing:
                skipped += 1
                continue
            _MEMORY_INCIDENTS[fp] = _to_public_dict(record, raw_payload)
            inserted += 1
        _LAST_UPSERT_STATS = {
            "inserted": inserted,
            "updated": 0,
            "skipped_as_duplicate": skipped,
            "processed": processed,
            "backend": "memory",
        }
        return dict(_LAST_UPSERT_STATS)


async def query_incidents(
    *,
    limit: int = 100,
    offset: int = 0,
    municipality: Optional[str] = None,
    incident_type: Optional[str] = None,
    status: Optional[str] = None,
    source_type: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    has_coordinates: Optional[bool] = None,
    verification_level: Optional[str] = None,
    severity: Optional[str] = None,
    tags: Optional[list[str]] = None,
    q: Optional[str] = None,
    sort_by: str = "newest",
) -> list[dict[str, Any]]:
    def _severity_rank(value: str) -> int:
        v = (value or "").lower()
        return {"critical": 4, "high": 3, "medium": 2, "low": 1}.get(v, 0)

    def _verification_rank(value: str) -> int:
        v = (value or "").lower()
        return {"official": 5, "multi_source": 4, "media": 3, "scanner": 2, "inferred": 1}.get(v, 0)

    def _priority_score(item: dict[str, Any]) -> float:
        severity_score = {"critical": 45, "high": 30, "medium": 18, "low": 8}.get(str(item.get("severity") or "").lower(), 4)
        verification_score = {
            "official": 26,
            "multi_source": 22,
            "media": 15,
            "scanner": 9,
            "inferred": 6,
        }.get(str(item.get("verification_level") or "").lower(), 4)
        source_score = {
            "official": 20,
            "open_data": 22,
            "media": 12,
            "scanner": 8,
            "fused": 10,
            "inferred": 8,
        }.get(str(item.get("source_type") or "").lower(), 4)

        tag_bonus = 0
        tset = {str(t).lower() for t in (item.get("tags") or []) if t}
        for tag in tset:
            if "violence" in tag or "violent" in tag:
                tag_bonus += 8
            if "weapon" in tag or "gun" in tag or "firearm" in tag:
                tag_bonus += 8
            if "multi-source" in tag or "multisource" in tag:
                tag_bonus += 6
            if "ongoing" in tag or "active" in tag:
                tag_bonus += 5

        recency_score = 0.0
        dt = _parse_incident_dt(item)
        if dt is not None:
            age_h = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
            if age_h <= 1:
                recency_score = 20.0
            elif age_h <= 6:
                recency_score = 14.0
            elif age_h <= 24:
                recency_score = 8.0
            elif age_h <= 72:
                recency_score = 4.0
            else:
                recency_score = 0.0

        return round(float(severity_score + verification_score + source_score + tag_bonus + recency_score), 2)

    def _human_time(dt: Optional[datetime]) -> str:
        if dt is None:
            return ""
        delta = datetime.now(dt.tzinfo) - dt
        sec = int(delta.total_seconds())
        if sec < 60:
            return "just now"
        minutes = sec // 60
        if minutes < 60:
            return f"{minutes}m ago"
        hours = minutes // 60
        if hours < 24:
            return f"{hours}h ago"
        days = hours // 24
        return f"{days}d ago"

    def _coord_quality(lat: Optional[float], lon: Optional[float], payload: dict[str, Any]) -> str:
        if lat is None or lon is None:
            return "missing"
        src_type = str(
            payload.get("source_type")
            or (payload.get("incident") or {}).get("source_type")
            or payload.get("source_class")
            or (payload.get("raw_payload") or {}).get("source_class")
            or ""
        ).lower()
        if "open_data" in src_type or "official_structured" in src_type:
            return "exact"
        acc = str(payload.get("location_accuracy") or "").lower()
        if acc in ("specific", "exact", "verified"):
            return "exact"
        return "approximate"

    def _decorate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        def _verification_label(v: str) -> str:
            m = (v or "").lower()
            return {
                "official": "Official",
                "multi_source": "Multi-source",
                "media": "Media",
                "scanner": "Scanner",
                "inferred": "Inferred",
            }.get(m, "Unknown")

        def _verification_explanation(v: str) -> str:
            m = (v or "").lower()
            return {
                "official": "Directly reported by an official agency source.",
                "multi_source": "Corroborated by multiple independent sources.",
                "media": "Reported by local media and pending official corroboration.",
                "scanner": "Derived from scanner traffic and not fully confirmed.",
                "inferred": "Inferred from partial signals and should be treated as preliminary.",
            }.get(m, "Verification confidence is currently unknown.")

        def _coordinate_explanation(qv: str) -> str:
            m = (qv or "").lower()
            return {
                "exact": "Coordinates are specific to the incident location.",
                "approximate": "Coordinates are approximate to area-level context, not exact address.",
                "missing": "No reliable coordinates are available for mapping.",
            }.get(m, "Coordinate quality is unknown.")

        def _source_type_label(v: str) -> str:
            m = (v or "").lower()
            return {
                "official": "Official",
                "open_data": "Official Open Data",
                "scanner": "Scanner",
                "media": "Media",
                "fused": "Inferred/Fused",
                "inferred": "Inferred/Fused",
            }.get(m, "Unknown")

        def _source_type_explanation(v: str) -> str:
            m = (v or "").lower()
            return {
                "official": "Published directly by an official public safety source.",
                "open_data": "Structured city open-data record with strong provenance.",
                "scanner": "Derived from live scanner traffic and dispatch monitoring.",
                "media": "Reported by media sources and subject to follow-up verification.",
                "fused": "Combined from multiple signals and inferred context.",
                "inferred": "Combined from multiple signals and inferred context.",
            }.get(m, "Source class is unknown.")

        for it in items:
            it["short_title"] = (it.get("title") or "")[:96]
            it["subtitle"] = " · ".join([p for p in [it.get("source_name"), it.get("municipality")] if p])
            dt = None
            try:
                raw = it.get("occurred_at") or it.get("published_at")
                dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00")) if raw else None
            except Exception:
                dt = None
            it["human_time"] = _human_time(dt)
            it["badges"] = list(it.get("tags") or [])[:5]
            it["coordinate_quality"] = _coord_quality(it.get("latitude"), it.get("longitude"), it.get("raw_payload") or {})
            it["verification_label"] = _verification_label(str(it.get("verification_level") or ""))
            it["verification_explanation"] = _verification_explanation(str(it.get("verification_level") or ""))
            it["coordinate_explanation"] = _coordinate_explanation(str(it.get("coordinate_quality") or ""))
            it["source_type_label"] = _source_type_label(str(it.get("source_type") or ""))
            it["source_type_explanation"] = _source_type_explanation(str(it.get("source_type") or ""))
            it["priority_score"] = _priority_score(it)
            it["is_high_priority"] = bool(it["priority_score"] >= 72)
        return items

    def _mark_trending(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc)
        recent_counts: dict[tuple[str, str], int] = {}
        for it in items:
            dt = _parse_incident_dt(it)
            if dt is None:
                continue
            if (now - dt) > timedelta(hours=24):
                continue
            key = (
                _norm_text(str(it.get("incident_type") or "unknown")),
                _norm_text(str(it.get("municipality") or "unknown")),
            )
            recent_counts[key] = recent_counts.get(key, 0) + 1
        for it in items:
            key = (
                _norm_text(str(it.get("incident_type") or "unknown")),
                _norm_text(str(it.get("municipality") or "unknown")),
            )
            it["is_trending"] = bool(recent_counts.get(key, 0) >= 2)
        return items

    def _apply_post_filters(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = items
        if tags:
            wanted = {_norm_text(t) for t in tags if t}
            if wanted:
                out = [it for it in out if any(_norm_text(tag) in wanted for tag in (it.get("tags") or []))]
        if q:
            needle = _norm_text(q)
            if needle:
                out = [
                    it
                    for it in out
                    if needle in _norm_text(it.get("title") or "")
                    or needle in _norm_text(it.get("description") or "")
                    or needle in _norm_text(it.get("municipality") or "")
                    or needle in _norm_text(it.get("source_name") or "")
                    or needle in _norm_text(it.get("incident_type") or "")
                ]
        mode = (sort_by or "newest").lower()
        if mode == "severity":
            out = sorted(
                out,
                key=lambda it: (_severity_rank(str(it.get("severity") or "")), str(it.get("occurred_at") or it.get("published_at") or "")),
                reverse=True,
            )
        elif mode == "verification":
            out = sorted(
                out,
                key=lambda it: (
                    _verification_rank(str(it.get("verification_level") or "")),
                    str(it.get("occurred_at") or it.get("published_at") or ""),
                ),
                reverse=True,
            )
        elif mode == "priority":
            out = sorted(
                out,
                key=lambda it: (
                    _priority_score(it),
                    str(it.get("occurred_at") or it.get("published_at") or ""),
                ),
                reverse=True,
            )
        else:
            out = sorted(out, key=lambda it: str(it.get("occurred_at") or it.get("published_at") or ""), reverse=True)
        out = _decorate(out)
        out = _mark_trending(out)
        return out

    global _LAST_QUERY_BACKEND
    session_factory = get_session_factory()
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)

    if session_factory is None:
        _LAST_QUERY_BACKEND = "memory"
        rows = list(_MEMORY_INCIDENTS.values())

        def _keep(item: dict[str, Any]) -> bool:
            if _is_scanner_conventional_stored_row(item.get("raw_payload")):
                return False
            if municipality and item.get("municipality") != municipality:
                return False
            if incident_type and item.get("incident_type") != incident_type:
                return False
            if status and item.get("status") != status:
                return False
            if source_type and item.get("source_type") != source_type:
                return False
            if verification_level and item.get("verification_level") != verification_level:
                return False
            if severity and item.get("severity") != severity:
                return False
            if has_coordinates is True and (item.get("latitude") is None or item.get("longitude") is None):
                return False
            if has_coordinates is False and (item.get("latitude") is not None and item.get("longitude") is not None):
                return False
            occurred_raw = item.get("occurred_at")
            occurred_dt = None
            if occurred_raw:
                try:
                    occurred_dt = datetime.fromisoformat(str(occurred_raw).replace("Z", "+00:00"))
                except Exception:
                    occurred_dt = None
            if start_date and (occurred_dt is None or occurred_dt < start_date):
                return False
            if end_date and (occurred_dt is None or occurred_dt > end_date):
                return False
            return True

        filtered = [x for x in rows if _keep(x)]
        filtered = _apply_post_filters(filtered)
        return filtered[offset : offset + limit]

    filters = []
    if municipality:
        filters.append(IncidentORM.municipality == municipality)
    if incident_type:
        filters.append(IncidentORM.incident_type == incident_type)
    if status:
        filters.append(IncidentORM.status == status)
    if source_type:
        filters.append(IncidentORM.source_type == source_type)
    if verification_level:
        filters.append(IncidentORM.verification_level == verification_level)
    if severity:
        filters.append(IncidentORM.severity == severity)
    if has_coordinates is True:
        filters.append(IncidentORM.latitude.is_not(None))
        filters.append(IncidentORM.longitude.is_not(None))
    if has_coordinates is False:
        filters.append(IncidentORM.latitude.is_(None))
        filters.append(IncidentORM.longitude.is_(None))
    if start_date:
        filters.append(IncidentORM.occurred_at >= start_date)
    if end_date:
        filters.append(IncidentORM.occurred_at <= end_date)

    stmt = select(IncidentORM)
    if filters:
        stmt = stmt.where(and_(*filters))
    stmt = stmt.order_by(IncidentORM.occurred_at.desc().nullslast(), IncidentORM.created_at.desc())
    fetch_cap = min(max(limit + offset + 200, 300), 2000)
    stmt = stmt.limit(fetch_cap)

    try:
        async with session_factory() as session:
            rows = (await session.execute(stmt)).scalars().all()
            _LAST_QUERY_BACKEND = "postgres"
            items = [
                {
                    "id": r.id,
                    "external_id": r.external_id,
                    "title": r.title,
                    "description": r.description,
                    "incident_type": r.incident_type,
                    "severity": r.severity,
                    "status": r.status,
                    "source_type": r.source_type,
                    "source_name": r.source_name,
                    "source_url": r.source_url,
                    "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
                    "published_at": r.published_at.isoformat() if r.published_at else None,
                    "municipality": r.municipality,
                    "address_text": r.address_text,
                    "latitude": r.latitude,
                    "longitude": r.longitude,
                    "confidence_score": r.confidence_score,
                    "verification_level": r.verification_level,
                    "tags": r.tags or [],
                    "raw_payload": r.raw_payload or {},
                    "provenance": r.provenance or {},
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                }
                for r in rows
            ]
            items = [it for it in items if not _is_scanner_conventional_stored_row(it.get("raw_payload"))]
            if _MEMORY_INCIDENTS:
                # Include memory fallback writes when DB upserts temporarily fail.
                merged: dict[str, dict[str, Any]] = {str(it.get("id") or ""): it for it in items}
                for it in _MEMORY_INCIDENTS.values():
                    if _is_scanner_conventional_stored_row(it.get("raw_payload")):
                        continue
                    key = str(it.get("id") or "")
                    if key and key not in merged:
                        merged[key] = it
                items = list(merged.values())
            items = _apply_post_filters(items)
            return items[offset : offset + limit]
    except Exception:
        _LAST_QUERY_BACKEND = "memory"
        rows = list(_MEMORY_INCIDENTS.values())
        filtered = rows
        if municipality:
            filtered = [x for x in filtered if x.get("municipality") == municipality]
        if incident_type:
            filtered = [x for x in filtered if x.get("incident_type") == incident_type]
        if status:
            filtered = [x for x in filtered if x.get("status") == status]
        if source_type:
            filtered = [x for x in filtered if x.get("source_type") == source_type]
        if verification_level:
            filtered = [x for x in filtered if x.get("verification_level") == verification_level]
        if severity:
            filtered = [x for x in filtered if x.get("severity") == severity]
        if has_coordinates is True:
            filtered = [x for x in filtered if x.get("latitude") is not None and x.get("longitude") is not None]
        if has_coordinates is False:
            filtered = [x for x in filtered if x.get("latitude") is None or x.get("longitude") is None]
        filtered = [x for x in filtered if not _is_scanner_conventional_stored_row(x.get("raw_payload"))]
        filtered = _apply_post_filters(filtered)
        return filtered[offset : offset + limit]


def incident_store_backend() -> str:
    return _LAST_QUERY_BACKEND


def last_upsert_stats() -> dict[str, Any]:
    return dict(_LAST_UPSERT_STATS)


def _parse_incident_dt(item: dict[str, Any]) -> Optional[datetime]:
    raw = item.get("occurred_at") or item.get("published_at")
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _window_delta(window: str) -> timedelta:
    w = (window or "").strip().lower()
    if w in ("24h", "1d", "day"):
        return timedelta(hours=24)
    if w in ("7d", "week", "weekly"):
        return timedelta(days=7)
    if w in ("30d", "month", "monthly"):
        return timedelta(days=30)
    return timedelta(days=7)


def _group_counts(items: list[dict[str, Any]], key: str, *, top_n: int = 8) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for it in items:
        val = str(it.get(key) or "unknown").strip() or "unknown"
        counts[val] = counts.get(val, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return [{"key": k, "count": v} for k, v in ranked[:top_n]]


def _bucket_daily(items: list[dict[str, Any]], start: datetime, days: int) -> list[dict[str, Any]]:
    slots = {}
    for i in range(days):
        d = (start + timedelta(days=i)).date().isoformat()
        slots[d] = 0
    for it in items:
        dt = _parse_incident_dt(it)
        if not dt:
            continue
        key = dt.date().isoformat()
        if key in slots:
            slots[key] += 1
    return [{"date": d, "count": slots[d]} for d in sorted(slots.keys())]


async def _load_incidents_for_window(start: datetime, end: datetime, *, cap: int = 10000) -> list[dict[str, Any]]:
    session_factory = get_session_factory()
    if session_factory is None:
        rows = list(_MEMORY_INCIDENTS.values())
        out: list[dict[str, Any]] = []
        for r in rows:
            if _is_scanner_conventional_stored_row(r.get("raw_payload")):
                continue
            dt = _parse_incident_dt(r)
            if dt is not None and start <= dt < end:
                out.append(r)
        return out

    stmt = (
        select(IncidentORM)
        .where(
            or_(
                and_(
                    IncidentORM.occurred_at.is_not(None),
                    IncidentORM.occurred_at >= start,
                    IncidentORM.occurred_at < end,
                ),
                and_(
                    IncidentORM.occurred_at.is_(None),
                    IncidentORM.published_at.is_not(None),
                    IncidentORM.published_at >= start,
                    IncidentORM.published_at < end,
                ),
            )
        )
        .order_by(IncidentORM.occurred_at.desc().nullslast(), IncidentORM.created_at.desc())
        .limit(max(100, min(cap, 25000)))
    )
    try:
        async with session_factory() as session:
            rows = (await session.execute(stmt)).scalars().all()
            return [
                {
                    "id": r.id,
                    "incident_type": r.incident_type,
                    "municipality": r.municipality,
                    "source_type": r.source_type,
                    "verification_level": r.verification_level,
                    "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
                    "published_at": r.published_at.isoformat() if r.published_at else None,
                    "latitude": r.latitude,
                    "longitude": r.longitude,
                    "raw_payload": r.raw_payload or {},
                }
                for r in rows
                if not _is_scanner_conventional_stored_row(r.raw_payload or {})
            ]
    except Exception:
        rows = list(_MEMORY_INCIDENTS.values())
        out: list[dict[str, Any]] = []
        for r in rows:
            if _is_scanner_conventional_stored_row(r.get("raw_payload")):
                continue
            dt = _parse_incident_dt(r)
            if dt is not None and start <= dt < end:
                out.append(r)
        return out


async def summarize_incidents(window: str = "7d") -> dict[str, Any]:
    delta = _window_delta(window)
    end = datetime.now(timezone.utc)
    start = end - delta
    prev_start = start - delta

    current_items = await _load_incidents_for_window(start, end)
    previous_items = await _load_incidents_for_window(prev_start, start)

    total = len(current_items)
    prev_total = len(previous_items)
    change = total - prev_total
    pct = (change / prev_total * 100.0) if prev_total > 0 else (100.0 if total > 0 else 0.0)

    coord_counts = {"exact": 0, "approximate": 0, "missing": 0}
    for it in current_items:
        lat = it.get("latitude")
        lon = it.get("longitude")
        if lat is None or lon is None:
            coord_counts["missing"] += 1
            continue
        acc = str((it.get("raw_payload") or {}).get("location_accuracy") or "").lower()
        if acc in ("specific", "exact", "verified"):
            coord_counts["exact"] += 1
        else:
            coord_counts["approximate"] += 1

    return {
        "window": window,
        "start": start.isoformat() + "Z",
        "end": end.isoformat() + "Z",
        "total": total,
        "previous_total": prev_total,
        "delta_count": change,
        "delta_percent": round(pct, 1),
        "groups": {
            "incident_type": _group_counts(current_items, "incident_type"),
            "municipality": _group_counts(current_items, "municipality"),
            "source_type": _group_counts(current_items, "source_type"),
            "verification_level": _group_counts(current_items, "verification_level"),
        },
        "trust": {
            "verification_levels": _group_counts(current_items, "verification_level"),
            "coordinate_quality": [{"key": k, "count": v} for k, v in coord_counts.items()],
            "verification_help": {
                "official": "Directly reported by an official agency source.",
                "multi_source": "Corroborated by multiple independent sources.",
                "media": "Reported by local media and pending official corroboration.",
                "scanner": "Derived from scanner traffic and not fully confirmed.",
                "inferred": "Inferred from partial signals and should be treated as preliminary.",
            },
            "coordinate_help": {
                "exact": "Coordinates are specific to the incident location.",
                "approximate": "Coordinates are approximate to area-level context.",
                "missing": "No reliable coordinates are available.",
            },
        },
    }


async def incident_trends(window: str = "30d") -> dict[str, Any]:
    delta = _window_delta(window)
    end = datetime.now(timezone.utc)
    start = end - delta
    items = await _load_incidents_for_window(start, end)

    days = max(1, int(delta.total_seconds() // 86400))
    daily = _bucket_daily(items, start=start, days=days)
    summary = await summarize_incidents(window=window)
    return {
        "window": window,
        "start": start.isoformat() + "Z",
        "end": end.isoformat() + "Z",
        "total": len(items),
        "series": {
            "daily_counts": daily,
        },
        "top": {
            "incident_type": summary["groups"]["incident_type"],
            "municipality": summary["groups"]["municipality"],
            "source_type": summary["groups"]["source_type"],
            "verification_level": summary["groups"]["verification_level"],
        },
        "delta_count": summary["delta_count"],
        "delta_percent": summary["delta_percent"],
    }

