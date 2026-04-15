#!/usr/bin/env python3
"""Regression test for the data-state cleanup pass:

1. WALB and other Albany-Georgia outlets are rejected by the locality
   gate via NON_LOCAL_SOURCES, regardless of whether the article text
   says "Albany, GA" verbatim. The text-only filter missed them in
   production (~9 rows survived).

2. Real Albany, NY outlets (Times Union, WNYT, etc.) are NOT collateral
   damage from the WALB additions.

3. The cleanup_false_local_incidents.py _is_hard_false_local helper
   recognizes WALB-class sources as HARD false-local so re-running the
   cleanup script's --quarantine flow targets them by default (without
   needing --include-soft).

4. The new backfill_incident_sources.py script:
   - exposes its module-level _COUNT_SQL and _BACKFILL_SQL
   - the BACKFILL_SQL produces a single-element JSONB array whose shape
     matches _build_source_entry() so the data converges with new-row
     inserts done through _to_orm()

Run: python scripts/test_walb_suppression_and_backfill.py
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server
from app.services.incident_repository import _build_source_entry  # noqa: F401

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
# 1. Locality gate WALB suppression
# ---------------------------------------------------------------------------

def test_walb_in_non_local_sources_set() -> None:
    nls = api_server.NON_LOCAL_SOURCES
    for needle in ("walb", "wfxl", "albany herald"):
        _report(f"NON_LOCAL_SOURCES_contains_{needle}", needle in nls)


def test_walb_rejected_by_locality_gate() -> None:
    cases = [
        # source name alone is the giveaway, even when title says only "Albany"
        {"title": "Albany police investigation continues",
         "description": "Suspect in custody", "source": "WALB",
         "link": "https://walb.com/x"},
        # case-insensitive
        {"title": "x", "source": "walb", "link": "https://walb.com/y"},
        # substring inside a longer source name
        {"title": "x", "source": "WALB News 10", "link": "https://walb.com/z"},
        # peer GA-affiliate
        {"title": "x", "source": "WFXL FOX 31", "link": "https://wfxl.com/x"},
        # GA newspaper
        {"title": "x", "source": "Albany Herald", "link": "https://albanyherald.com/x"},
    ]
    for art in cases:
        ok, reason = api_server.evaluate_strict_albany_county(art)
        _report(
            f"reject_{art['source']!r}",
            (not ok) and reason.startswith("non_local_source:"),
            f"ok={ok!r} reason={reason!r}",
        )


def test_real_albany_ny_sources_not_collateral_damage() -> None:
    # These must continue to pass when the text anchors Albany County.
    cases = [
        {"title": "Albany County Sheriff investigates Coeymans crash",
         "description": "Albany County, NY",
         "source": "Times Union", "link": "https://timesunion.com/x"},
        {"title": "Bethlehem Police arrest suspect on Delaware Avenue",
         "source": "WNYT", "link": "https://wnyt.com/x"},
        {"title": "Colonie Police seek man in Wolf Road incident",
         "source": "Spectrum News 1 Capital Region",
         "link": "https://spectrumlocalnews.com/x"},
    ]
    for art in cases:
        ok, reason = api_server.evaluate_strict_albany_county(art)
        _report(
            f"accept_{art['source']!r}",
            ok,
            f"ok={ok!r} reason={reason!r}",
        )


# ---------------------------------------------------------------------------
# 2. Cleanup-script HARD-classifier targets WALB
# ---------------------------------------------------------------------------

def test_cleanup_hard_classifier_includes_walb() -> None:
    spec = importlib.util.spec_from_file_location(
        "_cleanup_walb",
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "scripts", "cleanup_false_local_incidents.py",
        ),
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    for needle in ("walb", "wfxl", "albany herald"):
        _report(f"cleanup_HARD_markers_contains_{needle}",
                needle in mod._HARD_FALSE_LOCAL_MARKERS)

    # Functional check: a row whose raw_payload mentions WALB classifies HARD.
    walb_row = {
        "id": "abc",
        "title": "Albany police arrest",
        "raw_payload": {
            "title": "Albany police arrest",
            "source": "WALB",
            "link": "https://walb.com/x",
        },
    }
    _report("cleanup_classifies_walb_row_as_HARD",
            mod._is_hard_false_local(walb_row))


# ---------------------------------------------------------------------------
# 3. Backfill script — load + SQL shape parity with _build_source_entry
# ---------------------------------------------------------------------------

def test_backfill_script_loads_and_exposes_sql() -> None:
    spec = importlib.util.spec_from_file_location(
        "_backfill_inc",
        os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "scripts", "backfill_incident_sources.py",
        ),
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    spec.loader.exec_module(mod)  # type: ignore[union-attr]

    _report("backfill_module_has_count_sql",
            isinstance(getattr(mod, "_COUNT_SQL", None), str))
    _report("backfill_module_has_backfill_sql",
            isinstance(getattr(mod, "_BACKFILL_SQL", None), str))

    sql = mod._BACKFILL_SQL
    # Keys must mirror _build_source_entry exactly so backfill rows are
    # indistinguishable from new-row inserts.
    for key in ("'name'", "'url'", "'agency_id'", "'first_seen_at'"):
        _report(f"backfill_sql_emits_key_{key}",
                key in sql,
                f"sql_excerpt={sql[:200]!r}")

    # Must only target rows where sources is null or empty.
    _report("backfill_count_sql_targets_null_or_empty",
            "sources IS NULL OR jsonb_array_length(sources) = 0"
            in mod._COUNT_SQL)
    _report("backfill_apply_sql_targets_null_or_empty",
            "sources IS NULL OR jsonb_array_length(sources) = 0" in sql)

    # Must use jsonb_build_array of one jsonb_build_object — single-entry
    # bootstrap matching _to_orm()'s init shape.
    _report("backfill_writes_single_element_jsonb_array",
            "jsonb_build_array(" in sql and "jsonb_build_object(" in sql)

    # Must accept a :lim parameter so callers can throttle.
    _report("backfill_sql_uses_limit_param",
            ":lim" in sql)


def test_build_source_entry_keys_match_backfill_sql() -> None:
    """Sanity: the 4 keys _build_source_entry emits are the 4 the
    backfill SQL writes. If someone changes one without the other, this
    test catches the drift."""
    from app.models.incident import IncidentRecord
    rec = IncidentRecord(id="x", title="t", source_name="WNYT",
                         source_url="https://wnyt.example/x")
    entry = _build_source_entry(rec)
    expected = {"name", "url", "agency_id", "first_seen_at"}
    _report("build_source_entry_keys_unchanged",
            set(entry.keys()) == expected,
            f"got={sorted(entry.keys())}")


def main() -> None:
    test_walb_in_non_local_sources_set()
    test_walb_rejected_by_locality_gate()
    test_real_albany_ny_sources_not_collateral_damage()
    test_cleanup_hard_classifier_includes_walb()
    test_backfill_script_loads_and_exposes_sql()
    test_build_source_entry_keys_match_backfill_sql()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
