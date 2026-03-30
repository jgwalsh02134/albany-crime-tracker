from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from datetime import timedelta
from typing import Any
from typing import Optional

from sqlalchemy import and_
from sqlalchemy import or_
from sqlalchemy import select

from app.db.models import IncidentORM
from app.db.session import get_session_factory
from app.models.incident import IncidentRecord

logger = logging.getLogger(__name__)

_MEMORY_INCIDENTS: dict[str, dict[str, Any]] = {}
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


def _to_orm(record: IncidentRecord, raw_payload: dict[str, Any]) -> IncidentORM:
    return IncidentORM(
        id=record.id,
        external_id=record.external_ref or record.id,
        source_fingerprint=_stable_fingerprint(record, raw_payload),
        title=record.title,
        description=record.description,
        incident_type=record.incident_type,
        severity=record.severity,
        status=record.status,
        source_type=record.source_type,
        source_name=record.source_name,
        source_url=record.source_url,
        occurred_at=record.occurred_at,
        published_at=record.published_at,
        municipality=record.municipality,
        address_text=record.address_text,
        latitude=record.latitude,
        longitude=record.longitude,
        confidence_score=record.confidence_score,
        verification_level=record.verification_level,
        tags=record.tags,
        raw_payload=raw_payload,
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
    _set("source_type", record.source_type)
    _set("source_name", record.source_name)
    _set("source_url", record.source_url)
    _set("occurred_at", record.occurred_at)
    _set("published_at", record.published_at)
    _set("municipality", record.municipality)
    _set("address_text", record.address_text)
    _set("latitude", record.latitude)
    _set("longitude", record.longitude)
    _set("confidence_score", record.confidence_score)
    _set("verification_level", record.verification_level)
    _set("tags", record.tags)
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
                fps = _all_fingerprint_hashes(record, raw_payload)
                fp = fps[0]
                existing = await _find_existing_row(session, record, raw_payload, fps)
                if existing is None:
                    session.add(_to_orm(record, raw_payload))
                    inserted += 1
                    continue

                if _near_duplicate(existing, record, raw_payload):
                    skipped += 1
                    continue
                if _apply_updates(existing, record):
                    existing.raw_payload = raw_payload
                    updated += 1
                else:
                    skipped += 1

            await session.commit()
        _LAST_UPSERT_STATS = {
            "inserted": inserted,
            "updated": updated,
            "skipped_as_duplicate": skipped,
            "processed": processed,
            "backend": "postgres",
        }
        return dict(_LAST_UPSERT_STATS)
    except Exception:
        logger.warning("incident upsert fallback_to_memory")
        inserted = 0
        skipped = 0
        for idx, record in enumerate(records):
            raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
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
        acc = str(payload.get("location_accuracy") or "").lower()
        if acc in ("specific", "exact", "verified"):
            return "exact"
        return "approximate"

    def _decorate(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
        else:
            out = sorted(out, key=lambda it: str(it.get("occurred_at") or it.get("published_at") or ""), reverse=True)
        return out

    global _LAST_QUERY_BACKEND
    session_factory = get_session_factory()
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)

    if session_factory is None:
        _LAST_QUERY_BACKEND = "memory"
        rows = list(_MEMORY_INCIDENTS.values())

        def _keep(item: dict[str, Any]) -> bool:
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
        filtered = _decorate(filtered)
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
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                    "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                }
                for r in rows
            ]
            items = _apply_post_filters(items)
            items = _decorate(items)
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
        filtered = _apply_post_filters(filtered)
        filtered = _decorate(filtered)
        return filtered[offset : offset + limit]


def incident_store_backend() -> str:
    return _LAST_QUERY_BACKEND


def last_upsert_stats() -> dict[str, Any]:
    return dict(_LAST_UPSERT_STATS)

