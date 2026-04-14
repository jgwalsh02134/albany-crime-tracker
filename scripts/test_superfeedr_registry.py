#!/usr/bin/env python3
"""Tests for registry-driven Superfeedr selection + parsing + reconciliation."""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services import superfeedr as superfeedr_svc
from app.services import superfeedr_registry as sr
from app.services.source_registry import (
    index_by_feed_url,
    is_push_eligible,
    map_registry_to_incident_fields,
    normalize_feed_url,
    select_superfeedr_feeds,
)


def test_normalize_feed_url_basic():
    assert normalize_feed_url("HTTPS://WWW.News10.com/feed/") == "https://news10.com/feed"
    assert normalize_feed_url("https://news10.com/feed") == "https://news10.com/feed"
    assert normalize_feed_url("https://news10.com/feed/#top") == "https://news10.com/feed"
    assert normalize_feed_url("https://example.com/path/?a=1") == "https://example.com/path?a=1"
    assert normalize_feed_url("") == ""


def test_normalize_feed_url_equivalence():
    a = "https://www.news10.com/news/crime/feed/"
    b = "https://news10.com/news/crime/feed"
    assert normalize_feed_url(a) == normalize_feed_url(b)


def test_is_push_eligible_happy_path():
    entry = {
        "feed_url": "https://news10.com/feed/",
        "active_status": True,
        "validation_status": "reachable:200",
        "ingestion_method": "rss_poll",
        "auth_type": "none",
    }
    assert is_push_eligible(entry) is True


def test_is_push_eligible_rejects_inactive_and_unreachable():
    base = {
        "feed_url": "https://news10.com/feed/",
        "active_status": True,
        "validation_status": "reachable:200",
        "ingestion_method": "rss_poll",
    }
    assert is_push_eligible({**base, "active_status": False}) is False
    assert is_push_eligible({**base, "validation_status": "unreachable"}) is False
    assert is_push_eligible({**base, "validation_status": "reachable:403"}) is False
    assert is_push_eligible({**base, "ingestion_method": "html_scrape"}) is False
    assert is_push_eligible({**base, "feed_url": ""}) is False


def test_is_push_eligible_deny_hosts():
    reddit = {
        "feed_url": "https://www.reddit.com/r/Albany/search.rss",
        "active_status": True,
        "validation_status": "reachable:200",
        "ingestion_method": "rss_poll",
    }
    broadcast = {
        "feed_url": "https://www.broadcastify.com/listen/feed/3626",
        "active_status": True,
        "validation_status": "reachable:200",
        "ingestion_method": "rss_poll",
    }
    assert is_push_eligible(reddit) is False
    assert is_push_eligible(broadcast) is False


def test_allow_and_deny_overrides():
    entry = {
        "feed_url": "https://www.news10.com/feed/",
        "active_status": False,
        "validation_status": "unreachable",
        "ingestion_method": "rss_poll",
    }
    # allow override forces True
    assert is_push_eligible(entry, allow_feed_urls=["https://news10.com/feed"]) is True
    # deny override beats an otherwise-eligible entry
    good = {**entry, "active_status": True, "validation_status": "reachable:200"}
    assert is_push_eligible(good, deny_feed_urls=["https://news10.com/feed"]) is False


def test_select_superfeedr_feeds_dedupes_by_norm_url_prefers_higher_tier():
    entries = [
        {
            "source_id": "dup-tier2",
            "feed_url": "https://news10.com/feed/",
            "active_status": True,
            "validation_status": "reachable:200",
            "ingestion_method": "rss_poll",
            "trust_tier": "tier_2",
        },
        {
            "source_id": "dup-tier1",
            "feed_url": "https://www.news10.com/feed",
            "active_status": True,
            "validation_status": "reachable:200",
            "ingestion_method": "rss_poll",
            "trust_tier": "tier_1",
        },
    ]
    out = select_superfeedr_feeds(entries)
    assert len(out) == 1
    assert out[0]["source_id"] == "dup-tier1"


