#!/usr/bin/env python3
"""Regression test: the cleanup script's _reclassify() predicate must flag the
known false-local patterns (Albany GA / Dougherty County / GBI / Delmar MD) when
they appear in raw_payload, and must NOT flag real Albany County, NY rows.

Run: python scripts/test_cleanup_flagging.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.cleanup_false_local_incidents import (  # type: ignore
    _reclassify,
    _is_hard_false_local,
    _in_albany_county_bbox,
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


def row(title: str = "", description: str = "", source: str = "", link: str = "") -> dict:
    return {
        "id": "x",
        "title": title,
        "description": description,
        "source_name": source,
        "source_url": link,
        "raw_payload": {
            "title": title,
            "description": description,
            "source": source,
            "link": link,
        },
    }


def main() -> None:
    cases = [
        ("flag_albany_ga",
         row("Albany, GA man arrested after chase", "Dougherty County deputies on scene",
             source="WALB", link="https://walb.com/albany-ga"),
         "flag"),
        ("flag_gbi_ocilla",
         row("GBI investigating shooting in Ocilla", "Georgia state agents on scene",
             source="Official · Albany", link="https://news.google.com/rss/articles/ga"),
         "flag"),
        ("flag_delmar_md",
         row("Delmar, MD – Three-Vehicle Crash on Route 13",
             "Maryland State Police responded Sunday.", source="WRDE"),
         "flag"),
        ("flag_dougherty_county",
         row("Dougherty County fire crews battle blaze", "", source="WALB"),
         "flag"),
        ("pass_albany_ny_arbor_hill",
         row("Police investigating homicide in Arbor Hill",
             "Albany Police responded Tuesday.", source="Times Union",
             link="https://timesunion.com/foo"),
         "pass"),
        ("pass_colonie",
         row("Colonie police seek suspect in Wolf Road burglary",
             "", source="Spectrum News"),
         "pass"),
        ("pass_bethlehem_ny",
         row("Bethlehem Police respond to Delaware Avenue crash",
             "", source="Times Union"),
         "pass"),
        ("skip_empty_payload",
         {"id": "y", "title": "", "description": "", "source_name": "",
          "source_url": "", "raw_payload": {}},
         "raw_payload_missing"),
    ]

    for name, r, expected in cases:
        verdict, reason = _reclassify(r)
        _report(name, verdict == expected, f"got verdict={verdict} reason={reason}")

    # Hard vs soft classifier
    _report(
        "hard_classifier_albany_ga",
        _is_hard_false_local(row("Albany, GA shooting", source="WALB")),
    )
    _report(
        "hard_classifier_gbi",
        _is_hard_false_local(row("GBI investigating shooting in Ocilla")),
    )
    _report(
        "hard_classifier_delmar_md",
        _is_hard_false_local(row("Delmar, MD crash on Route 13")),
    )
    _report(
        "soft_classifier_troy",
        not _is_hard_false_local(row("Troy police say gun removed from streets")),
    )
    _report(
        "soft_classifier_saratoga",
        not _is_hard_false_local(row("Saratoga County assault sentencing")),
    )

    # Geo bbox protection
    _report("bbox_inside_albany", _in_albany_county_bbox(42.65, -73.75))
    _report("bbox_outside_georgia", not _in_albany_county_bbox(31.58, -84.15))
    _report("bbox_outside_maryland", not _in_albany_county_bbox(38.45, -75.58))
    _report("bbox_none_is_false", not _in_albany_county_bbox(None, None))

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
