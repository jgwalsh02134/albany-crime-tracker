#!/usr/bin/env python3
"""Unit tests for the Superfeedr integration layer."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.superfeedr import (
    parse_notification,
    verify_signature,
    runtime_status,
    SEED_FEEDS,
)


SAMPLE_NOTIFICATION = {
    "status": {
        "code": 200,
        "feed": "https://www.news10.com/news/crime/feed/",
        "http": "Fetched 200 in 0.5s",
    },
    "title": "News10 ABC Crime",
    "items": [
        {
            "title": "Police investigate shooting on Western Ave",
            "permalinkUrl": "https://www.news10.com/news/crime/police-investigate-shooting/",
            "summary": "Albany police are investigating a reported shooting on Western Avenue.",
            "published": 1743900000,
            "id": "news10-article-12345",
            "actor": {"displayName": "News10 ABC"},
            "categories": ["crime", "albany"],
        },
        {
            "title": "Arrest made in downtown burglary",
            "permalinkUrl": "https://www.news10.com/news/crime/arrest-burglary/",
            "content": "A suspect has been arrested in connection with a burglary in downtown Albany.",
            "published": 1743896400,
            "id": "news10-article-12346",
            "actor": {"displayName": "News10 ABC"},
        },
        {
            "title": "",
            "permalinkUrl": "https://www.news10.com/blank/",
        },
    ],
}


def test_parse_notification_shape():
    articles = parse_notification(SAMPLE_NOTIFICATION)
    assert len(articles) == 2, f"expected 2 articles (empty title skipped), got {len(articles)}"
    a = articles[0]
    assert a["title"] == "Police investigate shooting on Western Ave"
    assert a["link"] == "https://www.news10.com/news/crime/police-investigate-shooting/"
    # Registry-driven: source_name comes from registry entry when matched.
    assert a["source"], "source should be populated"
    assert a["guid"] == "news10-article-12345"
    assert a.get("pubDate"), "pubDate should be set from timestamp"
    assert isinstance(a.get("provenance"), dict), "provenance should be a dict"
    prov = a["provenance"]
    assert prov["origin"]["source_class"].startswith("rss_push_superfeedr"), (
        f"unexpected source_class: {prov['origin']['source_class']}"
    )
    assert prov["origin"]["ingestion_method"] == "superfeedr_push"
    assert prov["raw_capture"]["capture_method"] == "webhook_push"
    assert "superfeedr_feed_url" in (a.get("raw_payload") or {}), "raw_payload should have feed_url"
    # Registry match indicator must be present either way.
    assert "matched_registry" in a["raw_payload"]


def test_parse_notification_empty():
    articles = parse_notification({})
    assert articles == []


def test_parse_notification_no_items():
    articles = parse_notification({"status": {"code": 200}, "items": []})
    assert articles == []


def test_verify_signature_valid():
    secret = "test-secret-key"
    body = json.dumps(SAMPLE_NOTIFICATION).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()
    sig = f"sha1={digest}"
    assert verify_signature(body, sig, secret) is True


def test_verify_signature_invalid():
    secret = "test-secret-key"
    body = b"some body content"
    assert verify_signature(body, "sha1=deadbeef", secret) is False


def test_verify_signature_no_secret():
    assert verify_signature(b"body", "", "") is True


def test_seed_feeds_non_empty():
    assert len(SEED_FEEDS) >= 3, "seed feeds should have at least 3 entries"
    for feed in SEED_FEEDS:
        assert "url" in feed, f"seed feed missing url: {feed}"
        assert "key" in feed, f"seed feed missing key: {feed}"
        assert feed["url"].startswith("https://"), f"feed url should be https: {feed['url']}"


def test_runtime_status_shape():
    status = runtime_status()
    assert "configured" in status
    assert "hub_url" in status
    assert "stats" in status
    assert isinstance(status["stats"], dict)
    assert "notifications_received" in status["stats"]


def test_no_secrets_in_articles():
    articles = parse_notification(SAMPLE_NOTIFICATION)
    serialized = json.dumps(articles)
    for sensitive in ("SUPERFEEDR_TOKEN", "SUPERFEEDR_SECRET", "SUPERFEEDR_LOGIN"):
        assert sensitive not in serialized, f"{sensitive} leaked into article data"


def test_article_to_incident_compat():
    """Verify parsed articles are compatible with article_to_incident()."""
    from app.services.incident_transformers import article_to_incident

    articles = parse_notification(SAMPLE_NOTIFICATION)
    for a in articles:
        record = article_to_incident(a)
        assert record.title, "incident should have a title"
        assert record.source_url, "incident should have a source_url"
        assert record.provenance, "incident should carry provenance"


def main():
    tests = [
        test_parse_notification_shape,
        test_parse_notification_empty,
        test_parse_notification_no_items,
        test_verify_signature_valid,
        test_verify_signature_invalid,
        test_verify_signature_no_secret,
        test_seed_feeds_non_empty,
        test_runtime_status_shape,
        test_no_secrets_in_articles,
        test_article_to_incident_compat,
    ]
    pass_count = 0
    fail_count = 0
    for t in tests:
        name = t.__name__
        try:
            t()
            print(f"  PASS  {name}")
            pass_count += 1
        except Exception as exc:
            print(f"  FAIL  {name}: {exc}")
            fail_count += 1
    print(f"\n{pass_count}/{pass_count + fail_count} tests passed")
    return 1 if fail_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
