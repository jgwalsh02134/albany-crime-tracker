#!/usr/bin/env python3
"""Tests for the SUPERFEEDR_ADMIN_TOKEN gate and pilot-mode reconcile cap."""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Tests mutate env before importing api_server / config. Set a known token.
_ADMIN_TOKEN = "test-admin-token-xyz"
os.environ["SUPERFEEDR_ADMIN_TOKEN"] = _ADMIN_TOKEN
os.environ.setdefault("SUPERFEEDR_CALLBACK_BASE_URL", "https://example.test")

# Clear any cached Settings so the test values are picked up.
from app.core.config import get_settings
get_settings.cache_clear()  # type: ignore[attr-defined]

from fastapi.testclient import TestClient

import api_server  # noqa: E402

_client = TestClient(api_server.app)

DEV_ENDPOINTS = [
    ("GET", "/api/dev/superfeedr/status", None),
    ("GET", "/api/dev/superfeedr/desired", None),
    ("GET", "/api/dev/superfeedr/reconcile", None),
    ("GET", "/api/dev/superfeedr/subscriptions", None),
    ("POST", "/api/dev/superfeedr/subscribe", {"feed_url": "https://example.test/feed"}),
    ("POST", "/api/dev/superfeedr/unsubscribe", {"feed_url": "https://example.test/feed"}),
    ("POST", "/api/dev/superfeedr/seed", None),
    ("POST", "/api/dev/superfeedr/reconcile", None),
]


def _call(method: str, path: str, body, headers=None):
    kwargs: dict = {"headers": headers or {}}
    if body is not None:
        kwargs["json"] = body
    return _client.request(method, path, **kwargs)


def test_dev_endpoints_reject_missing_token():
    """No X-Admin-Token header -> 401."""
    for method, path, body in DEV_ENDPOINTS:
        resp = _call(method, path, body)
        assert resp.status_code == 401, (
            f"{method} {path} should 401 without token, got {resp.status_code}"
        )


def test_dev_endpoints_reject_invalid_token():
    """Wrong token -> 403."""
    headers = {"X-Admin-Token": "wrong-token"}
    for method, path, body in DEV_ENDPOINTS:
        resp = _call(method, path, body, headers=headers)
        assert resp.status_code == 403, (
            f"{method} {path} should 403 with wrong token, got {resp.status_code}"
        )


def test_dev_endpoints_accept_valid_token():
    """Correct token -> past the gate (not 401/403). Actual body may be any
    status reflecting downstream behavior; we only verify the gate."""
    headers = {"X-Admin-Token": _ADMIN_TOKEN}
    # Only test the endpoints that don't require Superfeedr account HTTP calls.
    safe = [
        ("GET", "/api/dev/superfeedr/status", None),
        ("GET", "/api/dev/superfeedr/desired", None),
    ]
    for method, path, body in safe:
        resp = _call(method, path, body, headers=headers)
        assert resp.status_code not in (401, 403), (
            f"{method} {path} should not be 401/403 with valid token, got {resp.status_code}"
        )
        assert resp.status_code == 200, f"{method} {path} unexpected status {resp.status_code}"


def test_webhook_endpoint_remains_public():
    """Public webhook must NOT require the admin token."""
    resp = _client.get("/api/superfeedr/webhook")
    assert resp.status_code == 200, f"GET webhook should be 200 public, got {resp.status_code}"
    # POST with empty body still returns 200 (our handler tolerates empty json)
    resp = _client.post("/api/superfeedr/webhook", data=b"")
    assert resp.status_code in (200, 400, 403), (
        f"POST webhook should not be 401 gated, got {resp.status_code}"
    )


def test_unconfigured_admin_token_returns_503():
    """When SUPERFEEDR_ADMIN_TOKEN is empty, dev endpoints must refuse (503)."""
    from app.core.config import get_settings
    # Flip env + bust cache.
    prev = os.environ.get("SUPERFEEDR_ADMIN_TOKEN", "")
    os.environ["SUPERFEEDR_ADMIN_TOKEN"] = ""
    get_settings.cache_clear()  # type: ignore[attr-defined]
    try:
        resp = _client.get(
            "/api/dev/superfeedr/status",
            headers={"X-Admin-Token": "anything"},
        )
        assert resp.status_code == 503, (
            f"unconfigured admin token should produce 503, got {resp.status_code}"
        )
    finally:
        os.environ["SUPERFEEDR_ADMIN_TOKEN"] = prev
        get_settings.cache_clear()  # type: ignore[attr-defined]


