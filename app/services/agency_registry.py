"""Canonical Albany-County agency authority registry.

Reads data/agencies.json (the structured authority reference file) and
exposes typed accessors that the rest of ACT can use without each call site
re-parsing the JSON or duplicating string lists.

The JSON file is the source of truth — adding/renaming an agency there
flows through to every consumer automatically.

Loader is process-cached via lru_cache; in tests, call `reset_cache()`
between cases that mutate the file.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Optional


_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_AGENCIES_PATH = os.path.join(_REPO_ROOT, "data", "agencies.json")
_SCANNER_ALIASES_PATH = os.path.join(_REPO_ROOT, "data", "scanner_aliases.json")


def _norm(value: str) -> str:
    return " ".join((value or "").lower().strip().split())


@lru_cache(maxsize=1)
def load_agencies() -> dict[str, Any]:
    """Return the parsed agencies.json document. Cached after first read."""
    with open(_AGENCIES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def reset_cache() -> None:
    """Drop the cached parse — used by tests that touch the JSON file."""
    load_agencies.cache_clear()
    load_scanner_aliases.cache_clear()


@lru_cache(maxsize=1)
def load_scanner_aliases() -> dict[str, Any]:
    """Return the parsed data/scanner_aliases.json document. Cached after
    first read. Defensive — returns an empty mapping if the file is missing
    or malformed so callers never crash on startup."""
    try:
        with open(_SCANNER_ALIASES_PATH, "r", encoding="utf-8") as f:
            doc = json.load(f)
        if not isinstance(doc, dict):
            return {"talkgroups": {}}
        if "talkgroups" not in doc or not isinstance(doc["talkgroups"], dict):
            doc["talkgroups"] = {}
        return doc
    except (OSError, json.JSONDecodeError):
        return {"talkgroups": {}}


def talkgroup_id_to_agency(talkgroup_id: Any) -> Optional[dict[str, Any]]:
    """Resolve a numeric scanner talkgroup ID (e.g. "13102") to a canonical
    agency record by joining data/scanner_aliases.json (which maps the
    talkgroup id → human agency string like "Albany Police") through
    resolve_agency() (which maps that string → canonical record).

    Returns None when the talkgroup is unknown to scanner_aliases.json or
    when the agency string does not map to a canonical entry. Both halves
    are defensive: missing files / bad keys / unknown agencies all fall
    through to None instead of raising.
    """
    if talkgroup_id is None:
        return None
    key = str(talkgroup_id).strip()
    if not key:
        return None
    aliases = load_scanner_aliases().get("talkgroups") or {}
    entry = aliases.get(key)
    if not isinstance(entry, dict):
        return None
    agency_string = str(entry.get("agency") or "").strip()
    if not agency_string:
        return None
    return resolve_agency(agency_string)


def talkgroup_mapping_coverage() -> dict[str, int]:
    """Stats on how completely scanner_aliases.json maps to canonical
    agencies. Surfaced via /api/sources/health so we can measure the
    integration quality over time and identify talkgroups that need a
    new alias entry or a new agency record.

    Keys:
      total              — count of talkgroups in scanner_aliases.json
      canonical_resolved — count whose agency string resolves to a record
      unmapped           — total - canonical_resolved
    """
    aliases = load_scanner_aliases().get("talkgroups") or {}
    total = 0
    resolved = 0
    for _tg_id, entry in aliases.items():
        if not isinstance(entry, dict):
            continue
        total += 1
        agency_string = str(entry.get("agency") or "").strip()
        if agency_string and resolve_agency(agency_string) is not None:
            resolved += 1
    return {
        "total": total,
        "canonical_resolved": resolved,
        "unmapped": total - resolved,
    }


def all_agencies() -> list[dict[str, Any]]:
    return list(load_agencies().get("agencies") or [])


def agency_by_id(agency_id: str) -> Optional[dict[str, Any]]:
    aid = (agency_id or "").strip().lower()
    if not aid:
        return None
    for a in all_agencies():
        if str(a.get("agency_id") or "").lower() == aid:
            return a
    return None


def populous_municipality_set() -> frozenset[str]:
    """Lowercased set of populous Albany-County municipalities. Used by the
    Live clusterer to decide which munis get strict thresholds vs the
    relaxed small-muni path."""
    raw = load_agencies().get("populous_municipalities") or []
    return frozenset(_norm(x) for x in raw if x)


def albany_county_municipality_set() -> frozenset[str]:
    """Lowercased set of every Albany-County municipality / hamlet name we
    care to recognize as a locality anchor."""
    raw = load_agencies().get("albany_county_municipalities") or []
    return frozenset(_norm(x) for x in raw if x)


def _agency_text_anchors(a: dict[str, Any]) -> list[str]:
    """All lowercase strings that appearing in source text would constitute
    strong evidence of an Albany-County agency (and therefore of locality).
    Includes canonical name, short name, and every declared alias."""
    out: list[str] = []
    for key in ("canonical_name", "short_name"):
        v = _norm(str(a.get(key) or ""))
        if v:
            out.append(v)
    for alias in (a.get("aliases") or []):
        v = _norm(str(alias or ""))
        if v:
            out.append(v)
    return out


def agency_alias_anchors(*, only_albany_county_primary: bool = False) -> frozenset[str]:
    """Every agency name/alias as a flat lowercase set, suitable for use as
    a locality-anchor source.

    With only_albany_county_primary=True, restricts to agencies whose
    is_albany_county_primary flag is true — i.e. day-to-day responders
    rather than federal task forces or single-property campus security.
    """
    out: set[str] = set()
    for a in all_agencies():
        if only_albany_county_primary and not a.get("is_albany_county_primary"):
            continue
        out.update(_agency_text_anchors(a))
    return frozenset(out)


def operational_live_agency_anchors() -> frozenset[str]:
    """Agency anchors restricted to is_operational_live_relevant=True. Used
    when the consumer specifically wants entities that produce live scanner /
    incident traffic, not disambiguation-only entries."""
    out: set[str] = set()
    for a in all_agencies():
        if not a.get("is_operational_live_relevant"):
            continue
        out.update(_agency_text_anchors(a))
    return frozenset(out)


def municipality_to_primary_agency() -> dict[str, str]:
    """Lowercased municipality → agency_id of the first municipal-police
    primary responder declared in the file. Useful for normalizing
    "incident in X" → which dispatching agency owns it."""
    out: dict[str, str] = {}
    for a in all_agencies():
        muni = _norm(str(a.get("municipality") or ""))
        if not muni:
            continue
        if a.get("agency_type") not in ("municipal_police", "county_sheriff"):
            continue
        if not a.get("is_albany_county_primary"):
            continue
        out.setdefault(muni, str(a.get("agency_id") or ""))
    # Backstop: every Albany County muni with no dedicated PD defaults to ACSO.
    for muni in albany_county_municipality_set():
        out.setdefault(muni, "acso")
    return out


def resolve_agency(text: str) -> Optional[dict[str, Any]]:
    """Best-effort lookup: given a free-text agency string from a feed
    (e.g. "Bethlehem PD" / "albany police" / "ECO"), return the matching
    agency record or None.

    Preference order:
      1. exact short_name match (case-insensitive),
      2. exact canonical_name match,
      3. alias contains-match (substring of the normalized text),
      4. canonical/short name as a substring of the text (catches
         "Bethlehem PD on scene" → bethlehem_pd),
      5. None.
    """
    needle = _norm(text)
    if not needle:
        return None
    for a in all_agencies():
        if _norm(str(a.get("short_name") or "")) == needle:
            return a
    for a in all_agencies():
        if _norm(str(a.get("canonical_name") or "")) == needle:
            return a
    for a in all_agencies():
        for alias in (a.get("aliases") or []):
            an = _norm(str(alias))
            if an and (an == needle or an in needle):
                return a
    for a in all_agencies():
        sn = _norm(str(a.get("short_name") or ""))
        if sn and sn in needle:
            return a
        cn = _norm(str(a.get("canonical_name") or ""))
        if cn and cn in needle:
            return a
    return None


# Talkgroup-tag fields scanner adapters set when ingesting calls from
# RadioReference, Broadcastify, or OpenMHz. Used to derive an agency
# without re-implementing per-source logic in api_server.
_CALL_TALKGROUP_FIELDS = (
    "talkgroup_tag",
    "talkgroup_description",
    "tgAlpha",
    "tgDescr",
    "talkgroupAlpha",
    "talkgroupDescription",
    "feed_name",
    "channel",
    "source",
)


def resolve_agency_from_call(call: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Best-effort agency resolution for a scanner call dict.

    Two-stage lookup:
      1. Walk the known talkgroup-tag fields scanner adapters populate
         (talkgroup_tag, talkgroup_description, etc.) — fastest path,
         catches RR / OpenMHz / Broadcastify-enriched calls.
      2. Fall back to the numeric talkgroup ID via scanner_aliases.json,
         so calls that arrive with only a `talkgroup_num` (no tag) still
         resolve. Closes the gap for scanner systems that don't surface
         human-readable tags directly.

    Defensive against non-dict input — returns None instead of raising.
    """
    if not isinstance(call, dict):
        return None
    for field in _CALL_TALKGROUP_FIELDS:
        v = call.get(field)
        if not v:
            continue
        a = resolve_agency(str(v))
        if a:
            return a
    # Numeric talkgroup ID fallback. Common keys used across adapters.
    for tg_field in ("talkgroup_num", "talkgroupID", "talkgroup", "tg"):
        tg = call.get(tg_field)
        if tg in (None, ""):
            continue
        a = talkgroup_id_to_agency(tg)
        if a:
            return a
    return None


