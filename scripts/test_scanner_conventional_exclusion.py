#!/usr/bin/env python3
"""Prove conventional scanner directory rows are not treated as live crime incidents."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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
    from api_server import _scanner_call_has_actionable_incident, is_crime_related

    conventional = {
        "title": "SCANNER · NYSP — Latham: Troop G base frequency",
        "description": "462.0000 MHz · Directory conventional frequency listing.",
        "source": "Scanner · NYSP",
        "_scanner_call": True,
        "_scanner_recent_live": True,
        "_scanner_conventional": True,
        "municipality": "Latham",
    }
    openmhz_routine = {
        "title": "Radio · Albany County E911 — Albany County: County Fire Dispatch",
        "description": "45s audio · County Fire Dispatch",
        "source": "Scanner · Albany County Feed",
        "_scanner_call": True,
        "_scanner_recent_live": True,
        "_scanner_critical_live": False,
        "municipality": "Albany County",
    }

    _report(
        "conventional_not_actionable",
        not _scanner_call_has_actionable_incident(conventional),
        "expected non-actionable conventional directory row",
    )
    _report(
        "conventional_not_crime_related",
        not is_crime_related(conventional),
        "conventional should not enter crime pipeline",
    )
    _report(
        "openmhz_recent_still_actionable",
        _scanner_call_has_actionable_incident(openmhz_routine),
        "OpenMHz recent calls remain eligible",
    )
    _report(
        "openmhz_recent_crime_related",
        is_crime_related(openmhz_routine),
        "OpenMHz recent call should stay crime-related for merge",
    )

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
