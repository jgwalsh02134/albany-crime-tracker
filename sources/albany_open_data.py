from __future__ import annotations

import time
from typing import Any

import httpx
from app.core.config import get_settings
from app.services.http_client import fetch_with_retry

SOCRATA_URL = "https://data.albanyny.gov/resource/qq93-cnn2.json"
CACHE_TTL_SECONDS = 60
settings = get_settings()
REQUEST_TIMEOUT_SECONDS = min(settings.external_timeout_seconds, 12.0)
MAX_RETRIES = settings.external_retry_attempts

_cache: dict[tuple[int, int], dict[str, Any]] = {}


def _cache_get(limit: int, offset: int) -> list[dict[str, Any]] | None:
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


def _pick_first_float(row: dict[str, Any], keys: list[str]) -> float | None:
    for key in keys:
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    title = _pick_first_str(
        row,
        ["incident_type", "offense_description", "offense", "title", "event_type", "crime_type"],
    )
    description = _pick_first_str(
        row,
        ["description", "narrative", "incident_description", "offense_description", "detail"],
    )
    date = _pick_first_str(row, ["occurred_date", "incident_date", "date", "report_date", "datetime"])
    rid = _pick_first_str(row, ["id", "incident_number", "event_number", "case_number", "row_id"])
    if not rid:
        rid = _pick_first_str(row, [":id"])
    if not rid:
        rid = _pick_first_str(row, ["_id"])

    latitude = _pick_first_float(row, ["latitude", "lat", "y"])
    longitude = _pick_first_float(row, ["longitude", "lon", "lng", "x"])

    # Socrata geolocation objects can appear as nested dicts.
    loc_obj = row.get("location") or row.get("geocoded_column") or {}
    if isinstance(loc_obj, dict):
        if latitude is None:
            latitude = _pick_first_float(loc_obj, ["latitude", "lat"])
        if longitude is None:
            longitude = _pick_first_float(loc_obj, ["longitude", "lon", "lng"])

    return {
        "id": rid or "",
        "title": title or "Albany incident",
        "description": description,
        "date": date,
        "latitude": latitude,
        "longitude": longitude,
        "source": "albany_open_data",
        "raw": row,
    }


async def fetch_albany_open_data(limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))

    cached = _cache_get(limit, offset)
    if cached is not None:
        return cached

    headers: dict[str, str] = {}
    token = settings.socrata_app_token
    if token:
        headers["X-App-Token"] = token

    params = {"$limit": str(limit), "$offset": str(offset)}

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
        try:
            resp = await fetch_with_retry(
                client,
                SOCRATA_URL,
                params=params,
                headers=headers,
                retries=MAX_RETRIES,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            if not resp or resp.status_code != 200:
                return []
            payload = resp.json()
            if not isinstance(payload, list):
                return []
            normalized = [_normalize_row(r) for r in payload if isinstance(r, dict)]
            _cache_set(limit, offset, normalized)
            return normalized
        except Exception:
            return []
    return []
