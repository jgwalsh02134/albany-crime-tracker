from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any
from typing import Optional

from sqlalchemy import and_
from sqlalchemy import select

from app.db.models import IncidentORM
from app.db.session import get_session_factory
from app.models.incident import IncidentRecord

_MEMORY_INCIDENTS: dict[str, dict[str, Any]] = {}
_LAST_QUERY_BACKEND = "memory"


def _stable_fingerprint(record: IncidentRecord, raw_payload: dict[str, Any]) -> str:
    basis = "|".join(
        [
            record.source_name or "",
            record.external_ref or "",
            record.source_url or "",
            (record.published_at.isoformat() if isinstance(record.published_at, datetime) else ""),
            record.title or "",
        ]
    )
    if not basis.strip("|"):
        basis = repr(raw_payload)[:500]
    return hashlib.sha256(basis.encode("utf-8", errors="ignore")).hexdigest()


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


async def upsert_incidents(records: list[IncidentRecord], raw_payloads: list[dict[str, Any]]) -> int:
    if not records:
        return 0
    session_factory = get_session_factory()
    if session_factory is None:
        upserts = 0
        for idx, record in enumerate(records):
            raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
            fp = _stable_fingerprint(record, raw_payload)
            _MEMORY_INCIDENTS[fp] = _to_public_dict(record, raw_payload)
            upserts += 1
        return upserts

    try:
        upserts = 0
        async with session_factory() as session:
            for idx, record in enumerate(records):
                raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
                fp = _stable_fingerprint(record, raw_payload)
                q = select(IncidentORM).where(IncidentORM.source_fingerprint == fp).limit(1)
                existing = (await session.execute(q)).scalar_one_or_none()
                if existing is None:
                    session.add(_to_orm(record, raw_payload))
                    upserts += 1
                    continue

                existing.title = record.title
                existing.description = record.description
                existing.incident_type = record.incident_type
                existing.severity = record.severity
                existing.status = record.status
                existing.source_type = record.source_type
                existing.source_name = record.source_name
                existing.source_url = record.source_url
                existing.occurred_at = record.occurred_at
                existing.published_at = record.published_at
                existing.municipality = record.municipality
                existing.address_text = record.address_text
                existing.latitude = record.latitude
                existing.longitude = record.longitude
                existing.confidence_score = record.confidence_score
                existing.verification_level = record.verification_level
                existing.tags = record.tags
                existing.raw_payload = raw_payload
                upserts += 1

            await session.commit()
        return upserts
    except Exception:
        upserts = 0
        for idx, record in enumerate(records):
            raw_payload = raw_payloads[idx] if idx < len(raw_payloads) else {}
            fp = _stable_fingerprint(record, raw_payload)
            _MEMORY_INCIDENTS[fp] = _to_public_dict(record, raw_payload)
            upserts += 1
        return upserts


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
) -> list[dict[str, Any]]:
    global _LAST_QUERY_BACKEND
    session_factory = get_session_factory()
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
        filtered.sort(key=lambda x: str(x.get("occurred_at") or ""), reverse=True)
        limit = max(1, min(limit, 1000))
        offset = max(0, offset)
        return filtered[offset : offset + limit]

    limit = max(1, min(limit, 1000))
    offset = max(0, offset)

    filters = []
    if municipality:
        filters.append(IncidentORM.municipality == municipality)
    if incident_type:
        filters.append(IncidentORM.incident_type == incident_type)
    if status:
        filters.append(IncidentORM.status == status)
    if source_type:
        filters.append(IncidentORM.source_type == source_type)
    if start_date:
        filters.append(IncidentORM.occurred_at >= start_date)
    if end_date:
        filters.append(IncidentORM.occurred_at <= end_date)

    stmt = select(IncidentORM)
    if filters:
        stmt = stmt.where(and_(*filters))
    stmt = stmt.order_by(IncidentORM.occurred_at.desc().nullslast(), IncidentORM.created_at.desc())
    stmt = stmt.limit(limit).offset(offset)

    try:
        async with session_factory() as session:
            rows = (await session.execute(stmt)).scalars().all()
            _LAST_QUERY_BACKEND = "postgres"
            return [
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
    except Exception:
        # DB unavailable at query-time -> graceful fallback to memory store.
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
        filtered.sort(key=lambda x: str(x.get("occurred_at") or ""), reverse=True)
        return filtered[offset : offset + limit]


def incident_store_backend() -> str:
    return _LAST_QUERY_BACKEND

