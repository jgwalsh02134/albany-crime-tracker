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
        "local_places": len(_LOCAL_PLACES),
    }


# =============================================================================
# LOCAL PLACE GAZETTEER — pin incidents WITHOUT burning Mapbox credits / when
# no token is configured. Covers Albany County streets, neighborhoods, towns,
# and landmarks that appear most often in crime/dispatch copy.
# =============================================================================
_LOCAL_PLACES: dict[str, Tuple[float, float]] = {
    # City of Albany neighborhoods
    "downtown albany": (42.6496, -73.7550), "center square": (42.6530, -73.7630),
    "arbor hill": (42.6620, -73.7570), "south end": (42.6400, -73.7530),
    "west hill": (42.6580, -73.7730), "pine hills": (42.6620, -73.7860),
    "north albany": (42.6730, -73.7470), "sheridan hollow": (42.6560, -73.7550),
    "mansion": (42.6440, -73.7560), "park south": (42.6520, -73.7720),
    "washington park": (42.6560, -73.7680), "buckingham pond": (42.6630, -73.7870),
    "helderberg": (42.6360, -73.7830), "delaware avenue": (42.6420, -73.7720),
    # Major City of Albany streets
    "central ave": (42.6630, -73.7970), "central avenue": (42.6630, -73.7970),
    "madison ave": (42.6510, -73.7670), "madison avenue": (42.6510, -73.7670),
    "state street": (42.6510, -73.7560), "pearl street": (42.6500, -73.7520),
    "south pearl": (42.6390, -73.7560), "north pearl": (42.6520, -73.7510),
    "lark street": (42.6550, -73.7630), "western ave": (42.6640, -73.7900),
    "western avenue": (42.6640, -73.7900), "washington ave": (42.6620, -73.7820),
    "clinton avenue": (42.6600, -73.7570), "clinton ave": (42.6600, -73.7570),
    "new scotland ave": (42.6480, -73.7770), "broadway": (42.6570, -73.7510),
    "myrtle avenue": (42.6470, -73.7720), "grand street": (42.6450, -73.7590),
    "morton avenue": (42.6420, -73.7660), "second avenue": (42.6370, -73.7620),
    "livingston avenue": (42.6580, -73.7600), "henry johnson": (42.6580, -73.7650),
    # Albany County municipalities
    "colonie": (42.7179, -73.8340), "loudonville": (42.7000, -73.7680),
    "latham": (42.7470, -73.7570), "cohoes": (42.7743, -73.7001),
    "watervliet": (42.7301, -73.7013), "green island": (42.7440, -73.6920),
    "menands": (42.6900, -73.7240), "bethlehem": (42.5870, -73.8290),
    "delmar": (42.6270, -73.8330), "slingerlands": (42.6420, -73.8650),
    "glenmont": (42.6010, -73.7910), "selkirk": (42.5470, -73.7920),
    "guilderland": (42.6970, -73.9070), "altamont": (42.7010, -74.0340),
    "westmere": (42.6900, -73.8810), "mckownville": (42.6850, -73.8520),
    "voorheesville": (42.6520, -73.9290), "ravena": (42.4810, -73.8110),
    "coeymans": (42.4760, -73.7960), "new scotland": (42.6080, -73.8890),
    "feura bush": (42.5680, -73.8830), "clarksville": (42.5510, -73.9210),
    "berne": (42.6210, -74.1390), "knox": (42.6610, -74.1230),
    "westerlo": (42.5210, -74.0410), "rensselaerville": (42.5230, -74.1530),
    # Landmarks
    "albany medical center": (42.6520, -73.7750), "albany med": (42.6520, -73.7750),
    "ualbany": (42.6860, -73.8240), "university at albany": (42.6860, -73.8240),
    "albany international airport": (42.7480, -73.8030),
    "empire state plaza": (42.6470, -73.7620), "times union center": (42.6480, -73.7480),
}

# Match longer/more-specific names first so "south pearl" beats "pearl".
_LOCAL_PLACE_KEYS = sorted(_LOCAL_PLACES.keys(), key=len, reverse=True)

# Street-address / intersection extraction from free text.
_STREET_RE = re.compile(
    r"\b(\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+"
    r"(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Pl|Place|Ct|Court|Way|Pkwy|Parkway|Ter|Terrace))\b"
)
_INTERSECTION_RE = re.compile(
    r"\b([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?\s+(?:Ave|Avenue|St|Street|Rd|Road|Blvd))"
    r"\s+(?:and|at|&|near)\s+"
    r"([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?\s+(?:Ave|Avenue|St|Street|Rd|Road|Blvd))\b"
)


def _local_lookup(text: str) -> Optional[Tuple[float, float, str]]:
    """Match the text against the local Albany gazetteer (no API call)."""
    low = (text or "").lower()
    for key in _LOCAL_PLACE_KEYS:
        if key in low:
            lat, lon = _LOCAL_PLACES[key]
            return (lat, lon, key.title())
    return None


def _extract_location_candidates(article: dict[str, Any]) -> list[str]:
    """Pull street addresses, intersections, and place hints from an article."""
    out: list[str] = []
    for field in ("matched_location", "address_text"):
        v = (article.get(field) or "").strip()
        if v and len(v) >= 4:
            out.append(v)
    incident = article.get("incident") or {}
    street = (incident.get("street_or_area") or "").strip()
    if street and len(street) >= 4:
        out.append(street)
    blob = f"{article.get('title','')} {article.get('description','') or article.get('summary','')}"
    m = _STREET_RE.search(blob)
    if m:
        out.append(m.group(1))
    mi = _INTERSECTION_RE.search(blob)
    if mi:
        out.append(f"{mi.group(1)} and {mi.group(2)}")
    return out


async def geocode_article_local_first(article: dict[str, Any]) -> dict[str, Any]:
    """Pin an incident using street/intersection/place extraction. Tries the
    local gazetteer first (free, instant), then Mapbox for precise addresses.
    Greatly increases map density vs. the matched_location-only path."""
    lat = article.get("latitude")
    lon = article.get("longitude")
    if lat not in (None, 0, 0.0) and lon not in (None, 0, 0.0):
        return article

    candidates = _extract_location_candidates(article)
    blob = f"{article.get('title','')} {article.get('description','') or article.get('summary','')} {article.get('municipality','')}"

    # 1. Precise street/intersection via Mapbox (when a real address is present).
    for cand in candidates:
        if re.search(r"\d", cand):  # has a number → worth a precise lookup
            result = await geocode_address(cand)
            if result:
                return {**article, "latitude": result["latitude"], "longitude": result["longitude"],
                        "matched_location": result["matched_location"], "coordinate_quality": "geocoded"}

    # 2. Local gazetteer on candidates + full text (free, no token needed).
    for cand in candidates + [blob]:
        hit = _local_lookup(cand)
        if hit:
            return {**article, "latitude": hit[0], "longitude": hit[1],
                    "matched_location": hit[2], "coordinate_quality": "approximate"}

    # 3. Mapbox fallback on any remaining candidate.
    for cand in candidates:
        result = await geocode_address(cand)
        if result:
            return {**article, "latitude": result["latitude"], "longitude": result["longitude"],
                    "matched_location": result["matched_location"], "coordinate_quality": "geocoded"}

    return article
