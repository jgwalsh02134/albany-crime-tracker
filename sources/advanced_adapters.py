from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from datetime import timezone
from email.utils import format_datetime
from typing import Any
from typing import Optional

import httpx

from app.core.config import get_settings
from app.models.incident import build_provenance
from app.services.http_client import fetch_with_retry

logger = logging.getLogger(__name__)

ALBANY_BOUNDS = {
    "lat_min": 42.4,
    "lat_max": 42.85,
    "lon_min": -74.1,
    "lon_max": -73.55,
}

ALBANY_MUNICIPALITIES = (
    "albany",
    "colonie",
    "bethlehem",
    "guilderland",
    "cohoes",
    "watervliet",
    "green island",
    "menands",
    "coeymans",
    "new scotland",
    "berne",
    "knox",
    "rensselaerville",
    "westerlo",
    "voorheesville",
    "altamont",
    "ravena",
    "delmar",
    "glenmont",
    "latham",
    "loudonville",
    "slingerlands",
    "selkirk",
    "clarksville",
    "westmere",
    "mckownville",
    "feura bush",
)

ALBANY_ROADWAYS = (
    "i-90",
    "i-87",
    "i-88",
    "i-787",
    "route 5",
    "route 7",
    "route 9w",
    "route 20",
    "ny-5",
    "ny-7",
    "ny-85",
    "us-9",
    "us-20",
    "thruway",
    "northway",
)

RADIOREFERENCE_SOAP_URL = "https://api.radioreference.com/soap2/"
# RadioReference trunk system id (SOAP getTrsTalkgroups)
RADIOREFERENCE_SYSTEM_ID = "8553"

# Albany / Schenectady Counties P25 — curated from RadioReference wiki + on-air SysID/WACN/CTID.
# SOAP calls use radioreference_sid; system_id is the over-the-air P25 system identifier.
SCANNER_ALBANY_P25_MAIN: dict[str, Any] = {
    "source_id": "scanner_albany_p25_main",
    "system_id": 695,
    "wacn": "BEE00",
    "radioreference_sid": "8553",
    "ctid": 1825,
    "confidence_base": 50,
    "priority_talkgroups": [10003, 18301, 10702, 11003, 11702, 10002, 13202],
    "wiki_reference": "RadioReference wiki — Albany/Schenectady Counties P25 (system 695 / WACN BEE00 / RR sid 8553)",
}

# Priority TG hard-seed (fallback when SOAP is empty or fields are sparse). Descriptions follow wiki naming:
# Law 1 = primary county law dispatch; Fire 1 = patched county/agency fire dispatch; etc.
ALBANY_P25_PRIORITY_TG_WIKI_SEED: dict[str, dict[str, Any]] = {
    "10003": {
        "wiki_channel_label": "County Law 1",
        "wiki_description": (
            "Law 1 = Albany County primary law dispatch (county sheriff / wide-area law enforcement dispatch)."
        ),
        "jurisdiction_hint": "Albany County",
        "discipline_hint": "police",
    },
    "18301": {
        "wiki_channel_label": "Police 1",
        "wiki_description": (
            "City of Albany Police 1 — primary municipal law dispatch for the City of Albany."
        ),
        "jurisdiction_hint": "City of Albany",
        "discipline_hint": "police",
    },
    "10702": {
        "wiki_channel_label": "County Fire 1",
        "wiki_description": (
            "Fire 1 = Albany County Fire 1 — patched county / mutual-aid fire dispatch (primary fire calling)."
        ),
        "jurisdiction_hint": "Albany County",
        "discipline_hint": "fire",
    },
    "11003": {
        "wiki_channel_label": "County Law 2",
        "wiki_description": (
            "Albany County Law 2 — secondary county law / operations (complements County Law 1)."
        ),
        "jurisdiction_hint": "Albany County",
        "discipline_hint": "police",
    },
    "11702": {
        "wiki_channel_label": "County Fire 2",
        "wiki_description": (
            "Albany County Fire 2 — secondary county fire operations / tactical fire support."
        ),
        "jurisdiction_hint": "Albany County",
        "discipline_hint": "fire",
    },
    "10002": {
        "wiki_channel_label": "County Law (secondary)",
        "wiki_description": (
            "Albany County law secondary / operations channel (TG 10002 on P25 system 695; wiki-aligned)."
        ),
        "jurisdiction_hint": "Albany County",
        "discipline_hint": "police",
    },
    "13202": {
        "wiki_channel_label": "Albany Fire 1",
        "wiki_description": (
            "City of Albany Fire 1 — primary AFD fire dispatch / fireground (city fire operations)."
        ),
        "jurisdiction_hint": "City of Albany",
        "discipline_hint": "fire",
    },
}