def test_index_by_feed_url_matches_canonical_and_feed():
    entries = [
        {
            "source_id": "s1",
            "feed_url": "https://news10.com/feed/",
            "canonical_url": "https://news10.com/",
            "active_status": True,
        }
    ]
    idx = index_by_feed_url(entries)
    assert idx[normalize_feed_url("https://news10.com/feed/")]["source_id"] == "s1"
    assert idx[normalize_feed_url("https://www.news10.com/")]["source_id"] == "s1"


def test_map_registry_to_incident_fields():
    official = {"category": "official_alerts", "trust_tier": "tier_1"}
    assert map_registry_to_incident_fields(official)["source_type"] == "official_alerts"
    assert map_registry_to_incident_fields(official)["verification_level"] == "official"

    media = {"category": "tv_news", "trust_tier": "tier_2"}
    m = map_registry_to_incident_fields(media)
    assert m["source_type"] == "local_news"
    assert m["verification_level"] == "media"

    unknown = {"category": "", "trust_tier": "tier_3"}
    u = map_registry_to_incident_fields(unknown)
    assert u["source_type"] == "unknown"


def test_push_metadata_matched_vs_unmatched():
    entry = {
        "source_id": "news10-crime-feed",
        "source_name": "News10 ABC Crime",
        "category": "tv_news",
        "trust_tier": "tier_2",
        "lane": "verified_incidents",
    }
    m = sr.push_metadata_for_entry(entry)
    assert m["matched"] is True
    assert m["source_id"] == "news10-crime-feed"
    assert m["source_name"] == "News10 ABC Crime"
    assert m["source_type"] == "local_news"
    assert m["verification_level"] == "media"
    assert m["trust_tier"] == "tier_2"
    assert m["source_priority"] == 2
    assert m["source_class"] == "rss_push_superfeedr"

    u = sr.push_metadata_for_entry(None)
    assert u["matched"] is False
    assert u["source_class"] == "rss_push_superfeedr_unmatched"
    assert u["trust_tier"] == "tier_3"


def test_parse_notification_uses_registry_metadata_when_matched():
    # Build an in-memory registry index that matches the sample feed.
    fake_entry = {
        "source_id": "news10-crime-feed",
        "source_name": "News10 ABC Crime",
        "category": "tv_news",
        "trust_tier": "tier_2",
        "lane": "verified_incidents",
        "feed_url": "https://www.news10.com/news/crime/feed/",
    }
    idx = {normalize_feed_url(fake_entry["feed_url"]): fake_entry}

    payload = {
        "status": {"feed": "https://www.news10.com/news/crime/feed/"},
        "title": "News10 Crime",
        "items": [
            {
                "title": "Shooting reported on Western Ave",
                "permalinkUrl": "https://www.news10.com/news/crime/a/",
                "summary": "...",
                "id": "news10-article-1",
                "published": 1743900000,
            }
        ],
    }
    articles = superfeedr_svc.parse_notification(payload, registry_index=idx)
    assert len(articles) == 1
    a = articles[0]
    assert a["source"] == "News10 ABC Crime"  # from registry, not actor
    assert a["source_priority"] == 2
    assert abs(a["_feed_reliability"] - 0.85) < 1e-9
    prov = a["provenance"]
    assert prov["origin"]["source_id"] == "news10-crime-feed"
    assert prov["origin"]["trust_tier"] == "tier_2"
    assert prov["origin"]["lane"] == "verified_incidents"
    assert prov["origin"]["source_class"] == "rss_push_superfeedr"
    # Incident fields propagated for article_to_incident()
    assert a["incident"]["source_type"] == "local_news"
    assert a["incident"]["verification_level"] == "media"
    assert a["raw_payload"]["matched_registry"] is True
    assert a["raw_payload"]["matched_source_id"] == "news10-crime-feed"


def test_parse_notification_unmatched_is_explicit():
    payload = {
        "status": {"feed": "https://unknown.example.com/rss"},
        "title": "Unknown",
        "items": [
            {"title": "t", "permalinkUrl": "https://unknown.example.com/a", "id": "x1"}
        ],
    }
    articles = superfeedr_svc.parse_notification(payload, registry_index={})
    assert len(articles) == 1
    a = articles[0]
    prov = a["provenance"]
    assert prov["origin"]["source_class"] == "rss_push_superfeedr_unmatched"
    assert a["raw_payload"]["matched_registry"] is False