def canonical_source_for_fingerprint(source_name: str) -> str:
    """Return a stable lowercased canonical token for a source/agency string.

    Used by incident_repository._candidate_fingerprints to normalize
    duplicate-spelling cases at dedupe time:
        "Albany PD" -> "apd"
        "Albany Police" -> "apd"
        "City of Albany Police Department" -> "apd"
        "APD" -> "apd"
    Sources that do not resolve to a canonical agency (Times Union, FBI
    Albany News, etc.) pass through with simple normalization so their
    fingerprints remain stable across runs.

    The function is pure and defensive: never raises, always returns a
    string. Callers can trust it as a 1:1 replacement for _norm_text on
    the source_name field.
    """
    raw = (source_name or "").strip()
    if not raw:
        return ""
    try:
        a = resolve_agency(raw)
    except Exception:
        a = None
    if a:
        sn = str(a.get("short_name") or "").strip().lower()
        if sn:
            return " ".join(sn.split())
    return _norm(raw)


def call_canonical_agency_summary(call: dict[str, Any]) -> dict[str, str]:
    """Return a small, stringifiable summary of the canonical agency for a
    scanner call. Used by api_server to inject canonical agency identity
    into Whisper prompts and the structured analysis prompt's
    local_reference_context. Empty values when no agency resolves so the
    caller can safely string-concat without conditional logic.
    """
    a = resolve_agency_from_call(call)
    if not a:
        return {"agency_id": "", "short_name": "", "canonical_name": "", "agency_type": ""}
    return {
        "agency_id": str(a.get("agency_id") or ""),
        "short_name": str(a.get("short_name") or ""),
        "canonical_name": str(a.get("canonical_name") or ""),
        "agency_type": str(a.get("agency_type") or ""),
    }
