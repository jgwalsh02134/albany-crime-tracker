#!/usr/bin/env python3
"""Unit tests for _is_scanner_conventional_stored_row (incident read-path filter)."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.incident_repository import _is_scanner_conventional_stored_row

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
    _report("empty_payload", not _is_scanner_conventional_stored_row(None))
    _report("empty_dict", not _is_scanner_conventional_stored_row({}))
    _report("true_bool", _is_scanner_conventional_stored_row({"_scanner_conventional": True}))
    _report("false_bool", not _is_scanner_conventional_stored_row({"_scanner_conventional": False}))
    _report("string_true", _is_scanner_conventional_stored_row({"_scanner_conventional": "true"}))
    _report("string_1", _is_scanner_conventional_stored_row({"_scanner_conventional": "1"}))
    _report("int_1", _is_scanner_conventional_stored_row({"_scanner_conventional": 1}))
    _report("openmhz_no_flag", not _is_scanner_conventional_stored_row({"_scanner_call": True, "title": "Radio · Test"}))
    _report("legacy_title_only", not _is_scanner_conventional_stored_row({"title": "SCANNER · NYSP — Latham"}))

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
