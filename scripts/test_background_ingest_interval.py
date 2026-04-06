#!/usr/bin/env python3
"""Unit checks for api_server._background_crime_ingest_interval_s (env BACKGROUND_CRIME_INGEST_SECONDS)."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> None:
    import api_server as m

    failed = 0
    cases = [
        ("120", 120.0),
        ("0", 0.0),
        ("90", 90.0),
        ("not-a-number", 120.0),
    ]
    for raw, want in cases:
        os.environ["BACKGROUND_CRIME_INGEST_SECONDS"] = raw
        got = m._background_crime_ingest_interval_s()
        if got != want:
            print(f"FAIL BACKGROUND_CRIME_INGEST_SECONDS={raw!r} want={want} got={got}")
            failed += 1
        else:
            print(f"PASS BACKGROUND_CRIME_INGEST_SECONDS={raw!r} -> {got}")

    del os.environ["BACKGROUND_CRIME_INGEST_SECONDS"]
    got_default = m._background_crime_ingest_interval_s()
    if got_default != 120.0:
        print(f"FAIL default want=120.0 got={got_default}")
        failed += 1
    else:
        print("PASS default unset -> 120.0")

    if failed:
        sys.exit(1)
    print(f"\n{len(cases) + 1}/{len(cases) + 1} tests passed")


if __name__ == "__main__":
    main()