NY511_EVENTS_URL = "https://511ny.org/api/GetEvents"
NY511_CAMERAS_URL = "https://511ny.org/api/GetCameras"

NWS_CAP_FALLBACK_URL = "https://api.weather.gov/alerts/active.atom?area=NY"

ALBANY_ARCGIS_SERVICE_URL = (
    "https://services6.arcgis.com/mBzcjj7yrA6fBe9F/arcgis/rest/services/"
    "Albany_County_Municipalities/FeatureServer"
)
ALBANY_ARCGIS_LAYER_URL = ALBANY_ARCGIS_SERVICE_URL + "/0"
ALBANY_ARCGIS_QUERY_URL = ALBANY_ARCGIS_LAYER_URL + "/query"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _is_albany_point(latitude: Optional[float], longitude: Optional[float]) -> bool:
    if latitude is None or longitude is None:
        return False
    return (
        ALBANY_BOUNDS["lat_min"] <= latitude <= ALBANY_BOUNDS["lat_max"]
        and ALBANY_BOUNDS["lon_min"] <= longitude <= ALBANY_BOUNDS["lon_max"]
    )


def _is_albany_blob(blob: str) -> bool:
    low = (blob or "").lower()
    if "albany county" in low:
        return True
    if any(m in low for m in ALBANY_MUNICIPALITIES):
        return True
    return any(r in low for r in ALBANY_ROADWAYS)