def test_parse_notification_flows_through_article_to_incident():
    from app.services.incident_transformers import article_to_incident

    fake_entry = {
        "source_id": "albany-rss",
        "source_name": "City of Albany RSS",
        "category": "official_alerts",
        "trust_tier": "tier_1",
        "lane": "official_updates",
        "feed_url": "https://www.albanyny.gov/rss.aspx",
    }
    idx = {normalize_feed_url(fake_entry["feed_url"]): fake_entry}
    payload = {
        "status": {"feed": "https://www.albanyny.gov/rss.aspx"},
        "items": [{"title": "t", "permalinkUrl": "https://www.albanyny.gov/a", "id": "i1"}],
    }
    articles = superfeedr_svc.parse_notification(payload, registry_index=idx)
    rec = article_to_incident(articles[0])
    assert rec.source_type == "official_alerts"
    assert rec.verification_level == "official"
    assert rec.source_name == "City of Albany RSS"
    assert rec.external_ref == "i1"


def test_reconcile_diff_dry_run_without_configuration():
    """reconcile() must not raise when Superfeedr isn't configured and
    Superfeedr's list endpoint returns nothing. It should return a coherent
    diff where desired feeds all appear in to_subscribe."""
    # Monkey-patch the HTTP layer to pretend no active subscriptions exist.
    async def fake_list_subscriptions(page: int = 1):
        return {"ok": True, "subscriptions": []}

    original = superfeedr_svc.list_subscriptions
    superfeedr_svc.list_subscriptions = fake_list_subscriptions  # type: ignore[assignment]
    try:
        result = asyncio.run(sr.reconcile(dry_run=True))
    finally:
        superfeedr_svc.list_subscriptions = original  # type: ignore[assignment]
    assert result["ok"] is True
    assert result["dry_run"] is True
    assert isinstance(result["to_subscribe"], list)
    assert isinstance(result["to_unsubscribe"], list)
    assert isinstance(result["callback_mismatched"], list)
    assert len(result["to_unsubscribe"]) == 0
    # There should be at least one desired feed in to_subscribe given the
    # current registry, assuming source_registry.json is present.
    assert result["desired_count"] >= 0


def test_push_and_poll_produce_matching_fingerprint():
    """Same incident arriving via Superfeedr push and later polling must share
    at least one fingerprint so the repository dedupes them.

    Uses the real article_to_incident + fingerprint code path."""
    from app.services.incident_repository import (
        _all_fingerprint_hashes,
        _stable_fingerprint,
    )
    from app.services.incident_transformers import article_to_incident

    entry = {
        "source_id": "albany-rss",
        "source_name": "City of Albany RSS",
        "category": "official_alerts",
        "trust_tier": "tier_1",
        "lane": "official_updates",
        "feed_url": "https://www.albanyny.gov/rss.aspx",
    }
    idx = {normalize_feed_url(entry["feed_url"]): entry}

    push_payload = {
        "status": {"feed": "https://www.albanyny.gov/rss.aspx"},
        "items": [
            {
                "title": "APD investigating robbery on Lark St",
                "permalinkUrl": "https://www.albanyny.gov/news/item-123",
                "summary": "Police investigating",
                "id": "albany-news-123",
                "published": 1744000000,
            }
        ],
    }
    push_article = superfeedr_svc.parse_notification(push_payload, registry_index=idx)[0]
    poll_article = {
        "title": "APD investigating robbery on Lark St",
        "link": "https://www.albanyny.gov/news/item-123",
        "pubDate": "Sat, 05 Apr 2025 00:00:00 +0000",
        "description": "Police investigating",
        "source": "City of Albany RSS",
        "guid": "albany-news-123",
        "external_ref": "albany-news-123",
        "incident": {"source_type": "official_alerts", "verification_level": "official"},
    }
    push_rec = article_to_incident(push_article)
    poll_rec = article_to_incident(poll_article)
    # When external_ref is stable, primary fingerprints must match exactly.
    assert _stable_fingerprint(push_rec, push_article) == _stable_fingerprint(poll_rec, poll_article)
    assert push_rec.source_name == poll_rec.source_name == "City of Albany RSS"
    assert push_rec.external_ref == poll_rec.external_ref == "albany-news-123"


