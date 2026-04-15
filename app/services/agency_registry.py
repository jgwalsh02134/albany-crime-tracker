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
      4. None.
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
    return None
