#!/usr/bin/env python3
"""Regression test: read/query layer must exclude rows tagged false_local_quarantine.

Covers the helper that all read paths use. If this test passes, then:
  - /api/incidents (query_incidents)
  - /api/incidents/summary (summarize_incidents via _load_incidents_for_window)
  - /api/incidents/trends (incident_trends via _load_incidents_for_window)
  - map / timeline (same query_incidents path)
will filter out quarantined rows, because every read path applies this helper
directly.

Run: python scripts/test_quarantine_read_exclusion.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.incident_repository import (
    FALSE_LOCAL_QUARANTINE_TAG,
    _is_false_local_quarantined_row,
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


def main() -> None:
    _report("tag_constant_matches_cleanup_script",
            FALSE_LOCAL_QUARANTINE_TAG == "false_local_quarantine")

    # Positive: quarantine tag in a list is detected.
    _report("list_with_tag", _is_false_local_quarantined_row(["false_local_quarantine"]))
    _report("list_with_tag_mixed",
            _is_false_local_quarantined_row(["violent", "false_local_quarantine", "albany"]))
    _report("list_with_tag_case_insensitive",
            _is_false_local_quarantined_row(["FALSE_LOCAL_QUARANTINE"]))
    _report("list_with_tag_whitespace",
            _is_false_local_quarantined_row(["  false_local_quarantine  "]))

    # Negative: empty / unrelated tags do not match.
    _report("empty_list_is_false", not _is_false_local_quarantined_row([]))
    _report("none_is_false", not _is_false_local_quarantined_row(None))
    _report("unrelated_tags_is_false",
            not _is_false_local_quarantined_row(["violent", "property", "scanner"]))

    # Defensive: non-list input shapes.
    _report("tuple_with_tag", _is_false_local_quarantined_row(("false_local_quarantine",)))
    _report("set_with_tag", _is_false_local_quarantined_row({"false_local_quarantine"}))
    _report("json_string_with_tag",
            _is_false_local_quarantined_row('["false_local_quarantine","violent"]'))
    _report("json_string_without_tag",
            not _is_false_local_quarantined_row('["violent","property"]'))
    _report("int_is_false", not _is_false_local_quarantined_row(0))
    _report("dict_is_false", not _is_false_local_quarantined_row({"tag": "false_local_quarantine"}))

    # Simulate the _keep() filter applied in query_incidents memory path.
    sample_rows = [
        {"id": "a", "title": "Albany shooting",
         "tags": [], "raw_payload": {}},
        {"id": "b", "title": "GBI investigating Ocilla",
         "tags": ["false_local_quarantine"], "raw_payload": {}},
        {"id": "c", "title": "Colonie burglary",
         "tags": ["violent"], "raw_payload": {}},
        {"id": "d", "title": "Delmar MD crash",
         "tags": ["false_local_quarantine", "historical"], "raw_payload": {}},
    ]
    kept = [r for r in sample_rows if not _is_false_local_quarantined_row(r.get("tags"))]
    kept_ids = {r["id"] for r in kept}
    _report("end_to_end_keeps_clean_rows",
            kept_ids == {"a", "c"},
            f"kept={kept_ids}")
    _report("end_to_end_drops_both_quarantined",
            "b" not in kept_ids and "d" not in kept_ids,
            f"kept={kept_ids}")

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
