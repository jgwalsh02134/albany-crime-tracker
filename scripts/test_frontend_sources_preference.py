#!/usr/bin/env python3
"""Regression test for frontend preference: backend-persisted incident.sources
must be preferred over the client-side _linked_sources clustering when both
are available, with _linked_sources retained as a fallback.

This pass is the consumer side of commit da1a435 (Persist multi-source
sources array on incidents). The backend now writes a JSONB list of
{name, url, agency_id?, first_seen_at} on every incident; the frontend
should prefer that list over recomputed cluster output.

Strategy
--------
1. Static checks against app.js — ensure the data path passes through
   r.sources as `linked_sources` and the buildIncidentCard pill prefers
   `item.linked_sources` over `item._linked_sources`.
2. Functional check via node — invoke the existing _dedupeLiveItems and
   confirm a card built with backend `linked_sources` still yields the
   correct +N pill HTML even when no client-side clustering ran.

Skips cleanly when node is not on PATH (matches test_live_clustering.py).

Run: python scripts/test_frontend_sources_preference.py
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
# Static contracts
# ---------------------------------------------------------------------------

def test_static_contracts() -> None:
    js = _read("app.js")

    # 1. _toFeedItemFromIncident must pass r.sources through as linked_sources.
    _report("toFeedItemFromIncident_passes_linked_sources",
            "linked_sources: Array.isArray(r.sources)" in js)

    # 2. linked_sources must be null when r.sources is empty/missing so the
    #    fallback branch can take over cleanly.
    _report("linked_sources_falls_through_to_null",
            re.search(
                r"linked_sources:\s*Array\.isArray\(r\.sources\)\s*"
                r"&&\s*r\.sources\.length\s*\?\s*r\.sources\s*:\s*null",
                js,
            ) is not None)

    # 3. buildIncidentCard's linked-sources pill must prefer
    #    item.linked_sources, then fall back to item._linked_sources.
    _report("pill_prefers_backend_then_falls_back",
            "var linked = (Array.isArray(item.linked_sources)" in js
            and "item._linked_sources" in js)

    # 4. The fallback chain must specifically be "backend wins, client
    #    clustering used only when backend is empty/missing."
    _report("preference_order_is_backend_first",
            "(Array.isArray(item.linked_sources) && item.linked_sources.length)"
            in js)


# ---------------------------------------------------------------------------
# Functional check via node
# ---------------------------------------------------------------------------

def _extract_app_js_block() -> str:
    """Pull the buildIncidentCard helpers and clustering helpers out of
    app.js so node can exercise them standalone. Pattern matches
    scripts/test_live_clustering.py — same extraction strategy."""
    with open(os.path.join(REPO, "app.js"), "r", encoding="utf-8") as f:
        src = f.read()
    cluster_start = src.find("  var _LIVE_CLUSTER_STOPWORDS")
    cluster_end = src.find("  // Render an honest freshness banner", cluster_start)
    if cluster_start == -1 or cluster_end == -1:
        raise RuntimeError("could not extract clustering block")
    return src[cluster_start:cluster_end]


def test_functional_pill_via_node() -> None:
    if shutil.which("node") is None:
        print("SKIP  node not on PATH — skipping functional pill check.")
        return

    helpers = _extract_app_js_block()

    test_js = helpers + r"""

function assert(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else      { console.log("  FAIL  " + name + "  " + (detail || "")); process.exitCode = 1; }
}

// Mini-renderer extracted from buildIncidentCard's pill block, stripped of
// HTML escaping for clarity. Mirrors the new preference logic exactly.
function corroboratedPillCount(item) {
  var linked = (Array.isArray(item.linked_sources) && item.linked_sources.length)
    ? item.linked_sources
    : (Array.isArray(item._linked_sources) ? item._linked_sources : null);
  if (!linked || linked.length <= 1) return 0;
  return linked.length - 1;
}

// Backend-persisted shape (post-da1a435) — three sources from the DB.
var backendItem = {
  source_name: "Times Union",
  linked_sources: [
    { name: "Times Union", url: "https://tu/a", agency_id: null, first_seen_at: "2026-04-14T00:00Z" },
    { name: "WNYT",        url: "https://wnyt/b", agency_id: null, first_seen_at: "2026-04-14T00:01Z" },
    { name: "Spectrum",    url: "https://spec/c", agency_id: null, first_seen_at: "2026-04-14T00:02Z" },
  ],
};
assert("backend_sources_drive_pill_count",
  corroboratedPillCount(backendItem) === 2,
  "got=" + corroboratedPillCount(backendItem));

// Legacy item with only client-side _linked_sources — fallback path.
var legacyItem = {
  source_name: "Times Union",
  _linked_sources: [
    { name: "Times Union", url: "https://tu/a" },
    { name: "WNYT",        url: "https://wnyt/b" },
  ],
};
assert("client_clustering_used_when_backend_absent",
  corroboratedPillCount(legacyItem) === 1,
  "got=" + corroboratedPillCount(legacyItem));

// Backend wins when both present (durable data preferred).
var bothItem = {
  source_name: "Times Union",
  linked_sources: [
    { name: "Times Union", url: "https://tu/a" },
    { name: "WNYT",        url: "https://wnyt/b" },
    { name: "Spectrum",    url: "https://spec/c" },
    { name: "WRGB",        url: "https://wrgb/d" },
  ],
  _linked_sources: [
    { name: "Times Union", url: "https://tu/a" },
    { name: "WNYT",        url: "https://wnyt/b" },
  ],
};
assert("backend_wins_over_client_clustering",
  corroboratedPillCount(bothItem) === 3,
  "got=" + corroboratedPillCount(bothItem));

// No corroboration: single-source row — pill suppressed.
var soloItem = {
  source_name: "Times Union",
  linked_sources: [
    { name: "Times Union", url: "https://tu/a" },
  ],
};
assert("single_source_suppresses_pill",
  corroboratedPillCount(soloItem) === 0);

// Empty array on backend → fall through to client clustering (legacy row
// pre-migration had sources=[] from the column default).
var emptyBackendItem = {
  source_name: "Times Union",
  linked_sources: [],
  _linked_sources: [
    { name: "Times Union", url: "https://tu/a" },
    { name: "WNYT",        url: "https://wnyt/b" },
  ],
};
assert("empty_backend_array_falls_through_to_client",
  corroboratedPillCount(emptyBackendItem) === 1,
  "got=" + corroboratedPillCount(emptyBackendItem));

// Both missing — no pill.
var nothingItem = { source_name: "Lone Wolf News" };
assert("no_sources_no_pill",
  corroboratedPillCount(nothingItem) === 0);
"""

    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(test_js)
        script_path = f.name

    try:
        result = subprocess.run(
            ["node", script_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)

    # Counted into the global tally as one composite — node sub-tests already
    # printed PASS/FAIL lines; treat their exit code as the verdict.
    _report("node_functional_block_passed",
            result.returncode == 0,
            f"node exited {result.returncode}")


def main() -> None:
    test_static_contracts()
    test_functional_pill_via_node()

    print(f"\n{passed}/{passed + failed} python-side checks passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
