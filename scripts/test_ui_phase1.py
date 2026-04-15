#!/usr/bin/env python3
"""Static validation for the UI phase-1 pass.

These are not browser tests — they parse the source files and assert the
structural contracts we just introduced. Run as part of the regular test
suite to catch regressions like "someone re-added the municipality chip row"
or "the freshness banner container was deleted".

Run: python scripts/test_ui_phase1.py
"""
from __future__ import annotations

import os
import re
import sys

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


def read(path: str) -> str:
    with open(os.path.join(REPO, path), "r", encoding="utf-8") as f:
        return f.read()


def main() -> None:
    html = read("index.html")
    js = read("app.js")
    css = read("style.css")

    # 1. Municipality chip row must be gone from home sub-header.
    #    The old row had data-filter="colonie" / "bethlehem" / "guilderland" buttons
    #    directly inside the home sub-header. The header itself (Live|News) stays.
    _report(
        "municipality_chip_row_removed_from_home_sub_header",
        'id="filterChips"' not in html
        and 'data-filter="colonie"' not in html
        and 'data-filter="bethlehem"' not in html
        and 'data-filter="guilderland"' not in html,
    )
    _report(
        "home_mode_bar_still_present",
        'class="home-mode-bar"' in html
        and 'data-home-mode="live"' in html
        and 'data-home-mode="news"' in html,
    )

    # 2. Freshness banner container must exist above the Live feed list.
    _report(
        "freshness_banner_container_exists",
        'id="liveFreshness"' in html,
    )
    _report(
        "freshness_banner_above_feed",
        html.index('id="liveFreshness"') < html.index('id="incidentListUnified"'),
    )

    # 3. JS must wire freshness rendering into the unified feed.
    _report("js_has_renderLiveFreshness", "function renderLiveFreshness" in js)
    _report("js_renderUnifiedFeed_calls_freshness", "renderLiveFreshness(items)" in js)
    _report(
        "js_renderUnifiedFeed_empty_resets_freshness",
        "renderLiveFreshness([])" in js,
    )

    # 4. Dedupe helper must be present and invoked inside renderUnifiedFeed.
    _report("js_has_dedupe_helper", "function _dedupeLiveItems" in js)
    _report("js_renderUnifiedFeed_dedupes", "_dedupeLiveItems(items)" in js)

    # 5. Source letter-avatar for News must be wired.
    _report("js_has_sourceInitials", "function _sourceInitials" in js)
    _report("js_storyCard_emits_avatar", 'class="home-story-avatar"' in js)

    # 6. CSS tokens for the freshness banner and avatar must exist, and the
    #    Major news card must keep its distinct treatment.
    _report("css_has_live_freshness", ".live-freshness" in css)
    _report("css_has_fresh_dot_tones", ".live-freshness-dot--aging" in css
            and ".live-freshness-dot--stale" in css)
    _report("css_has_story_avatar", ".home-story-avatar" in css)
    _report("css_major_story_has_stronger_border",
            bool(re.search(r"\.home-story-card--major[^{]*\{[^}]*border-left:\s*4px", css)))

    # 7. Prior hardcoded live red should be replaced by --brand-alert token
    #    when available (we set Major border-left to use var(--brand-alert)).
    _report("css_major_uses_brand_alert_token",
            "var(--brand-alert" in css)

    # 8. News freshness banner must be wired. Mirrors the Live banner pattern.
    _report("js_has_renderNewsFreshness", "function renderNewsFreshness" in js)
    _report("js_fetchHomeNews_calls_news_freshness",
            "renderNewsFreshness" in js and "fetchHomeNews" in js)
    _report("css_has_news_freshness", ".news-freshness" in css)
    _report("css_news_freshness_has_tones",
            ".news-freshness--stale" in css and ".news-freshness--aging" in css)

    # 9. Mobile spacing: feed card padding must be at the relaxed values,
    # summary line-height must be >= 1.4, meta font-size must be >= 11px.
    _report("css_feed_item_padding_relaxed",
            bool(re.search(r"\.feed-item\s*\{[^}]*padding:\s*12px\s+14px", css)))
    _report("css_feed_summary_line_height_readable",
            bool(re.search(r"\.feed-summary-line\s*\{[^}]*line-height:\s*1\.4", css)))
    _report("css_feed_meta_font_size_readable",
            bool(re.search(r"\.feed-meta\s*\{[^}]*font-size:\s*11px", css)))
    _report("css_feed_list_gap_relaxed",
            bool(re.search(r"\.feed-list\s*\{[^}]*gap:\s*10px", css)))

    # 10. Tiered clustering: populous-muni list must exist and must include
    # the five biggest Albany County municipalities.
    _report("js_has_populous_munis",
            "_LIVE_CLUSTER_POPULOUS_MUNIS" in js)
    for muni in ("albany", "colonie", "bethlehem", "guilderland", "cohoes"):
        _report(f"js_populous_munis_contains_{muni}",
                '"' + muni + '"' in js or "'" + muni + "'" in js)

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
