#!/usr/bin/env python3
"""Regression test for channel-aware structured-analysis context.

Backend foundation (commits c25379c + e0a4cef) gave Whisper the same
operational framing the channel registry encodes. This pass extends
api_server._scanner_call_local_reference_context — the variable handed
to the OpenAI Prompt API as `local_reference_context` — to also carry
channel_id / channel_label / channel_disciplines / channel_region.

Covers:
  - Channel resolved via call.channel_id stamp (the path that fires
    when /api/scanner/calls already enriched the call).
  - Channel resolved via talkgroup ID reverse lookup (the path that
    fires when /api/scanner/transcribe receives raw client-passed
    calls without the channel stamp).
  - Multi-discipline channel emits all disciplines as a comma-joined
    string (e.g. "police,fire" for bethlehem_public_safety).
  - Region passthrough.
  - Unknown talkgroup → channel keys absent (no fabricated values).
  - Empty call → no channel keys.
  - Existing canonical_agency_* keys still present (regression guard
    for commit 6a71eca).
  - Existing jurisdiction tail still present (regression guard for
    the original line).
  - Defensive against synthetic registry failure (channel resolver
    raising) — context still returns with the rest of the bits.

Run: python scripts/test_channel_aware_analysis_context.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server

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


def _ctx(call: dict) -> str:
    return api_server._scanner_call_local_reference_context(call)


# ---------------------------------------------------------------------------
# Channel via channel_id stamp
# ---------------------------------------------------------------------------

def test_channel_id_stamp_path() -> None:
    ctx = _ctx({"channel_id": "apd", "talkgroup_num": "13102",
                "talkgroup_tag": "APD Dispatch", "source": "Broadcastify"})
    _report("apd_emits_channel_id", "channel_id=apd" in ctx)
    _report("apd_emits_channel_label",
            "channel_label=Albany Police Dispatch" in ctx)
    _report("apd_emits_channel_disciplines",
            "channel_disciplines=police" in ctx)
    _report("apd_emits_channel_region",
            "channel_region=capital_albany" in ctx)


# ---------------------------------------------------------------------------
# Channel via talkgroup-id reverse lookup (no channel_id stamp)
# ---------------------------------------------------------------------------

def test_talkgroup_reverse_lookup_path() -> None:
    ctx = _ctx({"talkgroup_num": "10502", "source": "OpenMHz"})
    _report("tg_lookup_emits_channel_id",
            "channel_id=bethlehem_pd" in ctx)
    _report("tg_lookup_emits_channel_label",
            "channel_label=Bethlehem Police" in ctx)
    _report("tg_lookup_emits_channel_region",
            "channel_region=bethlehem_area" in ctx)


# ---------------------------------------------------------------------------
# Multi-discipline channel
# ---------------------------------------------------------------------------

def test_multi_discipline_channel_disciplines_csv() -> None:
    ctx = _ctx({"channel_id": "bethlehem_public_safety"})
    _report("multi_disc_disciplines_includes_police",
            "channel_disciplines=" in ctx and "police" in ctx)
    _report("multi_disc_disciplines_includes_fire",
            "channel_disciplines=" in ctx
            and ",fire" in ctx or "police,fire" in ctx)
    # Format: comma-joined lowercase
    _report("multi_disc_disciplines_csv_format",
            "channel_disciplines=police,fire" in ctx,
            "expected exact 'police,fire' csv")


def test_unified_channel_emits_all_three_disciplines() -> None:
    ctx = _ctx({"channel_id": "albany_city_unified"})
    _report("unified_disciplines_csv",
            "channel_disciplines=police,fire,ems" in ctx,
            "expected 'police,fire,ems' csv from albany_city_unified")


# ---------------------------------------------------------------------------
# Negative paths — no channel keys when no channel resolves
# ---------------------------------------------------------------------------

def test_unknown_talkgroup_omits_channel_keys() -> None:
    ctx = _ctx({"talkgroup_num": "999999",
                "talkgroup_tag": "Unknown", "source": "OpenMHz"})
    for needle in ("channel_id=", "channel_label=",
                   "channel_disciplines=", "channel_region="):
        _report(f"unknown_tg_omits_{needle}",
                needle not in ctx,
                f"unexpected: {needle}")


def test_empty_call_omits_channel_keys() -> None:
    ctx = _ctx({})
    for needle in ("channel_id=", "channel_label=",
                   "channel_disciplines=", "channel_region="):
        _report(f"empty_call_omits_{needle}",
                needle not in ctx)


# ---------------------------------------------------------------------------
# Regression guards for existing fields
# ---------------------------------------------------------------------------

def test_canonical_agency_block_still_present() -> None:
    """Commit 6a71eca added canonical_agency_* keys; channel keys must
    not displace them."""
    ctx = _ctx({"channel_id": "apd", "talkgroup_num": "13102"})
    for needle in ("canonical_agency_id=apd",
                   "canonical_agency_short_name=APD",
                   "canonical_agency_name=Albany City Police Department",
                   "canonical_agency_type=municipal_police"):
        _report(f"agency_block_still_emits_{needle.split('=')[0]}",
                needle in ctx,
                f"missing in ctx: {needle}")


def test_jurisdiction_tail_still_present() -> None:
    ctx = _ctx({})
    _report("jurisdiction_tail_present",
            "jurisdiction=Albany County, New York" in ctx)


def test_talkgroup_fields_still_present() -> None:
    ctx = _ctx({"talkgroup_num": "13102", "talkgroup_tag": "APD Dispatch",
                "talkgroup_description": "Albany PD Primary",
                "freq": 851000000, "source": "Broadcastify"})
    _report("talkgroup_num_emitted", "talkgroup_num=13102" in ctx)
    _report("talkgroup_tag_emitted", "talkgroup_tag=APD Dispatch" in ctx)
    _report("talkgroup_description_emitted",
            "talkgroup_description=Albany PD Primary" in ctx)
    _report("frequency_hz_emitted", "frequency_hz=851000000" in ctx)
    _report("source_emitted", "source=Broadcastify" in ctx)


# ---------------------------------------------------------------------------
# Defensive: registry failure must not break the context
# ---------------------------------------------------------------------------

def test_channel_resolver_failure_falls_through() -> None:
    """Synthetic registry failure: monkey-patch _scanner_channel_for_call
    to always raise. The context must still return with all the
    non-channel fields present (jurisdiction, talkgroup, agency)."""
    orig = api_server._scanner_channel_for_call
    def _boom(call):  # noqa: ANN001
        raise RuntimeError("synthetic channel-registry failure")
    api_server._scanner_channel_for_call = _boom
    try:
        ctx = _ctx({"talkgroup_num": "13102",
                    "talkgroup_tag": "APD Dispatch"})
    finally:
        api_server._scanner_channel_for_call = orig

    _report("registry_failure_omits_channel_keys",
            "channel_id=" not in ctx)
    _report("registry_failure_keeps_talkgroup_num",
            "talkgroup_num=13102" in ctx)
    _report("registry_failure_keeps_jurisdiction",
            "jurisdiction=Albany County, New York" in ctx)
    # canonical_agency_* should still resolve since that uses a
    # different code path.
    _report("registry_failure_keeps_canonical_agency",
            "canonical_agency_id=apd" in ctx)


def test_format_uses_pipe_separator() -> None:
    """Bits are joined with ' | '. Visual format guard."""
    ctx = _ctx({"channel_id": "apd", "talkgroup_num": "13102"})
    _report("format_pipe_separated",
            " | " in ctx)
    # Empty bits (those ending with '=' after concat) must be filtered
    # out so the model doesn't see "talkgroup_tag= |" noise.
    _report("format_no_empty_value_lines",
            not any(part.strip().endswith("=") for part in ctx.split(" | ")))


def main() -> None:
    test_channel_id_stamp_path()
    test_talkgroup_reverse_lookup_path()
    test_multi_discipline_channel_disciplines_csv()
    test_unified_channel_emits_all_three_disciplines()
    test_unknown_talkgroup_omits_channel_keys()
    test_empty_call_omits_channel_keys()
    test_canonical_agency_block_still_present()
    test_jurisdiction_tail_still_present()
    test_talkgroup_fields_still_present()
    test_channel_resolver_failure_falls_through()
    test_format_uses_pipe_separator()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