def test_reconcile_pilot_mode_caps_new_subscribes_and_blocks_unsub():
    """With SUPERFEEDR_MAX_SUBSCRIPTIONS=1 and an existing subscription for
    a desired feed, reconcile must:
      - limit to_subscribe to remaining capacity (0 here)
      - refuse to unsubscribe anything (even off-registry feeds)
      - expose deferred lists so the operator sees what was skipped"""
    from app.services import superfeedr as sf
    from app.services import superfeedr_registry as sr
    from app.core.config import get_settings

    os.environ["SUPERFEEDR_MAX_SUBSCRIPTIONS"] = "1"
    get_settings.cache_clear()  # type: ignore[attr-defined]

    desired = sr.desired_subscriptions()
    assert desired, "registry should have at least one desired feed for this test"
    # Pretend the first desired feed is the one existing active subscription,
    # plus an extra off-registry feed that reconcile would normally unsubscribe.
    existing_feed = desired[0]["feed_url"]
    off_registry_feed = "https://off-registry.example/rss"
    expected_callback = (
        get_settings().superfeedr_callback_base_url + "/api/superfeedr/webhook"
    )

    async def fake_list(page: int = 1):
        if page > 1:
            return {"ok": True, "subscriptions": []}
        # Mirror the real Superfeedr /list JSON shape: subscription objects
        # with a nested `feed` dict and an `endpoint` field.
        return {
            "ok": True,
            "subscriptions": [
                {
                    "subscription": {
                        "feed": {"url": existing_feed, "title": "existing"},
                        "endpoint": expected_callback,
                    }
                },
                {
                    "subscription": {
                        "feed": {"url": off_registry_feed, "title": "off"},
                        "endpoint": expected_callback,
                    }
                },
            ],
        }

    original = sf.list_subscriptions
    sf.list_subscriptions = fake_list  # type: ignore[assignment]
    try:
        result = asyncio.run(sr.reconcile(dry_run=True))
    finally:
        sf.list_subscriptions = original  # type: ignore[assignment]
        os.environ["SUPERFEEDR_MAX_SUBSCRIPTIONS"] = "0"
        get_settings.cache_clear()  # type: ignore[attr-defined]

    assert result["pilot_mode"] is True, "pilot_mode should be True when cap>0"
    assert result["max_subscriptions"] == 1
    # The existing feed counts as healthy -> remaining capacity is 0.
    assert result["to_subscribe"] == [], "no new subs should fit under cap=1"
    # All other desired feeds should be deferred, not silently dropped.
    assert len(result["deferred_to_subscribe"]) == len(desired) - 1
    # Never unsubscribe in pilot mode.
    assert result["to_unsubscribe"] == []
    # The off-registry feed should be surfaced as deferred_to_unsubscribe.
    deferred_urls = [x.get("feed_url") for x in result["deferred_to_unsubscribe"]]
    assert off_registry_feed in deferred_urls


def test_reconcile_non_pilot_mode_behaves_normally():
    """With cap=0, pilot_mode is False and deferred lists are empty."""
    from app.services import superfeedr as sf
    from app.services import superfeedr_registry as sr
    from app.core.config import get_settings

    os.environ["SUPERFEEDR_MAX_SUBSCRIPTIONS"] = "0"
    get_settings.cache_clear()  # type: ignore[attr-defined]

    async def fake_list(page: int = 1):
        return {"ok": True, "subscriptions": []}

    original = sf.list_subscriptions
    sf.list_subscriptions = fake_list  # type: ignore[assignment]
    try:
        result = asyncio.run(sr.reconcile(dry_run=True))
    finally:
        sf.list_subscriptions = original  # type: ignore[assignment]
    assert result["pilot_mode"] is False
    assert result["max_subscriptions"] == 0
    assert result["deferred_to_subscribe"] == []
    assert result["deferred_to_unsubscribe"] == []


def main():
    tests = [
        test_dev_endpoints_reject_missing_token,
        test_dev_endpoints_reject_invalid_token,
        test_dev_endpoints_accept_valid_token,
        test_webhook_endpoint_remains_public,
        test_unconfigured_admin_token_returns_503,
        test_reconcile_pilot_mode_caps_new_subscribes_and_blocks_unsub,
        test_reconcile_non_pilot_mode_behaves_normally,
    ]
    passed = failed = 0
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
