"""Registry-driven orchestration for Superfeedr push subscriptions.

The `superfeedr` module owns the HTTP transport (subscribe / unsubscribe /
list / verify / parse). This module owns the *policy*:

- which feeds we want pushed (derived from source_registry.json)
- how pushed notifications are matched back to registry entries
- how the desired set reconciles with what Superfeedr currently has

Polling is still the fallback. Feeds we do not push (auth-blocked,
non-RSS, deny-listed, or degraded) remain on the existing polling path.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from app.core.config import get_settings
from app.services import superfeedr as superfeedr_svc
from app.services.source_registry import (
    index_by_feed_url,
    load_source_registry,
    map_registry_to_incident_fields,
    normalize_feed_url,
    select_superfeedr_feeds,
)

logger = logging.getLogger(__name__)


# Feed-level overrides: useful if we want to force a known-good feed on even
# when the registry snapshot hasn't been revalidated, or to temporarily mute a
# noisy feed without editing the registry. Keep these small and explicit.
_ALLOW_OVERRIDES: list[str] = []
_DENY_OVERRIDES: list[str] = []


def _last_notification_store() -> dict[str, str]:
    store = getattr(superfeedr_svc, "_LAST_NOTIFICATION_BY_FEED", None)
    if store is None:
        store = {}
        superfeedr_svc._LAST_NOTIFICATION_BY_FEED = store  # type: ignore[attr-defined]
    return store


def record_feed_notification(feed_url: str, ts_iso: str) -> None:
    if not feed_url:
        return
    _last_notification_store()[normalize_feed_url(feed_url)] = ts_iso


def desired_subscriptions() -> list[dict[str, Any]]:
    entries = load_source_registry()
    return select_superfeedr_feeds(
        entries,
        allow_feed_urls=_ALLOW_OVERRIDES,
        deny_feed_urls=_DENY_OVERRIDES,
    )


def registry_index() -> dict[str, dict[str, Any]]:
    return index_by_feed_url(load_source_registry())


def match_entry_for_feed(feed_url: str, *, index: Optional[dict[str, dict[str, Any]]] = None) -> Optional[dict[str, Any]]:
    idx = index if index is not None else registry_index()
    norm = normalize_feed_url(feed_url)
    if not norm:
        return None
    return idx.get(norm)


def _expected_callback() -> str:
    s = get_settings()
    base = s.superfeedr_callback_base_url
    if not base:
        return ""
    return f"{base}/api/superfeedr/webhook"


def _parse_active_subscriptions(list_resp: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten Superfeedr's /list response into [{feed_url, callback_url}]."""
    if not list_resp.get("ok"):
        return []
    body = list_resp.get("subscriptions")
    out: list[dict[str, Any]] = []
    items: list[Any] = []
    if isinstance(body, list):
        items = body
    elif isinstance(body, dict):
        # Some Superfeedr shapes wrap in {"subscriptions": [...]}
        inner = body.get("subscriptions")
        if isinstance(inner, list):
            items = inner
        else:
            items = [body]
    for it in items:
        if not isinstance(it, dict):
            continue
        sub = it.get("subscription") if isinstance(it.get("subscription"), dict) else it
        topic = sub.get("topic") or sub.get("feed") or {}
        if isinstance(topic, dict):
            feed_url = str(topic.get("url") or topic.get("feed") or "")
        else:
            feed_url = str(topic or "")
        endpoint = sub.get("endpoint") or sub.get("callback") or ""
        out.append({
            "feed_url": feed_url,
            "callback_url": str(endpoint or ""),
        })
    return out


async def collect_active_subscriptions(max_pages: int = 10) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        resp = await superfeedr_svc.list_subscriptions(page=page)
        page_rows = _parse_active_subscriptions(resp)
        if not page_rows:
            break
        out.extend(page_rows)
        # Superfeedr returns fewer-than-page-size when no more pages; pragmatic cutoff:
        if len(page_rows) < 20:
            break
    return out


