"""Scanner channel registry — virtual channels grouping P25 talkgroups
into agency / region / unified views.

Reads data/scanner_channels.json and exposes typed accessors that the
scanner endpoints + UI can consume without re-deriving the talkgroup ↔
channel mapping at every call site.

The file itself is the source of truth — adding/renaming a channel
there flows through to every consumer automatically.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Optional


_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CHANNELS_PATH = os.path.join(_REPO_ROOT, "data", "scanner_channels.json")


@lru_cache(maxsize=1)
def load_channels() -> dict[str, Any]:
    """Return the parsed scanner_channels.json document. Cached after
    first read. Defensive — returns an empty registry if the file is
    missing or malformed so the scanner endpoints never 500 on import."""
    try:
        with open(_CHANNELS_PATH, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"channels": [], "regions": []}
    if not isinstance(doc, dict):
        return {"channels": [], "regions": []}
    if not isinstance(doc.get("channels"), list):
        doc["channels"] = []
    if not isinstance(doc.get("regions"), list):
        doc["regions"] = []
    return doc


def reset_cache() -> None:
    """Drop the cached parse — used by tests that touch the JSON file."""
    load_channels.cache_clear()


def list_channels() -> list[dict[str, Any]]:
    """Every channel record in stable (file) order."""
    return [dict(c) for c in (load_channels().get("channels") or [])
            if isinstance(c, dict)]


def list_regions() -> list[dict[str, Any]]:
    return [dict(r) for r in (load_channels().get("regions") or [])
            if isinstance(r, dict)]


def channel_by_id(channel_id: str) -> Optional[dict[str, Any]]:
    cid = (channel_id or "").strip().lower()
    if not cid:
        return None
    for c in list_channels():
        if str(c.get("channel_id") or "").lower() == cid:
            return c
    return None


def talkgroups_for_channel(channel_id: str) -> frozenset[str]:
    """Set of talkgroup IDs (as strings) that belong to a channel.
    Empty frozenset for unknown channels."""
    c = channel_by_id(channel_id)
    if not c:
        return frozenset()
    out: set[str] = set()
    for tg in (c.get("talkgroup_ids") or []):
        s = str(tg).strip()
        if s:
            out.add(s)
    return frozenset(out)


def channels_for_talkgroup(talkgroup_id: Any) -> list[dict[str, Any]]:
    """Reverse lookup: every channel that includes this talkgroup. A
    talkgroup may belong to multiple channels (e.g. APD dispatch is in
    both `apd` and `albany_city_unified`)."""
    if talkgroup_id is None:
        return []
    key = str(talkgroup_id).strip()
    if not key:
        return []
    out: list[dict[str, Any]] = []
    for c in list_channels():
        tgs = {str(t).strip() for t in (c.get("talkgroup_ids") or [])}
        if key in tgs:
            out.append(c)
    return out


def channels_by_region(region_id: str) -> list[dict[str, Any]]:
    rid = (region_id or "").strip().lower()
    if not rid:
        return []
    return [c for c in list_channels()
            if str(c.get("region") or "").lower() == rid]


def channels_by_agency(agency_id: str) -> list[dict[str, Any]]:
    aid = (agency_id or "").strip().lower()
    if not aid:
        return []
    return [c for c in list_channels()
            if str(c.get("agency_id") or "").lower() == aid]


# Channels primary attribution preference: when a talkgroup belongs to
# multiple channels (e.g. apd + albany_city_unified), the
# enrich_call_with_channel helper picks the FIRST single-agency channel
# (agency_id non-null) so the per-call stamp is the most specific
# attribution. Composite/unified channels are useful for filter views
# but not for "what is this call?" attribution.
def _preferred_channel(channels: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not channels:
        return None
    single = [c for c in channels if c.get("agency_id")]
    if single:
        # Prefer high-priority single-agency channel.
        single.sort(key=lambda c: (
            0 if str(c.get("priority") or "") == "high" else
            1 if str(c.get("priority") or "") == "medium" else 2
        ))
        return single[0]
    return channels[0]


_CALL_TG_FIELDS = ("talkgroup_num", "talkgroupID", "talkgroup", "tg")


def enrich_call_with_channel(call: dict[str, Any]) -> dict[str, Any]:
    """Stamp `channel_id` and `channel_label` onto a scanner-call dict.
    Returns the SAME dict mutated in place AND also returned for
    convenient chaining. No-op when the call has no resolvable
    talkgroup or no matching channel.
    """
    if not isinstance(call, dict):
        return call
    tg_value: Any = None
    for field in _CALL_TG_FIELDS:
        v = call.get(field)
        if v not in (None, ""):
            tg_value = v
            break
    if tg_value is None:
        return call
    matches = channels_for_talkgroup(tg_value)
    chosen = _preferred_channel(matches)
    if chosen:
        call["channel_id"] = chosen.get("channel_id")
        call["channel_label"] = chosen.get("label")
    return call


def call_matches_channel(call: dict[str, Any], channel_id: str) -> bool:
    """Filter predicate for /api/scanner/calls?channel=...

    Matches if the call's talkgroup is a member of the requested
    channel. Defensive — non-dict call or unknown channel returns
    False rather than raising."""
    if not isinstance(call, dict):
        return False
    cid = (channel_id or "").strip().lower()
    if not cid:
        return False
    tgs = talkgroups_for_channel(cid)
    if not tgs:
        return False
    for field in _CALL_TG_FIELDS:
        v = call.get(field)
        if v in (None, ""):
            continue
        if str(v).strip() in tgs:
            return True
    return False


def channels_payload() -> dict[str, Any]:
    """Public-API shape for /api/scanner/channels. Includes the channels
    list, region list, and a small reverse index talkgroup_id →
    [channel_id] so the UI can group calls without re-walking the list."""
    chans = list_channels()
    tg_index: dict[str, list[str]] = {}
    for c in chans:
        cid = str(c.get("channel_id") or "")
        for tg in (c.get("talkgroup_ids") or []):
            tg_index.setdefault(str(tg).strip(), []).append(cid)
    return {
        "channels": chans,
        "regions": list_regions(),
        "talkgroup_index": tg_index,
    }
