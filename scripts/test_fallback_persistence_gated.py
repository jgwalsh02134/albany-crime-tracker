#!/usr/bin/env python3
"""Regression test: the empty-pipeline fallback persistence path MUST run every
article through is_albany_related() before persisting. Previously it persisted
the first 250 raw feed rows unfiltered, which let false-local items (Albany, GA;
federal wire) land in the DB and surface on the map/timeline.

This test reproduces the exact filter used in the fallback branch of
api_server.get_crimes() and asserts it rejects the known false-local cases.

Run: python scripts/test_fallback_persistence_gated.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_server import is_albany_related

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
    raw_feed = [
        {
            "title": "Police investigating homicide in Arbor Hill",
            "description": "Albany Police responded Tuesday.",
            "source": "Times Union",
            "link": "https://timesunion.com/albany-homicide",
            "guid": "a1",
        },
        {
            "title": "GBI investigating shooting in Ocilla",
            "description": "Georgia state agents on scene.",
            "source": "Official · Albany",
            "link": "https://news.google.com/rss/articles/ga",
            "guid": "a2",
        },
        {
            "title": "Delmar, MD – Three-Vehicle Crash on Route 13",
            "description": "Maryland State Police responded.",
            "source": "WRDE",
            "link": "https://example.com/delmar-md",
            "guid": "a3",
        },
        {
            "title": "Colonie police seek suspect in Wolf Road burglary",
            "description": "",
            "source": "Spectrum News",
            "link": "https://example.com/colonie",
            "guid": "a4",
        },
    ]

    # Simulate the fixed fallback branch from api_server.get_crimes()
    rows_for_persistence = [a for a in raw_feed if is_albany_related(a)][:250]

    titles = [r["title"] for r in rows_for_persistence]

    _report(
        "keeps_real_albany_ny_incident",
        any("Arbor Hill" in t for t in titles),
        f"titles={titles}",
    )
    _report(
        "keeps_colonie_albany_county",
        any("Colonie" in t for t in titles),
        f"titles={titles}",
    )
    _report(
        "drops_georgia_ocilla_from_fallback",
        not any("Ocilla" in t for t in titles),
        f"titles={titles}",
    )
    _report(
        "drops_maryland_delmar_from_fallback",
        not any("Delmar, MD" in t for t in titles),
        f"titles={titles}",
    )

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
