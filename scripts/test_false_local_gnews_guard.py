#!/usr/bin/env python3
"""Regression tests: false-local Google News / force-label items must not pass strict Albany County gate.

Run: python scripts/test_false_local_gnews_guard.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_server import evaluate_strict_albany_county

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
    # (a) Fake official label must not anchor Georgia / GBI story
    fake_gnews = {
        "title": "GBI investigating shooting in Ocilla",
        "description": "Put the guns down — state agents are on scene.",
        "source": "Official · City of Albany Police Department",
        "link": "https://news.google.com/rss/articles/foo",
        "guid": "gnews-ocilla-1",
    }
    ok, reason = evaluate_strict_albany_county(fake_gnews)
    _report(
        "reject_fake_official_gbi_ocilla",
        not ok and reason.startswith("out_of_area:"),
        f"got ok={ok!r} reason={reason!r}",
    )

    # (b) Delmar, MD must not pass via weak Delmar (NY) locality
    delmar_md = {
        "title": "Delmar, MD – Three-Vehicle Crash on Route 13",
        "description": "Maryland State Police responded Sunday.",
        "source": "WRDE",
        "link": "https://example.com/delmar-md-crash",
        "guid": "delmar-md-1",
    }
    ok, reason = evaluate_strict_albany_county(delmar_md)
    _report(
        "reject_delmar_maryland",
        not ok and reason.startswith("out_of_area:"),
        f"got ok={ok!r} reason={reason!r}",
    )

    # (c) Real City of Albany
    albany_park = {
        "title": "Police investigating stabbing in Washington Park in Albany",
        "description": "",
        "source": "WNYT",
        "link": "https://wnyt.com/albany-stabbing",
        "guid": "albany-park-1",
    }
    ok, reason = evaluate_strict_albany_county(albany_park)
    _report(
        "accept_albany_washington_park",
        ok,
        f"got ok={ok!r} reason={reason!r}",
    )

    # (d) Neighboring Albany County munis
    cohoes = {
        "title": "Fire crews respond to structure fire on Central Avenue in Cohoes",
        "description": "",
        "source": "Spectrum News",
        "link": "https://example.com/cohoes-fire",
        "guid": "cohoes-1",
    }
    ok, reason = evaluate_strict_albany_county(cohoes)
    _report(
        "accept_cohoes",
        ok,
        f"got ok={ok!r} reason={reason!r}",
    )

    colonie = {
        "title": "Colonie police seek suspect in overnight burglary on Wolf Road",
        "description": "",
        "source": "Times Union",
        "link": "https://example.com/colonie-burglary",
        "guid": "colonie-1",
    }
    ok, reason = evaluate_strict_albany_county(colonie)
    _report(
        "accept_colonie",
        ok,
        f"got ok={ok!r} reason={reason!r}",
    )

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
