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

    # 11. v6 redesign — header is 2-zone (no center date/time strip).
    _report("html_header_center_removed",
            'class="header-center"' not in html)
    _report("html_header_keeps_left_and_right",
            'class="header-left"' in html and 'class="header-right"' in html)
    _report("html_header_keeps_live_indicator",
            'id="liveIndicator"' in html and 'id="topbarStatus"' in html)

    # 12. v6 redesign — Bottom nav: Home renamed to Live, data-view stays "feed".
    _report("html_bottom_nav_label_is_live",
            '<span class="tab-bar-label">Live</span>' in html)
    _report("html_bottom_nav_routing_target_unchanged",
            '<button class="tab-bar-item active" data-view="feed"' in html)
    _report("html_bottom_nav_uses_bolt_icon",
            '<span class="tab-bar-icon material-icons">bolt</span>' in html)

    # 13. v6 redesign — Live card meta row drops the per-card LIVE badge
    # and Federal pill (the freshness banner above the feed conveys
    # liveness; Federal is rare and noisy). Time gets a monospace class.
    _report("js_card_meta_drops_inline_live_badge",
            "if (liveBadge) html += liveBadge;" not in js)
    _report("js_card_meta_drops_federal_pill",
            "feed-meta-pill--federal" not in js)
    _report("js_card_meta_uses_mono_time_class",
            "feed-time--mono" in js)

    # 14. v6 redesign — CSS retune block is present and tokenizes the
    # hardcoded live-area #E53935 into var(--brand-alert) on the four
    # live-feed surfaces (LIVE section header, feed live dot, feed live
    # badge, feed item live border, feed time dot).
    _report("css_has_v6_redesign_block",
            "V6 REDESIGN PASS" in css)
    _report("css_live_section_header_uses_brand_alert",
            bool(re.search(r"\.feed-section-header--live\s*\{[^}]*var\(--brand-alert", css)))
    _report("css_feed_live_dot_uses_brand_alert",
            bool(re.search(r"\.feed-live-dot\s*\{[^}]*var\(--brand-alert", css)))
    _report("css_feed_live_badge_uses_brand_alert",
            bool(re.search(r"\.feed-live-badge\s*\{[^}]*var\(--brand-alert", css)))
    _report("css_feed_item_live_uses_brand_alert",
            bool(re.search(r"\.feed-item--live\s*\{[^}]*var\(--brand-alert", css)))
    _report("css_feed_time_dot_uses_brand_alert",
            bool(re.search(r"\.feed-time-dot\s*\{[^}]*var\(--brand-alert", css)))

    # 15. v6 redesign — Bottom nav tap target bumped + active accent line.
    _report("css_tab_bar_height_56",
            bool(re.search(r"\.tab-bar\s*\{[^}]*calc\(56px", css)))
    _report("css_tab_bar_active_accent_line",
            bool(re.search(r"\.tab-bar-item\.active::before", css)))

    # 16. v6 redesign — News section labels are uppercase + tracked.
    _report("css_news_section_labels_are_uppercase",
            bool(re.search(r"\.home-section-label\s*\{[^}]*text-transform:\s*uppercase", css)))

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
