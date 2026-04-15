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

from datetime import datetime, timedelta, timezone  # noqa: E402

from app.services.incident_repository import _is_actionable_for_live  # noqa: E402


def _iso_hours_ago(hours: float) -> str:
    """ISO-8601 timestamp `hours` hours before now, in UTC. Used to build
    fixture rows that test the recency gate without relying on wall-clock
    time the way `datetime.utcnow()` does."""
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

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

def test_helper_recency_gates_news_class() -> None:
    """Media rows are operational only within 12h. Older recent-looking
    rows must NOT be marked actionable just because they pass content
    gates — the prior 'non-scanner = always True' shortcut was the bug
    that admitted 200/200 rows in production sampling."""
    fresh_low = {
        "source_type": "local_news", "severity": "low",
        "title": "general news brief", "description": "",
        "published_at": _iso_hours_ago(2), "raw_payload": {},
    }
    _report("news_recent_low_severity_no_keyword_NOT_actionable",
            _is_actionable_for_live(fresh_low) is False,
            "low-severity media within window but no signal must NOT auto-pass")

    stale_high = {
        "source_type": "local_news", "severity": "high",
        "title": "Shooting on Cedar Ave", "description": "",
        "published_at": _iso_hours_ago(36), "raw_payload": {},
    }
    _report("news_stale_high_severity_NOT_actionable",
            _is_actionable_for_live(stale_high) is False,
            "stale row must be excluded regardless of severity")

    fresh_high = {
        "source_type": "local_news", "severity": "high",
        "title": "Shooting on Cedar Ave", "description": "",
        "published_at": _iso_hours_ago(2), "raw_payload": {},
    }
    _report("news_recent_high_severity_actionable",
            _is_actionable_for_live(fresh_high) is True)

    fresh_keyword = {
        "source_type": "local_news", "severity": "medium",
        "title": "Structure fire on Pearl Street", "description": "",
        "published_at": _iso_hours_ago(3), "raw_payload": {},
    }
    _report("news_recent_keyword_actionable",
            _is_actionable_for_live(fresh_keyword) is True)

    no_timestamp = {
        "source_type": "local_news", "severity": "high",
        "title": "Shooting on Cedar Ave", "raw_payload": {},
    }
    _report("news_missing_timestamp_NOT_actionable",
            _is_actionable_for_live(no_timestamp) is False,
            "rows without parseable time can't prove recency")


def test_helper_official_class_recency() -> None:
    """Official / open_data / multi_source within 24h is operational on
    recency alone (authoritative class). Stale official rows are not."""
    fresh_official = {
        "source_type": "official", "severity": "low",
        "title": "press release", "published_at": _iso_hours_ago(5),
        "raw_payload": {},
    }
    _report("official_recent_actionable",
            _is_actionable_for_live(fresh_official) is True)

    fresh_open_data = {
        "source_type": "open_data", "severity": "low",
        "title": "stat report", "published_at": _iso_hours_ago(8),
        "raw_payload": {},
    }
    _report("open_data_recent_actionable",
            _is_actionable_for_live(fresh_open_data) is True)

    multi_source_recent = {
        "source_type": "local_news", "verification_level": "multi_source",
        "severity": "low", "title": "low-severity multi-source",
        "published_at": _iso_hours_ago(10), "raw_payload": {},
    }
    _report("multi_source_recent_actionable",
            _is_actionable_for_live(multi_source_recent) is True)

    stale_official = {
        "source_type": "official", "severity": "low",
        "title": "press release", "published_at": _iso_hours_ago(48),
        "raw_payload": {},
    }
    _report("official_stale_NOT_actionable",
            _is_actionable_for_live(stale_official) is False)


def test_helper_corroboration_promotes_news() -> None:
    """Multi-outlet coverage of the same event IS itself an operational
    signal — backend-persisted sources array length >= 2 promotes a
    fresh media row even without high severity or keyword."""
    corroborated = {
        "source_type": "local_news", "severity": "medium",
        "title": "Coeymans incident report",
        "published_at": _iso_hours_ago(2),
        "sources": [
            {"name": "Times Union", "url": "https://tu/x"},
            {"name": "WNYT",        "url": "https://wnyt/y"},
        ],
        "raw_payload": {},
    }
    _report("news_recent_corroborated_actionable",
            _is_actionable_for_live(corroborated) is True)

    single_source = {
        "source_type": "local_news", "severity": "medium",
        "title": "Coeymans incident report",
        "published_at": _iso_hours_ago(2),
        "sources": [{"name": "Times Union", "url": "https://tu/x"}],
        "raw_payload": {},
    }
    _report("news_recent_single_source_NOT_actionable",
            _is_actionable_for_live(single_source) is False,
            "single-source recent low-signal media must NOT pass")


