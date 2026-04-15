#!/usr/bin/env python3
"""Regression test for channel + agency attribution stamped onto
scanner-analysis results.

Builds on commit c5c92c8 (channel-aware structured-analysis context).
That pass gave the OpenAI prompt the channel context; this pass
preserves the same context on the analysis OUTPUT so downstream
consumers (the in-memory whisper cache, incident extraction, future
UI) can read attribution directly without re-deriving from the source
call.

Covers:
  - ScannerTranscriptAnalysis schema gains a flat `attribution` dict
    (default empty) so the contract is documented.
  - _stamp_attribution_on_analysis composes channel keys
    (channel_id / channel_label / channel_disciplines / channel_region)
    + canonical agency keys (agency_id / agency_short_name /
    agency_canonical_name / agency_type) + feed keys (feed_id /
    feed_name / feed_priority) when present.
  - Agency keys use the flat naming agency_id / agency_short_name /
    agency_canonical_name / agency_type (regression guard for the
    "agency_agency_type" doubled-up bug found during development).
  - Resolver semantics mirror the channel-aware Whisper / context
    paths: channel_id stamp wins; falls back to talkgroup id; picks
    single-agency over composite.
  - Stream-monitor path (feed_id / feed_name / feed_priority, no
    talkgroup) still gets feed metadata stamped.
  - Defensive: None analysis / non-dict call / empty call → no raise,
    sensible no-op.
  - Idempotent: stamping twice with the same call doesn't lose keys.
  - Existing analysis fields preserved (summary, keywords, etc. not
    blanked).

Run: python scripts/test_scanner_analysis_attribution.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server
from app.services.scanner_analysis import ScannerTranscriptAnalysis

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


def _stamp(analysis: dict, call: dict) -> dict:
    return api_server._stamp_attribution_on_analysis(analysis, call)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_schema_has_attribution_field() -> None:
    m = ScannerTranscriptAnalysis()
    _report("schema_has_attribution_default_empty_dict",
            getattr(m, "attribution", None) == {})

    m2 = ScannerTranscriptAnalysis(attribution={"channel_id": "apd"})
    _report("schema_accepts_attribution_payload",
            m2.attribution.get("channel_id") == "apd")

    # extra="allow" must still be in effect.
    cfg = ScannerTranscriptAnalysis.model_config
    _report("schema_extra_allow_preserved",
            cfg.get("extra") == "allow")


# ---------------------------------------------------------------------------
# Channel resolution paths
# ---------------------------------------------------------------------------

def test_attribution_via_channel_id_stamp() -> None:
    out = _stamp({"summary": "x"},
                 {"channel_id": "apd", "talkgroup_num": "13102"})
    a = out.get("attribution") or {}
    _report("channel_id_path_emits_channel_id", a.get("channel_id") == "apd")
    _report("channel_id_path_emits_channel_label",
            a.get("channel_label") == "Albany Police Dispatch")
    _report("channel_id_path_emits_channel_disciplines",
            a.get("channel_disciplines") == ["police"])
    _report("channel_id_path_emits_channel_region",
            a.get("channel_region") == "capital_albany")


def test_attribution_via_talkgroup_reverse_lookup() -> None:
    out = _stamp({"summary": "x"}, {"talkgroup_num": "10502"})
    a = out.get("attribution") or {}
    _report("tg_path_resolves_bethlehem_pd",
            a.get("channel_id") == "bethlehem_pd"
            and a.get("channel_label") == "Bethlehem Police"
            and a.get("channel_region") == "bethlehem_area")


def test_attribution_picks_single_agency_over_composite() -> None:
    """tg 13102 belongs to BOTH apd and albany_city_unified — single
    agency must win for attribution."""
    out = _stamp({"summary": "x"}, {"talkgroup_num": "13102"})
    a = out.get("attribution") or {}
    _report("attribution_picks_apd_over_unified",
            a.get("channel_id") == "apd",
            f"got {a.get('channel_id')!r}")


# ---------------------------------------------------------------------------
# Canonical agency keys — flat naming (regression guard for doubled-up bug)
# ---------------------------------------------------------------------------

def test_agency_keys_flat_naming() -> None:
    out = _stamp({"summary": "x"},
                 {"channel_id": "apd", "talkgroup_num": "13102"})
    a = out.get("attribution") or {}
    _report("agency_id_present", a.get("agency_id") == "apd")
    _report("agency_short_name_present", a.get("agency_short_name") == "APD")
    _report("agency_canonical_name_present",
            a.get("agency_canonical_name") == "Albany City Police Department")
    _report("agency_type_present", a.get("agency_type") == "municipal_police")
    # Regression guard for the "agency_agency_type" bug.
    _report("no_doubled_up_agency_agency_type_key",
            "agency_agency_type" not in a)


# ---------------------------------------------------------------------------
# Stream-monitor path
# ---------------------------------------------------------------------------

def test_stream_monitor_feed_keys() -> None:
    out = _stamp({"summary": "y"},
                 {"feed_id": "3626", "feed_name": "Albany City Police/Fire",
                  "feed_priority": "high"})
    a = out.get("attribution") or {}
    _report("stream_emits_feed_id", a.get("feed_id") == "3626")
    _report("stream_emits_feed_name",
            a.get("feed_name") == "Albany City Police/Fire")
    _report("stream_emits_feed_priority", a.get("feed_priority") == "high")
    # No channel resolves from feed metadata alone.
    _report("stream_no_channel_keys", "channel_id" not in a)


# ---------------------------------------------------------------------------
# Negative + defensive paths
# ---------------------------------------------------------------------------

def test_empty_call_omits_attribution_block() -> None:
    out = _stamp({"summary": "x"}, {})
    _report("empty_call_no_attribution_key",
            "attribution" not in out
            or out.get("attribution") == {})


def test_unknown_talkgroup_omits_channel_keys() -> None:
    out = _stamp({"summary": "x"}, {"talkgroup_num": "999999"})
    a = out.get("attribution") or {}
    for k in ("channel_id", "channel_label",
              "channel_disciplines", "channel_region"):
        _report(f"unknown_tg_omits_{k}", k not in a)


def test_defensive_against_bad_inputs() -> None:
    # None analysis must pass through.
    _report("none_analysis_passes_through",
            _stamp(None, {"channel_id": "apd"}) is None)  # type: ignore[arg-type]

    # Non-dict call must not raise.
    out = _stamp({"summary": "y"}, "garbage")  # type: ignore[arg-type]
    _report("non_dict_call_no_raise", out == {"summary": "y"})

    # Non-dict analysis must pass through.
    _report("non_dict_analysis_passes_through",
            _stamp("not a dict", {"channel_id": "apd"}) == "not a dict")  # type: ignore[arg-type]

    # Synthetic registry failure — channel resolver raises.
    orig = api_server._scanner_channel_for_call
    def _boom(call):  # noqa: ANN001
        raise RuntimeError("synthetic registry failure")
    api_server._scanner_channel_for_call = _boom
    try:
        out = _stamp({"summary": "x"},
                     {"channel_id": "apd", "talkgroup_num": "13102"})
    finally:
        api_server._scanner_channel_for_call = orig

    a = out.get("attribution") or {}
    _report("registry_failure_no_channel_keys",
            "channel_id" not in a)
    # Agency path uses a different module (agency_registry), so it
    # should still work.
    _report("registry_failure_agency_keys_still_present",
            a.get("agency_id") == "apd")
    _report("registry_failure_summary_preserved",
            out.get("summary") == "x")


# ---------------------------------------------------------------------------
# Idempotency + preservation
# ---------------------------------------------------------------------------

def test_idempotent_stamping() -> None:
    call = {"channel_id": "apd", "talkgroup_num": "13102"}
    a = _stamp({"summary": "x"}, call)
    first = dict(a.get("attribution") or {})
    a = _stamp(a, call)
    second = dict(a.get("attribution") or {})
    _report("idempotent_attribution_stable",
            first == second,
            f"first_keys={sorted(first)} second_keys={sorted(second)}")


def test_preserves_existing_analysis_fields() -> None:
    payload = {
        "summary": "shots fired",
        "alert_level": "critical",
        "keywords": ["shooting", "shots fired"],
        "incident_candidate": {"title": "x"},
        "ui": {"headline": "y"},
        "raw": {"foo": "bar"},
        "prompt_id": "pmpt_abc",
        "prompt_version": "1",
    }
    _stamp(payload, {"channel_id": "apd", "talkgroup_num": "13102"})
    _report("summary_preserved", payload["summary"] == "shots fired")
    _report("keywords_preserved",
            payload["keywords"] == ["shooting", "shots fired"])
    _report("alert_level_preserved", payload["alert_level"] == "critical")
    _report("incident_candidate_preserved",
            payload["incident_candidate"] == {"title": "x"})
    _report("ui_preserved", payload["ui"] == {"headline": "y"})
    _report("attribution_now_present",
            payload.get("attribution", {}).get("channel_id") == "apd")


# ---------------------------------------------------------------------------
# Wiring: both call sites use the helper
# ---------------------------------------------------------------------------

def test_call_sites_invoke_helper() -> None:
    """Static contract: the two analyze_scanner_transcript call sites
    in api_server invoke _stamp_attribution_on_analysis on the result."""
    with open(os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "api_server.py"), "r", encoding="utf-8") as f:
        src = f.read()
    # Both call sites should call _stamp_attribution_on_analysis
    # immediately after analysis = await analyze_scanner_transcript(...)
    count = src.count("_stamp_attribution_on_analysis(analysis,")
    _report("two_call_sites_stamp_attribution", count >= 2,
            f"found {count} call sites; expected at least 2")


def main() -> None:
    test_schema_has_attribution_field()
    test_attribution_via_channel_id_stamp()
    test_attribution_via_talkgroup_reverse_lookup()
    test_attribution_picks_single_agency_over_composite()
    test_agency_keys_flat_naming()
    test_stream_monitor_feed_keys()
    test_empty_call_omits_attribution_block()
    test_unknown_talkgroup_omits_channel_keys()
    test_defensive_against_bad_inputs()
    test_idempotent_stamping()
    test_preserves_existing_analysis_fields()
    test_call_sites_invoke_helper()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
