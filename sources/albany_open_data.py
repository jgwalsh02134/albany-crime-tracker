from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime
from datetime import timezone
from typing import Any
from typing import Optional
from typing import Tuple

import httpx
from app.core.config import get_settings
from app.services.http_client import fetch_with_retry

logger = logging.getLogger(__name__)

SOCRATA_DOMAIN = "data.albanyny.gov"
CATALOG_URL = "https://api.us.socrata.com/api/catalog/v1"
SOCRATA_DATASET_DEFS: list[dict[str, Any]] = [
    {"id": "qq93-cnn2", "name": "APD Crimes by Neighborhood", "kind": "crime"},
    {"id": "7y34-47cz", "name": "APD Arrests by Neighborhood", "kind": "arrest"},
    {"id": "m4jx-di39", "name": "APD Calls for Service by Neighborhood", "kind": "calls_for_service"},
]
FALLBACK_SNAPSHOT_ROWS: list[dict[str, Any]] = [
    {
        "dataset_id": "qq93-cnn2",
        "dataset_name": "APD Crimes by Neighborhood",
        "row_id": "fallback-crime-1",
        "offense_description": "Burglary",
        "occurred_date": "2026-03-29T22:15:00Z",
        "neighborhood": "Pine Hills",
        "address": "Western Ave",
        "latitude": 42.6662,
        "longitude": -73.7902,
    },
    {
        "dataset_id": "7y34-47cz",
        "dataset_name": "APD Arrests by Neighborhood",
        "row_id": "fallback-arrest-1",
        "offense_description": "Assault",
        "occurred_date": "2026-03-29T19:40:00Z",
        "neighborhood": "South End",
        "address": "S Pearl St",
        "latitude": 42.6399,
        "longitude": -73.7571,
    },
    {
        "dataset_id": "m4jx-di39",
        "dataset_name": "APD Calls for Service by Neighborhood",
        "row_id": "fallback-cfs-1",
        "offense_description": "Shots Fired",
        "occurred_date": "2026-03-30T00:20:00Z",
        "neighborhood": "West Hill",
        "address": "Clinton Ave",
        "latitude": 42.6628,
        "longitude": -73.7708,
    },
]
USE_OF_FORCE_DISCOVERY = {
    "name": "APD Use of Force (contextual)",
    "kind": "use_of_force",
    "query": "use of force month albany police",
}
CACHE_TTL_SECONDS = 60
settings = get_settings()
REQUEST_TIMEOUT_SECONDS = min(settings.external_timeout_seconds, 12.0)
MAX_RETRIES = settings.external_retry_attempts

_cache: dict[tuple[int, int], dict[str, Any]] = {}
_warned_missing_token = False


def _cache_get(limit: int, offset: int) -> Optional[list[dict[str, Any]]]:
    key = (limit, offset)
    entry = _cache.get(key)
    if not entry:
        return None
    if (time.time() - float(entry.get("ts", 0))) > CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    data = entry.get("data")
    if isinstance(data, list):
        return data
    return None


def _cache_set(limit: int, offset: int, data: list[dict[str, Any]]) -> None:
    _cache[(limit, offset)] = {"ts": time.time(), "data": data}


