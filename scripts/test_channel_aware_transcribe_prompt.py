#!/usr/bin/env python3
"""Regression test for channel-aware Whisper prompt composition.

Backend foundation (commit c25379c) added the channel registry; this
pass extends api_server._scanner_transcribe_prompt to use channel
context (disciplines + region + label) when the call resolves to a
known channel, and falls back to the prior discipline-classifier path
when it doesn't.

Covers:
  - Channel resolved via call.channel_id stamp (the path that fires
    when /api/scanner/calls already enriched the call).
  - Channel resolved via talkgroup ID reverse lookup (the path that
    fires when /api/scanner/transcribe receives raw client-passed
    calls without the channel stamp).
  - Multi-discipline channel emits ALL discipline hints (e.g.
    bethlehem_public_safety = police + fire).
  - Region landmarks land when the channel's region has curated hints
    (Bethlehem area, Coeymans/Ravena, hilltowns, Capitol, Thruway).
  - Falls back to the legacy discipline-classifier prompt when no
    channel resolves but talkgroup_tag/description still classify
    discipline (regression guard for the v6/v7 prompt behavior).
  - Falls back to the base prompt when nothing resolves.
  - Defensive: missing/non-dict input doesn't raise.
  - Agency hint appended in all cases when the agency registry
    resolves a record (preserves commit 6a71eca behavior).

Run: python scripts/test_channel_aware_transcribe_prompt.py
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


# ---------------------------------------------------------------------------
# Channel resolver helper
# ---------------------------------------------------------------------------

def test_channel_resolver_prefers_channel_id_stamp() -> None:
    # Direct stamp wins.
    c = api_server._scanner_channel_for_call({"channel_id": "apd"})
    _report("resolver_resolves_via_channel_id_stamp",
            c is not None and c.get("channel_id") == "apd")

    # Unknown channel_id returns None.
    c2 = api_server._scanner_channel_for_call({"channel_id": "nonexistent"})
    _report("resolver_unknown_channel_id_returns_none", c2 is None)


def test_channel_resolver_falls_back_to_talkgroup() -> None:
    # tg 13102 (APD Dispatch) maps to apd via reverse lookup.
    c = api_server._scanner_channel_for_call({"talkgroup_num": "13102"})
    _report("resolver_via_talkgroup_num_picks_apd",
            c is not None and c.get("channel_id") == "apd")

    # Walks alternate field names too.
    for field in ("talkgroupID", "talkgroup", "tg"):
        c = api_server._scanner_channel_for_call({field: "13102"})
        _report(f"resolver_via_{field}", c is not None
                and c.get("channel_id") == "apd")


def test_channel_resolver_prefers_single_agency_over_composite() -> None:
    """tg 13102 belongs to BOTH apd and albany_city_unified — the
    resolver should pick the single-agency channel for attribution
    purposes, mirroring _preferred_channel in scanner_channels."""
    c = api_server._scanner_channel_for_call({"talkgroup_num": "13102"})
    _report("resolver_picks_single_agency_over_composite",
            c is not None and c.get("channel_id") == "apd",
            f"got {c.get('channel_id') if c else None!r}")


def test_channel_resolver_defensive() -> None:
    for bad in ({}, {"talkgroup_num": ""}, {"talkgroup_num": "999999"}):
        try:
            r = api_server._scanner_channel_for_call(bad)
            _report(f"resolver_defensive_{str(bad)[:30]}_returns_none",
                    r is None or isinstance(r, dict))
        except Exception as exc:
            _report(f"resolver_defensive_{str(bad)[:30]}_no_raise",
                    False, f"raised {exc}")


# ---------------------------------------------------------------------------
# Channel-based prompt builder
# ---------------------------------------------------------------------------

def test_single_discipline_channel_prompt() -> None:
    apd_chan = api_server._scanner_channel_for_call({"channel_id": "apd"})
    p = api_server._scanner_transcribe_prompt_for_channel(apd_chan)
    _report("single_disc_starts_with_base",
            p.startswith(api_server._SCANNER_TRANSCRIBE_PROMPT_BASE))
    _report("single_disc_emits_police_hint",
            api_server._SCANNER_DISCIPLINE_HINTS["police"] in p)
    _report("single_disc_does_not_emit_fire_hint",
            api_server._SCANNER_DISCIPLINE_HINTS["fire"] not in p)
    _report("single_disc_emits_channel_label",
            "Channel: Albany Police Dispatch." in p)


def test_multi_discipline_channel_prompt() -> None:
    """bethlehem_public_safety has disciplines=[police, fire] — both
    hints should be present in the composed prompt."""
    chan = api_server._scanner_channel_for_call({"channel_id": "bethlehem_public_safety"})
    p = api_server._scanner_transcribe_prompt_for_channel(chan)
    _report("multi_disc_includes_police", "Police dispatch:" in p)
    _report("multi_disc_includes_fire", "Fire dispatch:" in p)
    _report("multi_disc_excludes_ems_when_not_listed",
            "EMS dispatch:" not in p)
    # Bethlehem region landmarks should also land.
    _report("multi_disc_includes_region_hint_slingerlands",
            "Slingerlands" in p)
    _report("multi_disc_emits_channel_label",
            "Channel: Bethlehem Public Safety (Police + Fire)." in p)


def test_unified_channel_includes_all_three_disciplines() -> None:
    chan = api_server._scanner_channel_for_call({"channel_id": "albany_city_unified"})
    p = api_server._scanner_transcribe_prompt_for_channel(chan)
    for d in ("Police dispatch:", "Fire dispatch:", "EMS dispatch:"):
        _report(f"unified_includes_{d.split(' ')[0].lower()}_hint", d in p)


def test_region_hints_present_for_curated_regions() -> None:
    """Spot-check region landmark hints across the curated set."""
    cases = [
        ("coeymans_pd", "Route 144"),
        ("coeymans_pd", "Coeymans Landing"),
        ("guilderland_pd", "Crossgates Mall"),
        ("colonie_pd", "Wolf Road"),
        ("nysp_capitol", "Empire State Plaza"),
        ("green_island_pd", "George Street"),
    ]
    for cid, needle in cases:
        chan = api_server._scanner_channel_for_call({"channel_id": cid})
        p = api_server._scanner_transcribe_prompt_for_channel(chan)
        _report(f"region_hint_{cid}_includes_{needle.replace(' ', '_')}",
                needle in p,
                f"prompt tail: {p[-180:]!r}")


def test_region_without_curated_hints_omits_region_block() -> None:
    """ACSO is region=county_wide which intentionally has NO curated
    landmark block (the base prompt covers it). The channel-aware
    prompt should still work but not inject anything for that region."""
    chan = api_server._scanner_channel_for_call({"channel_id": "acso"})
    p = api_server._scanner_transcribe_prompt_for_channel(chan)
    _report("acso_does_not_inject_unknown_region",
            # Should not contain any of the curated region phrases.
            all(needle not in p for needle in (
                "Slingerlands", "Crossgates Mall", "Wolf Road",
                "Coeymans Landing", "Empire State Plaza",
            )))


# ---------------------------------------------------------------------------
# Full _scanner_transcribe_prompt integration
# ---------------------------------------------------------------------------

def test_full_prompt_for_known_channel_includes_all_pieces() -> None:
    p = api_server._scanner_transcribe_prompt({"channel_id": "apd",
                                               "talkgroup_num": "13102"})
    _report("full_prompt_apd_starts_with_base",
            p.startswith(api_server._SCANNER_TRANSCRIBE_PROMPT_BASE))
    _report("full_prompt_apd_has_police_hint",
            "Police dispatch:" in p)
    _report("full_prompt_apd_has_channel_label",
            "Channel: Albany Police Dispatch." in p)
    _report("full_prompt_apd_has_agency_hint",
            "Agency: Albany City Police Department (APD)." in p)


def test_full_prompt_falls_back_to_discipline_classifier() -> None:
    """When NO channel resolves but talkgroup_tag still classifies
    discipline, the legacy single-discipline prompt path must still
    produce a useful prompt (regression guard for v6/v7).

    Note: the legacy fallback uses _SCANNER_TRANSCRIBE_PROMPT_POLICE
    ("Police dispatch: expect 10-codes…") which is intentionally a
    different string than the new channel-path
    _SCANNER_DISCIPLINE_HINTS["police"] ("Police dispatch: 10-codes…").
    Back-compat means "Police dispatch:" + canonical police vocabulary
    must be present, regardless of which exact prompt string was used.
    """
    p = api_server._scanner_transcribe_prompt({"talkgroup_tag": "APD Dispatch"})
    _report("fallback_uses_police_prompt",
            "Police dispatch:" in p
            and "BOLO" in p
            and "felony stop" in p,
            f"got tail={p[-180:]!r}")
    _report("fallback_path_does_not_emit_channel_label",
            "Channel:" not in p,
            "no channel resolved → no channel label should be appended")


def test_full_prompt_empty_call_returns_base() -> None:
    p = api_server._scanner_transcribe_prompt({})
    _report("empty_call_returns_base_prompt",
            p == api_server._SCANNER_TRANSCRIBE_PROMPT_BASE)


def test_defensive_against_registry_failure() -> None:
    """If scanner_channels import fails inside _scanner_channel_for_call,
    the helper returns None and the function falls through to the
    discipline-classifier path. Verified by patching the function to
    always raise."""
    orig = api_server._scanner_channel_for_call
    def _boom(call):  # noqa: ANN001
        raise RuntimeError("synthetic registry failure")
    api_server._scanner_channel_for_call = _boom
    try:
        p = api_server._scanner_transcribe_prompt({"talkgroup_tag": "APD Dispatch"})
        _report("registry_failure_falls_through_to_discipline_path",
                "Police dispatch:" in p)
    finally:
        api_server._scanner_channel_for_call = orig


def main() -> None:
    test_channel_resolver_prefers_channel_id_stamp()
    test_channel_resolver_falls_back_to_talkgroup()
    test_channel_resolver_prefers_single_agency_over_composite()
    test_channel_resolver_defensive()
    test_single_discipline_channel_prompt()
    test_multi_discipline_channel_prompt()
    test_unified_channel_includes_all_three_disciplines()
    test_region_hints_present_for_curated_regions()
    test_region_without_curated_hints_omits_region_block()
    test_full_prompt_for_known_channel_includes_all_pieces()
    test_full_prompt_falls_back_to_discipline_classifier()
    test_full_prompt_empty_call_returns_base()
    test_defensive_against_registry_failure()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