async def reconcile(*, dry_run: bool = True) -> dict[str, Any]:
    """Compare desired (registry) vs actual Superfeedr subscriptions.

    Returns a structured report. When dry_run=False, applies the plan
    (subscribes missing, unsubscribes extras, re-subscribes callback mismatches).
    """
    desired = desired_subscriptions()
    desired_by_url: dict[str, dict[str, Any]] = {
        normalize_feed_url(str(e.get("feed_url") or "")): e for e in desired if e.get("feed_url")
    }

    callback = _expected_callback()
    actual = await collect_active_subscriptions()
    actual_by_url: dict[str, dict[str, Any]] = {}
    for row in actual:
        norm = normalize_feed_url(row.get("feed_url", ""))
        if norm:
            actual_by_url[norm] = row

    to_subscribe: list[dict[str, Any]] = []
    to_unsubscribe: list[dict[str, Any]] = []
    callback_mismatched: list[dict[str, Any]] = []
    healthy: list[dict[str, Any]] = []

    for norm, entry in desired_by_url.items():
        act = actual_by_url.get(norm)
        if act is None:
            to_subscribe.append(entry)
            continue
        if callback and act.get("callback_url") and act["callback_url"] != callback:
            callback_mismatched.append({
                "feed_url": entry.get("feed_url"),
                "source_id": entry.get("source_id"),
                "current_callback": act.get("callback_url"),
                "expected_callback": callback,
            })
        else:
            healthy.append({
                "feed_url": entry.get("feed_url"),
                "source_id": entry.get("source_id"),
            })

    for norm, act in actual_by_url.items():
        if norm not in desired_by_url:
            to_unsubscribe.append(act)

    # Pilot-mode cap. When SUPERFEEDR_MAX_SUBSCRIPTIONS > 0 we refuse to
    # exceed the account's subscription ceiling. Strategy:
    #   - keep healthy + callback_mismatched counted toward the cap
    #   - truncate to_subscribe (sorted by trust tier, already sorted by
    #     select_superfeedr_feeds) to the remaining capacity
    #   - never unsubscribe in pilot mode — leaves existing healthy feeds in
    #     place even if the registry shape changes later
    max_subs = int(get_settings().superfeedr_max_subscriptions or 0)
    deferred_to_subscribe: list[dict[str, Any]] = []
    pilot_mode = max_subs > 0
    if pilot_mode:
        # Active desired feeds already count toward capacity.
        already_using = len(healthy) + len(callback_mismatched)
        remaining = max(0, max_subs - already_using)
        if remaining < len(to_subscribe):
            deferred_to_subscribe = to_subscribe[remaining:]
            to_subscribe = to_subscribe[:remaining]
        # Do not unsubscribe anything in pilot mode; the goal is to preserve
        # the single existing subscription and avoid churn on a capped plan.
        deferred_to_unsubscribe = to_unsubscribe
        to_unsubscribe = []
    else:
        deferred_to_unsubscribe = []

    applied = {"subscribed": [], "unsubscribed": [], "resubscribed": [], "failed": []}
    if not dry_run:
        s = get_settings()
        if not superfeedr_svc._configured():
            return {"ok": False, "error": "superfeedr not configured"}
        if not callback:
            return {"ok": False, "error": "SUPERFEEDR_CALLBACK_BASE_URL not set"}
        secret = s.superfeedr_secret
        for entry in to_subscribe:
            try:
                r = await superfeedr_svc.subscribe(str(entry["feed_url"]), callback, secret=secret)
                r["source_id"] = entry.get("source_id")
                (applied["subscribed"] if r.get("ok") else applied["failed"]).append(r)
            except Exception as exc:
                applied["failed"].append({
                    "feed_url": entry.get("feed_url"),
                    "source_id": entry.get("source_id"),
                    "error": str(exc),
                })
        for act in to_unsubscribe:
            try:
                r = await superfeedr_svc.unsubscribe(
                    str(act.get("feed_url") or ""),
                    str(act.get("callback_url") or callback),
                )
                (applied["unsubscribed"] if r.get("ok") else applied["failed"]).append(r)
            except Exception as exc:
                applied["failed"].append({
                    "feed_url": act.get("feed_url"),
                    "error": str(exc),
                })
        for mm in callback_mismatched:
            try:
                await superfeedr_svc.unsubscribe(str(mm["feed_url"]), str(mm["current_callback"]))
                r = await superfeedr_svc.subscribe(str(mm["feed_url"]), callback, secret=secret)
                r["source_id"] = mm.get("source_id")
                (applied["resubscribed"] if r.get("ok") else applied["failed"]).append(r)
            except Exception as exc:
                applied["failed"].append({
                    "feed_url": mm.get("feed_url"),
                    "error": str(exc),
                })

    last_notif = _last_notification_store()
    return {
        "ok": True,
        "dry_run": dry_run,
        "expected_callback": callback,
        "desired_count": len(desired_by_url),
        "active_count": len(actual_by_url),
        "to_subscribe": [
            {"source_id": e.get("source_id"), "feed_url": e.get("feed_url"), "trust_tier": e.get("trust_tier")}
            for e in to_subscribe
        ],
        "to_unsubscribe": to_unsubscribe,
        "callback_mismatched": callback_mismatched,
        "healthy": healthy,
        "applied": applied,
        "pilot_mode": pilot_mode,
        "max_subscriptions": max_subs,
        "deferred_to_subscribe": [
            {"source_id": e.get("source_id"), "feed_url": e.get("feed_url"), "trust_tier": e.get("trust_tier")}
            for e in deferred_to_subscribe
        ],
        "deferred_to_unsubscribe": deferred_to_unsubscribe,
        "last_notification_by_feed": {
            url: ts for url, ts in last_notif.items() if url in desired_by_url
        },
    }


def push_metadata_for_entry(entry: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Compute push-ingestion metadata for a matched registry entry.

    When entry is None, return a conservative 'unmatched' block. The caller
    (parse_notification) uses this to populate provenance + incident fields
    deterministically.
    """
    if not entry:
        return {
            "matched": False,
            "source_id": "",
            "source_name": "",
            "trust_tier": "tier_3",
            "lane": "developing_incidents",
            "category": "",
            "source_type": "unknown",
            "verification_level": "inferred",
            "source_priority": 3,
            "feed_reliability": 0.6,
            "source_class": "rss_push_superfeedr_unmatched",
        }
    mapped = map_registry_to_incident_fields(entry)
    tier = str(entry.get("trust_tier") or "tier_3").lower()
    priority = {"tier_1": 1, "tier_2": 2, "tier_3": 3}.get(tier, 3)
    reliability = {"tier_1": 0.95, "tier_2": 0.85, "tier_3": 0.7}.get(tier, 0.7)
    return {
        "matched": True,
        "source_id": str(entry.get("source_id") or ""),
        "source_name": str(entry.get("source_name") or entry.get("organization") or ""),
        "trust_tier": tier,
        "lane": mapped.get("lane") or str(entry.get("lane") or ""),
        "category": str(entry.get("category") or ""),
        "source_type": mapped.get("source_type", "unknown"),
        "verification_level": mapped.get("verification_level", "inferred"),
        "source_priority": priority,
        "feed_reliability": reliability,
        "source_class": "rss_push_superfeedr",
    }
