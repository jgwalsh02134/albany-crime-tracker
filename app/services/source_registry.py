from __future__ import annotations

import json
import os
from collections import Counter
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit, urlunsplit


def _registry_path() -> str:
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "source_registry.json")


def load_source_registry() -> list[dict[str, Any]]:
    path = _registry_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                return [x for x in data if isinstance(x, dict)]
    except Exception:
        return []
    return []


def source_registry_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    category_counts = Counter(str(x.get("category") or "unknown") for x in entries)
    active_count = sum(1 for x in entries if bool(x.get("active_status")))
    # New adapters registered in api_server.py RSS_FEEDS_LOCAL
    new_adapters = [
        {
            "id": "ny511_traffic_gnews",
            "label": "511NY Traffic",
            "type": "traffic",
            "status": "active",
            "description": "511NY Capital District traffic incidents via Google News RSS",
        },
        {
            "id": "albany_open_data_gnews",
            "label": "Albany Open Data (Socrata)",
            "type": "open_data",
            "status": "active",
            "description": "Albany city/county open data crime statistics and incident records",
        },
        {
            "id": "community_alerts_gnews",
            "label": "Community Alerts",
            "type": "community",
            "status": "active",
            "description": "Local community alerts and social media public safety posts",
        },
    ]
    return {
        "total_sources": len(entries),
        "active_sources": active_count,
        "inactive_sources": max(0, len(entries) - active_count),
        "category_counts": dict(sorted(category_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "new_adapters": new_adapters,
        "adapter_types": ["scanner", "news", "traffic", "open_data", "community", "official"],
    }


def normalize_feed_url(url: str) -> str:
    """Canonical form for comparing feed URLs across registry / Superfeedr responses.

    Preserves scheme + host lowercased, keeps path verbatim (RSS paths are often
    case-sensitive on origin servers), strips fragments, drops common tracking
    params, and removes trailing slashes on the path.
    """
    raw = (url or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
    except Exception:
        return raw
    scheme = (parts.scheme or "https").lower()
    host = (parts.netloc or "").lower()
    if host.startswith("www."):
        host_alt = host[4:]
    else:
        host_alt = host
    # Keep stable host normalization: drop leading 'www.' so registry and
    # Superfeedr-reported feed URLs compare equal.
    host = host_alt
    path = parts.path or ""
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    query = parts.query or ""
    # Drop empty fragments; keep query string as-is (some feeds require params).
    return urlunsplit((scheme, host, path, query, ""))


# Hosts that should never be primary Superfeedr push subscriptions because
# they aren't true RSS in the push sense, create duplicate coverage, or are
# scanner / aggregator surfaces that polling handles directly.
#
# Grouped for clarity. Host matching is suffix-aware so subdomains (e.g.
# addons.mozilla.org, discover.buysellads.com) inherit the block.
_SUPERFEEDR_DENY_HOSTS: frozenset[str] = frozenset({
    # Aggregators / scanners already covered elsewhere
    "broadcastify.com",
    "feedly.com",
    "reddit.com",
    "old.reddit.com",
    "news.google.com",
    # Social profile surfaces (not real feeds, just URLs with "feed" in them)
    "twitter.com",
    "x.com",
    "linkedin.com",
    "facebook.com",
    "fb.com",
    "instagram.com",
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "pinterest.com",
    "bsky.app",
    "mastodon.social",
    "threads.net",
    # Browser extension / app stores (landing pages, not feeds)
    "addons.mozilla.org",
    "chromewebstore.google.com",
    "chrome.google.com",
    "microsoftedge.microsoft.com",
    "addons.opera.com",
    "apps.apple.com",
    "itunes.apple.com",
    "play.google.com",
    # Ad / marketing networks (Feedly marketing ecosystem pollution)
    "buysellads.com",
    "discover.buysellads.com",
    # Off-topic federal / non-incident sources auto-discovered into registry.
    # These are reachable RSS endpoints but have no ACT public-safety relevance
    # for Albany County. Keep this list surgical and review when adding.
    "oig.ssa.gov",
    "ice.gov",
    "stopdwi.org",
    "seeclickfix.com",
    "albanyhousing.org",
})


# Regex-free feed-path signatures. A URL must satisfy at least one to be
# considered a real feed (not a product/profile/landing page that merely
# contains the word "feed" in its path). Verified against every
# currently-eligible registry entry before being tightened.
_FEED_PATH_ENDINGS: tuple[str, ...] = (
    ".rss",
    ".atom",
    ".xml",
    "/rss",
    "/rss/",
    "/feed",
    "/feed/",
    "rss.aspx",
    "rssfeed.aspx",
    "/atom",
    "/atom/",
)
_FEED_QUERY_MARKERS: tuple[str, ...] = (
    "f=rss",
    "format=rss",
    "output=rss",
    "modid=",
    "cid=",
)


def _looks_like_feed_url(url: str) -> bool:
    """True when the URL's path/query matches a real feed signature.

    Rejects pages whose URL merely contains the substring 'feed' or 'rss' for
    unrelated reasons (e.g. /addon/feedly_mini/, /company/feedly,
    /about/feedback.htm, /detail/feedly-mini/<extension-id>).
    """
    if not url:
        return False
    try:
        parts = urlsplit(url)
    except Exception:
        return False
    path_lower = (parts.path or "").lower().rstrip("/") or "/"
    # Normalize: test with and without trailing slash to cover /feed vs /feed/.
    candidates = {path_lower, path_lower + "/"}
    for suffix in _FEED_PATH_ENDINGS:
        for cand in candidates:
            if cand.endswith(suffix):
                return True
    query_lower = (parts.query or "").lower()
    for marker in _FEED_QUERY_MARKERS:
        if marker in query_lower:
            return True
    return False


def _host_of(url: str) -> str:
    try:
        host = (urlsplit(url).netloc or "").lower()
    except Exception:
        return ""
    # Strip the leading "www." label only — not a char set.
    if host.startswith("www."):
        host = host[4:]
    return host


def _host_matches_deny(host: str, deny_hosts: frozenset[str]) -> bool:
    """Return True when `host` exactly matches or is a subdomain of any
    denied host. e.g. addons.mozilla.org matches 'mozilla.org' if listed,
    and discover.buysellads.com matches 'buysellads.com'."""
    if not host:
        return False
    for denied in deny_hosts:
        d = denied.lower()
        if d.startswith("www."):
            d = d[4:]
        if host == d or host.endswith("." + d):
            return True
    return False


def is_push_eligible(
    entry: dict[str, Any],
    *,
    allow_feed_urls: Optional[Iterable[str]] = None,
    deny_feed_urls: Optional[Iterable[str]] = None,
) -> bool:
    """Return True if a registry entry should be a primary Superfeedr push feed.

    Rules:
      - must have a non-empty feed_url
      - must be active_status == True
      - validation_status must indicate reachable:200
      - ingestion_method must be rss_poll (push replaces polling)
      - host must not be in the deny list (scanner / aggregator / duplicator)
      - explicit allow/deny overrides by feed_url win over heuristic rules
    """
    feed_url = str(entry.get("feed_url") or "").strip()
    if not feed_url:
        return False
    norm = normalize_feed_url(feed_url)
    deny_norm = {normalize_feed_url(u) for u in (deny_feed_urls or [])}
    allow_norm = {normalize_feed_url(u) for u in (allow_feed_urls or [])}
    if norm in deny_norm:
        return False
    if norm in allow_norm:
        return True
    if not bool(entry.get("active_status")):
        return False
    if str(entry.get("validation_status") or "").strip().lower() != "reachable:200":
        return False
    if str(entry.get("ingestion_method") or "").strip().lower() != "rss_poll":
        return False
    if str(entry.get("auth_type") or "").strip().lower() not in ("", "none"):
        return False
    host = _host_of(feed_url)
    if _host_matches_deny(host, _SUPERFEEDR_DENY_HOSTS):
        return False
    # Reject URLs that merely contain "feed"/"rss" substrings without being
    # actual feeds (addon/extension pages, social profiles, feedback pages).
    if not _looks_like_feed_url(feed_url):
        return False
    return True


def select_superfeedr_feeds(
    entries: list[dict[str, Any]],
    *,
    allow_feed_urls: Optional[Iterable[str]] = None,
    deny_feed_urls: Optional[Iterable[str]] = None,
) -> list[dict[str, Any]]:
    """Return the subset of registry entries eligible for Superfeedr push.

    De-duplicates by normalized feed URL, preferring higher trust_tier.
    """
    tier_rank = {"tier_1": 3, "tier_2": 2, "tier_3": 1}
    best: dict[str, dict[str, Any]] = {}
    for e in entries:
        if not is_push_eligible(
            e,
            allow_feed_urls=allow_feed_urls,
            deny_feed_urls=deny_feed_urls,
        ):
            continue
        norm = normalize_feed_url(str(e.get("feed_url") or ""))
        if not norm:
            continue
        prev = best.get(norm)
        if prev is None or tier_rank.get(str(e.get("trust_tier") or ""), 0) > tier_rank.get(
            str(prev.get("trust_tier") or ""), 0
        ):
            best[norm] = e
    # Stable order: tier first, then source_id alpha
    return sorted(
        best.values(),
        key=lambda x: (
            -tier_rank.get(str(x.get("trust_tier") or ""), 0),
            str(x.get("source_id") or ""),
        ),
    )


def index_by_feed_url(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Build a lookup of normalized feed_url and canonical_url -> registry entry.

    canonical_url is included because Superfeedr sometimes echoes the canonical
    site URL rather than the feed URL in status.feed / title metadata.
    Feed URL takes precedence when both map to the same normalized string.
    """
    out: dict[str, dict[str, Any]] = {}
    for e in entries:
        for key in ("canonical_url", "feed_url"):
            url = str(e.get(key) or "").strip()
            if not url:
                continue
            norm = normalize_feed_url(url)
            if not norm:
                continue
            # feed_url wins if already set by feed_url for a different entry
            if key == "feed_url" or norm not in out:
                out[norm] = e
    return out


# Mapping from registry category / trust_tier to the IncidentRecord-level
# source_type and verification_level the rest of ACT expects.
def map_registry_to_incident_fields(entry: dict[str, Any]) -> dict[str, str]:
    category = str(entry.get("category") or "").lower()
    tier = str(entry.get("trust_tier") or "").lower()
    lane = str(entry.get("lane") or "").lower()

    if category in ("official_alerts", "official_structured", "municipal", "federal"):
        source_type = "official_alerts"
        verification = "official"
    elif category in ("tv_news", "newspaper", "radio", "community"):
        source_type = "local_news"
        verification = "media"
    elif category == "scanner":
        source_type = "scanner"
        verification = "scanner"
    else:
        source_type = "local_news" if tier in ("tier_1", "tier_2") else "unknown"
        verification = "media" if tier in ("tier_1", "tier_2") else "inferred"

    # Tier_1 structured data reports should surface as official.
    if tier == "tier_1" and category in ("official_structured", "municipal", "federal"):
        verification = "official"
    # developing lanes are less confirmed.
    if lane == "developing_incidents" and verification == "media":
        # keep as-is; media-reported developing incidents are still media-verified
        pass

    return {"source_type": source_type, "verification_level": verification, "lane": lane}
