#!/usr/bin/env python3
"""Regression tests for the source-strengthening pass.

Covers:
  - talkgroup_id_to_agency() resolves numeric scanner talkgroups via
    data/scanner_aliases.json + the canonical agency registry,
  - talkgroup_mapping_coverage() returns total / canonical_resolved /
    unmapped counts,
  - resolve_agency_from_call() now falls back to numeric talkgroup_num
    when no tag fields resolve,
  - Socrata background-ingest helpers exist with safe defaults
    (disabled when SOCRATA_INGEST_SECONDS is unset / 0 / malformed),
  - /api/sources/health route still registered and surfaces the new
    keys (scanner_talkgroup_mapping, ingest_loops.socrata).

Run: python scripts/test_source_strengthening.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server
from app.services.agency_registry import (
    load_scanner_aliases,
    resolve_agency_from_call,
    talkgroup_id_to_agency,
    talkgroup_mapping_coverage,
)

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


def test_scanner_aliases_loadable() -> None:
    doc = load_scanner_aliases()
    _report("scanner_aliases_returns_dict", isinstance(doc, dict))
    _report("scanner_aliases_has_talkgroups_key", "talkgroups" in doc)
    _report("scanner_aliases_talkgroups_is_dict",
            isinstance(doc.get("talkgroups"), dict))


def test_talkgroup_id_to_agency() -> None:
    # Spot-check a few well-known mappings from the existing
    # data/scanner_aliases.json file. These are the canonical entries
    # the v6-redesign + agency-registry layers expect to resolve.
    cases = [
        ("13102", "apd"),           # Albany Police Dispatch
        ("15202", "acso"),          # Albany County Sheriff Law Dispatch
        ("10401", "colonie_pd"),    # Colonie Police Dispatch
        ("10502", "bethlehem_pd"),  # Bethlehem Police Dispatch
        ("10601", "cohoes_pd"),     # Cohoes Police Dispatch
    ]
    for tg, expected in cases:
        a = talkgroup_id_to_agency(tg)
        got = (a or {}).get("agency_id")
        _report(f"tg_{tg}_resolves_to_{expected}", got == expected, f"got={got!r}")

    # Defensive against unknown / empty / wrong-type input — never raises.
    for bad in ("99999", "", None, 0, False, "abc", {}, []):
        _report(f"tg_id_{bad!r}_returns_none",
                talkgroup_id_to_agency(bad) is None)  # type: ignore[arg-type]


def test_talkgroup_mapping_coverage() -> None:
    cov = talkgroup_mapping_coverage()
    _report("coverage_has_required_keys",
            set(cov.keys()) == {"total", "canonical_resolved", "unmapped"},
            f"keys={sorted(cov.keys())}")
    _report("coverage_total_positive", cov["total"] > 0, f"total={cov['total']}")
    _report("coverage_resolved_lte_total",
            cov["canonical_resolved"] <= cov["total"])
    _report("coverage_unmapped_balances",
            cov["canonical_resolved"] + cov["unmapped"] == cov["total"])
    # The five core municipal PDs + ACSO talkgroups must all resolve, so
    # canonical_resolved must be at least 6.
    _report("coverage_resolved_at_least_six",
            cov["canonical_resolved"] >= 6,
            f"resolved={cov['canonical_resolved']}")


def test_resolve_agency_from_call_uses_id_fallback() -> None:
    # tag-only path still works (regression check for 6a71eca behavior)
    a1 = resolve_agency_from_call({"talkgroup_description": "Bethlehem Police Dispatch"})
    _report("tag_path_still_resolves_bethlehem",
            (a1 or {}).get("agency_id") == "bethlehem_pd")

    # NEW: numeric-id-only path resolves via scanner_aliases.json fallback.
    for tg, expected in [("13102", "apd"), ("15202", "acso"), ("10502", "bethlehem_pd")]:
        a = resolve_agency_from_call({"talkgroup_num": tg})
        _report(f"id_only_path_resolves_{expected}_for_{tg}",
                (a or {}).get("agency_id") == expected)

    # Tag wins over ID when both present and they conflict — first-match
    # semantics in resolve_agency_from_call() (tag fields walked before
    # the ID fallback).
    a = resolve_agency_from_call({"talkgroup_description": "Bethlehem Police Dispatch",
                                  "talkgroup_num": "13102"})  # 13102 = APD by id
    _report("tag_wins_over_id_when_both_present",
            (a or {}).get("agency_id") == "bethlehem_pd",
            f"got={(a or {}).get('agency_id')!r}")

    # Unknown ID returns None, doesn't raise.
    _report("unknown_id_returns_none",
            resolve_agency_from_call({"talkgroup_num": "99999"}) is None)


def test_socrata_loop_helpers() -> None:
    # Default behavior: disabled when env is unset or 0.
    os.environ.pop("SOCRATA_INGEST_SECONDS", None)
    _report("socrata_default_disabled",
            api_server._background_socrata_ingest_interval_s() == 0.0)

    os.environ["SOCRATA_INGEST_SECONDS"] = "1800"
    _report("socrata_env_1800",
            api_server._background_socrata_ingest_interval_s() == 1800.0)

    # Malformed env falls back to 0 rather than raising at startup.
    os.environ["SOCRATA_INGEST_SECONDS"] = "not-a-number"
    _report("socrata_bad_value_falls_back_to_zero",
            api_server._background_socrata_ingest_interval_s() == 0.0)
    os.environ.pop("SOCRATA_INGEST_SECONDS", None)

    # Required public API surface.
    for name in (
        "_background_socrata_ingest_interval_s",
        "_background_socrata_ingest_loop",
        "start_background_socrata_ingest",
        "stop_background_socrata_ingest",
    ):
        _report(f"api_server_has_{name}", hasattr(api_server, name))

    # Stat shape required by /api/sources/health.
    socrata_stats = api_server._BACKGROUND_INGEST_STATS.get("socrata") or {}
    for key in ("enabled", "interval_s", "last_tick_at",
                "last_persisted_count", "last_error"):
        _report(f"socrata_stats_has_{key}", key in socrata_stats)


def test_health_route_registered() -> None:
    routes = {getattr(r, "path", None) for r in api_server.app.routes}
    _report("health_route_still_registered",
            "/api/sources/health" in routes)


def main() -> None:
    test_scanner_aliases_loadable()
    test_talkgroup_id_to_agency()
    test_talkgroup_mapping_coverage()
    test_resolve_agency_from_call_uses_id_fallback()
    test_socrata_loop_helpers()
    test_health_route_registered()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