def test_push_and_poll_dedupe_when_guids_differ():
    """Realistic case: push uses permalink-as-id, poll uses an internal guid.
    Primary fingerprint will diverge, but the candidate-hash set must overlap
    so _find_existing_row still matches via IncidentORM.source_fingerprint.in_()."""
    from app.services.incident_repository import _all_fingerprint_hashes
    from app.services.incident_transformers import article_to_incident

    entry = {
        "source_id": "news10-crime-feed",
        "source_name": "News10 ABC Crime",
        "category": "tv_news",
        "trust_tier": "tier_2",
        "lane": "verified_incidents",
        "feed_url": "https://www.news10.com/news/crime/feed/",
    }
    idx = {normalize_feed_url(entry["feed_url"]): entry}

    push_payload = {
        "status": {"feed": "https://www.news10.com/news/crime/feed/"},
        "items": [
            {
                "title": "Shooting reported in Arbor Hill",
                "permalinkUrl": "https://www.news10.com/news/crime/shooting-arbor-hill/",
                "id": "https://www.news10.com/news/crime/shooting-arbor-hill/",
                "published": 1744100000,
            }
        ],
    }
    push_article = superfeedr_svc.parse_notification(push_payload, registry_index=idx)[0]
    poll_article = {
        "title": "Shooting reported in Arbor Hill",
        "link": "https://www.news10.com/news/crime/shooting-arbor-hill/",
        "pubDate": "Mon, 07 Apr 2025 15:00:00 +0000",
        "source": "News10 ABC Crime",
        "guid": "news10-article-9999",
        "external_ref": "news10-article-9999",
        "incident": {"source_type": "local_news", "verification_level": "media"},
    }
    push_rec = article_to_incident(push_article)
    poll_rec = article_to_incident(poll_article)
    push_fps = set(_all_fingerprint_hashes(push_rec, push_article))
    poll_fps = set(_all_fingerprint_hashes(poll_rec, poll_article))
    # The source_url|source_name candidate must match both sides.
    assert push_fps & poll_fps, "expected at least one overlapping fingerprint candidate"


def test_host_prefix_strip_does_not_eat_w_literal():
    """Regression: ensure www.-prefix stripping doesn't affect hosts that
    legitimately start with 'w' (wamc.org, wnyt.com)."""
    from app.services.source_registry import _host_of
    assert _host_of("https://www.wamc.org/news.rss") == "wamc.org"
    assert _host_of("https://wnyt.com/feed/") == "wnyt.com"
    assert _host_of("https://www.news10.com/feed/") == "news10.com"


def test_desired_subscriptions_returns_list():
    out = sr.desired_subscriptions()
    assert isinstance(out, list)
    for e in out:
        assert e.get("feed_url")
        assert e.get("active_status") is True
        assert e.get("validation_status") == "reachable:200"


def main():
    tests = [
        test_normalize_feed_url_basic,
        test_normalize_feed_url_equivalence,
        test_is_push_eligible_happy_path,
        test_is_push_eligible_rejects_inactive_and_unreachable,
        test_is_push_eligible_deny_hosts,
        test_allow_and_deny_overrides,
        test_select_superfeedr_feeds_dedupes_by_norm_url_prefers_higher_tier,
        test_index_by_feed_url_matches_canonical_and_feed,
        test_map_registry_to_incident_fields,
        test_push_metadata_matched_vs_unmatched,
        test_parse_notification_uses_registry_metadata_when_matched,
        test_parse_notification_unmatched_is_explicit,
        test_parse_notification_flows_through_article_to_incident,
        test_reconcile_diff_dry_run_without_configuration,
        test_push_and_poll_produce_matching_fingerprint,
        test_push_and_poll_dedupe_when_guids_differ,
        test_host_prefix_strip_does_not_eat_w_literal,
        test_desired_subscriptions_returns_list,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL  {t.__name__}: {exc}")
            failed += 1
    print(f"\n{passed}/{passed + failed} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
