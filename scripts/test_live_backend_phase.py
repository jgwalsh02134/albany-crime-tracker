#!/usr/bin/env python3
"""Regression tests for the split-cadence / talkgroup-prompt / source-health
backend phase. All tests run without a DB or network — they exercise pure
helpers and introspect registered routes.

Run: python scripts/test_live_backend_phase.py
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


def test_scanner_ingest_interval_env() -> None:
    os.environ.pop("SCANNER_INGEST_SECONDS", None)
    _report(
        "scanner_ingest_default_disabled",
        api_server._background_scanner_ingest_interval_s() == 0.0,
    )
    os.environ["SCANNER_INGEST_SECONDS"] = "30"
    _report(
        "scanner_ingest_env_30",
        api_server._background_scanner_ingest_interval_s() == 30.0,
    )
    os.environ["SCANNER_INGEST_SECONDS"] = "not-a-number"
    _report(
        "scanner_ingest_bad_value_falls_back_to_zero",
        api_server._background_scanner_ingest_interval_s() == 0.0,
    )
    os.environ.pop("SCANNER_INGEST_SECONDS", None)


def test_crime_ingest_interval_env_unchanged() -> None:
    # Preserve existing behavior: default 120 when unset.
    os.environ.pop("BACKGROUND_CRIME_INGEST_SECONDS", None)
    _report(
        "crime_ingest_default_120",
        api_server._background_crime_ingest_interval_s() == 120.0,
    )


def test_scanner_discipline_classifier() -> None:
    cases = [
        ({"talkgroup_tag": "APD Dispatch"}, "police"),
        ({"talkgroup_description": "Albany City Police Dispatch"}, "police"),
        ({"talkgroup_tag": "NYSP Troop G"}, "police"),
        ({"talkgroup_description": "Sheriff Primary"}, "police"),
        ({"talkgroup_tag": "APFD Fireground 1"}, "fire"),
        ({"talkgroup_description": "Colonie Fire Dispatch"}, "fire"),
        ({"talkgroup_tag": "Engine 1"}, "fire"),
        ({"talkgroup_description": "Albany EMS Medic"}, "ems"),
        ({"talkgroup_tag": "Mohawk Ambulance"}, "ems"),
        ({"talkgroup_description": "Paramedic Channel"}, "ems"),
        ({"talkgroup_tag": ""}, "unknown"),
        ({}, "unknown"),
        ({"talkgroup_tag": "General Ops"}, "unknown"),
    ]
    for call, expected in cases:
        got = api_server._scanner_discipline_from_call(call)
        _report(
            f"discipline_{expected}_{str(call)[:50]}",
            got == expected,
            f"expected={expected} got={got}",
        )


def test_scanner_prompt_selection() -> None:
    # Each discipline returns a prompt containing discipline-specific jargon.
    police = api_server._scanner_transcribe_prompt({"talkgroup_tag": "APD Dispatch"})
    _report("police_prompt_mentions_police_terms",
            "police" in police.lower() and "pursuit" in police.lower())

    fire = api_server._scanner_transcribe_prompt({"talkgroup_tag": "APFD Engine 1"})
    _report("fire_prompt_mentions_fire_terms",
            "fire" in fire.lower() and "engine" in fire.lower())

    ems = api_server._scanner_transcribe_prompt({"talkgroup_tag": "Mohawk Ambulance"})
    _report("ems_prompt_mentions_ems_terms",
            "ems" in ems.lower() and "ambulance" in ems.lower())

    # Unknown call falls back to the base prompt (never regresses below current).
    unknown = api_server._scanner_transcribe_prompt({})
    _report("unknown_prompt_uses_base",
            unknown == api_server._SCANNER_TRANSCRIBE_PROMPT_BASE)

    # All prompts mention Albany County so the locality hint is preserved.
    for label, p in (("police", police), ("fire", fire), ("ems", ems), ("unknown", unknown)):
        _report(f"{label}_prompt_has_albany_county_hint",
                "albany county" in p.lower())


def test_source_health_route_registered() -> None:
    routes = {getattr(r, "path", None) for r in api_server.app.routes}
    _report("source_health_route_registered",
            "/api/sources/health" in routes)


def test_background_ingest_stats_shape() -> None:
    stats = api_server._BACKGROUND_INGEST_STATS
    _report("stats_has_crime_key", "crime" in stats)
    _report("stats_has_scanner_key", "scanner" in stats)
    for key in ("enabled", "interval_s", "last_tick_at", "last_error"):
        _report(f"crime_stats_has_{key}", key in stats["crime"])
        _report(f"scanner_stats_has_{key}", key in stats["scanner"])
    _report("scanner_stats_has_last_merged_count",
            "last_merged_count" in stats["scanner"])


def main() -> None:
    test_scanner_ingest_interval_env()
    test_crime_ingest_interval_env_unchanged()
    test_scanner_discipline_classifier()
    test_scanner_prompt_selection()
    test_source_health_route_registered()
    test_background_ingest_stats_shape()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