def _pick_first_str(payload: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _pick_first_float(payload: dict[str, Any], keys: list[str]) -> Optional[float]:
    for key in keys:
        value = payload.get(key)
        if value in (None, ""):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_m = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return 2 * radius_m * math.asin(min(1.0, math.sqrt(a)))


def _municipality_from_blob(blob: str) -> str:
    low = (blob or "").lower()
    for muni in sorted(ALBANY_MUNICIPALITIES, key=len, reverse=True):
        if re.search(rf"(?<![a-z0-9]){re.escape(muni)}(?![a-z0-9])", low):
            return muni.title()
    if "albany county" in low:
        return "Albany County"
    return ""


def _severity_from_blob(blob: str) -> str:
    low = (blob or "").lower()
    if any(
        term in low
        for term in (
            "tornado warning",
            "active shooter",
            "mass casualty",
            "evacuate now",
            "take shelter now",
            "catastrophic",
        )
    ):
        return "critical"
    if any(
        term in low
        for term in (
            "warning",
            "closure",
            "flood",
            "dangerous",
            "crash",
            "incident",
            "emergency",
        )
    ):
        return "high"
    return "medium"


def _discipline_from_blob(blob: str) -> str:
    low = (blob or "").lower()
    if any(term in low for term in ("fire", "ems", "rescue", "ambulance", "medical")):
        if any(term in low for term in ("police", "sheriff", "law", "car-to-car", "dispatch")):
            return "multi"
        return "fire_ems" if "fire" in low else "ems"
    if any(term in low for term in ("police", "sheriff", "law", "dispatch", "state police")):
        return "police"
    if any(term in low for term in ("interop", "countywide", "emergency", "mutual aid")):
        return "interop"
    return "other"


_rr_degraded_warned_at: float = 0.0
_rr_soap_blocked_until: float = 0.0
_RR_SOAP_COOLDOWN = 600


def _log_rr_degraded(msg: str, *args: Any) -> None:
    """Rate-limited RadioReference degradation warning — at most once per 10 minutes."""
    global _rr_degraded_warned_at
    now = time.time()
    if (now - _rr_degraded_warned_at) < 600:
        return
    _rr_degraded_warned_at = now
    logger.warning(msg, *args)


def _mark_rr_soap_blocked() -> None:
    global _rr_soap_blocked_until
    _rr_soap_blocked_until = time.time() + _RR_SOAP_COOLDOWN


def _is_rr_soap_blocked() -> bool:
    return time.time() < _rr_soap_blocked_until


class ArcGISAdapter:
    def __init__(self) -> None:
        self._cache: dict[tuple[float, float], dict[str, Any]] = {}
        self._cache_ts: dict[tuple[float, float], float] = {}

    async def lookup_municipality(
        self,
        client: httpx.AsyncClient,
        latitude: Optional[float],
        longitude: Optional[float],
    ) -> dict[str, Any]:
        if latitude is None or longitude is None:
            return {}
        cache_key = (round(latitude, 4), round(longitude, 4))
        cache_age = time.time() - self._cache_ts.get(cache_key, 0.0)
        if cache_key in self._cache and cache_age < 6 * 3600:
            return dict(self._cache[cache_key])

        settings = get_settings()
        params = {
            "f": "json",
            "geometry": json.dumps(
                {
                    "x": longitude,
                    "y": latitude,
                    "spatialReference": {"wkid": 4326},
                }
            ),
            "geometryType": "esriGeometryPoint",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "MUNI_NAME,URL",
            "returnGeometry": "false",
        }
        resp = await fetch_with_retry(
            client,
            ALBANY_ARCGIS_QUERY_URL,
            params=params,
            retries=settings.external_retry_attempts,
            timeout=min(settings.external_timeout_seconds, 12.0),
        )
        if not resp or resp.status_code != 200:
            return {}
        try:
            payload = resp.json()
        except Exception:
            return {}
        features = payload.get("features") if isinstance(payload, dict) else None
        if not isinstance(features, list) or not features:
            return {}
        attrs = features[0].get("attributes") if isinstance(features[0], dict) else None
        if not isinstance(attrs, dict):
            return {}
        result = {
            "municipality": str(attrs.get("MUNI_NAME") or "").strip(),
            "source_url": str(attrs.get("URL") or ALBANY_ARCGIS_LAYER_URL).strip(),
        }
        self._cache[cache_key] = result
        self._cache_ts[cache_key] = time.time()
        return dict(result)


class RadioReferenceWSAdapter:
    def __init__(self) -> None:
        self._cache: dict[str, dict[str, Any]] = {}
        self._cache_ts = 0.0

    def _map_talkgroup(self, tg_data: dict[str, str]) -> dict[str, Any]:
        alpha = str(tg_data.get("alpha") or "").strip()
        description = str(tg_data.get("description") or "").strip()
        tag = str(tg_data.get("tag") or "").strip()
        category = str(tg_data.get("category") or "").strip()
        mode = str(tg_data.get("mode") or "").strip()
        blob = " ".join(x for x in (alpha, description, tag, category) if x)
        municipality = _municipality_from_blob(blob)
        discipline = _discipline_from_blob(blob)
        agency = alpha or tag or category or "RadioReference"
        jurisdiction = municipality or (
            "Albany County" if any(r in blob.lower() for r in ALBANY_ROADWAYS) else ""
        )
        return {
            "alpha": alpha,
            "description": description,
            "tag": tag,
            "category": category,
            "mode": mode,
            "agency": agency,
            "department": agency,
            "municipality": municipality,
            "jurisdiction": jurisdiction,
            "discipline": discipline,
            "provider": "radioreference",
        }

    async def fetch_talkgroups(self, sid: str = RADIOREFERENCE_SYSTEM_ID) -> dict[str, dict[str, Any]]:
        settings = get_settings()
        if not (
            settings.radioreference_api_key
            and settings.radioreference_username
            and settings.radioreference_password
        ):
            return dict(self._cache)
        if self._cache and (time.time() - self._cache_ts) < 3600:
            return dict(self._cache)
        if _is_rr_soap_blocked():
            return dict(self._cache)

        soap_body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:rr="http://api.radioreference.com/soap2/">
  <soap:Body>
    <rr:getTrsTalkgroups>
      <rr:sid>{sid}</rr:sid>
      <rr:authInfo>
        <rr:appKey>{settings.radioreference_api_key}</rr:appKey>
        <rr:username>{settings.radioreference_username}</rr:username>
        <rr:password>{settings.radioreference_password}</rr:password>
        <rr:version>latest</rr:version>
        <rr:style>doc</rr:style>
      </rr:authInfo>
    </rr:getTrsTalkgroups>
  </soap:Body>
</soap:Envelope>"""

        async with httpx.AsyncClient(follow_redirects=True) as client:
            try:
                resp = await fetch_with_retry(
                    client,
                    RADIOREFERENCE_SOAP_URL,
                    method="POST",
                    content=soap_body,
                    headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""},
                    retries=1,
                    timeout=min(settings.external_timeout_seconds, 15.0),
                )
                if not resp or resp.status_code != 200:
                    _mark_rr_soap_blocked()
                    _log_rr_degraded(
                        "radioreference_ws_degraded status=%s — scanner enrichment using wiki/cache fallback (cooldown %ds)",
                        resp.status_code if resp else "none",
                        _RR_SOAP_COOLDOWN,
                    )
                    return dict(self._cache)
                root = ET.fromstring(resp.text)
                mapped: dict[str, dict[str, Any]] = {}
                for element in root.iter():
                    local_name = element.tag.split("}")[-1] if "}" in element.tag else element.tag
                    if local_name not in {"talkgroup", "return", "item"}:
                        continue
                    tg_id = ""
                    tg_data: dict[str, str] = {}
                    for child in list(element):
                        child_name = child.tag.split("}")[-1] if "}" in child.tag else child.tag
                        child_text = str(child.text or "").strip()
                        if child_name in {"tgDec", "tgId", "dec"}:
                            tg_id = child_text
                        elif child_name in {"alpha", "tgAlpha"}:
                            tg_data["alpha"] = child_text
                        elif child_name in {"description", "tgDescr"}:
                            tg_data["description"] = child_text
                        elif child_name in {"tag", "tgTag"}:
                            tg_data["tag"] = child_text
                        elif child_name in {"category", "catName"}:
                            tg_data["category"] = child_text
                        elif child_name == "mode":
                            tg_data["mode"] = child_text
                    if tg_id and tg_data:
                        mapped[tg_id] = self._map_talkgroup(tg_data)
                if mapped:
                    self._cache = mapped
                    self._cache_ts = time.time()
                    logger.info("radioreference_ws_loaded talkgroups=%s", len(mapped))
            except Exception as exc:
                _mark_rr_soap_blocked()
                _log_rr_degraded("radioreference_ws_error: %s — using wiki/cache fallback (cooldown %ds)", exc, _RR_SOAP_COOLDOWN)
        return dict(self._cache)

    def enrich_call(
        self,
        call: dict[str, Any],
        talkgroups: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        tg = str(call.get("talkgroup_num") or call.get("talkgroup") or "").strip()
        mapping = talkgroups.get(tg)
        if not mapping:
            return call
        enriched = dict(call)
        if not enriched.get("talkgroup_tag") and mapping.get("alpha"):
            enriched["talkgroup_tag"] = mapping["alpha"]
        if not enriched.get("talkgroup_description") and mapping.get("description"):
            enriched["talkgroup_description"] = mapping["description"]
        for key in (
            "agency",
            "department",
            "discipline",
            "municipality",
            "jurisdiction",
            "category",
            "tag",
            "mode",
            "provider",
        ):
            rr_key = f"rr_{key}"
            if rr_key not in enriched and key in mapping:
                enriched[rr_key] = mapping[key]
        if not enriched.get("municipality") and mapping.get("municipality"):
            enriched["municipality"] = mapping["municipality"]
        for meta_key in (
            "wiki_channel_label",
            "wiki_description",
            "jurisdiction_hint",
            "discipline_hint",
            "wiki_seeded",
            "priority_talkgroup",
            "rr_row_present",
        ):
            if meta_key in mapping and meta_key not in enriched:
                enriched[meta_key] = mapping[meta_key]
        return enriched


class TalkgroupMapper:
    """
    Merges RadioReference SOAP talkgroup rows with hard-seeded wiki metadata for Albany/Schenectady P25.
    Exposes TGID → agency/jurisdiction hints and priority-TG detection for scanner pipelines.
    """

    def __init__(self, adapter: RadioReferenceWSAdapter) -> None:
        self._adapter = adapter

    @staticmethod
    def registry() -> dict[str, Any]:
        return dict(SCANNER_ALBANY_P25_MAIN)

    @staticmethod
    def wiki_seed() -> dict[str, dict[str, Any]]:
        return dict(ALBANY_P25_PRIORITY_TG_WIKI_SEED)

    def priority_ids(self) -> set[str]:
        return {str(x) for x in (SCANNER_ALBANY_P25_MAIN.get("priority_talkgroups") or [])}

    def merge_rr_with_wiki(self, rr: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """Overlay wiki seed on SOAP rows; inject seed-only TGs if RR omitted them."""
        pri = self.priority_ids()
        seed = self.wiki_seed()
        out: dict[str, dict[str, Any]] = {}

        for tg_id, meta in (rr or {}).items():
            tid = str(tg_id).strip()
            if not tid:
                continue
            merged = dict(meta)
            w = seed.get(tid)
            if w:
                merged.update(w)
                merged["wiki_seeded"] = True
                jur = str(w.get("jurisdiction_hint") or "")
                if jur and not merged.get("municipality"):
                    merged["municipality"] = jur
                    merged["jurisdiction"] = jur
            merged["priority_talkgroup"] = tid in pri
            merged["rr_row_present"] = True
            out[tid] = merged

        for tid, w in seed.items():
            if tid in out:
                continue
            tg_data = {
                "alpha": str(w.get("wiki_channel_label") or ""),
                "description": str(w.get("wiki_description") or ""),
                "tag": str(w.get("discipline_hint") or ""),
                "category": str(w.get("jurisdiction_hint") or ""),
                "mode": "",
            }
            row = dict(self._adapter._map_talkgroup(tg_data))
            row.update(w)
            row["wiki_seeded"] = True
            row["rr_row_present"] = False
            row["priority_talkgroup"] = tid in pri
            jur = str(w.get("jurisdiction_hint") or "")
            if jur:
                row["municipality"] = jur
                row["jurisdiction"] = jur
            out[tid] = row

        for tid, row in out.items():
            row.setdefault("priority_talkgroup", tid in pri)
        return out

    async def get_merged_talkgroups(self, sid: str = RADIOREFERENCE_SYSTEM_ID) -> dict[str, dict[str, Any]]:
        try:
            rr = await self._adapter.fetch_talkgroups(sid=sid)
        except Exception:
            rr = {}
        return self.merge_rr_with_wiki(rr)

    @staticmethod
    def confidence_01(call: dict[str, Any], row: Optional[dict[str, Any]] = None) -> float:
        """Map wiki confidence_base (0–100) into article confidence with RR / emergency boosts."""
        base_pct = int(SCANNER_ALBANY_P25_MAIN.get("confidence_base") or 50)
        c = max(0.05, min(0.95, base_pct / 100.0))
        r = row or {}
        if r.get("rr_row_present"):
            c = min(0.93, c + 0.12)
        if r.get("wiki_seeded"):
            c = min(0.94, c + 0.03)
        if call.get("emergency") or call.get("is_emergency"):
            c = min(0.96, c + 0.08)
        return round(c, 3)


class NY511Adapter:
    def __init__(self, arcgis_adapter: ArcGISAdapter) -> None:
        self.arcgis_adapter = arcgis_adapter

    async def _fetch_json(
        self,
        client: httpx.AsyncClient,
        url: str,
        params: dict[str, str],
    ) -> Any:
        settings = get_settings()
        resp = await fetch_with_retry(
            client,
            url,
            params=params,
            retries=settings.external_retry_attempts,
            timeout=min(settings.external_timeout_seconds, 15.0),
        )
        if not resp or resp.status_code != 200:
            return None
        try:
            return resp.json()
        except Exception:
            return None

    def _normalize_cameras(self, payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return [x for x in payload if isinstance(x, dict)]
        if isinstance(payload, dict):
            for key in ("cameras", "Cameras", "items", "Items"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [x for x in value if isinstance(x, dict)]
        return []

    def _normalize_events(self, payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return [x for x in payload if isinstance(x, dict)]
        if isinstance(payload, dict):
            for key in ("events", "Events", "items", "Items"):
                value = payload.get(key)
                if isinstance(value, list):
                    return [x for x in value if isinstance(x, dict)]
        return []

    def _is_albany_event(self, event: dict[str, Any]) -> bool:
        county = str(event.get("CountyName") or event.get("county") or "").strip().lower()
        roadway = str(event.get("RoadwayName") or event.get("roadway") or "").strip().lower()
        description = str(event.get("Description") or event.get("description") or "").strip().lower()
        latitude = _pick_first_float(event, ["Latitude", "latitude"])
        longitude = _pick_first_float(event, ["Longitude", "longitude"])
        if county in {"albany", "albany county"}:
            return True
        if any(r in roadway for r in ALBANY_ROADWAYS):
            return True
        if _is_albany_point(latitude, longitude):
            return True
        return _is_albany_blob(" ".join((roadway, description)))

    def _correlate_cameras(
        self,
        event: dict[str, Any],
        cameras: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        latitude = _pick_first_float(event, ["Latitude", "latitude"])
        longitude = _pick_first_float(event, ["Longitude", "longitude"])
        roadway = str(event.get("RoadwayName") or event.get("roadway") or "").strip().lower()
        scored: list[tuple[float, dict[str, Any]]] = []
        for camera in cameras:
            cam_lat = _pick_first_float(camera, ["Latitude", "latitude"])
            cam_lon = _pick_first_float(camera, ["Longitude", "longitude"])
            cam_roadway = str(
                camera.get("RoadwayName") or camera.get("roadway") or camera.get("Name") or ""
            ).strip().lower()
            same_roadway = bool(roadway and cam_roadway and roadway in cam_roadway)
            if latitude is not None and longitude is not None and cam_lat is not None and cam_lon is not None:
                distance_m = _haversine_m(latitude, longitude, cam_lat, cam_lon)
                if distance_m <= 2500 or same_roadway:
                    scored.append((distance_m, camera))
            elif same_roadway:
                scored.append((0.0, camera))
        scored.sort(key=lambda item: item[0])
        return [camera for _, camera in scored[:3]]

    async def fetch_rows(self, limit_per_source: int = 60) -> list[dict[str, Any]]:
        settings = get_settings()
        params = {"format": "json"}
        if settings.ny_511_api_key:
            params["key"] = settings.ny_511_api_key

        async with httpx.AsyncClient(timeout=settings.external_timeout_seconds, follow_redirects=True) as client:
            events_payload, cameras_payload = await asyncio.gather(
                self._fetch_json(client, NY511_EVENTS_URL, params),
                self._fetch_json(client, NY511_CAMERAS_URL, params),
            )
            events = self._normalize_events(events_payload)
            cameras = self._normalize_cameras(cameras_payload)
            rows: list[dict[str, Any]] = []
            for event in events:
                if not self._is_albany_event(event):
                    continue
                event_type = _pick_first_str(event, ["EventType", "event_type"])
                roadway = _pick_first_str(event, ["RoadwayName", "roadway"])
                direction = _pick_first_str(event, ["DirectionOfTravel", "direction"])
                description = _pick_first_str(event, ["Description", "description"])
                location = _pick_first_str(event, ["Location", "PrimaryLocation", "location"])
                county = _pick_first_str(event, ["CountyName", "county"])
                event_id = _pick_first_str(event, ["ID", "id"]) or hashlib.sha1(
                    json.dumps(event, sort_keys=True).encode("utf-8", errors="ignore")
                ).hexdigest()[:16]
                latitude = _pick_first_float(event, ["Latitude", "latitude"])
                longitude = _pick_first_float(event, ["Longitude", "longitude"])
                municipality = county.replace(" County", "").replace(" county", "").title()
                if not municipality and _is_albany_point(latitude, longitude):
                    arcgis = await self.arcgis_adapter.lookup_municipality(client, latitude, longitude)
                    municipality = str(arcgis.get("municipality") or "")
                nearby_cameras = self._correlate_cameras(event, cameras)
                camera_urls = [
                    _pick_first_str(camera, ["VideoUrl", "Url", "videoUrl", "url"])
                    for camera in nearby_cameras
                ]
                camera_urls = [x for x in camera_urls if x]
                title_parts = [x for x in (event_type, roadway, direction) if x]
                title = " — ".join(title_parts) if title_parts else "511NY Traffic Event"
                if camera_urls:
                    description = (
                        (description or location or title)
                        + f" Nearby cameras: {len(camera_urls)}."
                    )
                severity_raw = _pick_first_str(event, ["Severity", "severity"]).lower()
                pub_date = _pick_first_str(event, ["Reported", "StartDate", "reported"]) or format_datetime(_now_utc())
                row_id = f"511ny_full_{event_id}"
                rows.append(
                    {
                        "id": row_id,
                        "guid": row_id,
                        "title": title,
                        "summary": description or location or title,
                        "description": description or location,
                        "link": f"https://511ny.org/map#EventId={event_id}",
                        "source": "511NY Full API",
                        "source_name": "511NY Full API",
                        "source_url": NY511_EVENTS_URL,
                        "pubDate": pub_date,
                        "confidence": 0.96,
                        "event_type": "traffic_incident",
                        "municipality": municipality or "Albany County",
                        "matched_location": location or municipality or roadway,
                        "latitude": latitude,
                        "longitude": longitude,
                        "_511_incident": True,
                        "incident": {
                            "id": row_id,
                            "event_type": "traffic_incident",
                            "status": "active" if severity_raw in {"major", "critical", "high"} else "recent",
                            "severity": "high" if severity_raw in {"major", "critical", "high"} else "medium",
                            "source_type": "official_alerts",
                            "source_name": "511NY Full API",
                            "source_url": NY511_EVENTS_URL,
                            "verification_level": "official",
                            "confidence_score": 0.96,
                            "municipality": municipality or "Albany County",
                            "operational_badges": [
                                "tier1",
                                "official",
                                "official_updates",
                                "tier_1",
                                "511",
                                "cameras" if camera_urls else "events_only",
                            ],
                        },
                        "raw_payload": {
                            "source_class": "official_structured_or_press",
                            "trust_tier": "tier_1",
                            "lane": "official_updates",
                            "ingestion": "511ny_full",
                            "events_endpoint": NY511_EVENTS_URL,
                            "cameras_endpoint": NY511_CAMERAS_URL,
                            "camera_count": len(camera_urls),
                            "camera_urls": camera_urls,
                            "camera_names": [
                                _pick_first_str(camera, ["Name", "name", "RoadwayName"])
                                for camera in nearby_cameras
                            ],
                            "event": {k: str(v)[:300] for k, v in event.items() if v is not None},
                        },
                        "provenance": build_provenance(
                            source_class="official_structured_or_press",
                            source_id="511ny-events",
                            trust_tier="tier_1",
                            lane="official_updates",
                            ingestion_method="json_api",
                            feed_url=NY511_EVENTS_URL,
                            captured_at=datetime.now(timezone.utc).isoformat(),
                            content_type="json_api_row",
                            capture_method="511ny_full_api",
                        ),
                        "source_priority": 5,
                        "source_reliability": 1.0,
                    }
                )
                if len(rows) >= max(1, limit_per_source):
                    break
        return rows


class IPAWSAdapter:
    async def fetch_rows(self, limit_per_source: int = 20) -> list[dict[str, Any]]:
        settings = get_settings()
        headers = {
            "Accept": "application/atom+xml, application/xml, text/xml",
            "User-Agent": "Albany Crime Tracker / IPAWS fallback",
        }
        async with httpx.AsyncClient(timeout=settings.external_timeout_seconds, follow_redirects=True) as client:
            resp = await fetch_with_retry(
                client,
                NWS_CAP_FALLBACK_URL,
                headers=headers,
                retries=settings.external_retry_attempts,
                timeout=min(settings.external_timeout_seconds, 15.0),
            )
            if not resp or resp.status_code != 200:
                return []
            try:
                root = ET.fromstring(resp.text)
            except Exception as exc:
                logger.warning("ipaws_cap_parse_error: %s", exc)
                return []

            rows: list[dict[str, Any]] = []
            ns = {"atom": "http://www.w3.org/2005/Atom"}
            entries = root.findall(".//atom:entry", ns)
            for entry in entries:
                title = (entry.findtext("atom:title", default="", namespaces=ns) or "").strip()
                summary = (entry.findtext("atom:summary", default="", namespaces=ns) or "").strip()
                updated = (entry.findtext("atom:updated", default="", namespaces=ns) or "").strip()
                link = ""
                link_elem = entry.find("atom:link", ns)
                if link_elem is not None:
                    link = str(link_elem.get("href") or "").strip()
                blob = " ".join(x for x in (title, summary) if x)
                if not _is_albany_blob(blob):
                    continue
                municipality = _municipality_from_blob(blob) or "Albany County"
                severity = _severity_from_blob(blob)
                event_hash = hashlib.sha1(
                    ("|".join((title, updated, link))).encode("utf-8", errors="ignore")
                ).hexdigest()[:16]
                row_id = f"ipaws_cap_{event_hash}"
                rows.append(
                    {
                        "id": row_id,
                        "guid": row_id,
                        "title": title or "IPAWS / NWS Alert",
                        "summary": summary or title,
                        "description": summary,
                        "link": link or NWS_CAP_FALLBACK_URL,
                        "source": "IPAWS CAP / NWS Fallback",
                        "source_name": "IPAWS CAP / NWS Fallback",
                        "source_url": NWS_CAP_FALLBACK_URL,
                        "pubDate": updated or format_datetime(_now_utc()),
                        "confidence": 0.90,
                        "event_type": "public_alert",
                        "municipality": municipality,
                        "matched_location": municipality,
                        "incident": {
                            "id": row_id,
                            "event_type": "public_alert",
                            "status": "active",
                            "severity": severity,
                            "source_type": "official_alerts",
                            "source_name": "IPAWS CAP / NWS Fallback",
                            "source_url": NWS_CAP_FALLBACK_URL,
                            "verification_level": "official",
                            "confidence_score": 0.90,
                            "municipality": municipality,
                            "operational_badges": [
                                "tier1",
                                "official",
                                "official_updates",
                                "tier_1",
                                "cap_feed",
                            ],
                        },
                        "raw_payload": {
                            "source_class": "official_cap_feed",
                            "trust_tier": "tier_1",
                            "lane": "official_updates",
                            "ingestion": "ipaws_cap",
                            "fallback_feed": NWS_CAP_FALLBACK_URL,
                            "entry_title": title,
                            "entry_summary": summary,
                        },
                        "provenance": build_provenance(
                            source_class="official_cap_feed",
                            source_id="ipaws-cap-nws",
                            trust_tier="tier_1",
                            lane="official_updates",
                            ingestion_method="atom_feed",
                            feed_url=NWS_CAP_FALLBACK_URL,
                            captured_at=datetime.now(timezone.utc).isoformat(),
                            content_type="cap_alert",
                            capture_method="ipaws_cap_atom",
                        ),
                        "source_priority": 5,
                        "source_reliability": 0.90,
                    }
                )
                if len(rows) >= max(1, limit_per_source):
                    break
        return rows


_ARCGIS_ADAPTER = ArcGISAdapter()
_RADIOREFERENCE_WS_ADAPTER = RadioReferenceWSAdapter()
_TALKGROUP_MAPPER = TalkgroupMapper(_RADIOREFERENCE_WS_ADAPTER)
_NY511_ADAPTER = NY511Adapter(_ARCGIS_ADAPTER)
_IPAWS_ADAPTER = IPAWSAdapter()


def get_arcgis_adapter() -> ArcGISAdapter:
    return _ARCGIS_ADAPTER


def get_radioreference_ws_adapter() -> RadioReferenceWSAdapter:
    return _RADIOREFERENCE_WS_ADAPTER


def get_talkgroup_mapper() -> TalkgroupMapper:
    return _TALKGROUP_MAPPER


def get_511_adapter() -> NY511Adapter:
    return _NY511_ADAPTER


def get_ipaws_adapter() -> IPAWSAdapter:
    return _IPAWS_ADAPTER


def radioreference_runtime_status() -> dict[str, Any]:
    adapter = _RADIOREFERENCE_WS_ADAPTER
    blocked = _is_rr_soap_blocked()
    has_cache = bool(adapter._cache)
    return {
        "soap_blocked": blocked,
        "soap_cooldown_seconds": _RR_SOAP_COOLDOWN,
        "cache_populated": has_cache,
        "cache_talkgroup_count": len(adapter._cache),
        "status": "degraded_soap_blocked" if blocked else ("live" if has_cache else "wiki_fallback_only"),
    }
