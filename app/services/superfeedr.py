from __future__ import annotations

import hashlib
import hmac
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.core.config import get_settings
from app.models.incident import build_provenance

logger = logging.getLogger(__name__)

SUPERFEEDR_HUB_URL = "https://push.superfeedr.com"

_subscription_log: list[dict[str, Any]] = []
_LAST_NOTIFICATION_BY_FEED: dict[str, str] = {}


def _configured() -> bool:
    s = get_settings()
    return bool(s.superfeedr_login and s.superfeedr_token)


def _auth() -> tuple[str, str]:
    s = get_settings()
    return (s.superfeedr_login, s.superfeedr_token)


def _redact_subscriptions(body: Any) -> Any:
    """Remove secret values from Superfeedr subscription list responses."""
    if isinstance(body, list):
        return [_redact_subscriptions(item) for item in body]
    if isinstance(body, dict):
        out = {}
        for k, v in body.items():
            if k == "secret":
                out[k] = "****" if v else ""
            elif k == "subscription" and isinstance(v, dict):
                out[k] = _redact_subscriptions(v)
            else:
                out[k] = _redact_subscriptions(v) if isinstance(v, (dict, list)) else v
        return out
    return body


def _redact_secret_from_text(text: str) -> str:
    """Mask any hub.secret values that may appear in raw Superfeedr responses."""
    s = get_settings()
    secret = s.superfeedr_secret
    if secret and secret in text:
        text = text.replace(secret, "****")
    return text


