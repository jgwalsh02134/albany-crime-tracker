#!/usr/bin/env python3
"""Regression test for the v7 redesign — operational-attribution Live cards.

Closes the largest UI gap remaining after f56a205 (Backfill
responding_agency_id on legacy incidents): the resolved agency id was
persisted but never reached the card. v7 surfaces it as the leading
meta pill so Live rows read as operational events ("APD · Albany Police
investigates Cochran Avenue shooting") instead of article snippets
("Times Union · ...").

Covers:

Static contracts (against app.js / style.css)
  - _toFeedItemFromIncident passes responding_agency_id through.
  - The Live card meta row renders an .feed-meta-pill--agency BEFORE
    the area + source pills when an agency resolves.
  - The agency CSS rule uses var(--brand-primary) so a future brand
    pass (CERN blue / Princeton orange) auto-propagates.

Functional checks (via node) on the real app.js helpers
  - _agencyDisplayName resolves the 5 most-frequently-backfilled
    canonical ids (apd, acso, bethlehem_pd, colonie_pd, nysp_troop_g)
    to the documented display strings.
  - Unknown ids fall back to a presentable form rather than being
    suppressed (so a future addition to data/agencies.json doesn't
    silently disappear).
  - Empty / null / whitespace inputs return the empty string so the
    renderer's `if (agencyDisplay)` guard naturally suppresses the
    pill — protects all the rows where responding_agency_id is null
    (media-outlet sources).

Skips cleanly when node is not on PATH (matches test_live_clustering.py).

Run: python scripts/test_v7_redesign_agency_pill.py
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
    css = _read("style.css")

    # 1. Data path: feed item carries responding_agency_id.
    _report("feed_item_carries_responding_agency_id",
            "responding_agency_id: r.responding_agency_id || null" in js)

    # 2. Resolver helpers exist.
    _report("agency_display_names_table_present",
            "var _AGENCY_DISPLAY_NAMES" in js)
    _report("agency_display_name_function_present",
            "function _agencyDisplayName" in js)

    # 3. Map covers the 5 most-frequently-backfilled canonical ids.
    for aid, label in [("apd", "APD"), ("acso", "ACSO"),
                       ("bethlehem_pd", "Bethlehem PD"),
                       ("colonie_pd", "Colonie PD"),
                       ("nysp_troop_g", "NYSP Troop G")]:
        _report(f"agency_map_includes_{aid}",
                f'{aid}: "{label}"' in js)

    # 4. Card render: agency pill emitted BEFORE area + source.
    #    Locate buildIncidentCard's meta block and check ordering.
    meta_block_match = re.search(
        r"html \+= '<div class=\"feed-meta\">';\s*"
        r"var agencyDisplay = _agencyDisplayName\(item\.responding_agency_id\);\s*"
        r"if \(agencyDisplay\) \{[^}]*feed-meta-pill--agency",
        js,
    )
    _report("agency_pill_emitted_inside_meta_block_with_guard",
            meta_block_match is not None)

    # Order check: agency pill block appears before --area pill in source.
    agency_idx = js.find("feed-meta-pill--agency")
    area_idx = js.find("feed-meta-pill--area")
    _report("agency_pill_renders_before_area_pill",
            agency_idx > 0 and area_idx > agency_idx)

    # 5. CSS: the new pill rule uses --brand-primary token so the future
    #    brand pass auto-propagates.
    _report("css_has_agency_pill_rule",
            ".feed-meta-pill--agency" in css)
    _report("css_agency_pill_uses_brand_primary",
            bool(re.search(
                r"\.feed-meta-pill--agency\s*\{[^}]*var\(--brand-primary",
                css,
            )))


# ---------------------------------------------------------------------------
# Functional via node
# ---------------------------------------------------------------------------

def _extract_agency_helper_block() -> str:
    """Pull just the _AGENCY_DISPLAY_NAMES table + _agencyDisplayName fn
    from app.js so node can exercise them standalone."""
    js = _read("app.js")
    start = js.find("  var _AGENCY_DISPLAY_NAMES = {")
    if start == -1:
        raise RuntimeError("could not find _AGENCY_DISPLAY_NAMES in app.js")
    end_marker = "  function _sourceInitials("
    end = js.find(end_marker, start)
    if end == -1:
        raise RuntimeError("could not find end marker for agency helper block")
    return js[start:end]


def test_functional_via_node() -> None:
    if shutil.which("node") is None:
        print("SKIP  node not on PATH — skipping functional resolver checks.")
        return

    helpers = _extract_agency_helper_block()

    test_js = helpers + r"""

function assert(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else      { console.log("  FAIL  " + name + "  " + (detail || "")); process.exitCode = 1; }
}

// Known canonical ids resolve to their documented short names.
var known = [
  ["apd", "APD"],
  ["acso", "ACSO"],
  ["bethlehem_pd", "Bethlehem PD"],
  ["colonie_pd", "Colonie PD"],
  ["nysp_troop_g", "NYSP Troop G"],
  ["coeymans_pd", "Coeymans PD"],
  ["watervliet_pd", "Watervliet PD"],
  ["csx_police", "CSX Police"],
];
known.forEach(function (pair) {
  var got = _agencyDisplayName(pair[0]);
  assert("known_id_" + pair[0] + "_displays_as_" + pair[1].replace(/ /g, "_"),
         got === pair[1], "got=" + JSON.stringify(got));
});

// Case-insensitive (the data path may emit lowercase or with whitespace).
assert("case_insensitive", _agencyDisplayName("APD") === "APD");
assert("trimmed", _agencyDisplayName("  acso  ") === "ACSO");

// Unknown ids fall back to title-cased words with PD/PO/LE uppercased.
assert("unknown_falls_back_titlecase",
  _agencyDisplayName("some_new_pd") === "Some New PD",
  "got=" + JSON.stringify(_agencyDisplayName("some_new_pd")));
assert("unknown_le_uppercased",
  _agencyDisplayName("foo_le") === "Foo LE",
  "got=" + JSON.stringify(_agencyDisplayName("foo_le")));

// Null-ish inputs return empty string so the renderer guard suppresses
// the pill cleanly. This is the path for the 280 visible rows whose
// responding_agency_id is null (media-outlet sources).
assert("null_returns_empty_string", _agencyDisplayName(null) === "");
assert("undefined_returns_empty_string", _agencyDisplayName(undefined) === "");
assert("empty_returns_empty_string", _agencyDisplayName("") === "");
assert("whitespace_returns_empty_string", _agencyDisplayName("   ") === "");
assert("non_string_returns_empty_string", _agencyDisplayName(123) === "");
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
    _report("node_functional_block_passed",
            result.returncode == 0,
            f"node exited {result.returncode}")


def main() -> None:
    test_static_contracts()
    test_functional_via_node()

    print(f"\n{passed}/{passed + failed} python-side checks passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
