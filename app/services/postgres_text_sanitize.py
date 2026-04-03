from __future__ import annotations

import logging
from typing import Any

from app.models.incident import IncidentRecord

logger = logging.getLogger(__name__)


def sanitize_str(value: object) -> tuple[str, int]:
    """Remove null bytes from a string destined for Postgres text/varchar/JSON string values."""
    s = "" if value is None else str(value)
    n = s.count("\x00")
    if n == 0:
        return s, 0
    return s.replace("\x00", ""), n


def _deep_sanitize_json(obj: Any) -> tuple[Any, int]:
    if isinstance(obj, str):
        out, n = sanitize_str(obj)
        return out, n
    if isinstance(obj, dict):
        removed = 0
        dirty = False
        new_d: dict[Any, Any] = {}
        for k, v in obj.items():
            key_out, kn = sanitize_str(k) if isinstance(k, str) else (k, 0)
            removed += kn
            if kn or key_out is not k:
                dirty = True
            val_out, vn = _deep_sanitize_json(v)
            removed += vn
            if vn or val_out is not v:
                dirty = True
            new_d[key_out] = val_out
        if not dirty and removed == 0:
            return obj, 0
        return new_d, removed
    if isinstance(obj, list):
        removed = 0
        new_l: list[Any] = []
        dirty = False
        for item in obj:
            item_out, n = _deep_sanitize_json(item)
            removed += n
            new_l.append(item_out)
            if n or item_out is not item:
                dirty = True
        if not dirty:
            return obj, 0
        return new_l, removed
    if isinstance(obj, tuple):
        removed = 0
        items: list[Any] = []
        for item in obj:
            io, n = _deep_sanitize_json(item)
            removed += n
            items.append(io)
        if removed == 0 and len(items) == len(obj) and all(a is b for a, b in zip(items, obj)):
            return obj, 0
        return tuple(items), removed
    return obj, 0


def sanitize_incident_inputs(
    record: IncidentRecord,
    raw_payload: dict[str, Any],
) -> tuple[IncidentRecord, dict[str, Any], int]:
    """
    Return a copy of the incident and payload safe for Postgres (no \\x00 in strings).
    Third element is total null bytes removed across all sanitized strings.
    """
    if not isinstance(raw_payload, dict):
        raw_payload = {}
    removed = 0
    fields_touched: list[str] = []

    def grab(field: str, raw: str) -> str:
        nonlocal removed
        clean, n = sanitize_str(raw)
        if n:
            removed += n
            fields_touched.append(field)
        return clean

    id_v = grab("id", record.id)
    title_v = grab("title", record.title)
    desc_v = grab("description", record.description)
    itype_v = grab("incident_type", record.incident_type)
    sev_v = grab("severity", record.severity)
    stat_v = grab("status", record.status)
    stype_v = grab("source_type", record.source_type)
    sname_v = grab("source_name", record.source_name)
    surl_v = grab("source_url", record.source_url)
    muni_v = grab("municipality", record.municipality)
    addr_v = grab("address_text", record.address_text)
    ver_v = grab("verification_level", record.verification_level)
    ext_v = record.external_ref
    if ext_v is not None:
        ext_clean, n = sanitize_str(ext_v)
        if n:
            removed += n
            fields_touched.append("external_ref")
        ext_v = ext_clean
    geom_v = record.geom_wkt
    if geom_v is not None:
        g_clean, n = sanitize_str(geom_v)
        if n:
            removed += n
            fields_touched.append("geom_wkt")
        geom_v = g_clean

    tags_out = list(record.tags)
    tags_changed = False
    for i, t in enumerate(tags_out):
        t_clean, n = sanitize_str(t)
        if n:
            removed += n
            tags_changed = True
            fields_touched.append(f"tags[{i}]")
        tags_out[i] = t_clean
    if not tags_changed:
        tags_out = record.tags

    payload_out, pr = _deep_sanitize_json(raw_payload)
    removed += pr
    if pr > 0:
        fields_touched.append("raw_payload")

    new_record = record.model_copy(
        update={
            "id": id_v,
            "title": title_v,
            "description": desc_v,
            "incident_type": itype_v,
            "severity": sev_v,  # type: ignore[arg-type]
            "status": stat_v,  # type: ignore[arg-type]
            "source_type": stype_v,  # type: ignore[arg-type]
            "source_name": sname_v,
            "source_url": surl_v,
            "municipality": muni_v,
            "address_text": addr_v,
            "verification_level": ver_v,  # type: ignore[arg-type]
            "tags": tags_out,
            "external_ref": ext_v,
            "geom_wkt": geom_v,
        }
    )

    if removed > 0:
        logger.info(
            "postgres_text_sanitized incident_id=%s null_bytes_removed=%s fields=%s",
            (id_v or title_v or "?")[:120],
            removed,
            ",".join(fields_touched[:40]) + ("..." if len(fields_touched) > 40 else ""),
        )

    return new_record, payload_out if isinstance(payload_out, dict) else {}, removed