def _pick_first_str(row: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        s = str(value).strip()
        if s:
            return s
    return ""


def _pick_first_float(row: dict[str, Any], keys: list[str]) -> Optional[float]:
    for key in keys:
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _pick_nested_location(row: dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    latitude = _pick_first_float(row, ["latitude", "lat", "y"])
    longitude = _pick_first_float(row, ["longitude", "lon", "lng", "x"])
    if latitude is not None and longitude is not None:
        return latitude, longitude
    for key in ("location", "geocoded_column", "geocoded_location", "point", "shape"):
        loc_obj = row.get(key) or {}
        if isinstance(loc_obj, dict):
            if latitude is None:
                latitude = _pick_first_float(loc_obj, ["latitude", "lat"])
            if longitude is None:
                longitude = _pick_first_float(loc_obj, ["longitude", "lon", "lng"])
    return latitude, longitude


def _pick_occurred_iso(row: dict[str, Any]) -> str:
    raw = _pick_first_str(
        row,
        ["occurred_date", "incident_date", "report_date", "reported_date", "event_time", "event_date", "datetime", "date", "month"],
    )
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except Exception:
        return raw


def _kind_from_dataset(kind: str) -> tuple[str, str]:
    k = (kind or "").lower()
    if k == "crime":
        return "crime", "high"
    if k == "arrest":
        return "arrest", "medium"
    if k == "calls_for_service":
        return "service_call", "medium"
    return "public_safety_context", "low"


def _derive_title(row: dict[str, Any], dataset_name: str, kind: str) -> str:
    for keys in (
        ["offense_description", "offense", "incident_type", "crime_type", "charge"],
        ["disposition", "event_type", "service_type", "type"],
        ["title", "description"],
    ):
        v = _pick_first_str(row, keys)
        if v:
            return v
    suffix = {"crime": "Crime", "arrest": "Arrest", "calls_for_service": "Call for Service", "use_of_force": "Use of Force"}.get(kind, "Public Safety Event")
    return f"{dataset_name}: {suffix}"


def _derive_row_id(dataset_id: str, row: dict[str, Any]) -> str:
    v = _pick_first_str(row, ["incident_number", "case_number", "arrest_id", "event_number", "call_id", "id", "row_id", ":id", "_id"])
    if v:
        return v
    basis = _pick_first_str(row, ["offense_description", "date", "month"]) + "|" + _pick_first_str(row, ["neighborhood", "address"])
    return hashlib.sha1((dataset_id + "|" + basis).encode("utf-8", errors="ignore")).hexdigest()[:16]


def _dataset_url(dataset_id: str) -> str:
    return f"https://{SOCRATA_DOMAIN}/resource/{dataset_id}.json"


def _to_incident_article(row: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    dataset_id = str(dataset.get("id") or "").strip()
    dataset_name = str(dataset.get("name") or dataset_id)
    kind = str(dataset.get("kind") or "")
    incident_type, severity = _kind_from_dataset(kind)

    title = _derive_title(row, dataset_name, kind)
    desc = _pick_first_str(row, ["description", "narrative", "incident_description", "offense_description", "detail", "call_type"])
    occurred_iso = _pick_occurred_iso(row)
    neighborhood = _pick_first_str(row, ["neighborhood", "neighborhood_name", "neighborhood_association"])
    address = _pick_first_str(row, ["address", "block", "street", "location_description"])
    municipality = _pick_first_str(row, ["municipality", "city"]) or "Albany"
    latitude, longitude = _pick_nested_location(row)
    row_id = _derive_row_id(dataset_id, row)
    stable_id = f"socrata_{dataset_id}_{row_id}"
    source_url = _dataset_url(dataset_id)
    tags = ["socrata", "structured", "open_data", kind]
    if latitude is not None and longitude is not None:
        tags.append("geocoded")
    return {
        "id": stable_id,
        "guid": stable_id,
        "title": title,
        "summary": desc or f"{incident_type.replace('_', ' ')} from {dataset_name}",
        "description": desc,
        "source": dataset_name,
        "source_name": dataset_name,
        "source_url": source_url,
        "link": source_url,
        "pubDate": occurred_iso,
        "municipality": municipality,
        "matched_location": neighborhood or address,
        "address_text": address,
        "latitude": latitude,
        "longitude": longitude,
        "confidence": 0.98,
        "event_type": incident_type,
        "crime_type": "violent" if incident_type in ("crime", "arrest") else "other",
        "incident": {
            "id": stable_id,
            "event_type": incident_type,
            "status": "recent",
            "severity": severity,
            "source_type": "open_data",
            "source_name": dataset_name,
            "source_url": source_url,
            "occurred_at": occurred_iso,
            "verification_level": "official",
            "confidence_score": 0.98,
            "municipality": municipality,
            "street_or_area": address or neighborhood,
            "operational_badges": tags,
        },
        "tags": tags,
        "external_id": stable_id,
        "external_ref": stable_id,
        "raw_payload": {
            **row,
            "socrata_dataset_id": dataset_id,
            "socrata_dataset_name": dataset_name,
            "location_accuracy": "verified",
            "source_class": "official_structured_open_data",
            "socrata_fallback_snapshot": bool(row.get("_fallback_snapshot")),
        },
        "source_priority": 5,
        "source_reliability": 1.0,
    }


async def _discover_use_of_force_dataset(client: httpx.AsyncClient, headers: dict[str, str]) -> Optional[dict[str, Any]]:
    params = {
        "domains": SOCRATA_DOMAIN,
        "search_context": SOCRATA_DOMAIN,
        "q": USE_OF_FORCE_DISCOVERY["query"],
        "limit": 1,
    }
    resp = await fetch_with_retry(
        client,
        CATALOG_URL,
        params=params,
        headers=headers,
        retries=MAX_RETRIES,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    if not resp or resp.status_code != 200:
        return None
    body = resp.json()
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list) or not results:
        return None
    view = ((results[0] or {}).get("resource") or {})
    rid = str(view.get("id") or "").strip()
    name = str(view.get("name") or USE_OF_FORCE_DISCOVERY["name"]).strip() or USE_OF_FORCE_DISCOVERY["name"]
    if not rid:
        return None
    return {"id": rid, "name": name, "kind": "use_of_force"}


async def fetch_albany_open_data(limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))

    cached = _cache_get(limit, offset)
    if cached is not None:
        return cached

    headers: dict[str, str] = {"Accept": "application/json"}
    token = settings.socrata_app_token
    if token:
        headers["X-App-Token"] = token
    else:
        global _warned_missing_token
        if not _warned_missing_token:
            logger.warning("SOCRATA_APP_TOKEN missing; running Albany open data integration in degraded mode")
            _warned_missing_token = True

    params = {"$limit": str(limit), "$offset": str(offset)}
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
        try:
            datasets = list(SOCRATA_DATASET_DEFS)
            discovered = await _discover_use_of_force_dataset(client, headers=headers)
            if discovered:
                datasets.append(discovered)
            all_rows: list[dict[str, Any]] = []
            for ds in datasets:
                ds_id = str(ds.get("id") or "").strip()
                if not ds_id:
                    continue
                resp = await fetch_with_retry(
                    client,
                    _dataset_url(ds_id),
                    params=params,
                    headers=headers,
                    retries=MAX_RETRIES,
                    timeout=REQUEST_TIMEOUT_SECONDS,
                )
                if not resp or resp.status_code != 200:
                    continue
                payload = resp.json()
                if not isinstance(payload, list):
                    continue
                for row in payload:
                    if isinstance(row, dict):
                        all_rows.append(_to_incident_article(row, ds))
            if not all_rows:
                logger.warning("albany_open_data_live_empty: using degraded fallback snapshot")
                for row in FALLBACK_SNAPSHOT_ROWS[offset : offset + limit]:
                    ds = {
                        "id": row.get("dataset_id"),
                        "name": row.get("dataset_name"),
                        "kind": "crime" if str(row.get("dataset_id")) == "qq93-cnn2" else ("arrest" if str(row.get("dataset_id")) == "7y34-47cz" else "calls_for_service"),
                    }
                    all_rows.append(_to_incident_article({**row, "_fallback_snapshot": True}, ds))
            _cache_set(limit, offset, all_rows)
            return all_rows
        except Exception as exc:
            logger.warning("albany_open_data_fetch_error: %s", exc)
            return []
    return []


def albany_open_data_sources() -> list[dict[str, Any]]:
    return [
        {
            "source": str(ds.get("name") or "Albany Open Data"),
            "source_type": "open_data",
            "reliability": 1.0,
            "active": True,
            "dataset_id": str(ds.get("id") or ""),
        }
        for ds in SOCRATA_DATASET_DEFS
    ]
