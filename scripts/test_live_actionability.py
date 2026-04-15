#!/usr/bin/env python3
"""Regression test for operational ranking + scanner actionability on Live.

Closes the structural gap diagnosed in the prior "Live still article-led"
audit:
- /api/incidents now accepts sort_by="operational"
- query_incidents projects is_actionable_live on every row
- the operational sort ranks (actionable desc, severity desc, time desc)
- the frontend lifts its blanket scanner-exclusion for actionable rows

Static + functional coverage. Skips node block cleanly when node is not
on PATH.

Run: python scripts/test_live_actionability.py
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from app.services.incident_repository import _is_actionable_for_live  # noqa: E402

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


def _read(path: str) -> str:
    with open(os.path.join(REPO, path), "r", encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------------------
# Helper truth table
# ---------------------------------------------------------------------------

def test_helper_non_scanner_always_actionable() -> None:
    cases = [
        {"source_type": "local_news", "severity": "low",
         "title": "general news brief", "raw_payload": {}},
        {"source_type": "official", "severity": "medium",
         "title": "press release", "raw_payload": {}},
        {"source_type": "open_data", "severity": "low",
         "title": "stat report", "raw_payload": {}},
    ]
    for c in cases:
        _report(f"non_scanner_actionable_{c['source_type']}",
                _is_actionable_for_live(c) is True)


def test_helper_scanner_conventional_blocked() -> None:
    item = {
        "source_type": "scanner", "severity": "low",
        "title": "tones", "raw_payload": {"_scanner_conventional": True},
    }
    _report("scanner_conventional_blocked",
            _is_actionable_for_live(item) is False)


def test_helper_scanner_with_critical_live_flag() -> None:
    item = {
        "source_type": "scanner", "severity": "medium",
        "title": "10-13", "raw_payload": {"_scanner_critical_live": True},
    }
    _report("scanner_critical_live_flag_actionable",
            _is_actionable_for_live(item) is True)

    item2 = {
        "source_type": "scanner", "severity": "medium",
        "title": "stop", "raw_payload": {"_scanner_recent_live": True},
    }
    _report("scanner_recent_live_flag_actionable",
            _is_actionable_for_live(item2) is True)


def test_helper_scanner_high_severity() -> None:
    for sev in ("critical", "high"):
        item = {"source_type": "scanner", "severity": sev,
                "title": "standoff", "raw_payload": {}}
        _report(f"scanner_{sev}_severity_actionable",
                _is_actionable_for_live(item) is True)


def test_helper_scanner_keyword_match() -> None:
    cases = [
        ("shooting", "Shooting on Cedar Ave"),
        ("structure fire", "Structure fire reported"),
        ("pursuit", "Vehicle pursuit on I-90"),
        ("overdose", "Suspected overdose"),
        ("mvc", "MVC with entrapment"),
    ]
    for kw, title in cases:
        item = {"source_type": "scanner", "severity": "medium",
                "title": title, "raw_payload": {}}
        _report(f"scanner_keyword_{kw}_actionable",
                _is_actionable_for_live(item) is True)


def test_helper_scanner_chatter_blocked() -> None:
    cases = [
        {"source_type": "scanner", "severity": "low",
         "title": "general assist", "description": "non-emergency",
         "raw_payload": {}},
        {"source_type": "scanner", "severity": "low",
         "title": "radio check", "raw_payload": {}},
    ]
    for c in cases:
        _report(f"scanner_chatter_blocked_{c.get('title')!r}",
                _is_actionable_for_live(c) is False)


def test_helper_defensive() -> None:
    # None / wrong-type raw_payload must not raise.
    for raw in (None, "garbage", 0, [], 12345):
        try:
            _is_actionable_for_live({
                "source_type": "scanner", "severity": "high",
                "title": "shooting", "raw_payload": raw,
            })
            _report(f"defensive_raw_payload_{type(raw).__name__}_no_raise", True)
        except Exception as exc:
            _report(f"defensive_raw_payload_{type(raw).__name__}_no_raise",
                    False, f"raised {exc}")
    # Empty item
    _report("defensive_empty_item",
            _is_actionable_for_live({}) is True)  # default to non-scanner True


# ---------------------------------------------------------------------------
# Static contracts in the repository + frontend
# ---------------------------------------------------------------------------

def test_repo_projects_actionable_in_both_paths() -> None:
    src = _read("app/services/incident_repository.py")
    # _to_public_dict (memory path) stamps it.
    _report("memory_projection_stamps_actionable",
            'out["is_actionable_live"] = _is_actionable_for_live(out)' in src)
    # DB-row projection stamps it via post-pass.
    _report("db_projection_stamps_actionable",
            "for it in items:\n                it[\"is_actionable_live\"] = _is_actionable_for_live(it)"
            in src)
    # Backstop in _apply_post_filters.
    _report("post_filters_backfill_actionable",
            "if \"is_actionable_live\" not in it:" in src)


def test_repo_supports_operational_sort() -> None:
    src = _read("app/services/incident_repository.py")
    _report("repo_has_operational_branch", 'elif mode == "operational":' in src)
    _report("operational_sort_uses_actionable_first",
            re.search(
                r'mode == "operational"[\s\S]+?'
                r'1 if it\.get\("is_actionable_live"\) else 0',
                src,
            ) is not None)


def test_api_whitelists_operational_sort() -> None:
    src = _read("api_server.py")
    _report("api_whitelist_includes_operational",
            '"operational"' in src
            and 'if sort_mode not in ("newest", "severity", "verification", "priority", "operational")'
            in src)


def test_frontend_lifts_blanket_scanner_filter() -> None:
    src = _read("app.js")
    # _feedTabFromRecord now reads is_actionable_live before routing scanner
    # rows to scanner_only.
    _report("feedtab_reads_is_actionable_live",
            "r.is_actionable_live !== true" in src)
    # _toFeedItemFromIncident passes the flag through.
    _report("feed_item_carries_is_actionable_live",
            "is_actionable_live: r.is_actionable_live === true" in src)
    # fetchIncidents requests sort_by=operational.
    _report("fetchIncidents_requests_operational",
            'sort_by: "operational"' in src
            and "/api/incidents?limit=180&sort_by=operational" in src)
    # Old blanket-filter line is gone (the comment about lifting must remain
    # but the unconditional "if scanner → scanner_only" branch is replaced).
    _report("old_unconditional_scanner_block_replaced",
            'if (st === "scanner" || v === "scanner" || sn.indexOf("scanner") !== -1) return "scanner_only";'
            not in src)


# ---------------------------------------------------------------------------
# Functional via node — frontend _feedTabFromRecord behavior matrix
# ---------------------------------------------------------------------------

def _extract_feedtab() -> str:
    js = _read("app.js")
    start = js.find("  function _feedTabFromRecord(r)")
    if start == -1:
        raise RuntimeError("could not find _feedTabFromRecord in app.js")
    end = js.find("\n  }\n", start)
    if end == -1:
        raise RuntimeError("could not find end of _feedTabFromRecord block")
    return js[start:end + 4]


def test_frontend_routing_via_node() -> None:
    if shutil.which("node") is None:
        print("SKIP  node not on PATH — skipping _feedTabFromRecord checks.")
        return

    block = _extract_feedtab()
    test_js = block + r"""

