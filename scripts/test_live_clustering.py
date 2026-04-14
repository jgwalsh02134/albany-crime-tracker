#!/usr/bin/env python3
"""Regression tests for the client-side Live incident clustering.

We exercise the real app.js helpers (_dedupeLiveItems, _liveClusterSameEvent,
_liveClusterTokens, _liveClusterJaccard) inside node so the tests catch
changes to the actual shipping code rather than a Python re-implementation.

Requires `node` on PATH. If node isn't available, the test skips with a
clear message rather than faking a pass.

Run: python scripts/test_live_clustering.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _extract_functions_from_app_js() -> str:
    """Pull the clustering-related helpers out of app.js so we can run them
    standalone under node without loading the whole IIFE/DOM environment.

    We grab one contiguous region bounded by the first clustering marker and
    the start of the next unrelated helper (renderLiveFreshness). Simpler
    and more robust than per-function extraction.
    """
    with open(os.path.join(REPO, "app.js"), "r", encoding="utf-8") as f:
        src = f.read()
    start_marker = "  var _LIVE_CLUSTER_STOPWORDS"
    end_marker = "  // Render an honest freshness banner"
    s = src.find(start_marker)
    e = src.find(end_marker, s)
    if s == -1 or e == -1:
        raise RuntimeError(
            f"extractor could not locate clustering block (s={s}, e={e})"
        )
    return src[s:e]


def main() -> int:
    if shutil.which("node") is None:
        print("SKIP  node not on PATH — cannot exercise app.js clustering helpers.")
        return 0

    harness = _extract_functions_from_app_js()

    test_js = harness + r"""

function assert(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else      { console.log("  FAIL  " + name + "  " + (detail || "")); process.exitCode = 1; }
}

function mk(id, title, muni, tMin, source, url) {
  return {
    id: id,
    title: title,
    municipality: muni,
    pubDate: new Date(Date.now() - tMin * 60000).toISOString(),
    source_name: source,
    source_url: url,
  };
}

// 1. Paraphrased Coeymans headlines must collapse into one card.
var coe1 = mk("c1", "Car crash in Coeymans injures two", "Coeymans", 30, "Times Union", "https://tu.example/crash");
var coe2 = mk("c2", "Coeymans car crash kills one", "Coeymans", 20, "WNYT", "https://wnyt.example/crash");
var coe3 = mk("c3", "Two hurt in Coeymans crash on Route 144", "Coeymans", 10, "Spectrum", "https://spectrum.example/crash");
var clustered1 = _dedupeLiveItems([coe1, coe2, coe3]);
assert("coeymans_three_paraphrases_cluster_to_one",
  clustered1.length === 1,
  "got length=" + clustered1.length);
assert("coeymans_cluster_leader_is_freshest",
  clustered1[0] && clustered1[0].id === "c3",
  "leader=" + (clustered1[0] && clustered1[0].id));
assert("coeymans_cluster_carries_all_three_sources",
  clustered1[0] && clustered1[0]._linked_sources && clustered1[0]._linked_sources.length === 3,
  "sources=" + JSON.stringify(clustered1[0] && clustered1[0]._linked_sources));

// 2. Distinct incidents in the same municipality must NOT merge.
var a1 = mk("a1", "House fire on Delaware Avenue", "Albany", 40, "TU");
var a2 = mk("a2", "Shooting reported on Central Ave", "Albany", 35, "WNYT");
var clustered2 = _dedupeLiveItems([a1, a2]);
assert("distinct_albany_incidents_stay_separate",
  clustered2.length === 2,
  "got length=" + clustered2.length);

// 3. Same title in different municipalities must NOT merge.
var m1 = mk("m1", "Traffic stop leads to arrest", "Colonie", 20, "TU");
var m2 = mk("m2", "Traffic stop leads to arrest", "Bethlehem", 15, "WNYT");
var clustered3 = _dedupeLiveItems([m1, m2]);
assert("same_title_different_muni_stays_separate",
  clustered3.length === 2,
  "got length=" + clustered3.length);

// 4. Same event outside the 6h window stays separate.
var w1 = mk("w1", "Fire at Hudson Avenue warehouse", "Albany", 30, "TU");
var w2 = mk("w2", "Fire at Hudson Avenue warehouse", "Albany", 30 + 7 * 60, "WNYT");
var clustered4 = _dedupeLiveItems([w1, w2]);
assert("same_event_outside_6h_window_stays_separate",
  clustered4.length === 2,
  "got length=" + clustered4.length);

// 5. Empty municipality on one side is permissive (merges with neighbor).
var e1 = mk("e1", "Shooting reported on Madison Avenue", "Albany", 20, "TU");
var e2 = mk("e2", "Shooting reported on Madison Avenue", "", 15, "WNYT");
var clustered5 = _dedupeLiveItems([e1, e2]);
assert("empty_muni_side_is_permissive",
  clustered5.length === 1,
  "got length=" + clustered5.length);

// 6. Jaccard threshold: weak overlap does NOT merge.
var j1 = mk("j1", "Arbor Hill homicide investigation continues", "Albany", 30, "TU");
var j2 = mk("j2", "Traffic stop on Clinton Avenue", "Albany", 25, "WNYT");
var clustered6 = _dedupeLiveItems([j1, j2]);
assert("weak_token_overlap_does_not_merge",
  clustered6.length === 2,
  "got length=" + clustered6.length);

// 7. Substring rule: "Coeymans car crash" and "Coeymans car crash kills one" → same.
//    (sanity check specifically for the product problem described.)
var s1 = mk("s1", "Coeymans car crash", "Coeymans", 30, "TU");
var s2 = mk("s2", "Coeymans car crash kills one", "Coeymans", 20, "WNYT");
var clustered7 = _dedupeLiveItems([s1, s2]);
assert("substring_containment_clusters_same_event",
  clustered7.length === 1,
  "got length=" + clustered7.length);

// 8. Same source, same URL must not double-count.
var d1 = mk("d1", "Fire on Pearl Street", "Albany", 20, "TU", "https://tu.example/fire");
var d2 = mk("d2", "Fire on Pearl Street", "Albany", 15, "TU", "https://tu.example/fire");
var clustered8 = _dedupeLiveItems([d1, d2]);
assert("identical_source_url_does_not_inflate_count",
  clustered8.length === 1 && clustered8[0]._linked_sources && clustered8[0]._linked_sources.length === 1,
  "sources=" + JSON.stringify(clustered8[0] && clustered8[0]._linked_sources));

// 9. Single item gets NO _linked_sources array (pill only appears when > 1).
var solo = mk("x", "Single unique incident nobody else covered", "Albany", 10, "TU");
var clustered9 = _dedupeLiveItems([solo]);
assert("single_item_has_no_linked_sources_array",
  clustered9.length === 1 && !clustered9[0]._linked_sources,
  "linked=" + JSON.stringify(clustered9[0] && clustered9[0]._linked_sources));

// 10. Jaccard sanity: identical token sets → 1.0, disjoint → 0.0.
var ta = _liveClusterTokens("House fire on Delaware Avenue");
var tb = _liveClusterTokens("House fire on Delaware Avenue");
assert("jaccard_identical_is_1", Math.abs(_liveClusterJaccard(ta, tb) - 1.0) < 1e-9);
var tc = _liveClusterTokens("Traffic stop leads to arrest");
assert("jaccard_disjoint_is_0", _liveClusterJaccard(ta, tc) === 0);
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
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
