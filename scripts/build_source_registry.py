#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LE_DIRECTORY_PATH = os.path.join(ROOT, "le_directory.json")
REGISTRY_PATH = os.path.join(ROOT, "source_registry.json")
INVENTORY_PATH = os.path.join(ROOT, "source_inventory.md")


@dataclass
class UrlCheck:
    url: str
    status_code: Optional[int]
    reachable: bool
    requires_auth: bool
    note: str = ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")


def _host(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower()
    except Exception:
        return ""


def _category_for_url(url: str, fallback: str = "community") -> str:
    h = _host(url)
    u = (url or "").lower()
    if "data.albanyny.gov" in h or "/resource/" in u:
        return "official_structured"
    if "511ny.org" in h:
        return "traffic"
    if "justice.gov" in h or "fbi.gov" in h or "api.usa.gov" in h:
        return "federal"
    if "troopers.ny.gov" in h or "publicapps.troopers.ny.gov" in h:
        return "state"
    if "albanycountyny.gov" in h:
        return "county"
    if "albanyny.gov" in h:
        return "municipal"
    if "news10.com" in h or "cbs6albany.com" in h or "wnyt.com" in h or "spectrumlocalnews.com" in h:
        return "tv_news"
    if "timesunion.com" in h or "dailygazette.com" in h:
        return "newspapers"
    if "dailyvoice.com" in h or "patch.com" in h or "spotlightnews.com" in h:
        return "digital_only_news"
    if "wamc.org" in h:
        return "radio"
    if "openmhz.com" in h or "broadcastify.com" in h or "radioreference.com" in h:
        return "scanner"
    if "albany.edu" in h or "police.albany.edu" in h:
        return "campus"
    if "facebook.com" in h or "twitter.com" in h or "x.com" in h:
        return "official_social"
    return fallback


def _lane_for_category(category: str) -> str:
    if category in {"official_structured", "federal", "state", "county", "municipal", "official_press", "official_alerts"}:
        return "official_updates"
    if category in {"tv_news", "newspapers", "digital_only_news", "radio"}:
        return "verified_incidents"
    if category in {"scanner", "community", "official_social"}:
        return "developing_incidents"
    return "trends_context"


def _tier_for_category(category: str) -> str:
    if category in {"official_structured", "official_press", "official_alerts", "federal", "state", "county", "municipal"}:
        return "tier_1"
    if category in {"tv_news", "newspapers", "digital_only_news", "radio"}:
        return "tier_2"
    return "tier_3"


def _ingestion_method_for_url(url: str) -> str:
    u = (url or "").lower()
    if "api.radioreference.com/soap2" in u:
        return "soap_api"
    if "arcgis/rest/services" in u:
        return "feature_service"
    if ".atom" in u or "weather.gov/alerts" in u:
        return "cap_feed"
    if ".rss" in u or "/feed" in u or "/rss" in u or "news.google.com/rss/" in u:
        return "rss_poll"
    if "/resource/" in u or "/api/" in u:
        return "json_api"
    if "facebook.com" in u or "twitter.com" in u or "x.com" in u:
        return "social_parser"
    return "html_scrape"


async def _check_url(client: httpx.AsyncClient, url: str) -> UrlCheck:
    try:
        r = await client.get(url, timeout=12.0, follow_redirects=True)
        requires_auth = r.status_code in (401, 403)
        reachable = r.status_code < 400 or r.status_code in (401, 403)
        note = ""
        if r.status_code == 429:
            note = "rate_limited"
        return UrlCheck(url=url, status_code=r.status_code, reachable=reachable, requires_auth=requires_auth, note=note)
    except Exception as exc:
        return UrlCheck(url=url, status_code=None, reachable=False, requires_auth=False, note=str(exc))


def _extract_links(base_url: str, html: str) -> list[str]:
    out: list[str] = []
    text = html or ""
    for m in re.finditer(r'<link[^>]+rel=["\']alternate["\'][^>]+>', text, flags=re.I):
        tag = m.group(0)
        if ("rss" in tag.lower()) or ("atom" in tag.lower()):
            href_m = re.search(r'href=["\']([^"\']+)["\']', tag, flags=re.I)
            if href_m:
                out.append(urljoin(base_url, unescape(href_m.group(1))))
    for m in re.finditer(r'href=["\']([^"\']+)["\']', text, flags=re.I):
        href = unescape(m.group(1)).strip()
        if not href or href.startswith("#") or href.startswith("mailto:") or href.startswith("javascript:"):
            continue
        full = urljoin(base_url, href)
        fl = full.lower()
        if any(k in fl for k in ("/feed", "/rss", ".rss", "sitemap.xml", "/newsroom", "/press", "/alerts", "/police", "/crime", "/public-safety", "/local-news")):
            out.append(full)
    uniq: list[str] = []
    seen: set[str] = set()
    for u in out:
        k = u.strip()
        if not k or k in seen:
            continue
        seen.add(k)
        uniq.append(k)
    return uniq


def _seed_entries() -> list[dict[str, Any]]:
    seeds = [
        ("albany-socrata-crimes", "Albany Socrata Crimes by Neighborhood", "official_structured", "https://data.albanyny.gov/resource/qq93-cnn2.json"),
        ("albany-socrata-arrests", "Albany Socrata Arrests by Neighborhood", "official_structured", "https://data.albanyny.gov/resource/7y34-47cz.json"),
        ("albany-socrata-calls", "Albany Socrata Calls for Service by Neighborhood", "official_structured", "https://data.albanyny.gov/resource/m4jx-di39.json"),
        ("albany-socrata-force", "Albany Socrata Use of Force by Month", "official_structured", "https://data.albanyny.gov/resource/na5h-ypn4.json"),
        ("albany-rss", "City of Albany RSS", "official_alerts", "https://www.albanyny.gov/rss.aspx"),
        ("albany-civicalerts", "City of Albany CivicAlerts", "official_alerts", "https://www.albanyny.gov/CivicAlerts.aspx"),
        ("albany-civicalerts-apd", "Albany Police CivicAlerts Category", "official_alerts", "https://www.albanyny.gov/CivicAlerts.aspx?CID=10"),
        ("albany-pubsafety-committee-rss", "Albany Public Safety Committee RSS", "municipal", "https://www.albanyny.gov/RSSFeed.aspx?ModID=65&CID=Public-Safety-Committee-17"),
        ("albany-cprb-rss", "Albany Community Police Review Board RSS", "municipal", "https://www.albanyny.gov/RSSFeed.aspx?ModID=65&CID=Community-Police-Review-Board-29"),
        ("albany-pd", "Albany Police Department", "municipal", "https://www.albanyny.gov/348/Albany-Police"),
        ("albany-da-press", "Albany County DA Press Office", "official_press", "https://www.albanycountyny.gov/government/albany-county-district-attorney/press-office"),
        ("nysp-newsroom", "NYSP Newsroom", "official_press", "https://troopers.ny.gov/nysp-newsroom"),
        ("nysp-media-reports", "NYSP Media Reports", "official_press", "https://publicapps.troopers.ny.gov/Media_Reports/"),
        ("usao-ndny-rss", "USAO NDNY RSS", "federal", "https://www.justice.gov/usao-ndny/pr/rss"),
        ("fbi-albany-news", "FBI Albany News", "federal", "https://www.fbi.gov/contact-us/field-offices/albany/news"),
        ("fbi-albany-rss", "FBI Albany Field Office RSS", "federal", "https://www.fbi.gov/contact-us/field-offices/albany/RSS"),
        ("ny511-dev-doc", "511NY Developers Docs", "traffic", "https://511ny.org/developers/doc"),
        ("ny511-events-api", "511NY GetEvents API", "traffic", "https://511ny.org/api/GetEvents"),
        ("fbi-cde-api", "FBI Crime Data Explorer API", "federal", "https://api.usa.gov/crime/fbi/sapi"),
        ("news10-feed", "NEWS10 Feed", "tv_news", "https://www.news10.com/feed/"),
        ("news10-crime-feed", "NEWS10 Crime Feed", "tv_news", "https://www.news10.com/news/crime/feed/"),
        ("news10-local-feed", "NEWS10 Local Feed", "tv_news", "https://www.news10.com/news/local-news/feed/"),
        ("cbs6-news-rss", "CBS6 News RSS", "tv_news", "https://cbs6albany.com/news.rss"),
        ("cbs6-local-rss", "CBS6 Local RSS", "tv_news", "https://cbs6albany.com/news/local.rss"),
        ("spectrum-ps-rss", "Spectrum Capital Region Public Safety RSS", "tv_news", "https://spectrumlocalnews.com/services/contentfeed.nys|capital-region|public-safety.landing.rss"),
        ("spectrum-capregion-news-rss", "Spectrum Capital Region News RSS", "tv_news", "https://spectrumlocalnews.com/services/contentfeed.nys|capital-region|news.landing.rss"),
        ("times-union-local-feed", "Times Union Local Feed", "newspapers", "https://www.timesunion.com/local/feed/"),
        ("daily-gazette-rss", "Daily Gazette Crime RSS Search", "newspapers", "https://www.dailygazette.com/search/?f=rss&t=article&c=news/crime"),
        ("spotlight-feed", "Spotlight News Feed", "digital_only_news", "https://spotlightnews.com/feed/"),
        ("spotlight-crime-feed", "Spotlight Crime Feed", "digital_only_news", "https://spotlightnews.com/category/news/crime-and-police/feed/"),
        ("daily-voice-feed", "Daily Voice Albany Feed", "digital_only_news", "https://dailyvoice.com/ny/albany/feed/"),
        ("patch-albany-rss", "Patch Albany RSS", "digital_only_news", "https://patch.com/new-york/albany-ny/posts.rss"),
        ("patch-colonie-rss", "Patch Colonie RSS", "digital_only_news", "https://patch.com/new-york/colonie-ny/posts.rss"),
        ("patch-guilderland-rss", "Patch Guilderland RSS", "digital_only_news", "https://patch.com/new-york/guilderland-ny/posts.rss"),
        ("patch-bethlehem-rss", "Patch Bethlehem RSS", "digital_only_news", "https://patch.com/new-york/bethlehem-ny/posts.rss"),
        ("wamc-news", "WAMC News", "radio", "https://www.wamc.org/news"),
        ("wnyt-gnews-fallback", "WNYT Google News RSS", "tv_news", "https://news.google.com/rss/search?q=site:wnyt.com+Albany+crime+OR+arrest+OR+shooting+OR+fire&hl=en-US&gl=US&ceid=US:en"),
        ("openmhz-calls", "OpenMHz Albany Calls API", "scanner", "https://api.openmhz.com/albanycony/calls/newer"),
        ("openmhz-system", "OpenMHz Albany System", "scanner", "https://openmhz.com/system/albanycony"),
        ("broadcastify-feed-3626", "Broadcastify Feed 3626", "scanner", "https://www.broadcastify.com/listen/feed/3626"),
        ("broadcastify-ctid-1825", "Broadcastify Albany County", "scanner", "https://www.broadcastify.com/listen/ctid/1825"),
        ("radioreference-ctid-1825", "RadioReference Albany County", "scanner", "https://www.radioreference.com/db/browse/ctid/1825"),
        ("ualbany-incidents", "UAlbany Incident Log", "campus", "https://police.albany.edu/IETS/UPD_All_Incidents.aspx"),
        ("reddit-albany-crime-rss", "Reddit Albany Crime Search RSS", "community", "https://www.reddit.com/r/Albany/search.rss?q=crime+OR+shooting+OR+police+OR+arrest&sort=new&restrict_sr=on"),
        ("spotcrime-albany", "SpotCrime Albany", "community", "https://spotcrime.com/NY/Albany"),
        ("crime-stoppers", "Capital Region Crime Stoppers", "community", "http://www.capitalregioncrimestoppers.com"),
        ("albany-police-facebook", "Albany Police Facebook", "official_social", "https://www.facebook.com/AlbanyNYPolice"),
        ("albany-police-twitter", "Albany Police X", "official_social", "https://twitter.com/albanypolice"),
        ("colonie-facebook", "Colonie PD Facebook", "official_social", "https://www.facebook.com/ColoniePD"),
        ("colonie-twitter", "Colonie PD X", "official_social", "https://twitter.com/colonie_police"),
        ("bethlehem-facebook", "Bethlehem PD Facebook", "official_social", "https://www.facebook.com/PDBethlehem"),
        ("bethlehem-twitter", "Bethlehem PD X", "official_social", "https://twitter.com/PdBethlehem"),
        ("guilderland-facebook", "Guilderland PD Facebook", "official_social", "https://www.facebook.com/guilderlandpolice"),
        ("guilderland-twitter", "Guilderland PD X", "official_social", "https://twitter.com/guilderlandpd"),
        ("nysp-facebook", "NYSP Facebook", "official_social", "https://www.facebook.com/nyspolice"),
        ("nysp-twitter", "NYSP X", "official_social", "https://twitter.com/nyspolice"),
    ]
    out: list[dict[str, Any]] = []
    for sid, name, category, url in seeds:
        out.append(
            {
                "source_id": sid,
                "source_name": name,
                "organization": name,
                "category": category,
                "lane": _lane_for_category(category),
                "trust_tier": _tier_for_category(category),
                "canonical_url": url,
                "feed_url": url if _ingestion_method_for_url(url) == "rss_poll" else "",
                "api_url": url if _ingestion_method_for_url(url) == "json_api" else "",
                "social_urls": [url] if category == "official_social" else [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": "Seed source",
                "auth_type": "none",
                "env_var_if_needed": "SOCRATA_APP_TOKEN" if "data.albanyny.gov" in url else "",
                "active_status": False,
                "validation_status": "pending",
                "last_checked_at": "",
                "ingestion_method": _ingestion_method_for_url(url),
                "legal_notes": "Use published public endpoints and platform terms.",
            }
        )
    out.extend(
        [
            {
                "source_id": "511ny_full",
                "source_name": "511NY Full API",
                "organization": "511NY Full API",
                "category": "traffic",
                "lane": "official_updates",
                "trust_tier": "tier_1",
                "canonical_url": "https://511ny.org/developers/doc",
                "feed_url": "",
                "api_url": "https://511ny.org/api/GetEvents",
                "social_urls": [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": "511NY GetEvents + GetCameras fusion for Albany County traffic incidents.",
                "auth_type": "key",
                "env_var_if_needed": "511_NY_API_KEY",
                "active_status": False,
                "validation_status": "pending",
                "last_checked_at": "",
                "ingestion_method": "json_api",
                "legal_notes": "Use published public endpoints and platform terms.",
                "provider": "511ny",
                "type": "api",
                "config": {
                    "events_endpoint": "https://511ny.org/api/GetEvents",
                    "cameras_endpoint": "https://511ny.org/api/GetCameras",
                    "api_key_env": "511_NY_API_KEY",
                },
            },
            {
                "source_id": "radioreference_ws",
                "source_name": "RadioReference WS",
                "organization": "RadioReference WS",
                "category": "scanner",
                "lane": "developing_incidents",
                "trust_tier": "tier_3",
                "canonical_url": "https://api.radioreference.com/soap2/",
                "feed_url": "",
                "api_url": "https://api.radioreference.com/soap2/",
                "social_urls": [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": "SOAP talkgroup metadata and agency/jurisdiction mapping for Albany County scanner enrichment.",
                "auth_type": "auth_required",
                "env_var_if_needed": "RADIOREFERENCE_API_KEY,RADIOREFERENCE_USERNAME,RADIOREFERENCE_PASSWORD",
                "active_status": False,
                "validation_status": "pending",
                "last_checked_at": "",
                "ingestion_method": "soap_api",
                "legal_notes": "Use authenticated RadioReference SOAP access per account terms.",
                "provider": "radioreference",
                "type": "api",
                "config": {
                    "sid": "8553",
                    "system_id": 695,
                    "wacn": "BEE00",
                    "ctid": 1825,
                    "credentials": [
                        "RADIOREFERENCE_API_KEY",
                        "RADIOREFERENCE_USERNAME",
                        "RADIOREFERENCE_PASSWORD",
                    ],
                    "talkgroup_mapping": "runtime_enrichment",
                },
            },
            {
                "source_id": "scanner_albany_p25_main",
                "source_name": "Albany/Schenectady P25 (scanner registry)",
                "organization": "Albany/Schenectady Counties P25",
                "category": "scanner",
                "lane": "developing_incidents",
                "trust_tier": "tier_3",
                "canonical_url": "https://www.radioreference.com/db/sid/8553",
                "feed_url": "",
                "api_url": "https://api.radioreference.com/soap2/",
                "social_urls": [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": (
                    "Curated P25 registry: SysID 695, WACN BEE00, RR sid 8553, CTID 1825; "
                    "priority law/fire/EMS dispatch TGs with wiki-aligned labels."
                ),
                "auth_type": "auth_required",
                "env_var_if_needed": "RADIOREFERENCE_API_KEY,RADIOREFERENCE_USERNAME,RADIOREFERENCE_PASSWORD",
                "active_status": False,
                "validation_status": "pending",
                "last_checked_at": "",
                "ingestion_method": "soap_api",
                "legal_notes": "Scanner metadata only; corroborate with official sources.",
                "provider": "radioreference",
                "type": "scanner_registry",
                "config": {
                    "source_id": "scanner_albany_p25_main",
                    "system_id": 695,
                    "sid": 8553,
                    "wacn": "BEE00",
                    "radioreference_sid": "8553",
                    "ctid": 1825,
                    "confidence_base": 50,
                    "priority_talkgroups": [10003, 18301, 10702, 11003, 11702, 10002, 13202],
                    "priority_talkgroup_meta": {
                        "10003": {
                            "wiki_channel_label": "County Law 1",
                            "wiki_description": (
                                "Law 1 = Albany County primary law dispatch "
                                "(county sheriff / wide-area law enforcement dispatch)."
                            ),
                        },
                        "18301": {
                            "wiki_channel_label": "Police 1",
                            "wiki_description": (
                                "City of Albany Police 1 — primary municipal law dispatch for the City of Albany."
                            ),
                        },
                        "10702": {
                            "wiki_channel_label": "County Fire 1",
                            "wiki_description": (
                                "Fire 1 = Albany County Fire 1 — patched county / mutual-aid fire dispatch "
                                "(primary fire calling)."
                            ),
                        },
                        "11003": {
                            "wiki_channel_label": "County Law 2",
                            "wiki_description": (
                                "Albany County Law 2 — secondary county law / operations "
                                "(complements County Law 1)."
                            ),
                        },
                        "11702": {
                            "wiki_channel_label": "County Fire 2",
                            "wiki_description": (
                                "Albany County Fire 2 — secondary county fire operations / tactical fire support."
                            ),
                        },
                        "10002": {
                            "wiki_channel_label": "County Law (secondary)",
                            "wiki_description": (
                                "Albany County law secondary / operations channel "
                                "(TG 10002 on P25 system 695; wiki-aligned)."
                            ),
                        },
                        "13202": {
                            "wiki_channel_label": "Albany Fire 1",
                            "wiki_description": (
                                "City of Albany Fire 1 — primary AFD fire dispatch / fireground "
                                "(city fire operations)."
                            ),
                        },
                    },
                    "credentials": [
                        "RADIOREFERENCE_API_KEY",
                        "RADIOREFERENCE_USERNAME",
                        "RADIOREFERENCE_PASSWORD",
                    ],
                },
            },
            {
                "source_id": "ipaws_cap",
                "source_name": "IPAWS CAP / NWS Fallback",
                "organization": "IPAWS CAP / NWS Fallback",
                "category": "official_alerts",
                "lane": "official_updates",
                "trust_tier": "tier_1",
                "canonical_url": "https://api.weather.gov/alerts/active.atom?area=NY",
                "feed_url": "https://api.weather.gov/alerts/active.atom?area=NY",
                "api_url": "",
                "social_urls": [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": "CAP-style public alert ingestion using NWS atom fallback for Albany-relevant alerts.",
                "auth_type": "none",
                "env_var_if_needed": "",
                "active_status": False,
                "validation_status": "pending",
                "last_checked_at": "",
                "ingestion_method": "cap_feed",
                "legal_notes": "Use public CAP/alert endpoints and official terms.",
                "provider": "nws",
                "type": "cap_feed",
                "config": {
                    "fallback_feed": "https://api.weather.gov/alerts/active.atom?area=NY",
                    "confidence": 0.9,
                },
            },
            {
                "source_id": "albany_arcgis",
                "source_name": "Albany ArcGIS Municipal Boundaries",
                "organization": "Albany ArcGIS Municipal Boundaries",
                "category": "official_structured",
                "lane": "official_updates",
                "trust_tier": "tier_1",
                "canonical_url": "https://services6.arcgis.com/mBzcjj7yrA6fBe9F/arcgis/rest/services/Albany_County_Municipalities/FeatureServer",
                "feed_url": "",
                "api_url": "https://services6.arcgis.com/mBzcjj7yrA6fBe9F/arcgis/rest/services/Albany_County_Municipalities/FeatureServer/0/query",
                "social_urls": [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": "Albany County municipality boundary lookup for geo-aware enrichment and validation.",
                "auth_type": "none",
                "env_var_if_needed": "",
                "active_status": False,
                "validation_status": "pending",
                "last_checked_at": "",
                "ingestion_method": "feature_service",
                "legal_notes": "Use public ArcGIS feature service and respect service limits.",
                "provider": "arcgis",
                "type": "feature_service",
                "config": {
                    "service_url": "https://services6.arcgis.com/mBzcjj7yrA6fBe9F/arcgis/rest/services/Albany_County_Municipalities/FeatureServer",
                    "query_url": "https://services6.arcgis.com/mBzcjj7yrA6fBe9F/arcgis/rest/services/Albany_County_Municipalities/FeatureServer/0/query",
                    "field": "MUNI_NAME",
                },
            },
        ]
    )
    return out


def _from_le_directory(data: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ag in data.get("agencies", []):
        category = ag.get("tier") or _category_for_url(ag.get("website", ""))
        agency_type = str(ag.get("type") or "").lower()
        if agency_type == "judicial" or "court" in str(ag.get("id") or ""):
            mapped_category = "courts"
        elif category in {"federal", "state", "county", "municipal", "campus"}:
            mapped_category = category
        else:
            mapped_category = "official_press"
        website = ag.get("website") or ""
        social = [s.get("url", "") for s in ag.get("socialAccounts", []) if s.get("url")]
        news = ag.get("newsPressSurfaces", []) or []
        feed_url = ""
        api_url = ""
        for n in news:
            u = n.get("url") or ""
            if not u:
                continue
            method = _ingestion_method_for_url(u)
            if method == "rss_poll" and not feed_url:
                feed_url = u
            if method == "json_api" and not api_url:
                api_url = u
        out.append(
            {
                "source_id": ag.get("id"),
                "source_name": ag.get("name"),
                "organization": ag.get("name"),
                "category": mapped_category,
                "lane": _lane_for_category(mapped_category),
                "trust_tier": _tier_for_category(mapped_category),
                "canonical_url": website,
                "feed_url": feed_url,
                "api_url": api_url,
                "social_urls": social,
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": ag.get("jurisdiction") or ag.get("notes") or "",
                "auth_type": "none",
                "env_var_if_needed": "",
                "active_status": bool(ag.get("active", False)),
                "validation_status": "seeded",
                "last_checked_at": "",
                "ingestion_method": _ingestion_method_for_url(feed_url or api_url or website),
                "legal_notes": "Official agency source; respect robots/terms and records laws.",
            }
        )
    for media in data.get("mediaSources", []):
        website = media.get("website") or ""
        category = _category_for_url(website, fallback="digital_only_news")
        out.append(
            {
                "source_id": media.get("id"),
                "source_name": media.get("name"),
                "organization": media.get("name"),
                "category": category,
                "lane": _lane_for_category(category),
                "trust_tier": _tier_for_category(category),
                "canonical_url": website,
                "feed_url": "",
                "api_url": "",
                "social_urls": [s.get("url", "") for s in media.get("socialAccounts", []) if s.get("url")],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": media.get("coverageFocus") or "",
                "auth_type": "none",
                "env_var_if_needed": "",
                "active_status": True,
                "validation_status": "seeded",
                "last_checked_at": "",
                "ingestion_method": _ingestion_method_for_url(website),
                "legal_notes": "Media source; ingest metadata or feed-compliant excerpts.",
            }
        )
    for cp in data.get("communityPlatforms", []):
        url = cp.get("url", "") or ""
        out.append(
            {
                "source_id": cp.get("id"),
                "source_name": cp.get("name"),
                "organization": cp.get("name"),
                "category": _category_for_url(url, fallback="community"),
                "lane": _lane_for_category("community"),
                "trust_tier": "tier_3",
                "canonical_url": url,
                "feed_url": "",
                "api_url": "",
                "social_urls": [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": cp.get("description") or "",
                "auth_type": "none",
                "env_var_if_needed": "",
                "active_status": True,
                "validation_status": "seeded",
                "last_checked_at": "",
                "ingestion_method": _ingestion_method_for_url(url),
                "legal_notes": "Community platform; treat as signal only, not official fact.",
            }
        )
    return out


async def _discover_links(initial_urls: list[str]) -> dict[str, str]:
    discovered: dict[str, str] = {}
    frontier = list(dict.fromkeys([u for u in initial_urls if u]))
    no_new_passes = 0
    pass_count = 0
    max_discovered = 600
    sem = asyncio.Semaphore(20)

    async def _fetch_extract(client: httpx.AsyncClient, u: str) -> list[str]:
        async with sem:
            try:
                resp = await client.get(u)
                if resp.status_code >= 400:
                    return []
                content_type = (resp.headers.get("content-type") or "").lower()
                if "html" not in content_type and "xml" not in content_type:
                    return []
                return _extract_links(u, resp.text)
            except Exception:
                return []

    async with httpx.AsyncClient(follow_redirects=True, timeout=12.0) as client:
        while frontier and no_new_passes < 2 and pass_count < 8:
            pass_count += 1
            new_urls: list[str] = []
            tasks = [_fetch_extract(client, u) for u in frontier[:200]]
            batches = await asyncio.gather(*tasks)
            for parent, links in zip(frontier[:200], batches):
                for link in links:
                    if link in discovered:
                        continue
                    discovered[link] = parent
                    new_urls.append(link)
                    if len(discovered) >= max_discovered:
                        frontier = []
                        break
                if len(discovered) >= max_discovered:
                    break
            if not new_urls:
                no_new_passes += 1
                frontier = []
            else:
                no_new_passes = 0
                frontier = new_urls
    return discovered


def _dedupe_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e in entries:
        sid = str(e.get("source_id") or "")
        url = str(e.get("canonical_url") or e.get("feed_url") or e.get("api_url") or "")
        key = sid or url
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


async def build_registry() -> list[dict[str, Any]]:
    with open(LE_DIRECTORY_PATH, "r", encoding="utf-8") as f:
        le_data = json.load(f)
    entries = _seed_entries() + _from_le_directory(le_data)
    entries = _dedupe_entries(entries)
    seed_urls = [e.get("canonical_url", "") for e in entries if e.get("canonical_url")]
    discovered = await _discover_links(seed_urls)
    for link, parent in discovered.items():
        category = _category_for_url(link, fallback="community")
        entries.append(
            {
                "source_id": "discovered-" + _slug(_host(link) + "-" + os.path.basename(urlparse(link).path or "root")),
                "source_name": f"Discovered {link}",
                "organization": _host(link),
                "category": category,
                "lane": _lane_for_category(category),
                "trust_tier": _tier_for_category(category),
                "canonical_url": link,
                "feed_url": link if _ingestion_method_for_url(link) == "rss_poll" else "",
                "api_url": link if _ingestion_method_for_url(link) == "json_api" else "",
                "social_urls": [link] if category == "official_social" else [],
                "geography_scope": "albany_county_capital_region",
                "coverage_notes": f"Discovered from {parent}",
                "auth_type": "none",
                "env_var_if_needed": "",
                "active_status": False,
                "validation_status": "discovered_unchecked",
                "last_checked_at": "",
                "ingestion_method": _ingestion_method_for_url(link),
                "legal_notes": "Discovered endpoint; verify terms before ingestion.",
            }
        )
    entries = _dedupe_entries(entries)

    urls_to_check: dict[str, str] = {}
    for e in entries:
        for field in ("canonical_url", "feed_url", "api_url"):
            u = str(e.get(field) or "").strip()
            if u and u not in urls_to_check:
                urls_to_check[u] = field

    checks: dict[str, UrlCheck] = {}
    async with httpx.AsyncClient(follow_redirects=True, timeout=12.0) as client:
        sem = asyncio.Semaphore(25)

        async def _one(u: str) -> tuple[str, UrlCheck]:
            async with sem:
                return (u, await _check_url(client, u))

        tasks = [_one(u) for u in urls_to_check.keys()]
        for u, chk in await asyncio.gather(*tasks):
            checks[u] = chk

    checked_at = _now_iso()
    for e in entries:
        canonical = str(e.get("canonical_url") or "").strip()
        feed_url = str(e.get("feed_url") or "").strip()
        api_url = str(e.get("api_url") or "").strip()
        relevant = [checks[u] for u in (canonical, feed_url, api_url) if u in checks]
        reachable = any(c.reachable for c in relevant)
        requires_auth = any(c.requires_auth for c in relevant)
        status_codes = [c.status_code for c in relevant if c.status_code is not None]
        e["active_status"] = bool(reachable)
        if requires_auth:
            e["auth_type"] = "auth_required"
        if reachable:
            e["validation_status"] = f"reachable:{status_codes[0] if status_codes else 'ok'}"
        else:
            note = next((c.note for c in relevant if c.note), "unreachable")
            e["validation_status"] = note
        e["last_checked_at"] = checked_at
    return entries


def write_outputs(entries: list[dict[str, Any]]) -> None:
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=True)
        f.write("\n")

    cat_counts = Counter(e.get("category", "unknown") for e in entries)
    tier_counts = Counter(e.get("trust_tier", "unknown") for e in entries)
    active_counts = Counter("active" if e.get("active_status") else "inactive" for e in entries)

    lines = [
        "# Source Inventory",
        "",
        f"- Generated at: `{_now_iso()}`",
        f"- Total sources: **{len(entries)}**",
        f"- Active (reachable): **{active_counts.get('active', 0)}**",
        f"- Inactive/unreachable: **{active_counts.get('inactive', 0)}**",
        "",
        "## Category Counts",
        "",
    ]
    for cat, count in sorted(cat_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"- `{cat}`: {count}")
    lines.extend(["", "## Trust Tier Counts", ""])
    for tier, count in sorted(tier_counts.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"- `{tier}`: {count}")
    lines.extend(["", "## Notes", "", "- `active_status=true` means at least one endpoint returned a reachable HTTP status (including auth-gated 401/403).", "- Social/community sources remain lane-separated and are not treated as official incident truth without corroboration.", ""])
    with open(INVENTORY_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


async def main() -> int:
    entries = await build_registry()
    write_outputs(entries)
    print(f"Wrote {len(entries)} sources to {REGISTRY_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
