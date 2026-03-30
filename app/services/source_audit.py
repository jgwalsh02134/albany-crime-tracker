from __future__ import annotations

import os
import re
from collections import Counter
from typing import Any
from urllib.parse import parse_qs
from urllib.parse import urlparse


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _read_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def _norm_url(url: str) -> str:
    if not url:
        return ""
    try:
        p = urlparse(url.strip())
        host = (p.netloc or "").lower()
        path = re.sub(r"/+", "/", p.path or "").rstrip("/")
        return host + path
    except Exception:
        return ""


def _extract_site_domain_from_gnews(url: str) -> str:
    try:
        p = urlparse(url)
        if "news.google.com" not in (p.netloc or "").lower():
            return ""
        q = parse_qs(p.query or "")
        query = " ".join(q.get("q", []))
        m = re.search(r"site:([a-z0-9.-]+\.[a-z]{2,})", query, flags=re.I)
        if m:
            return m.group(1).lower()
    except Exception:
        return ""
    return ""


def _implemented_url_keys() -> set[str]:
    root = _repo_root()
    api_server = _read_file(os.path.join(root, "api_server.py"))
    tier1 = _read_file(os.path.join(root, "sources", "tier1_official.py"))
    urls = set(re.findall(r'"url"\s*:\s*"([^"]+)"', api_server))
    urls.update(re.findall(r'"(https?://[^"]+)"', tier1))
    urls.update(
        {
            "https://data.albanyny.gov/resource/qq93-cnn2.json",
            "https://data.albanyny.gov/resource/7y34-47cz.json",
            "https://data.albanyny.gov/resource/m4jx-di39.json",
            "https://www.albanyny.gov/rss.aspx",
            "https://www.albanycountyny.gov/government/albany-county-district-attorney/press-office",
            "https://troopers.ny.gov/nysp-newsroom",
            "https://publicapps.troopers.ny.gov/Media_Reports/",
            "https://www.justice.gov/usao-ndny/pr/rss",
            "https://511ny.org/api/GetEvents",
            "https://api.openmhz.com/albanycony/calls/newer",
            "https://api.openmhz.com/albanycony/calls?num=40",
        }
    )
    return {_norm_url(u) for u in urls if u}


def audit_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    implemented_keys = _implemented_url_keys()
    audited: list[dict[str, Any]] = []

    raw_url_counts: Counter[str] = Counter()
    social_counts: Counter[str] = Counter()
    host_counts: Counter[str] = Counter()
    direct_hosts: set[str] = set()

    for e in entries:
        canonical = str(e.get("canonical_url") or "")
        feed = str(e.get("feed_url") or "")
        api = str(e.get("api_url") or "")
        social_urls = e.get("social_urls") if isinstance(e.get("social_urls"), list) else []
        social = str(social_urls[0]) if social_urls else ""
        primary = canonical or feed or api or social
        primary_key = _norm_url(primary)
        if primary_key:
            raw_url_counts[primary_key] += 1
        if social:
            social_counts[_norm_url(social)] += 1
        host = (urlparse(primary).netloc or "").lower() if primary else ""
        if host:
            host_counts[host] += 1
            if "news.google.com" not in host:
                direct_hosts.add(host)

    for e in entries:
        canonical = str(e.get("canonical_url") or "")
        feed = str(e.get("feed_url") or "")
        api = str(e.get("api_url") or "")
        social_urls = e.get("social_urls") if isinstance(e.get("social_urls"), list) else []
        social = str(social_urls[0]) if social_urls else ""
        source_id = str(e.get("source_id") or "")
        validation_status = str(e.get("validation_status") or "")
        active_status = bool(e.get("active_status"))
        ingestion_method = str(e.get("ingestion_method") or "")
        auth_type = str(e.get("auth_type") or "")

        key_candidates = {_norm_url(x) for x in (canonical, feed, api) if x}
        implemented = any(k in implemented_keys for k in key_candidates) and (not source_id.startswith("discovered-"))
        validated_live = active_status and validation_status.startswith("reachable:")

        duplicate_flag = False
        duplicate_reason = ""
        primary = canonical or feed or api or social
        primary_key = _norm_url(primary)
        if primary_key and raw_url_counts[primary_key] > 1:
            duplicate_flag = True
            duplicate_reason = "duplicate_url"
        if social and social_counts[_norm_url(social)] > 1:
            duplicate_flag = True
            duplicate_reason = duplicate_reason or "duplicate_social"
        gnews_site = _extract_site_domain_from_gnews(primary)
        if gnews_site and gnews_site in direct_hosts:
            duplicate_flag = True
            duplicate_reason = duplicate_reason or "gnews_fallback_duplicate"
        if "everbridge.com/products/nixle" in primary.lower():
            duplicate_flag = True
            duplicate_reason = duplicate_reason or "nixle_mirror_duplicate"

        unsuitable_flag = False
        unsuitable_reason = ""
        lower_vs = validation_status.lower()
        if any(x in lower_vs for x in ("nodename nor servname", "timed out", "ssl", "connection", "name or service not known")):
            unsuitable_flag = True
            unsuitable_reason = "unreachable"
        if auth_type == "auth_required" and ingestion_method == "html_scrape":
            unsuitable_flag = True
            unsuitable_reason = unsuitable_reason or "blocked_or_auth_gated"
        if "reachable:403" in validation_status and ingestion_method == "html_scrape":
            unsuitable_flag = True
            unsuitable_reason = unsuitable_reason or "blocked_403"

        discovered = source_id.startswith("discovered-")
        if duplicate_flag:
            audit_class = "duplicate_or_low_value"
            reason = duplicate_reason or "duplicate"
        elif unsuitable_flag:
            audit_class = "unsuitable_or_blocked"
            reason = unsuitable_reason or "unsuitable"
        elif implemented and validated_live:
            audit_class = "implemented_and_active"
            reason = "implemented_live"
        elif validated_live:
            audit_class = "discovered_and_validated"
            reason = "validated_not_implemented"
        else:
            audit_class = "discovered_but_unvalidated" if discovered or not implemented else "unsuitable_or_blocked"
            reason = "discovered_unvalidated" if (discovered or not implemented) else "not_live"

        audited.append(
            {
                "source_id": source_id,
                "source_name": str(e.get("source_name") or ""),
                "organization": str(e.get("organization") or ""),
                "category": str(e.get("category") or ""),
                "lane": str(e.get("lane") or ""),
                "trust_tier": str(e.get("trust_tier") or ""),
                "canonical_url": canonical,
                "feed_url": feed,
                "api_url": api,
                "social_url": social,
                "implemented_ingestor": "yes" if implemented else "no",
                "validated_live": "yes" if validated_live else "no",
                "active_status": str(active_status).lower(),
                "duplicate_flag": "yes" if duplicate_flag else "no",
                "unsuitable_flag": "yes" if unsuitable_flag else "no",
                "reason": reason,
                "audit_class": audit_class,
            }
        )
    return audited


def audit_counts(audited: list[dict[str, Any]]) -> dict[str, int]:
    c = Counter(str(x.get("audit_class") or "unknown") for x in audited)
    return dict(sorted(c.items(), key=lambda kv: (-kv[1], kv[0])))