function assert(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else      { console.log("  FAIL  " + name + "  " + (detail || "")); process.exitCode = 1; }
}

// Actionable scanner row → falls through scanner_only block, gets
// classified as "developing" (no other rule fires).
var scanner_actionable = {
  source_type: "scanner",
  verification_level: "scanner",
  source_name: "Broadcastify",
  is_actionable_live: true,
};
assert("actionable_scanner_not_excluded",
  _feedTabFromRecord(scanner_actionable) !== "scanner_only",
  "got=" + _feedTabFromRecord(scanner_actionable));

// Non-actionable scanner row → routes to scanner_only as before.
var scanner_chatter = {
  source_type: "scanner",
  verification_level: "scanner",
  source_name: "Broadcastify",
  is_actionable_live: false,
};
assert("chatter_scanner_routes_to_scanner_only",
  _feedTabFromRecord(scanner_chatter) === "scanner_only");

// Missing flag → conservative: blanket-exclude (legacy behavior preserved
// for older API responses).
var legacy_scanner = {
  source_type: "scanner",
  verification_level: "scanner",
  source_name: "Broadcastify",
};
assert("missing_actionable_flag_falls_back_to_excluded",
  _feedTabFromRecord(legacy_scanner) === "scanner_only");

// Non-scanner news row → unchanged: developing
assert("news_row_unchanged",
  _feedTabFromRecord({source_type: "local_news", source_name: "Times Union"})
    === "developing");

// Open-data row → unchanged: verified
assert("open_data_unchanged",
  _feedTabFromRecord({source_type: "open_data"}) === "verified");

// Official row → unchanged: official
assert("official_unchanged",
  _feedTabFromRecord({source_type: "official"}) === "official");
"""

    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(test_js)
        path = f.name

    try:
        result = subprocess.run(
            ["node", path], capture_output=True, text=True, timeout=30,
        )
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    _report("node_frontend_routing_block_passed",
            result.returncode == 0,
            f"node exited {result.returncode}")


def main() -> None:
    test_helper_non_scanner_always_actionable()
    test_helper_scanner_conventional_blocked()
    test_helper_scanner_with_critical_live_flag()
    test_helper_scanner_high_severity()
    test_helper_scanner_keyword_match()
    test_helper_scanner_chatter_blocked()
    test_helper_defensive()
    test_repo_projects_actionable_in_both_paths()
    test_repo_supports_operational_sort()
    test_api_whitelists_operational_sort()
    test_frontend_lifts_blanket_scanner_filter()
    test_frontend_routing_via_node()

    print(f"\n{passed}/{passed + failed} python-side checks passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
