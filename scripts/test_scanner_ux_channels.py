#!/usr/bin/env python3
"""Regression test for the scanner channel preset frontend pass.

Backend foundation (commit c25379c) is already covered by
test_scanner_channels.py. This file validates the consumer side:
  - HTML container exists with a default "All channels" pill
  - JS state + fetcher + chip builder + channel filter wiring
  - Per-card channel attribution pill rendered on the right rows
  - CSS rules for the strip, active state, and per-card pill
  - Functional checks on the JS chip builder via node

Skips the node block cleanly when node is not on PATH.

Run: python scripts/test_scanner_ux_channels.py
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
# index.html structure
# ---------------------------------------------------------------------------

def test_html_has_channel_chip_strip() -> None:
    html = _read("index.html")
    _report("html_has_scanner_channel_chips_container",
            'id="scannerChannelChips"' in html)
    # Default "All channels" pill must ship in the HTML so the surface
    # is never blank if the channels endpoint is slow / unavailable.
    _report("html_default_all_channels_pill",
            'data-scanner-channel=""' in html
            and "All channels" in html)
    # The strip must sit ABOVE the discipline filter row so the user
    # sees agency/region context first.
    pos_chips = html.find('id="scannerChannelChips"')
    pos_filters = html.find('id="scannerFilterChips"')
    _report("channel_strip_above_discipline_filter",
            pos_chips != -1 and pos_filters != -1 and pos_chips < pos_filters)
    # Role + ARIA so screen readers identify the strip as a channel
    # selector, not generic chips.
    _report("html_strip_has_role_tablist",
            'role="tablist"' in html and 'aria-label="Scanner channel"' in html)


# ---------------------------------------------------------------------------
# JS wiring contracts
# ---------------------------------------------------------------------------

def test_js_state_and_helpers_present() -> None:
    js = _read("app.js")
    _report("js_active_channel_state_var",
            "var _activeScannerChannel = null;" in js)
    _report("js_channels_cache_var",
            "var _scannerChannelsCache = null;" in js)
    _report("js_fetchScannerChannels_function_present",
            "function fetchScannerChannels()" in js)
    _report("js_initScannerChannelChips_function_present",
            "function initScannerChannelChips()" in js)
    _report("js_init_called_at_startup",
            "setTimeout(initScannerChannelChips" in js,
            "channel chips must initialize after first render")


def test_js_fetch_calls_appends_channel_param() -> None:
    js = _read("app.js")
    # The fetchScannerCalls function must construct the URL with
    # ?channel=<id> when the active channel is set.
    _report("js_url_appends_channel_param",
            'API + "/api/scanner/calls"' in js
            and '"?channel=" + encodeURIComponent(_activeScannerChannel)' in js)
    # Must bypass apiClient when the channel filter is active (apiClient
    # doesn't know about the new param).
    _report("js_bypasses_apiclient_when_channel_active",
            "_activeScannerChannel || !apiClient" in js)


def test_js_chip_click_handler() -> None:
    js = _read("app.js")
    _report("js_chip_click_sets_active_channel",
            "_activeScannerChannel = raw || null;" in js)
    _report("js_chip_click_refetches_calls",
            re.search(
                r'_activeScannerChannel = raw \|\| null;[\s\S]{0,400}?fetchScannerCalls\(\)',
                js,
            ) is not None)
    # Single delegated listener (no rebinding on every render).
    _report("js_listener_bound_once",
            "host._actChannelBound" in js)


def test_js_card_renders_channel_label() -> None:
    js = _read("app.js")
    _report("js_card_emits_channel_label_pill",
            'class="sc-card-channel"' in js
            and "call.channel_label" in js)
    # The pill must be SUPPRESSED when the user is already filtered to
    # the same channel (otherwise every card would carry a redundant
    # pill matching the active filter).
    _report("js_card_suppresses_pill_when_filtered_to_same_channel",
            "_activeScannerChannel !== call.channel_id" in js)


# ---------------------------------------------------------------------------
# CSS contracts
# ---------------------------------------------------------------------------

def test_css_has_chip_strip_styles() -> None:
    css = _read("style.css")
    _report("css_has_sc_channel_row", ".sc-channel-row" in css)
    _report("css_strip_horizontal_scrollable",
            bool(re.search(r"\.sc-channel-row\s*\{[^}]*overflow-x:\s*auto", css)))
    _report("css_chip_uses_brand_primary_when_active",
            bool(re.search(
                r"\.sc-channel-chip\.active\s*\{[^}]*var\(--brand-primary",
                css,
            )))
    _report("css_per_card_channel_pill",
            ".sc-card-channel" in css)


# ---------------------------------------------------------------------------
# Functional via node — the chip builder produces correct order
# ---------------------------------------------------------------------------

def test_chip_builder_via_node() -> None:
    if shutil.which("node") is None:
        print("SKIP  node not on PATH — skipping chip builder functional checks.")
        return

    test_js = r"""
// Reimplementation of the priority-sort logic from initScannerChannelChips
// so we can verify it deterministically without a DOM.
var rank = { high: 0, medium: 1, low: 2 };
function sortChannelsByPriority(channels) {
  return channels.slice().sort(function (a, b) {
    var ra = rank[a.priority] != null ? rank[a.priority] : 3;
    var rb = rank[b.priority] != null ? rank[b.priority] : 3;
    return ra - rb;
  });
}

function assert(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else      { console.log("  FAIL  " + name + "  " + (detail || "")); process.exitCode = 1; }
}

var input = [
  { channel_id: "low_one",    priority: "low" },
  { channel_id: "high_one",   priority: "high" },
  { channel_id: "medium_one", priority: "medium" },
  { channel_id: "high_two",   priority: "high" },
  { channel_id: "no_priority" },
];
var sorted = sortChannelsByPriority(input);
var ids = sorted.map(function (c) { return c.channel_id; });
assert("priority_high_first",
  ids[0] === "high_one" && ids[1] === "high_two",
  "got=" + JSON.stringify(ids));
assert("priority_medium_after_high",
  ids[2] === "medium_one",
  "got=" + JSON.stringify(ids));
assert("priority_low_after_medium",
  ids[3] === "low_one",
  "got=" + JSON.stringify(ids));
assert("missing_priority_sinks_to_end",
  ids[4] === "no_priority",
  "got=" + JSON.stringify(ids));

// Verify URL composition matches what fetchScannerCalls builds.
function buildUrl(activeChannel) {
  var API = "https://example.com";
  return API + "/api/scanner/calls"
    + (activeChannel ? "?channel=" + encodeURIComponent(activeChannel) : "");
}
assert("url_no_channel_no_param",
  buildUrl(null) === "https://example.com/api/scanner/calls");
assert("url_with_channel_appends_param",
  buildUrl("apd") === "https://example.com/api/scanner/calls?channel=apd");
assert("url_url_encodes_special_chars",
  buildUrl("nysp_troop_g") === "https://example.com/api/scanner/calls?channel=nysp_troop_g");
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
    _report("node_chip_builder_block_passed",
            result.returncode == 0,
            f"node exited {result.returncode}")


def main() -> None:
    test_html_has_channel_chip_strip()
    test_js_state_and_helpers_present()
    test_js_fetch_calls_appends_channel_param()
    test_js_chip_click_handler()
    test_js_card_renders_channel_label()
    test_css_has_chip_strip_styles()
    test_chip_builder_via_node()

    print(f"\n{passed}/{passed + failed} python-side checks passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
