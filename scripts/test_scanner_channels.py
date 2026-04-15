#!/usr/bin/env python3
"""Regression test for the scanner channels layer.

Covers:
  - data/scanner_channels.json structure (every channel has the
    required field contract, and every talkgroup_id referenced exists
    in data/scanner_aliases.json so cross-file consistency is enforced)
  - scanner_channels module helpers (list_channels, channel_by_id,
    talkgroups_for_channel, channels_for_talkgroup, channels_by_region,
    channels_by_agency, enrich_call_with_channel, call_matches_channel,
    channels_payload)
  - preferred-channel attribution: a talkgroup that belongs to multiple
    channels (e.g. apd + albany_city_unified) gets stamped with the
    single-agency channel
  - api_server route registration

Run: python scripts/test_scanner_channels.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server  # for route registration assertion
from app.services.scanner_channels import (
    call_matches_channel,
    channel_by_id,
    channels_by_agency,
    channels_by_region,
    channels_for_talkgroup,
    channels_payload,
    enrich_call_with_channel,
    list_channels,
    list_regions,
    talkgroups_for_channel,
)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

passed = 0
failed = 0


def _report(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


# ---------------------------------------------------------------------------
# data/scanner_channels.json structural contract
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {
    "channel_id", "label", "agency_id", "talkgroup_ids",
    "disciplines", "region", "priority", "notes",
}
ALLOWED_DISCIPLINES = {"police", "fire", "ems"}
ALLOWED_PRIORITIES = {"high", "medium", "low"}


def test_file_loads_and_minimum_size() -> None:
    chans = list_channels()
    _report("at_least_20_channels", len(chans) >= 20,
            f"got {len(chans)}")

    regs = list_regions()
    _report("at_least_5_regions", len(regs) >= 5, f"got {len(regs)}")


def test_every_channel_has_required_fields() -> None:
    for c in list_channels():
        missing = REQUIRED_FIELDS - set(c.keys())
        _report(f"channel_{c.get('channel_id')}_has_required_fields",
                not missing,
                f"missing={missing}")


def test_channel_ids_unique() -> None:
    ids = [c["channel_id"] for c in list_channels()]
    _report("channel_ids_unique",
            len(ids) == len(set(ids)),
            f"dupes={[i for i in ids if ids.count(i) > 1]}")


def test_disciplines_and_priorities_valid() -> None:
    for c in list_channels():
        cid = c.get("channel_id")
        ds = set(c.get("disciplines") or [])
        _report(f"channel_{cid}_disciplines_subset_of_allowed",
                ds.issubset(ALLOWED_DISCIPLINES),
                f"disciplines={ds}")
        _report(f"channel_{cid}_priority_valid",
                c.get("priority") in ALLOWED_PRIORITIES,
                f"priority={c.get('priority')}")


def test_every_talkgroup_id_exists_in_aliases() -> None:
    """Cross-file consistency: every talkgroup referenced by a channel
    must be present in data/scanner_aliases.json so the channel
    actually has working source data."""
    with open(os.path.join(REPO, "data", "scanner_aliases.json")) as f:
        aliases = json.load(f)
    valid = set((aliases.get("talkgroups") or {}).keys())
    for c in list_channels():
        cid = c.get("channel_id")
        for tg in (c.get("talkgroup_ids") or []):
            tg_s = str(tg).strip()
            _report(f"channel_{cid}_talkgroup_{tg_s}_exists_in_aliases",
                    tg_s in valid,
                    f"missing in scanner_aliases.json")


def test_channels_with_agency_id_resolve_to_real_agency() -> None:
    """When a channel claims a canonical agency_id, that id must exist
    in data/agencies.json so downstream consumers can render the agency
    short_name etc."""
    from app.services.agency_registry import agency_by_id
    for c in list_channels():
        aid = c.get("agency_id")
        if not aid:
            continue
        rec = agency_by_id(aid)
        _report(f"channel_{c.get('channel_id')}_agency_{aid}_resolves",
                rec is not None,
                f"agency_id not in data/agencies.json")


# ---------------------------------------------------------------------------
# Loader helpers
# ---------------------------------------------------------------------------

def test_channel_by_id_known_and_unknown() -> None:
    _report("channel_by_id_apd_resolves",
            (channel_by_id("apd") or {}).get("label") == "Albany Police Dispatch")
    _report("channel_by_id_case_insensitive",
            (channel_by_id("APD") or {}).get("channel_id") == "apd")
    _report("channel_by_id_unknown_returns_none",
            channel_by_id("nonexistent") is None)
    _report("channel_by_id_empty_returns_none",
            channel_by_id("") is None)


def test_talkgroups_for_channel() -> None:
    apd_tgs = talkgroups_for_channel("apd")
    for tg in ("13102", "13302", "13402", "13502"):
        _report(f"apd_includes_tg_{tg}", tg in apd_tgs)
    _report("unknown_channel_returns_empty_set",
            talkgroups_for_channel("nonexistent") == frozenset())


def test_reverse_lookup_includes_unified() -> None:
    """tg 13102 (APD dispatch) belongs to BOTH apd and
    albany_city_unified — a talkgroup may live in multiple channels."""
    chans = channels_for_talkgroup("13102")
    ids = {c.get("channel_id") for c in chans}
    _report("tg_13102_in_apd", "apd" in ids)
    _report("tg_13102_in_albany_city_unified", "albany_city_unified" in ids)
    _report("tg_unknown_returns_empty",
            channels_for_talkgroup("999999") == [])
    _report("tg_none_returns_empty",
            channels_for_talkgroup(None) == [])


def test_channels_by_region_and_agency() -> None:
    bethlehem = {c.get("channel_id") for c in channels_by_region("bethlehem_area")}
    for cid in ("bethlehem_pd", "bethlehem_fire", "bethlehem_public_safety"):
        _report(f"region_bethlehem_includes_{cid}", cid in bethlehem)

    acso_chans = channels_by_agency("acso")
    _report("agency_acso_has_one_channel",
            len(acso_chans) == 1 and acso_chans[0].get("channel_id") == "acso")


# ---------------------------------------------------------------------------
# Call enrichment + preferred attribution
# ---------------------------------------------------------------------------

def test_enrich_call_stamps_single_agency_channel() -> None:
    """When tg 13102 maps to multiple channels (apd + unified), the
    stamp should be the SINGLE-AGENCY channel (apd), not the unified
    composite — composite channels are useful for filter views but a
    bad answer for "what is this call?" attribution."""
    call = {"id": "c1", "talkgroup_num": "13102",
            "time": "2026-04-15T10:00:00Z"}
    enrich_call_with_channel(call)
    _report("enrich_picks_single_agency_channel_over_unified",
            call.get("channel_id") == "apd",
            f"got channel_id={call.get('channel_id')!r}")
    _report("enrich_stamps_label",
            call.get("channel_label") == "Albany Police Dispatch")


def test_enrich_handles_missing_or_unknown_talkgroup() -> None:
    # Missing talkgroup → call dict unchanged.
    call_a = {"id": "x"}
    enrich_call_with_channel(call_a)
    _report("enrich_no_talkgroup_unchanged",
            "channel_id" not in call_a)

    # Unknown talkgroup → call dict unchanged.
    call_b = {"id": "y", "talkgroup_num": "999999"}
    enrich_call_with_channel(call_b)
    _report("enrich_unknown_talkgroup_unchanged",
            "channel_id" not in call_b)

    # Non-dict input → no raise, returns input.
    _report("enrich_non_dict_no_raise",
            enrich_call_with_channel(None) is None)  # type: ignore[arg-type]


def test_enrich_uses_first_available_tg_field() -> None:
    """Adapters use varied field names — the enricher must pick the
    first non-empty among {talkgroup_num, talkgroupID, talkgroup, tg}."""
    for field in ("talkgroup_num", "talkgroupID", "talkgroup", "tg"):
        call = {"id": "x", field: "13102"}
        enrich_call_with_channel(call)
        _report(f"enrich_resolves_via_{field}",
                call.get("channel_id") == "apd",
                f"got channel_id={call.get('channel_id')!r}")


# ---------------------------------------------------------------------------
# Filter predicate
# ---------------------------------------------------------------------------

def test_call_matches_channel() -> None:
    _report("matches_apd_for_tg_13102",
            call_matches_channel({"talkgroup_num": "13102"}, "apd"))
    _report("not_matches_acso_for_tg_13102",
            not call_matches_channel({"talkgroup_num": "13102"}, "acso"))
    _report("not_matches_unknown_channel",
            not call_matches_channel({"talkgroup_num": "13102"}, "nonexistent"))
    _report("not_matches_when_call_has_no_tg",
            not call_matches_channel({"id": "x"}, "apd"))
    _report("non_dict_call_returns_false",
            not call_matches_channel(None, "apd"))  # type: ignore[arg-type]
    _report("empty_channel_id_returns_false",
            not call_matches_channel({"talkgroup_num": "13102"}, ""))


# ---------------------------------------------------------------------------
# Public API payload + route registration
# ---------------------------------------------------------------------------

def test_channels_payload_shape() -> None:
    p = channels_payload()
    _report("payload_has_channels", isinstance(p.get("channels"), list))
    _report("payload_has_regions", isinstance(p.get("regions"), list))
    _report("payload_has_talkgroup_index",
            isinstance(p.get("talkgroup_index"), dict))
    # Reverse index correctness: tg 13102 should map to ['apd',
    # 'albany_city_unified'] in that order.
    idx = p.get("talkgroup_index") or {}
    _report("payload_index_includes_apd_for_13102",
            "apd" in (idx.get("13102") or []))
    _report("payload_index_includes_unified_for_13102",
            "albany_city_unified" in (idx.get("13102") or []))


def test_routes_registered() -> None:
    routes = {getattr(r, "path", None) for r in api_server.app.routes}
    _report("scanner_channels_route_registered",
            "/api/scanner/channels" in routes)
    _report("scanner_calls_route_registered",
            "/api/scanner/calls" in routes)


def main() -> None:
    test_file_loads_and_minimum_size()
    test_every_channel_has_required_fields()
    test_channel_ids_unique()
    test_disciplines_and_priorities_valid()
    test_every_talkgroup_id_exists_in_aliases()
    test_channels_with_agency_id_resolve_to_real_agency()
    test_channel_by_id_known_and_unknown()
    test_talkgroups_for_channel()
    test_reverse_lookup_includes_unified()
    test_channels_by_region_and_agency()
    test_enrich_call_stamps_single_agency_channel()
    test_enrich_handles_missing_or_unknown_talkgroup()
    test_enrich_uses_first_available_tg_field()
    test_call_matches_channel()
    test_channels_payload_shape()
    test_routes_registered()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
