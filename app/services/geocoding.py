"""
Mapbox-backed geocoding service for Albany County incidents.

Used as a fallback when the local ALBANY_LOCATIONS dictionary doesn't
match.  Results are cached in-memory (LRU) to avoid burning API credits
on repeated lookups for the same address string.
"""
from __future__ import annotations

import logging
import re
from functools import lru_cache
from typing import Any, Optional, Tuple

from urllib.parse import quote as urlquote

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# Albany County bounding box for biasing + result filtering
_ALBANY_BBOX = (-74.2, 42.35, -73.5, 42.9)  # (min_lon, min_lat, max_lon, max_lat)
_ALBANY_CENTER = (-73.7562, 42.6526)          # lon, lat (City Hall)

# Rate-limit guard: skip geocoding entirely if we've exhausted monthly quota
_consecutive_auth_failures = 0
_MAX_AUTH_FAILURES = 5  # after 5 consecutive 401/403, stop calling


def _strip_address(raw: str) -> str:
    """Normalize an address string for lookup."""
    s = (raw or "").strip()
    # Remove common prefixes from scanner/news text
    s = re.sub(r"^(near|on|at|of|the|block of|area of|vicinity of)\s+", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip()
    return s


@lru_cache(maxsize=2048)
def _cached_geocode(address: str) -> Optional[Tuple[float, float, str]]:
    """
    Synchronous Mapbox forward-geocode with LRU cache.

    Returns (lat, lon, place_name) or None.  Called from the async wrapper
    via the event loop — Mapbox responds quickly enough that a sync call
    inside an async context is acceptable for this use case.
    """
    global _consecutive_auth_failures

    settings = get_settings()
    token = settings.mapbox_token
    if not token:
        return None

    if _consecutive_auth_failures >= _MAX_AUTH_FAILURES:
        return None

    query = _strip_address(address)
    if not query or len(query) < 4:
        return None

    # Add "Albany NY" context if not already present
    q_lower = query.lower()
    if "albany" not in q_lower and "ny" not in q_lower:
        query = f"{query}, Albany, NY"

    try:
        url = "https://api.mapbox.com/geocoding/v5/mapbox.places/" + urlquote(query, safe="") + ".json"
        params = {
            "access_token": token,
            "limit": "1",
            "types": "address,poi,neighborhood,locality,place",
            "bbox": f"{_ALBANY_BBOX[0]},{_ALBANY_BBOX[1]},{_ALBANY_BBOX[2]},{_ALBANY_BBOX[3]}",
            "proximity": f"{_ALBANY_CENTER[0]},{_ALBANY_CENTER[1]}",
        }
        resp = httpx.get(url, params=params, timeout=8.0)

        if resp.status_code in (401, 403):
            _consecutive_auth_failures += 1
            logger.warning("Mapbox auth failure (%d consecutive)", _consecutive_auth_failures)
            return None

        _consecutive_auth_failures = 0  # reset on any non-auth response

        if resp.status_code != 200:
            logger.debug("Mapbox geocode HTTP %d for %r", resp.status_code, query)
            return None

        data = resp.json()
        features = data.get("features") or []
        if not features:
            return None

        feat = features[0]
        center = feat.get("center")  # [lon, lat]
        if not center or len(center) < 2:
            return None

        lon, lat = float(center[0]), float(center[1])

        # Verify result is within Albany County bounds
        if not (_ALBANY_BBOX[0] <= lon <= _ALBANY_BBOX[2] and _ALBANY_BBOX[1] <= lat <= _ALBANY_BBOX[3]):
            logger.debug("Mapbox result outside Albany bounds: %s → (%f, %f)", query, lat, lon)
            return None

        place_name = feat.get("place_name") or query
        return (lat, lon, place_name)

    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        logger.debug("Mapbox geocode network error for %r: %s", query, exc)
        return None
    except Exception as exc:
        logger.warning("Mapbox geocode unexpected error for %r: %s", query, exc)
        return None


async def geocode_address(address: str) -> Optional[dict[str, Any]]:
    """
    Geocode a free-text address to coordinates within Albany County.

    Returns a dict with latitude, longitude, matched_location, coordinate_quality
    or None if no match is found.
    """
    result = _cached_geocode(address)
    if result is None:
        return None

    lat, lon, place_name = result
    return {
        "latitude": lat,
        "longitude": lon,
        "matched_location": place_name,
        "coordinate_quality": "geocoded",
    }


async def geocode_article_mapbox(article: dict[str, Any]) -> dict[str, Any]:
    """
    Try to geocode an article using Mapbox.  Looks at address_text,
    matched_location, and title/description for location hints.

    Returns the article dict augmented with lat/lon if successful,
    or unmodified if geocoding fails or the article already has coordinates.
    """
    # Skip if article already has valid coordinates
    lat = article.get("latitude")
    lon = article.get("longitude")
    if lat is not None and lon is not None:
        try:
            if float(lat) != 0.0 and float(lon) != 0.0:
                return article
        except (TypeError, ValueError):
            pass

    # Try different location fields in priority order
    candidates = []
    for field in ("matched_location", "address_text"):
        val = (article.get(field) or "").strip()
        if val and len(val) >= 4:
            candidates.append(val)

    # Extract location hints from incident metadata
    incident = article.get("incident") or {}
    street = (incident.get("street_or_area") or "").strip()
    if street and len(street) >= 4:
        candidates.append(street)

    for candidate in candidates:
        result = await geocode_address(candidate)
        if result:
            return {
                **article,
                "latitude": result["latitude"],
                "longitude": result["longitude"],
                "matched_location": result["matched_location"],
                "coordinate_quality": result["coordinate_quality"],
            }

    return article


def geocode_cache_stats() -> dict[str, Any]:
    """Return cache hit/miss stats for monitoring."""
    info = _cached_geocode.cache_info()
    return {
        "hits": info.hits,
        "misses": info.misses,
        "size": info.currsize,
        "maxsize": info.maxsize,
        "auth_failures": _consecutive_auth_failures,
    }