async def subscribe(
    feed_url: str,
    callback_url: str,
    *,
    secret: str = "",
    retrieve: bool = True,
    fmt: str = "json",
) -> dict[str, Any]:
    if not _configured():
        return {"ok": False, "error": "superfeedr not configured"}
    data: dict[str, str] = {
        "hub.mode": "subscribe",
        "hub.topic": feed_url,
        "hub.callback": callback_url,
        "format": fmt,
    }
    if secret:
        data["hub.secret"] = secret
    if retrieve:
        data["retrieve"] = "true"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            SUPERFEEDR_HUB_URL,
            data=data,
            auth=_auth(),
        )
    result = {
        "ok": resp.status_code in (200, 202, 204),
        "status_code": resp.status_code,
        "feed_url": feed_url,
        "callback_url": callback_url,
    }
    if resp.status_code not in (200, 202, 204):
        result["body"] = _redact_secret_from_text(resp.text[:500])
    _subscription_log.append({
        "action": "subscribe",
        "feed_url": feed_url,
        "callback_url": callback_url,
        "status_code": resp.status_code,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    logger.info(
        "superfeedr_subscribe feed=%s status=%s",
        feed_url,
        resp.status_code,
    )
    return result


async def unsubscribe(feed_url: str, callback_url: str) -> dict[str, Any]:
    if not _configured():
        return {"ok": False, "error": "superfeedr not configured"}
    data = {
        "hub.mode": "unsubscribe",
        "hub.topic": feed_url,
        "hub.callback": callback_url,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            SUPERFEEDR_HUB_URL,
            data=data,
            auth=_auth(),
        )
    result = {
        "ok": resp.status_code in (200, 202, 204),
        "status_code": resp.status_code,
        "feed_url": feed_url,
    }
    _subscription_log.append({
        "action": "unsubscribe",
        "feed_url": feed_url,
        "status_code": resp.status_code,
        "ts": datetime.now(timezone.utc).isoformat(),
    })
    logger.info(
        "superfeedr_unsubscribe feed=%s status=%s",
        feed_url,
        resp.status_code,
    )
    return result


async def list_subscriptions(page: int = 1) -> dict[str, Any]:
    if not _configured():
        return {"ok": False, "error": "superfeedr not configured"}
    params: dict[str, str] = {
        "hub.mode": "list",
        "page": str(page),
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            SUPERFEEDR_HUB_URL,
            params=params,
            auth=_auth(),
            headers={"Accept": "application/json"},
        )
    if resp.status_code != 200:
        return {
            "ok": False,
            "status_code": resp.status_code,
            "body": _redact_secret_from_text(resp.text[:500]),
        }
    try:
        body = resp.json()
    except Exception:
        body = _redact_secret_from_text(resp.text[:1000])
    return {"ok": True, "status_code": 200, "subscriptions": _redact_subscriptions(body)}


def verify_signature(body: bytes, signature: str, secret: str) -> bool:
    """Verify X-Hub-Signature HMAC-SHA1 from Superfeedr."""
    if not secret or not signature:
        return not secret
    expected = "sha1=" + hmac.new(
        secret.encode("utf-8"),
        body,
        hashlib.sha1,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def parse_notification(
    payload: dict[str, Any],
    *,
    registry_index: Optional[dict[str, dict[str, Any]]] = None,
) -> list[dict[str, Any]]:
    """Convert a Superfeedr JSON notification into ACT article dicts.

    When a registry lookup succeeds for the notification's feed, pushed items
    inherit real source metadata (source_id, source_name, trust_tier, lane,
    source_type, verification_level). Unmatched feeds fall through with an
    explicit 'unmatched' source_class so they are visible instead of silently
    treated as generic tier_3.
    """
    # Late import to avoid circular dependency (superfeedr_registry imports
    # this module for transport helpers).
    from app.services import superfeedr_registry

    status = payload.get("status") or {}
    feed_url = str(status.get("feed") or "")
    feed_title = str(payload.get("title") or "")
    items = payload.get("items") or []
    articles: list[dict[str, Any]] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    idx = registry_index if registry_index is not None else superfeedr_registry.registry_index()
    matched_entry = superfeedr_registry.match_entry_for_feed(feed_url, index=idx) if feed_url else None
    meta = superfeedr_registry.push_metadata_for_entry(matched_entry)
    if feed_url:
        superfeedr_registry.record_feed_notification(feed_url, now_iso)

    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        permalink = str(item.get("permalinkUrl") or "")
        if not permalink:
            alt_links = (item.get("standardLinks") or {}).get("alternate") or []
            if isinstance(alt_links, list) and alt_links:
                permalink = str((alt_links[0] or {}).get("href") or "")
        summary = str(item.get("summary") or item.get("content") or "").strip()
        if len(summary) > 400:
            summary = summary[:400] + "..."
        published_ts = item.get("published") or item.get("updated")
        if isinstance(published_ts, (int, float)):
            pub_date = datetime.fromtimestamp(published_ts, tz=timezone.utc).strftime(
                "%a, %d %b %Y %H:%M:%S %z"
            )
        elif isinstance(published_ts, str):
            pub_date = published_ts
        else:
            pub_date = ""

        actor = item.get("actor") or {}
        # Prefer registry source_name so push + poll produce identical dedupe
        # fingerprints (source_url + source_name).
        source_name = (
            meta["source_name"]
            or str(actor.get("displayName") or "")
            or feed_title
            or "Superfeedr"
        )
        item_id = str(item.get("id") or permalink or title)

        raw_hash = hashlib.sha256(
            (item_id + title).encode("utf-8", errors="ignore")
        ).hexdigest()[:16]

        provenance_source_id = meta["source_id"] or f"superfeedr:{feed_url}"

        article: dict[str, Any] = {
            "title": title,
            "link": permalink,
            "pubDate": pub_date,
            "description": summary,
            "source": source_name,
            "source_url": permalink,
            "guid": item_id,
            "external_ref": item_id,
            "_feed_reliability": meta["feed_reliability"],
            "source_priority": meta["source_priority"],
            # Nest source_type/verification_level so article_to_incident picks
            # them up on the IncidentRecord.
            "incident": {
                "source_type": meta["source_type"],
                "verification_level": meta["verification_level"],
                "source_name": source_name,
            },
            "provenance": build_provenance(
                source_class=meta["source_class"],
                source_id=provenance_source_id,
                trust_tier=meta["trust_tier"],
                lane=meta["lane"],
                ingestion_method="superfeedr_push",
                feed_url=feed_url,
                captured_at=now_iso,
                raw_fields_hash=raw_hash,
                content_type="superfeedr_json_item",
                capture_method="webhook_push",
            ),
            "raw_payload": {
                "superfeedr_feed_url": feed_url,
                "superfeedr_feed_title": feed_title,
                "superfeedr_item_id": item_id,
                "superfeedr_actor": actor.get("displayName", ""),
                "superfeedr_categories": item.get("categories") or [],
                "matched_source_id": meta["source_id"],
                "matched_registry": bool(meta["matched"]),
            },
        }
        articles.append(article)
    return articles


_SUPERFEEDR_STATS: dict[str, Any] = {
    "notifications_received": 0,
    "articles_parsed": 0,
    "articles_persisted": 0,
    "last_notification_at": "",
    "errors": 0,
}


def record_notification(article_count: int, persisted: int) -> None:
    _SUPERFEEDR_STATS["notifications_received"] += 1
    _SUPERFEEDR_STATS["articles_parsed"] += article_count
    _SUPERFEEDR_STATS["articles_persisted"] += persisted
    _SUPERFEEDR_STATS["last_notification_at"] = datetime.now(timezone.utc).isoformat()


def record_error() -> None:
    _SUPERFEEDR_STATS["errors"] += 1


def runtime_status() -> dict[str, Any]:
    try:
        from app.services.superfeedr_registry import desired_subscriptions
        desired = desired_subscriptions()
        desired_summary = {
            "count": len(desired),
            "by_trust_tier": _count_by(desired, "trust_tier"),
        }
    except Exception as exc:
        desired_summary = {"error": str(exc)}
    return {
        "configured": _configured(),
        "hub_url": SUPERFEEDR_HUB_URL,
        "stats": dict(_SUPERFEEDR_STATS),
        "recent_subscription_log": _subscription_log[-10:],
        "desired_subscriptions": desired_summary,
        "last_notification_by_feed": dict(_LAST_NOTIFICATION_BY_FEED),
    }


def _count_by(entries: list[dict[str, Any]], key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in entries:
        k = str(e.get(key) or "unknown")
        out[k] = out.get(k, 0) + 1
    return out


SEED_FEEDS: list[dict[str, str]] = [
    {
        "key": "news10_crime",
        "url": "https://www.news10.com/news/crime/feed/",
        "label": "News10 ABC Crime",
    },
    {
        "key": "news10_albany",
        "url": "https://www.news10.com/news/albany-county/feed/",
        "label": "News10 ABC Albany County",
    },
    {
        "key": "cbs6_local",
        "url": "https://cbs6albany.com/news/local.rss",
        "label": "CBS6 Albany Local",
    },
    {
        "key": "wnyt",
        "url": "https://wnyt.com/feed/",
        "label": "WNYT",
    },
    {
        "key": "albany_city_rss",
        "url": "https://www.albanyny.gov/RSSFeed.aspx?ModID=71&CID=All-0",
        "label": "City of Albany Official",
    },
    {
        "key": "spectrum_capregion_pubsafety",
        "url": "https://spectrumlocalnews.com/services/contentfeed.nys|capital-region|public-safety.landing.rss",
        "label": "Spectrum Capital Region Public Safety",
    },
    {
        "key": "spectrum_capregion_news",
        "url": "https://spectrumlocalnews.com/services/contentfeed.nys|capital-region|news.landing.rss",
        "label": "Spectrum Capital Region News",
    },
    {
        "key": "fbi_albany",
        "url": "https://www.fbi.gov/contact-us/field-offices/albany/RSS",
        "label": "FBI Albany Field Office",
    },
    {
        "key": "albanyny_pubsafety_committee",
        "url": "https://www.albanyny.gov/RSSFeed.aspx?ModID=65&CID=Public-Safety-Committee-17",
        "label": "City of Albany Public Safety Committee",
    },
    {
        "key": "albanyny_cprb",
        "url": "https://www.albanyny.gov/RSSFeed.aspx?ModID=65&CID=Community-Police-Review-Board-29",
        "label": "City of Albany Community Police Review Board",
    },
    {
        "key": "dailygazette_crime",
        "url": "https://www.dailygazette.com/search/?f=rss&t=article&c=news/crime",
        "label": "Daily Gazette Crime",
    },
]


async def subscribe_seed_feeds() -> list[dict[str, Any]]:
    """Subscribe ACT's desired push feeds.

    Prefers the registry-driven selection. Falls back to the legacy SEED_FEEDS
    list only when the registry is empty or returns zero eligible feeds (e.g.
    during fresh deploys before source_registry.json is loaded).
    """
    s = get_settings()
    if not _configured():
        return [{"ok": False, "error": "superfeedr not configured"}]
    callback_base = s.superfeedr_callback_base_url
    if not callback_base:
        return [{"ok": False, "error": "SUPERFEEDR_CALLBACK_BASE_URL not set"}]
    callback = f"{callback_base}/api/superfeedr/webhook"
    secret = s.superfeedr_secret

    # Registry-first
    try:
        from app.services.superfeedr_registry import desired_subscriptions
        registry_feeds = [
            {
                "key": str(e.get("source_id") or ""),
                "url": str(e.get("feed_url") or ""),
                "label": str(e.get("source_name") or ""),
            }
            for e in desired_subscriptions()
            if e.get("feed_url")
        ]
    except Exception as exc:
        logger.warning("superfeedr_seed_registry_load_failed: %s", exc)
        registry_feeds = []

    feeds = registry_feeds if registry_feeds else SEED_FEEDS

    results: list[dict[str, Any]] = []
    for feed in feeds:
        try:
            r = await subscribe(
                feed["url"],
                callback,
                secret=secret,
            )
            r["feed_key"] = feed["key"]
            results.append(r)
        except Exception as exc:
            results.append({
                "ok": False,
                "feed_key": feed["key"],
                "feed_url": feed["url"],
                "error": str(exc),
            })
    return results
