#!/usr/bin/env python3
"""Regression test for scripts/backfill_responding_agency_id.py.

Covers the three things that make the script safe:
  - row-to-article shaping prefers raw_payload but falls back to scalar
    columns so legacy rows with sparse raw_payload still resolve,
  - resolution semantics match new-ingest behavior (uses the same
    _resolve_responding_agency_id helper from incident_transformers),
  - the script never invents an agency: rows whose source doesn't map
    to a canonical record stay None and are NOT written.

Also asserts the SQL contracts: SELECT targets only NULL rows, UPDATE
uses an idempotency clause that prevents clobbering concurrent writes.

Run: python scripts/test_backfill_responding_agency_id.py
"""
from __future__ import annotations

import importlib.util
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_script_module():
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "scripts", "backfill_responding_agency_id.py",
    )
    spec = importlib.util.spec_from_file_location("_backfill_resp_aid", path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec and spec.loader
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


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


def test_module_loads_and_exposes_sql() -> None:
    mod = _load_script_module()
    _report("module_has_select_sql",
            isinstance(getattr(mod, "_SELECT_SQL", None), str))
    _report("module_has_update_sql",
            isinstance(getattr(mod, "_UPDATE_SQL", None), str))
    _report("select_targets_null_only",
            "responding_agency_id IS NULL" in mod._SELECT_SQL)
    # UPDATE must keep the IS NULL clause so the script never clobbers a
    # value written by a concurrent ingest between SELECT and UPDATE.
    _report("update_keeps_null_clause",
            "WHERE id = :id AND responding_agency_id IS NULL"
            in mod._UPDATE_SQL)
    _report("select_uses_lim_param", ":lim" in mod._SELECT_SQL)
    _report("update_uses_aid_param", ":aid" in mod._UPDATE_SQL)


def test_row_to_article_prefers_raw_payload() -> None:
    mod = _load_script_module()
    row = {
        "id": "x",
        "source_name": "scalar-source",
        "source_url": "https://scalar/x",
        "raw_payload": {"title": "rp title", "source": "rp-source",
                        "link": "https://rp/y"},
    }
    art = mod._row_to_article(row)
    _report("uses_raw_payload_source", art.get("source") == "rp-source")
    _report("uses_raw_payload_link", art.get("link") == "https://rp/y")
    # Title should come from raw_payload too
    _report("uses_raw_payload_title", art.get("title") == "rp title")


def test_row_to_article_falls_back_to_scalars() -> None:
    mod = _load_script_module()
    # Sparse raw_payload — no source / link
    row = {
        "id": "y",
        "source_name": "ACSO",
        "source_url": "https://acso/x",
        "raw_payload": {"title": "t"},
    }
    art = mod._row_to_article(row)
    _report("falls_back_source_to_scalar", art.get("source") == "ACSO")
    _report("falls_back_link_to_scalar",
            art.get("link") == "https://acso/x")

    # raw_payload missing entirely
    row2 = {"id": "z", "source_name": "Bethlehem PD",
            "source_url": "https://bpd/x", "raw_payload": None}
    art2 = mod._row_to_article(row2)
    _report("none_raw_payload_falls_back",
            art2.get("source") == "Bethlehem PD")
    _report("none_raw_payload_link_fallback",
            art2.get("link") == "https://bpd/x")

    # raw_payload not a dict (defensive)
    row3 = {"id": "w", "source_name": "APD",
            "source_url": "https://apd/x", "raw_payload": "garbage"}
    art3 = mod._row_to_article(row3)
    _report("non_dict_raw_payload_falls_back",
            art3.get("source") == "APD")


def test_resolve_for_row_matches_new_ingest_semantics() -> None:
    mod = _load_script_module()
    cases = [
        # Recognized agency via source-name path (canonical resolver).
        ({"id": "a", "source_name": "Bethlehem PD", "source_url": "",
          "raw_payload": {}}, "bethlehem_pd"),
        ({"id": "b", "source_name": "Albany County Sheriff",
          "source_url": "", "raw_payload": {}}, "acso"),
        # Real production sample — "Official · City of Albany Police
        # Department" must resolve to apd via substring match.
        ({"id": "c",
          "source_name": "Official · City of Albany Police Department",
          "source_url": "", "raw_payload": {}}, "apd"),
        # NYSP press release. The canonical resolver matches via the
        # "nysp" or "troop g" aliases as substrings of the input source
        # name, so the test case must contain one of them. Plain
        # "New York State Police" intentionally does NOT resolve —
        # there's no substring overlap with any alias — and that's
        # correct: the registry models Troop G specifically, not the
        # statewide NYSP umbrella.
        ({"id": "d", "source_name": "NYSP Troop G",
          "source_url": "", "raw_payload": {}}, "nysp_troop_g"),
        ({"id": "d2", "source_name": "State Police, Troop G",
          "source_url": "", "raw_payload": {}}, "nysp_troop_g"),
        # Scanner-call attribution via raw_payload talkgroup id (closes
        # the gap when source_name is generic).
        ({"id": "e", "source_name": "Broadcastify", "source_url": "",
          "raw_payload": {"_scanner_call": True, "talkgroup_num": "13102"}},
         "apd"),
    ]
    for row, expected in cases:
        got = mod._resolve_for_row(row)
        _report(f"resolve_{row['source_name']!r}",
                got == expected,
                f"got={got!r} expected={expected!r}")


def test_resolve_for_row_returns_none_for_media() -> None:
    mod = _load_script_module()
    # Real production unresolved-source sample — these must NOT be
    # invented into agencies.
    for src in ("CBS6 Albany", "MSN", "The Daily Gazette",
                "NEWS10 Crime Feed", "News10 ABC", "Natalie St. Denis",
                "Cassie Abel", ""):
        row = {"id": "x", "source_name": src, "source_url": "",
               "raw_payload": {}}
        got = mod._resolve_for_row(row)
        _report(f"media_source_{src!r}_returns_none", got is None,
                f"got={got!r}")


def test_resolve_for_row_is_defensive() -> None:
    mod = _load_script_module()
    # Pathological inputs must never raise — the resolver wrapper
    # treats any exception as 'no match'.
    for row in (
        {"id": "x", "source_name": None, "source_url": None, "raw_payload": None},
        {"id": "x", "source_name": "", "source_url": "", "raw_payload": "garbage"},
        {"id": "x", "source_name": "WALB", "source_url": "", "raw_payload": {}},
    ):
        try:
            mod._resolve_for_row(row)
            _report(f"defensive_input_no_raise_{row.get('source_name')!r}", True)
        except Exception as exc:
            _report(f"defensive_input_no_raise_{row.get('source_name')!r}",
                    False, f"raised {exc}")


def main() -> None:
    test_module_loads_and_exposes_sql()
    test_row_to_article_prefers_raw_payload()
    test_row_to_article_falls_back_to_scalars()
    test_resolve_for_row_matches_new_ingest_semantics()
    test_resolve_for_row_returns_none_for_media()
    test_resolve_for_row_is_defensive()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