def test_helper_scanner_conventional_blocked() -> None:
    item = {
        "source_type": "scanner", "severity": "low",
        "title": "tones", "published_at": _iso_hours_ago(0.5),
        "raw_payload": {"_scanner_conventional": True},
    }
    _report("scanner_conventional_blocked",
            _is_actionable_for_live(item) is False)


def test_helper_scanner_recency_gate() -> None:
    """Scanner items also have a recency gate (12h). A scanner row with
    high severity but stale time must be rejected."""
    stale_scanner = {
        "source_type": "scanner", "severity": "high",
        "title": "Shooting on Cedar Ave",
        "published_at": _iso_hours_ago(20), "raw_payload": {},
    }
    _report("scanner_stale_NOT_actionable",
            _is_actionable_for_live(stale_scanner) is False)

    fresh_scanner = {
        "source_type": "scanner", "severity": "high",
        "title": "Shooting on Cedar Ave",
        "published_at": _iso_hours_ago(1), "raw_payload": {},
    }
    _report("scanner_fresh_high_severity_actionable",
            _is_actionable_for_live(fresh_scanner) is True)


def test_helper_scanner_with_critical_live_flag() -> None:
    item = {
        "source_type": "scanner", "severity": "medium",
        "title": "10-13", "published_at": _iso_hours_ago(0.5),
        "raw_payload": {"_scanner_critical_live": True},
    }
    _report("scanner_critical_live_flag_actionable",
            _is_actionable_for_live(item) is True)

    item2 = {
        "source_type": "scanner", "severity": "medium",
        "title": "stop", "published_at": _iso_hours_ago(0.5),
        "raw_payload": {"_scanner_recent_live": True},
    }
    _report("scanner_recent_live_flag_actionable",
            _is_actionable_for_live(item2) is True)


def test_helper_scanner_keyword_match() -> None:
    """Tightened keyword set: only operationally meaningful keywords
    promote scanner rows. 'alarm' and bare 'traffic stop' / 'crash'
    were intentionally REMOVED in this pass."""
    cases = [
        ("shooting", "Shooting on Cedar Ave"),
        ("structure fire", "Structure fire reported"),
        ("pursuit", "Vehicle pursuit on I-90"),
        ("overdose", "Suspected overdose"),
        ("rollover", "Rollover crash on I-87"),
    ]
    for kw, title in cases:
        item = {"source_type": "scanner", "severity": "medium",
                "title": title, "published_at": _iso_hours_ago(1),
                "raw_payload": {}}
        _report(f"scanner_keyword_{kw}_actionable",
                _is_actionable_for_live(item) is True)

    # Removed keywords no longer auto-promote.
    for kw, title in [("alarm", "Alarm activation"),
                      ("traffic stop", "Traffic stop made")]:
        item = {"source_type": "scanner", "severity": "medium",
                "title": title, "published_at": _iso_hours_ago(1),
                "raw_payload": {}}
        _report(f"scanner_removed_keyword_{kw}_NOT_actionable",
                _is_actionable_for_live(item) is False)


def test_helper_scanner_chatter_blocked() -> None:
    cases = [
        {"source_type": "scanner", "severity": "low",
         "title": "general assist", "description": "non-emergency",
         "published_at": _iso_hours_ago(0.5), "raw_payload": {}},
        {"source_type": "scanner", "severity": "low",
         "title": "radio check", "published_at": _iso_hours_ago(0.5),
         "raw_payload": {}},
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
                "title": "shooting", "published_at": _iso_hours_ago(0.5),
                "raw_payload": raw,
            })
            _report(f"defensive_raw_payload_{type(raw).__name__}_no_raise", True)
        except Exception as exc:
            _report(f"defensive_raw_payload_{type(raw).__name__}_no_raise",
                    False, f"raised {exc}")
    # Empty item: no source_type, no timestamp → must be NOT actionable
    # (recency gate fails). The prior version returned True here which
    # was a contributor to the production over-admission.
    _report("defensive_empty_item_NOT_actionable",
            _is_actionable_for_live({}) is False)


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
    test_helper_recency_gates_news_class()
    test_helper_official_class_recency()
    test_helper_corroboration_promotes_news()
    test_helper_scanner_conventional_blocked()
    test_helper_scanner_recency_gate()
    test_helper_scanner_with_critical_live_flag()
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
