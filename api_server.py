#!/usr/bin/env python3
from __future__ import annotations
"""Albany County Crime Tracker v6 — Backend API Server.
- City of Albany vs Albany County distinction in all filters
- Strict two-tier location filter (Albany County, NY municipalities only)
- Source reliability ranking (official → local TV/print → aggregated)
- Article confidence scoring
- xAI Grok-3 with location verification & confidence in situation reports
- 14 RSS feeds: local news, official sources, targeted Google News
- DCJS 10-year crime trends, FBI NIBRS agency data
- Geocoded crime map, pattern detection, AI chat (SSE streaming)
"""

import asyncio
import hashlib
import hmac
import io
import json
import json as _json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import unicodedata
from difflib import SequenceMatcher
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime, parsedate_to_datetime
from urllib.parse import quote, quote_plus, urlparse
from typing import Any, Optional

import httpx
import incident_intelligence as intel
from sources.albany_open_data import fetch_albany_open_data
from sources.albany_open_data import socrata_runtime_status
from sources.advanced_adapters import SCANNER_ALBANY_P25_MAIN
from sources.advanced_adapters import TalkgroupMapper
from sources.advanced_adapters import get_511_adapter
from sources.advanced_adapters import get_radioreference_ws_adapter
from sources.advanced_adapters import get_talkgroup_mapper
from sources.advanced_adapters import radioreference_runtime_status
from sources.tier1_official import fetch_tier1_sources
from sources.bluesky_adapter import bluesky_runtime_status
from sources.bluesky_adapter import fetch_bluesky_posts
from sources.nws_alerts import fetch_nws_alerts
from sources.nws_alerts import nws_runtime_status
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from app.api.health import router as health_router
from app.core.config import get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging, set_request_id
from app.db.session import close_database
from app.db.session import has_database
from app.db.session import init_database
from app.services.cache import DEFAULT_TTLS, create_cache_backend, create_refresh_guard
from app.services.http_client import fetch_with_retry
from app.models.incident import build_provenance as _build_incident_provenance
from app.services.incident_persistence import persist_articles_as_incidents
import app.services.superfeedr as superfeedr_svc
from app.services.incident_repository import incident_trends
from app.services.incident_repository import incident_store_backend
from app.services.incident_repository import last_upsert_stats
from app.services.incident_repository import query_incidents
from app.services.incident_repository import summarize_incidents
from app.services.scanner_analysis import analyze_scanner_transcript
from app.services.incident_transformers import article_to_incident
from app.services.geocoding import geocode_article_mapbox, geocode_cache_stats
from app.services.geocoding import geocode_article_local_first
from app.services.source_registry import load_source_registry
from app.services.source_registry import source_registry_summary
from app.services.source_audit import audit_counts
from app.services.source_audit import audit_entries

# --- Config ---
# Last incident pipeline snapshot for /api/incidents/debug (tuning / diagnostics).
_LAST_INCIDENT_PIPELINE: dict[str, Any] = {}
_GEO_FILTER_STATS: dict[str, Any] = {"accepted": 0, "rejected": 0, "reasons": {}}

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger("albany-crime-tracker")

XAI_API_KEY = settings.xai_api_key
XAI_BASE = "https://api.x.ai/v1"
XAI_MODEL = "grok-3"  # Strongest full xAI reasoning model (not mini / fast variants)

ASCII_PUNCT_TRANSLATION = str.maketrans({
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
    "—": "-",
    "–": "-",
    "→": "->",
    "≥": ">=",
    "≤": "<=",
    "•": "*",
    "…": "...",
    "\xa0": " ",
})

# --- Cache ---
cache_backend = create_cache_backend(settings.redis_url, DEFAULT_TTLS)
refresh_guard = create_refresh_guard(settings.redis_url)
CACHE_TTL = DEFAULT_TTLS

# =============================================================================
# ALBANY KEYWORDS — Primary location vocabulary
# CRITICAL DISTINCTION:
#   "City of Albany"   = the actual city (county seat), pop ~99k
#   "Albany County"    = the full county (City + 9 towns + villages + hamlets)
# =============================================================================
ALBANY_KEYWORDS = [
    # === CITY OF ALBANY (core urban area) ===
    "city of albany", "albany city", "downtown albany", "albany ny", "albany, ny",
    # === FULL ALBANY COUNTY (all municipalities) ===
    "albany county", "colonie", "bethlehem", "guilderland", "cohoes", "watervliet",
    "new scotland", "coeymans", "green island", "berne", "knox", "rensselaerville", "westerlo",
    # === Villages and key hamlets (very important for news reports) ===
    "altamont", "menands", "ravena", "voorheesville", "latham", "loudonville",
    "delmar", "slingerlands", "glenmont", "clarksville", "feura bush", "westmere",
]

# Tier 1: All ALBANY_KEYWORDS + additional unambiguous signals → accept immediately
ALBANY_TIER1 = frozenset(ALBANY_KEYWORDS) | frozenset([
    # Explicit "town of / city of" forms
    "albany new york",
    "town of colonie", "town of bethlehem", "town of guilderland",
    "town of new scotland", "town of coeymans", "town of westerlo",
    "town of rensselaerville", "town of berne", "town of knox",
    # Additional hamlets
    "elsmere", "selkirk", "roessleville", "karner",
    # Albany city neighborhoods
    "arbor hill", "sheridan hollow", "pine hills",
    "south end albany", "west hill albany", "center square", "buckingham pond",
    # Key venues & landmarks exclusive to Albany NY
    "mvp arena", "times union center", "crossgates mall", "stuyvesant plaza",
    "suny albany", "university at albany",
    "albany medical center", "albany med",
    "empire state plaza", "egg albany",
    "albany international airport", "albany airport", "colonie center",
    # Streets and highways that uniquely identify Albany NY area
    "wolf road", "manning boulevard", "central avenue albany", "new scotland avenue",
    "state farm road",
    "i-787", "i-90", "route 9w",
    # Local colleges/institutions exclusive to Albany County
    "siena college", "albany law", "sage college", "college of saint rose",
    "albany college of pharmacy", "hvcc", "hudson valley community",
    # Additional hamlets/neighborhoods
    "north albany", "south albany", "broadway albany", "lark street",
])

# Tier 2: "albany" alone is ambiguous — needs at least one NY confirmation signal
# Other generic terms like "capital region" need multiple signals

# Strong confirmation that a "albany" mention is Albany, NY
NY_CONFIRMATION_SIGNALS = frozenset([
    # Explicit NY state references
    "new york", "state of new york", " nys ", "n.y.", "upstate new york", "upstate ny",
    # Neighboring cities that uniquely place us in the NY Capital Region
    "troy", "schenectady", "saratoga", "rensselaer county",
    "niskayuna", "halfmoon", "clifton park",
    # Albany-specific law enforcement (very strong signal)
    "albany police", "albany county sheriff", "colonie police", "bethlehem police",
    # NY law enforcement
    "state police", "nysp", "new york state police", "troopers",
    "troopers.ny.gov",
    # Local institutions
    "suny", "cuny", "albany medical",
    # Local media (their mere mention in an article signals Albany NY context)
    "times union", "wnyt", "news10", "cbs6", "spectrum news albany", "daily gazette",
    # Albany area geography
    "mohawk river", "hudson river albany", "catskill", "adirondack",
    "thruway", "taconic", "northway", "i-787", "route 9w albany",
    # NY political figures / offices
    "hochul", "cuomo", "comptroller dinapoli", "attorney general james",
    # "capital district" with NY context (not Iceland / Denmark)
    "capital district ny", "capital district new york",
])

# Generic phrases that appear worldwide — need multiple NY signals to trust
GENERIC_REGION_TERMS = frozenset(["capital region", "capital district"])

# =============================================================================
# FALSE POSITIVE INDICATORS — Immediate rejection
# =============================================================================
FALSE_POSITIVE_INDICATORS = frozenset([
    # Other places named Albany
    "albany, ga", "albany, georgia", "albany georgia",
    "dougherty county",                          # Albany GA county
    "albany, or", "albany, oregon", "albany oregon",
    "linn county",                               # Albany OR county
    "albany, ca", "albany, california", "albany ca",
    "albany, wa", "albany, washington",
    "albany, australia", "albany western australia", "western australia",
    "albany, uk", "albany, new zealand",
    "albany, bahamas",
    # Iceland "Capital Region" false positives
    "iceland", "reykjavik", "reykjavík", "icelandic", "ísland",
    # Other "Capital Region" locations
    "capital region of denmark", "capital region denmark",
    "national capital region", "metro manila", "manila bulletin",
    "capital regional district", "victoria bc",
    "australian capital territory", "canberra",
    # Other US state capitals that have their own "capital regions"
    "sacramento, ca", "sacramento ca",
    "harrisburg, pa", "harrisburg pa",
    "tallahassee, fl", "tallahassee fl",
    "richmond, va", "richmond va",
    "lansing, mi", "lansing mi",
    "concord, nh", "concord nh",
    # Noise: national sports drafts (never local crime)
    "nfl draft", "nba draft", "mlb draft",
    # Canada
    "ottawa, ontario", "ontario canada",
])

# Non-local source names — reject regardless. Substring-matched against the
# article's `source` field (case-insensitive). When the source IS the dead
# giveaway (e.g. an Albany, GA TV station), the text-level FALSE_POSITIVE
# scan often misses it because the article itself doesn't always say
# "Albany, GA" verbatim — it just says "Albany" and the locality gate
# accepts. Adding the source name closes that hole at zero recall cost
# for actual Albany, NY coverage.
NON_LOCAL_SOURCES = frozenset([
    "iceland review", "reykjavik grapevine", "manila bulletin",
    "the guardian", "bbc news", "sydney morning herald",
    "the australian", "times of india", "daily mail",
    # Albany, Georgia TV / radio affiliates
    "walb", "wfxl", "albany herald",
    # Albany, Oregon TV / radio — KEZI (ABC), KVAL (CBS), KMTR (NBC)
    "kezi", "kval", "kmtr", "albany democrat-herald",
    # Other "Albany" cities in other states
    "the morning call",  # Lehigh Valley PA (Bethlehem, PA — not NY)
    "msn",  # Aggregator that mixes all cities
])

# Local source domains — presence in link is strong Albany NY signal
LOCAL_DOMAINS = frozenset([
    "wnyt.com", "timesunion.com", "cbs6albany.com", "news10.com",
    "spectrumlocalnews.com", "troopers.ny.gov", "albanyny.gov",
    "albanycounty.com", "dailygazette.com", "spotlightnews.com",
    "dailyvoice.com", "wrgb.com", "wnyt13.com",
])

# If the article URL is from a Capital District outlet but the headline omits "Albany",
# still accept when the story clearly looks like crime/public-safety (reduces false drops on Sat. night wire copy).
_LOCAL_OUTLET_CRIME_PASS_TERMS = frozenset([
    "shooting", "shots fired", "shot ", "stabbing", "stabbed",
    "homicide", "murder", "manslaughter",
    "fatal", "deadly", "dies after", "killed",
    "crash", "collision", "rollover", "mva", "wrong-way",
    "arrest", "arrested", "charged", "charged with", "in custody",
    "robbery", "burglary", "assault", "kidnapping",
    "pursuit", "standoff", "barricade", "hostage", "swat",
    "missing", "amber alert", "silver alert",
    "fire", "blaze", "structure fire", "working fire",
    "overdose", "investigating a", "police investigate", "police investigating",
    "sheriff", "state police", "trooper", "nysp",
])

# =============================================================================
# SOURCE RELIABILITY TIERS
# 1.0 = Official government/law enforcement
# 0.85-0.95 = Established local news
# 0.65-0.80 = Aggregated/national coverage of local events
# =============================================================================
SOURCE_RELIABILITY_MAP = {
    "ny state police": 1.0,
    "new york state police": 1.0,
    "city of albany": 1.0,
    "albany police department": 1.0,
    "albany county sheriff": 1.0,
    "cbs6 albany": 0.92,
    "news10 abc": 0.92,
    "wnyt": 0.90,
    "times union": 0.90,
    "spectrum news albany": 0.85,
    "local news": 0.72,
}


def get_source_reliability(source: str) -> float:
    s = (source or "").lower()
    for key, score in SOURCE_RELIABILITY_MAP.items():
        if key in s:
            return score
    return 0.70  # default for unknown/aggregated


# =============================================================================
# RSS FEEDS — ranked by reliability
# =============================================================================

# Primary: established local outlets (no filter needed — exclusively Albany-area)
RSS_FEEDS_LOCAL = {
    # ── Core TV stations ──────────────────────────────────────────────────────
    "news10_crime": {
        "url": "https://www.news10.com/news/crime/feed/",
        "label": "News10 ABC Crime",
        "filter": "strict",
        "reliability": 0.92,
        "priority": 2,
    },
    "news10_albany": {
        "url": "https://www.news10.com/news/albany-county/feed/",
        "label": "News10 ABC",
        "filter": None,   # Exclusively Albany County
        "reliability": 0.92,
        "priority": 2,
    },
    "cbs6_local": {
        "url": "https://cbs6albany.com/news/local.rss",
        "label": "CBS6 Albany",
        "filter": "strict",
        "reliability": 0.92,
        "priority": 2,
    },
    "wnyt": {
        "url": "https://wnyt.com/feed/",
        "label": "WNYT",
        "filter": "strict",
        "reliability": 0.90,
        "priority": 2,
    },
    # ── Premium newspapers — highest priority ─────────────────────────────────
    # Times Union blocks direct RSS; pull via Google News site: search instead
    # (kept in LOCAL block because these are premium/prioritized sources)
    # Query includes (albany OR county name) to pre-filter for Albany County content
    "timesunion_gnews_crime": {
        "url": "https://news.google.com/rss/search?q=site:timesunion.com+(albany+OR+colonie+OR+guilderland+OR+cohoes+OR+watervliet)+(crime+OR+arrest+OR+shooting+OR+police+OR+stabbing)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Times Union",
        "filter": "albany",
        "reliability": 0.92,
        "priority": 3,
    },
    "timesunion_gnews_local": {
        "url": "https://news.google.com/rss/search?q=site:timesunion.com+(\"albany+county\"+OR+\"city+of+albany\"+OR+colonie+OR+guilderland+OR+bethlehem+OR+cohoes+OR+watervliet+OR+latham+OR+loudonville+OR+delmar)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Times Union",
        "filter": "albany",
        "reliability": 0.92,
        "priority": 3,
    },
    # Daily Gazette / Spotlight — direct feeds + Google News fallback
    "dailygazette_crime": {
        "url": "https://www.dailygazette.com/spotlightnews/news/crime/feed/",
        "label": "Daily Gazette Crime",
        "filter": "albany",
        "reliability": 0.90,
        "priority": 3,
    },
    "dailygazette_gnews": {
        "url": "https://news.google.com/rss/search?q=site:dailygazette.com+(albany+OR+colonie+OR+guilderland+OR+cohoes+OR+watervliet+OR+bethlehem+OR+latham)+(crime+OR+arrest+OR+police+OR+shooting)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Daily Gazette",
        "filter": "albany",
        "reliability": 0.90,
        "priority": 3,
    },
    "spotlight_gnews": {
        "url": "https://news.google.com/rss/search?q=site:spotlightnews.com+(albany+OR+colonie+OR+guilderland+OR+bethlehem+OR+cohoes)+(crime+OR+arrest+OR+police+OR+shooting)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "The Spotlight",
        "filter": "albany",
        "reliability": 0.90,
        "priority": 3,
    },
    # ── Other local sources ───────────────────────────────────────────────────
    "spectrum_albany": {
        "url": "https://spectrumlocalnews.com/nys/albany/rss.xml",
        "label": "Spectrum News Albany",
        "filter": "strict",
        "reliability": 0.85,
        "priority": 2,
    },
    # WAMC Northeast Public Radio — direct RSS (proper dates, not IP-blocked).
    # A reliable, high-quality DIRECT alternative to Google News for the
    # Capital Region. filter=strict applies the standard locality gate.
    "wamc_news": {
        "url": "https://www.wamc.org/news.rss",
        "label": "WAMC",
        "filter": "strict",
        "reliability": 0.88,
        "priority": 2,
        "timeout": 10,
    },
    "albany_city_official": {
        "url": "https://www.albanyny.gov/RSSFeed.aspx?ModID=71&CID=All-0",
        "label": "City of Albany",
        "filter": None,   # Official Albany city releases
        "reliability": 1.0,
        "priority": 3,
    },
}

# Google News targeted searches — strict Albany filter applied to all
RSS_FEEDS_GNEWS = {
    # ── Broad county-level searches ───────────────────────────────────────────
    "gnews_albany_county_crime": {
        "url": "https://news.google.com/rss/search?q=%22albany+county%22+%22new+york%22+crime+OR+arrest+OR+police+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.75,
        "priority": 1,
    },
    "gnews_albany_ny_police": {
        "url": "https://news.google.com/rss/search?q=%22albany+ny%22+police+OR+arrest+OR+shooting+OR+crime+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.72,
        "priority": 1,
    },
    "gnews_albany_recent": {
        "url": "https://news.google.com/rss/search?q=%22albany%2C+ny%22+arrest+OR+shooting+OR+crime+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.72,
        "priority": 1,
    },
    # ── Official state police ─────────────────────────────────────────────────
    "gnews_nys_police": {
        "url": "https://news.google.com/rss/search?q=site:troopers.ny.gov+albany+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "NY State Police",
        "filter": None,   # troopers.ny.gov is always legitimate
        "reliability": 1.0,
        "priority": 3,
    },
    # ── Hyper-local per-town searches ─────────────────────────────────────────
    "gnews_colonie": {
        "url": "https://news.google.com/rss/search?q=Colonie+NY+(crime+OR+arrest+OR+police+OR+shooting+OR+burglary)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Colonie",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_bethlehem": {
        "url": "https://news.google.com/rss/search?q=Bethlehem+NY+(crime+OR+arrest+OR+police+OR+shooting)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Bethlehem / Delmar",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_guilderland": {
        "url": "https://news.google.com/rss/search?q=Guilderland+NY+(crime+OR+arrest+OR+police+OR+shooting)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Guilderland / Altamont",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_cohoes": {
        "url": "https://news.google.com/rss/search?q=Cohoes+NY+(crime+OR+arrest+OR+police)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Cohoes",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_watervliet": {
        "url": "https://news.google.com/rss/search?q=Watervliet+NY+(crime+OR+arrest+OR+police)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Watervliet",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_latham_loudonville": {
        "url": "https://news.google.com/rss/search?q=(Latham+OR+Loudonville)+NY+(crime+OR+arrest+OR+police+OR+shooting)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Latham / Loudonville",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_newscotland": {
        "url": "https://news.google.com/rss/search?q=%22New+Scotland%22+NY+(crime+OR+arrest+OR+police)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "New Scotland / Slingerlands",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_coeymans_ravena": {
        "url": "https://news.google.com/rss/search?q=(Coeymans+OR+Ravena)+NY+(crime+OR+arrest+OR+police)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Coeymans / Ravena",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_green_island": {
        "url": "https://news.google.com/rss/search?q=%22Green+Island%22+NY+(crime+OR+arrest+OR+police+OR+fire)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Green Island",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 2,
    },
    "gnews_menands": {
        "url": "https://news.google.com/rss/search?q=Menands+NY+(crime+OR+arrest+OR+police+OR+fire)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Menands",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 2,
    },
    "gnews_voorheesville": {
        "url": "https://news.google.com/rss/search?q=(Voorheesville+OR+%22New+Salem%22)+NY+(crime+OR+arrest+OR+police+OR+fire)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Voorheesville",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 2,
    },
    "gnews_westerlo_berne_knox": {
        "url": "https://news.google.com/rss/search?q=(Westerlo+OR+Berne+OR+Knox+OR+Rensselaerville)+%22Albany+County%22+(crime+OR+arrest+OR+police+OR+fire)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Hilltowns",
        "filter": "strict",
        "reliability": 0.70,
        "priority": 1,
    },
    # ── Legacy broad-suburb search kept for overlap coverage ──────────────────
    "gnews_albany_suburbs": {
        "url": "https://news.google.com/rss/search?q=(colonie+OR+bethlehem+OR+guilderland+OR+cohoes+OR+watervliet)+%22new+york%22+(crime+OR+police+OR+arrest)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.75,
        "priority": 1,
    },
    # Dispatch-style wire queries (faster than 3d aggregation; still Albany-filtered)
    "gnews_capital_region_breaking": {
        "url": (
            "https://news.google.com/rss/search?q="
            "(%22Albany+County%22+OR+%22City+of+Albany%22+OR+Colonie+OR+Latham+OR+Cohoes+OR+Watervliet+OR+Delmar)"
            "+(crash+OR+fire+OR+shooting+OR+stabbing+OR+pursuit+OR+closure+OR+missing+OR+alert)"
            "+when:1d&hl=en-US&gl=US&ceid=US:en"
        ),
        "label": "Capital Region breaking",
        "filter": "strict",
        "reliability": 0.72,
        "priority": 2,
    },
}

# Browser User-Agent + concurrency cap for Google News. Datacenter IPs that
# burst many simultaneous requests with a bot UA get 403/429'd; a real browser
# UA + a low concurrency cap keeps us under Google News' rate limit.
_GNEWS_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15"
)
_GNEWS_SEMAPHORE = asyncio.Semaphore(4)

_gnews_blocked_until: float = 0.0
_gnews_block_logged_at: float = 0.0
_GNEWS_BLOCK_TTL = 600  # 10 min (was 30) — faster recovery after a transient block


def _check_gnews_blocked(url: str, resp_status: int = 0) -> bool:
    """Return True if Google News feeds should be skipped.

    When *resp_status* is a block indicator (403/429/503), mark Google News
    as blocked for ``_GNEWS_BLOCK_TTL`` seconds and log once.
    """
    global _gnews_blocked_until, _gnews_block_logged_at
    if "news.google.com" not in (url or ""):
        return False
    now = time.time()
    if resp_status in (403, 429, 503):
        _gnews_blocked_until = now + _GNEWS_BLOCK_TTL
        if (now - _gnews_block_logged_at) > _GNEWS_BLOCK_TTL:
            logger.warning(
                "gnews_blocked: Google News RSS returning %s — suppressing gnews feeds for %ds",
                resp_status,
                _GNEWS_BLOCK_TTL,
            )
            _gnews_block_logged_at = now
        return True
    return now < _gnews_blocked_until


def gnews_runtime_status() -> dict[str, Any]:
    now = time.time()
    blocked = now < _gnews_blocked_until
    remaining = max(0, int(_gnews_blocked_until - now)) if blocked else 0
    return {
        "blocked": blocked,
        "block_ttl_seconds": _GNEWS_BLOCK_TTL,
        "block_remaining_seconds": remaining,
        "status": "blocked" if blocked else "available",
    }


# =============================================================================
# OFFICIAL POLICE SOURCES — Priority 4 (highest) — X/Twitter + Blotters
# =============================================================================
# Strategy:
#   • Google News targeted searches for each department (reliable backbone)
#   • Nitter RSS for X/Twitter accounts (best-effort; fails gracefully)
#   • NYSP direct press releases + Nixle alerts
#   All labeled "Official" and given priority=4 to float to the top of the Live feed.

RSS_FEEDS_OFFICIAL = {
    # ── Albany PD (@albanypolice) ─────────────────────────────────────────────
    # Google News is reliable backbone; force_label=True tags all results "Official"
    "official_albany_pd": {
        "url": "https://news.google.com/rss/search?q=%22Albany+Police+Department%22+OR+%22Albany+Police%22+arrest+OR+crime+OR+incident+OR+shooting+OR+stabbing+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @albanypolice",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Albany County Sheriff (@ACSOTWEET) ────────────────────────────────────
    "official_acso": {
        "url": "https://news.google.com/rss/search?q=%22Albany+County+Sheriff%22+arrest+OR+crime+OR+incident+OR+investigation+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @ACSOTWEET",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Colonie Police (@colonie_police) ─────────────────────────────────────
    "official_colonie_pd": {
        "url": "https://news.google.com/rss/search?q=%22Colonie+Police%22+arrest+OR+crime+OR+incident+OR+shooting+OR+burglary+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @colonie_police",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Bethlehem PD (@PdBethlehem) ──────────────────────────────────────────
    "official_bethlehem_pd": {
        "url": "https://news.google.com/rss/search?q=%22Bethlehem+Police%22+%22New+York%22+arrest+OR+crime+OR+incident+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @PdBethlehem",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── NY State Police Troop G (@nyspolice) ──────────────────────────────────
    "official_nysp_troop_g": {
        "url": "https://news.google.com/rss/search?q=%22State+Police%22+%22Troop+G%22+OR+(%22State+Police%22+%22Albany%22)+arrest+OR+shooting+OR+crime+OR+investigation+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @nyspolice",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # NYSP press releases via Google News site: search
    "official_nysp_site": {
        "url": "https://news.google.com/rss/search?q=site:troopers.ny.gov+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "NYSP Blotter",
        "filter": None,              # troopers.ny.gov is always NYSP — no filter needed
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
    },
    # ── NYSP troopers.ny.gov direct RSS (best-effort) ─────────────────────────
    "nysp_media_reports": {
        "url": "https://troopers.ny.gov/news/releases/rss",
        "label": "NYSP Blotter",
        "filter": "albany",
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 10,
    },
    # ── NYSP Newsroom (press releases + blotter coverage via Google News) ────
    "nysp_newsroom_albany": {
        "url": "https://news.google.com/rss/search?q=site:troopers.ny.gov+(%22Troop+G%22+OR+%22Albany%22+OR+%22Colonie%22+OR+%22Bethlehem%22+OR+%22Guilderland%22)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "NYSP Newsroom",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
    },
    "nysp_newsroom_arrests": {
        "url": "https://news.google.com/rss/search?q=%22New+York+State+Police%22+(%22Albany%22+OR+%22Colonie%22+OR+%22Latham%22+OR+%22Cohoes%22+OR+%22Bethlehem%22)+(arrest+OR+crash+OR+investigation+OR+shooting)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "NYSP Press Release",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Daily Gazette Crime Blotter (direct RSS) ──────────────────────────────
    "dailygazette_blotter": {
        "url": "https://www.dailygazette.com/spotlightnews/news/crime/feed/",
        "label": "Daily Gazette Blotter",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.95,
        "priority": 4,
    },
    # ── Nixle Albany public safety alerts ─────────────────────────────────────
    "nixle_albany": {
        "url": "https://www.nixle.com/rss/?city=Albany&state=NY",
        "label": "Nixle Alert",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 8,
    },
    # Additional county municipalities (Nixle is dispatch-oriented vs. article RSS)
    "nixle_colonie": {
        "url": "https://www.nixle.com/rss/?city=Colonie&state=NY",
        "label": "Nixle Alert",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 8,
    },
    "nixle_guilderland": {
        "url": "https://www.nixle.com/rss/?city=Guilderland&state=NY",
        "label": "Nixle Alert",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 8,
    },
    # ── Federal: USAO Northern District of New York (Google News fallback) ───
    "usao_ndny_gnews": {
        "url": "https://news.google.com/rss/search?q=%22Northern+District+of+New+York%22+OR+%22USAO+NDNY%22+OR+site:justice.gov/usao-ndny+albany+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "US Attorney NDNY",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.95,
        "priority": 5,
    },
}


# =============================================================================
# ADDITIONAL SOURCES — Patch, Fox23, Reddit, extended Nixle, 511NY
# =============================================================================
RSS_FEEDS_EXTENDED = {
    # ── Patch.com (hyperlocal community news) ─────────────────────────────────
    "patch_albany": {
        "url": "https://patch.com/new-york/albany/police-fire.rss",
        "label": "Patch Albany",
        "filter": None,
        "reliability": 0.82,
        "priority": 2,
        "timeout": 10,
    },
    "patch_colonie": {
        "url": "https://patch.com/new-york/colonie/police-fire.rss",
        "label": "Patch Colonie",
        "filter": None,
        "reliability": 0.82,
        "priority": 2,
        "timeout": 10,
    },
    "patch_bethlehem": {
        "url": "https://patch.com/new-york/bethlehem/police-fire.rss",
        "label": "Patch Bethlehem",
        "filter": None,
        "reliability": 0.82,
        "priority": 2,
        "timeout": 10,
    },
    "patch_guilderland": {
        "url": "https://patch.com/new-york/guilderland/police-fire.rss",
        "label": "Patch Guilderland",
        "filter": None,
        "reliability": 0.82,
        "priority": 2,
        "timeout": 10,
    },
    # ── Fox23 (WXXA) ──────────────────────────────────────────────────────────
    "fox23_crime": {
        "url": "https://www.fox23news.com/news/crime/feed/",
        "label": "Fox23",
        "filter": "strict",
        "reliability": 0.88,
        "priority": 2,
    },
    "fox23_gnews": {
        "url": "https://news.google.com/rss/search?q=site:fox23news.com+(albany+OR+colonie+OR+cohoes+OR+watervliet+OR+guilderland)+(crime+OR+arrest+OR+police+OR+fire)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Fox23",
        "filter": "strict",
        "reliability": 0.85,
        "priority": 2,
    },
    # Reddit + social moved to dedicated RSS_FEEDS_SOCIAL block (verified
    # accounts, reliable Google News site: surfacing — see below).
    # ── Extended Nixle municipalities ─────────────────────────────────────────
    "nixle_bethlehem": {
        "url": "https://www.nixle.com/rss/?city=Bethlehem&state=NY",
        "label": "Nixle Alert",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 8,
    },
    "nixle_cohoes": {
        "url": "https://www.nixle.com/rss/?city=Cohoes&state=NY",
        "label": "Nixle Alert",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 8,
    },
    "nixle_watervliet": {
        "url": "https://www.nixle.com/rss/?city=Watervliet&state=NY",
        "label": "Nixle Alert",
        "filter": None,
        "force_label": True,
        "reliability": 1.0,
        "priority": 4,
        "timeout": 8,
    },
    # ── 511NY Traffic (always enabled — public RSS) ───────────────────────────
    "ny511_albany_events": {
        "url": "https://511ny.org/api/getevents?format=rss&eventtype=incidents&region=albany",
        "label": "511NY Traffic",
        "filter": None,
        "reliability": 0.95,
        "priority": 3,
        "timeout": 10,
    },
    # ── Hudson Valley News Network ────────────────────────────────────────────
    "hvnn_gnews": {
        "url": "https://news.google.com/rss/search?q=site:hudsonvalleynewsnetwork.com+(albany+OR+colonie+OR+guilderland+OR+cohoes+OR+bethlehem)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "HVNN",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    # ── Capital Region breaking — wire/aggregator layer ───────────────────────
    "gnews_capital_overnight": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+NY%22+OR+%22Albany+County%22)+(overnight+OR+%22early+morning%22+OR+%22late+night%22)+(police+OR+shooting+OR+stabbing+OR+robbery)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.72,
        "priority": 2,
    },
}


# =============================================================================
# POLICE ACTIVITY DRAGNET — full-spectrum incident-type coverage
# =============================================================================
# These searches deliberately target SPECIFIC police-activity types rather
# than generic "crime" so the Live feed captures the full operational picture
# (tactical situations, searches, alerts, fatalities, fire/EMS) — not just
# what a newsroom labels a "crime story". Each runs through the standard RSS
# pipeline (parse_rss → is_albany_related strict filter), so out-of-area
# matches are gated the same way as every other Google News feed.
RSS_FEEDS_POLICE_ACTIVITY = {
    # ── Tactical / high-risk operations ───────────────────────────────────────
    "act_tactical": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Bethlehem+OR+Guilderland+OR+Cohoes+OR+Watervliet)+(standoff+OR+barricade+OR+hostage+OR+SWAT+OR+%22shelter+in+place%22+OR+lockdown)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 3,
    },
    "act_pursuit": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Latham+OR+Cohoes)+(pursuit+OR+%22police+chase%22+OR+manhunt+OR+%22foot+pursuit%22+OR+fugitive)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 3,
    },
    # ── Searches, seizures, enforcement actions ───────────────────────────────
    "act_enforcement": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Bethlehem+OR+Guilderland)+(%22search+warrant%22+OR+%22drug+bust%22+OR+%22narcotics%22+OR+%22weapons+seized%22+OR+%22gun+recovered%22+OR+%22K-9%22)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 3,
    },
    # ── Public-safety alerts (threats, packages, evacuations) ─────────────────
    "act_alerts": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Guilderland)+(%22bomb+threat%22+OR+%22suspicious+package%22+OR+evacuation+OR+%22active+shooter%22+OR+hazmat)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 3,
    },
    # ── Missing persons / AMBER / Silver alerts ───────────────────────────────
    "act_missing": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Bethlehem)+(%22missing+person%22+OR+%22AMBER+Alert%22+OR+%22Silver+Alert%22+OR+%22endangered%22)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 3,
    },
    # ── Officer-involved / use of force ───────────────────────────────────────
    "act_officer_involved": {
        "url": "https://news.google.com/rss/search?q=(%22Albany%22+OR+%22Albany+County%22)+(%22officer-involved%22+OR+%22officer+involved%22+OR+%22use+of+force%22+OR+%22police+shooting%22+OR+%22officer+shot%22)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.80,
        "priority": 4,
    },
    # ── Death / homicide investigations ───────────────────────────────────────
    "act_death_inv": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Cohoes+OR+Watervliet)+(homicide+OR+%22death+investigation%22+OR+%22body+found%22+OR+fatal+OR+%22shot+dead%22)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 3,
    },
    # ── Fire / EMS major responses ────────────────────────────────────────────
    "act_fire_ems": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+County%22+OR+%22Albany+NY%22+OR+Colonie+OR+Bethlehem+OR+Guilderland+OR+Cohoes)+(%22structure+fire%22+OR+%22working+fire%22+OR+%22house+fire%22+OR+%22mass+casualty%22+OR+%22multiple+injured%22)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 3,
    },
    # ── Albany County Sheriff specific ────────────────────────────────────────
    "act_acso": {
        "url": "https://news.google.com/rss/search?q=%22Albany+County+Sheriff%22+(arrest+OR+investigation+OR+incident+OR+deputies+OR+%22traffic+stop%22+OR+seized)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @ACSOTWEET",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.92,
        "priority": 4,
    },
    # ── University at Albany Police (Clery / campus safety) ───────────────────
    "act_ualbany": {
        "url": "https://news.google.com/rss/search?q=(%22University+at+Albany%22+OR+UAlbany+OR+%22UAlbany+Police%22)+(crime+OR+arrest+OR+assault+OR+%22timely+warning%22+OR+%22campus+safety%22+OR+theft)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "UAlbany Campus Safety",
        "filter": "strict",
        "reliability": 0.80,
        "priority": 2,
    },
    # ── Siena / College of Saint Rose campus areas ────────────────────────────
    "act_campus_other": {
        "url": "https://news.google.com/rss/search?q=(%22Siena+College%22+OR+%22Saint+Rose%22+OR+%22Albany+Law%22+OR+%22Albany+Medical%22)+(crime+OR+arrest+OR+assault+OR+%22campus+safety%22+OR+robbery)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Campus Safety",
        "filter": "strict",
        "reliability": 0.72,
        "priority": 1,
    },
    # ── CapNewYork / NY Daily wire dragnet for any Albany police action ────────
    "act_wire_dragnet": {
        "url": "https://news.google.com/rss/search?q=(%22Albany+police%22+OR+%22Colonie+police%22+OR+%22Bethlehem+police%22+OR+%22Guilderland+police%22+OR+%22Cohoes+police%22+OR+%22Watervliet+police%22)+when:1d&hl=en-US&gl=US&ceid=US:en",
        "label": "Capital Region",
        "filter": "strict",
        "reliability": 0.74,
        "priority": 3,
    },
}


# =============================================================================
# COMMUNITY / BLOGS / NEIGHBORHOOD WATCH — hyperlocal + grassroots layer
# =============================================================================
# Verified working feeds + Google News site: searches for platforms that
# block direct scraping. Direct-RSS blogs use filter="crime" so only their
# public-safety posts surface (their arts/culture/fundraising content is
# gated out). Honest note: Nextdoor, Citizen, Ring Neighbors, and private
# Facebook groups have NO public API and block scraping — the reliable way
# to surface their content is Google News indexing of public posts.
RSS_FEEDS_COMMUNITY = {
    # ── Direct-RSS hyperlocal blogs / newsletters (verified live) ─────────────
    "community_them_and_us": {
        "url": "https://themandus.substack.com/feed",
        "label": "Them & Us Media",
        "filter": "crime",
        "reliability": 0.62,
        "priority": 1,
        "timeout": 10,
    },
    "community_albany_proper": {
        "url": "https://www.albanyproper.com/feed/",
        "label": "Albany Proper",
        "filter": "crime",
        "reliability": 0.60,
        "priority": 1,
        "timeout": 10,
    },
    "community_albany_scanner": {
        "url": "https://www.albanyscanner.com/rss/",
        "label": "Albany Scanner",
        "filter": "crime",
        "reliability": 0.66,
        "priority": 1,
        "timeout": 10,
    },
    # ── Neighborhood associations (safety alerts via Google News) ─────────────
    "community_neighborhood_assns": {
        "url": "https://news.google.com/rss/search?q=(%22Pine+Hills%22+OR+%22Center+Square%22+OR+%22West+Hill%22+OR+%22Arbor+Hill%22+OR+%22South+End%22+OR+%22Mansion+neighborhood%22+OR+%22Park+South%22)+Albany+(crime+OR+shooting+OR+robbery+OR+safety+OR+police+OR+burglary)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Neighborhood Watch",
        "filter": "strict",
        "reliability": 0.62,
        "priority": 2,
    },
    # ── Nextdoor public agency / neighborhood posts (via Google News) ─────────
    "community_nextdoor": {
        "url": "https://news.google.com/rss/search?q=site:nextdoor.com+(Albany+OR+Colonie+OR+Bethlehem+OR+Guilderland)+(police+OR+crime+OR+shooting+OR+suspicious+OR+burglary+OR+theft)+when:5d&hl=en-US&gl=US&ceid=US:en",
        "label": "Nextdoor",
        "filter": "strict",
        "reliability": 0.50,
        "priority": 1,
    },
    # ── Citizen app incidents (via Google News indexing) ──────────────────────
    "community_citizen": {
        "url": "https://news.google.com/rss/search?q=site:citizen.com+(Albany+OR+Colonie+OR+Cohoes+OR+Watervliet)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Citizen",
        "filter": "strict",
        "reliability": 0.55,
        "priority": 1,
    },
    # ── Council of Albany Neighborhood Associations (CANA) ────────────────────
    "community_cana": {
        "url": "https://news.google.com/rss/search?q=(%22Council+of+Albany+Neighborhood+Associations%22+OR+CANA+Albany+OR+%22neighborhood+association%22+Albany)+(safety+OR+crime+OR+police+OR+shooting)+when:5d&hl=en-US&gl=US&ceid=US:en",
        "label": "Neighborhood Watch",
        "filter": "strict",
        "reliability": 0.58,
        "priority": 1,
    },
}


# =============================================================================
# SOCIAL MEDIA + REDDIT — verified Albany County NY accounts/communities
# =============================================================================
# IMPORTANT — reliability note: Reddit, X/Twitter, and Facebook all block
# direct server-side scraping (Reddit 403s datacenter IPs; X/FB require
# API keys). The RELIABLE way to surface their content is Google News
# `site:` searches — Google indexes posts from these accounts/communities
# and is not IP-blocked. Each account below was verified to exist:
#   • Albany PD:           x.com/albanypolice · facebook.com/AlbanyNYPolice
#   • Albany Co. Sheriff:  x.com/ACSOTWEET     · facebook.com/Albany-County-Sheriffs-Office
#   • Colonie PD:          x.com/colonie_police· facebook.com/ColoniePD
#   • NY State Police:     x.com/nyspolice
#   • Reddit:              r/Albany · r/CapitalRegion · r/albanyny
RSS_FEEDS_SOCIAL = {
    # ── Reddit communities (via Google News site: search — reliable) ──────────
    "social_reddit_albany": {
        "url": "https://news.google.com/rss/search?q=site:reddit.com/r/Albany+(police+OR+crime+OR+shooting+OR+stabbing+OR+arrest+OR+crash+OR+fire+OR+emergency+OR+%22shots+fired%22)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Reddit r/Albany",
        "filter": "albany",
        "reliability": 0.55,
        "priority": 1,
    },
    "social_reddit_capitalregion": {
        "url": "https://news.google.com/rss/search?q=site:reddit.com/r/CapitalRegion+(police+OR+crime+OR+shooting+OR+stabbing+OR+arrest+OR+crash+OR+fire+OR+emergency)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Reddit r/CapitalRegion",
        "filter": "strict",
        "reliability": 0.52,
        "priority": 1,
    },
    "social_reddit_albanyny": {
        "url": "https://news.google.com/rss/search?q=site:reddit.com/r/albanyny+(police+OR+crime+OR+shooting+OR+arrest+OR+crash+OR+fire+OR+emergency)+when:5d&hl=en-US&gl=US&ceid=US:en",
        "label": "Reddit r/albanyny",
        "filter": "strict",
        "reliability": 0.50,
        "priority": 1,
    },
    # Reddit sitewide — catches threads in any sub mentioning Albany incidents
    "social_reddit_sitewide": {
        "url": "https://news.google.com/rss/search?q=site:reddit.com+(%22Albany+NY%22+OR+%22Albany+County%22+OR+Colonie+OR+Cohoes+OR+Watervliet)+(shooting+OR+stabbing+OR+%22police+activity%22+OR+%22heavy+police%22+OR+standoff+OR+%22shots+fired%22)+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": "Reddit",
        "filter": "strict",
        "reliability": 0.48,
        "priority": 1,
    },
    # ── Direct Reddit RSS (best-effort — may be IP-blocked on server) ─────────
    "social_reddit_albany_direct": {
        "url": "https://www.reddit.com/r/Albany/search.rss?q=police+OR+shooting+OR+stabbing+OR+arrest+OR+crash+OR+fire&sort=new&restrict_sr=on&t=week",
        "label": "Reddit r/Albany",
        "filter": "albany",
        "reliability": 0.45,
        "priority": 1,
        "timeout": 10,
    },
    # ── Albany PD social (verified @albanypolice / facebook.com/AlbanyNYPolice) ─
    "social_albany_pd": {
        "url": "https://news.google.com/rss/search?q=(site:twitter.com/albanypolice+OR+site:x.com/albanypolice+OR+site:facebook.com/AlbanyNYPolice+OR+%22Albany+Police%22)+(arrest+OR+incident+OR+shooting+OR+investigation+OR+%22in+custody%22+OR+alert)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @albanypolice",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.90,
        "priority": 4,
    },
    # ── Albany County Sheriff social (verified @ACSOTWEET) ────────────────────
    "social_acso": {
        "url": "https://news.google.com/rss/search?q=(site:twitter.com/ACSOTWEET+OR+site:x.com/ACSOTWEET+OR+%22Albany+County+Sheriff%22)+(arrest+OR+incident+OR+investigation+OR+deputies+OR+seized+OR+alert)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @ACSOTWEET",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.90,
        "priority": 4,
    },
    # ── Colonie PD social (verified @colonie_police / facebook.com/ColoniePD) ──
    "social_colonie_pd": {
        "url": "https://news.google.com/rss/search?q=(site:twitter.com/colonie_police+OR+site:x.com/colonie_police+OR+site:facebook.com/ColoniePD+OR+%22Colonie+Police%22)+(arrest+OR+incident+OR+shooting+OR+investigation+OR+%22news+release%22)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @colonie_police",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.90,
        "priority": 4,
    },
    # ── NY State Police social (verified @nyspolice) — Albany scoped ──────────
    "social_nysp": {
        "url": "https://news.google.com/rss/search?q=(site:twitter.com/nyspolice+OR+site:x.com/nyspolice)+(Albany+OR+%22Troop+G%22+OR+Colonie+OR+Cohoes)+when:2d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @nyspolice",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.90,
        "priority": 4,
    },
}


def _total_source_count() -> int:
    """Count of all configured RSS/news/activity sources for status display."""
    return (
        len(RSS_FEEDS_LOCAL) + len(RSS_FEEDS_GNEWS) + len(RSS_FEEDS_OFFICIAL)
        + len(RSS_FEEDS_EXTENDED) + len(RSS_FEEDS_POLICE_ACTIVITY)
        + len(RSS_FEEDS_SOCIAL) + len(RSS_FEEDS_COMMUNITY)
    )


def build_operational_rss_feeds() -> dict[str, dict]:
    """
    Optional 511NY / NY-Alert RSS layers. Set env to enable:
      NY511_CAPITAL_DISTRICT_RSS — regional traffic/incident RSS URL
      NY_ALERT_RSS_URL — state or campus alert RSS URL
    Also merges RSS_FEEDS_EXTENDED (always-on expanded sources).
    """
    out: dict[str, dict] = dict(RSS_FEEDS_EXTENDED)
    out.update(RSS_FEEDS_POLICE_ACTIVITY)
    out.update(RSS_FEEDS_SOCIAL)
    out.update(RSS_FEEDS_COMMUNITY)
    u511 = os.getenv("NY511_CAPITAL_DISTRICT_RSS", "").strip()
    if u511:
        out["ny511_capital_district"] = {
            "url": u511,
            "label": "511NY",
            "filter": None,
            "reliability": 0.99,
            "priority": 5,
            "tag_511": True,
        }
    ny_alert = os.getenv("NY_ALERT_RSS_URL", "").strip()
    if ny_alert:
        out["ny_alert_rss"] = {
            "url": ny_alert,
            "label": "NY-Alert",
            "filter": None,
            "reliability": 0.98,
            "priority": 5,
            "tag_ny_alert": True,
        }
    return out


CRIME_ARTICLES_CACHE_KEY = "crime_articles_v3"

DCJS_URL = (
    "https://data.ny.gov/resource/ca8h-8gjq.json"
    "?$where=county='Albany' AND agency='County Total'"
    "&$order=year DESC&$limit=10"
)

# =============================================================================
# CRIME KEYWORDS
# =============================================================================
CRIME_KEYWORDS = [
    "arrest", "arrested", "booked", "booking", "arraigned", "charged", "murder", "homicide", "shooting", "stabbing",
    "robbery", "burglary", "theft", "assault", "weapon", "drug",
    "police", "sheriff", "suspect", "victim", "crime", "felony",
    "misdemeanor", "indicted", "convicted", "sentence", "investigation",
    "stolen", "domestic", "dui", "dwi", "sexual", "rape", "arson",
    "vandalism", "trespass", "kidnapping", "fraud", "larceny",
    "crash", "fatal", "manslaughter", "gang", "narcotics",
    "trooper", "state police", "pursuit", "standoff", "fugitive",
    "mva", "rollover", "closure", "detour", "road closed", "lane closed",
    "mutual aid", "structure fire", "working fire",
    "warrant", "bail", "parole", "probation",
]

# =============================================================================
# LIVE vs NEWS TAB CLASSIFICATION
# =============================================================================

# Items with these patterns are soft news / background — go to News tab even if recent
NOISE_KEYWORDS = [
    # Court/legal outcomes (not active events)
    "court rules", "convicted of", "sentenced to", "plead guilty", "pleads guilty",
    "plea deal", "guilty plea", "found guilty", "verdict", "acquitted",
    "civil lawsuit", "civil suit", "settlement reached",
    # Grant funding / administrative stories
    "receives grant", "state grant", "federal grant", "grant funding",
    "receives over $", "awarded grant", "million in funding",
    # Planned / awareness / community events (not incidents)
    "awareness walk", "awareness event", "response gathering", "community forum",
    "town hall", "crime prevention event", "community conversations",
    "fundraiser", "seminar", "training class",
    # Summaries / roundups
    "annual report", "annual crime statistics", "state of the city",
    "5 things to know", "top stories", "weekly roundup", "monthly crime report",
    "in memoriam", "obituary", "year in review", "looking back",
    "crime is down", "crime rates", "statewide report", "budget proposal",
    # Governance / board appointments (not active incidents)
    "appoints", "appointee", "review board", "CPRB", "civilian review",
    "police commission", "board member", "board seat", "city council vote",
    "new hire", "named as", "steps down", "resigns", "retirement",
]

# Items with these keywords signal an ACTIVE / BREAKING incident → Live tab
URGENT_KEYWORDS = [
    "shooting", "shot and killed", "stabbing", "stabbed", "on fire", "structure fire",
    "crash", "collision", "fatal accident", "armed robbery", "armed suspect",
    "pursuit", "high-speed chase", "standoff", "swat", "hostage", "barricaded",
    "missing person", "amber alert", "homicide", "murder", "assault", "carjacking",
    "suspect at large", "manhunt", "lockdown", "bomb threat", "explosion",
    "overdose", "breaking", "developing", "just in", "active scene",
    "shots fired", "reports of gunfire", "multiple victims", "mass casualty",
    "traffic stop", "vehicle pursuit", "foot pursuit",
    # Overnight arrest coverage
    "arrested", "charged with", "taken into custody", "in custody",
    "police make arrest", "suspect arrested", "man arrested", "woman arrested",
    "charged in connection", "faces charges", "indicted",
    "booked", "booked at", "booking", "arraigned",
]

# Live tab: max parsed age (hours) for pipeline; classify_feed_tab uses 12h cutoff separately.
LIVE_MAX_AGE_HOURS = 24.0
# Legacy name: max age (hours) for including OpenMHz calls in the merge pipeline (critical may span up to this).
LIVE_CUTOFF_HOURS = 24
# OpenMHz: routine calls in this window are eligible for the crime feed / Live (with classify rules).
SCANNER_OPENMHZ_RECENT_HOURS = 6.0
OPENMHZ_CALLS_PER_SYSTEM = 40
MAP_CUTOFF_DAYS = 5      # Map: hard cutoff at 5 days

# Live feed source_priority tiers (higher = wins dedup merge; scanner/Nixle first-class for real-time)
SOURCE_PRIORITY_OFFICIAL_X_GROK = 26
SOURCE_PRIORITY_NIXLE = 25
SOURCE_PRIORITY_DIRECTORY_BLOTTER = 24
SOURCE_PRIORITY_SCANNER_CRITICAL = 18
SOURCE_PRIORITY_SCANNER_RECENT = 15
SOURCE_PRIORITY_SCANNER_FEED_LINK = 3

# OpenMHz / directory scanner lines must match one of these to appear in main Live feed (not just Scanner tab)
SCANNER_CRITICAL_LIVE_KEYWORDS = (
    "shooting", "shots fired", "shot fired", "person shot", "was shot", "gunshot",
    "stabbing", "stabbed",
    "pursuit", "pursuing", "in pursuit", "vehicle pursuit", "foot pursuit",
    "high-speed chase", "police chase",
    "officer involved", "officer-involved", "ois", "officer down",
    "standoff", "barricade", "barricaded",
    "swat",
    "hostage", "armed robbery", "armed suspect", "armed with",
    "homicide", "murder", "felony assault", "felony charge",
    "k9", "k-9", "canine",
    "active shooter",
    "structure fire", "working fire", "entrapment", "fully engulfed",
    "manhunt", "fugitive", "wanted suspect",
    "explosion", "bomb threat",
    "kidnapping", "abducted",
)


def _scanner_blob_matches_critical_live(blob: str) -> bool:
    t = (blob or "").lower()
    return any(kw in t for kw in SCANNER_CRITICAL_LIVE_KEYWORDS)


def _include_scanner_item_in_crime_feed(article: dict) -> bool:
    """Broadcastify stream cards stay off crime feed; OpenMHz needs critical and/or recent-live flag."""
    if article.get("_scanner_feed_link"):
        return bool(article.get("_scanner_critical_live") or article.get("_scanner_recent_live"))
    if article.get("_scanner_call"):
        return bool(article.get("_scanner_critical_live") or article.get("_scanner_recent_live"))
    return True


def _format_display_date(dt: datetime) -> str:
    """Weekday, month, day without zero-padding (POSIX %-d is not portable)."""
    return f"{dt.strftime('%A, %B')} {dt.day}"


def get_article_age_hours(article) -> Optional[float]:
    """Returns age of article in hours, or None if unparseable."""
    pub = article.get("pubDate", "")
    if not pub:
        return None
    try:
        dt = parsedate_to_datetime(pub)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    except Exception:
        return None


def get_article_age_minutes(article) -> Optional[float]:
    """Age in minutes for scoring and UI."""
    pub = article.get("pubDate", "")
    if not pub:
        return None
    try:
        dt = parsedate_to_datetime(pub)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 60
    except Exception:
        return None


# Ongoing / operational wording — allows items 12–24h old to stay on Live when still relevant.
ONGOING_ACTIVE_KEYWORDS = (
    "active", "developing", "breaking", "just in", "road closed", "road closure",
    "lanes closed", "missing", "still missing", "shelter in place", "shelter-in-place",
    "avoid the area", "avoid area", "scene", "on scene", "at the scene",
    "responding", "still responding", "searching", "active search",
    "pursuit", "in pursuit", "pursuing", "shutdown", "closure", "closed until further",
    "traffic diverted", "detour", "police activity", "heavy police presence",
)

# Strong public-safety / dispatch signals → Live when fresh (subject to age caps).
LIVE_SAFETY_SIGNAL_KEYWORDS = (
    "scanner", "dispatch", "911", "bolo", "be on the lookout", "lookout for",
    "active alert", "emergency alert", "civil emergency", "shelter in place",
    "road closure", "road closed", "lane closure", "missing person", "amber alert",
    "silver alert", "pursuit", "vehicle pursuit", "foot pursuit", "high-speed chase",
    "crash", "collision", "mva", "rollover", "fatal crash",
    "shots fired", "shooting", "shot fired", "stabbing", "stabbed",
    "robbery in progress", "armed robbery", "structure fire", "working fire",
    "fully engulfed", "manhunt", "barricaded", "standoff", "swat", "hostage",
    "explosion", "bomb threat", "hazmat",
)

# Routine / narrative coverage → News if older than LIVE_ROUTINE_NEWS_MAX_H unless explicitly active/safety.
ROUTINE_CRIME_NEWS_PHRASES = (
    "press release", "announces arrest", "announced the arrest", "following an investigation",
    "continuing to investigate", "investigation into", "years in prison", "sentenced to",
    "plead guilty", "pleads guilty", "arraigned on", "court appearance", "indictment",
    "weekly blotter", "crime blotter", "blotter wrap", "case update", "cold case",
    "years ago", "looking back", "monthly report",
)

LIVE_ROUTINE_NEWS_MAX_H = 6.0

# Stale generic arrest headlines (not ongoing scenes) → News tab.
_ARREST_GLOSS_TITLE_FRAGMENTS = (
    "arrest made", "suspect arrested", "man arrested", "woman arrested",
    "person arrested", "booked at", "booked on", "arraigned on",
)


def _arrest_gloss_title(title_lower: str) -> bool:
    return any(x in title_lower for x in _ARREST_GLOSS_TITLE_FRAGMENTS)


def _article_combined_text(article: dict) -> str:
    t = (article.get("title", "") or "") + " " + (article.get("description", "") or "")
    return t.lower()


def is_realtime_public_safety(article: dict) -> bool:
    """True when source/title/description looks like dispatch-level or scanner-adjacent activity."""
    src = (article.get("source") or "").lower()
    blob = f"{src} {_article_combined_text(article)}"
    phrases = (
        "fire dispatch",
        "police dispatch",
        "sheriff dispatch",
        "call for service",
        "structure fire",
        "pedestrian struck",
        "suspicious person",
        "shots fired",
        "unconscious person",
    )
    if any(p in blob for p in phrases):
        return True
    singles = (
        "scanner",
        "dispatch",
        "ems",
        "trooper",
        "openmhz",
        "mvc",
        "rollover",
        "pursuit",
        "domestic",
        "overdose",
    )
    return any(s in blob for s in singles)


# Live tab: major incidents that may stay visible between 6–12h despite age.
LIVE_TAB_HIGH_SEVERITY_KEYWORDS = (
    "shooting",
    "homicide",
    "stabbing",
    "missing person",
    "active scene",
    "shelter in place",
    "shelter-in-place",
    "swat",
    "barricaded",
    "manhunt",
)


def _text_has_any(hay: str, needles: tuple) -> bool:
    return any(n in hay for n in needles)


def ongoing_public_safety_relevance(article: dict) -> bool:
    """True if copy suggests an ongoing scene, alert, or developing incident."""
    return _text_has_any(_article_combined_text(article), ONGOING_ACTIVE_KEYWORDS)


def live_safety_signal_match(article: dict) -> bool:
    """Dispatch-style / in-progress public safety signals in title + description."""
    return _text_has_any(_article_combined_text(article), LIVE_SAFETY_SIGNAL_KEYWORDS)


def routine_summary_or_press_story(article: dict) -> bool:
    """Soft news / wrap-ups / DA narrative — deprioritize for Live when stale."""
    return _text_has_any(_article_combined_text(article), ROUTINE_CRIME_NEWS_PHRASES)


PRIORITY_LIVE_TITLE_KEYWORDS = [
    "shooting", "shot and killed", "shots fired",
    "stabbing", "stabbed",
    "homicide", "murder",
    "officer-involved", "officer involved shooting",
    "pursuit", "high-speed chase", "foot pursuit", "vehicle pursuit",
    "armed robbery", "armed suspect",
    "carjacking", "kidnapping",
    "hostage", "barricaded", "standoff", "swat",
    "amber alert", "missing child", "missing person",
    "explosion", "bomb threat",
    "traffic alert", "road closed", "closure", "crash on", "fatal crash",
    "structure fire", "working fire",
    "suspect at large", "manhunt", "wanted",
]


def compute_is_active_incident(article: dict) -> bool:
    """
    Display / API flag: ongoing operational relevance (scene, alert, scanner, nixle, or very fresh hazard).
    """
    if article.get("_scanner_call") or article.get("_nixle_item"):
        return True
    if is_realtime_public_safety(article):
        return True
    if ongoing_public_safety_relevance(article):
        return True
    if live_safety_signal_match(article):
        return True
    tt = (article.get("title", "") or "").lower()
    if any(kw in tt for kw in PRIORITY_LIVE_TITLE_KEYWORDS):
        return True
    am = article.get("age_minutes")
    if isinstance(am, (int, float)) and am <= 120 and any(
        k in tt for k in ("alert", "crash", "fire", "missing", "closure", "pursuit", "shooting")
    ):
        return True
    return False


def live_score(article: dict) -> float:
    """
    Higher = closer to top of Live. Combines recency tiers, source class, ongoing bonus.
    Formula (additive):
      recency:   0–30m → 4200; 30m–2h → 3600→3000 linear; 2–6h → 3000→2200; 6–12h → 2200→900;
                 12–24h → 900→400 linear (items here only if tab=live via ongoing relevance)
      source:    scanner +2800 (+1350 if ≤30m); nixle +2600; official w/ safety signal +2000; official generic +950;
                 blotter +750; local TV/print names +1100; other +850
      ongoing:   +700 if ongoing_public_safety_relevance
    """
    age_m = article.get("age_minutes")
    if age_m is None:
        try:
            age_m = get_article_age_minutes(article)
        except Exception:
            age_m = None
    if age_m is None:
        rec = 350.0
    elif age_m <= 30:
        rec = 4200.0
    elif age_m <= 120:
        rec = 3600.0 - (age_m - 30) * (600.0 / 90.0)
    elif age_m <= 360:
        rec = 3000.0 - (age_m - 120) * (800.0 / 240.0)
    elif age_m <= 720:
        rec = 2200.0 - (age_m - 360) * (1300.0 / 360.0)
    elif age_m <= 1440:
        rec = 900.0 - (age_m - 720) * (500.0 / 720.0)
    else:
        rec = 0.0

    src_l = (article.get("source") or "").lower()
    if article.get("_scanner_call"):
        w = 2800.0
        if age_m is not None and age_m <= 30:
            w += 1350.0
    elif article.get("_nixle_item"):
        w = 2600.0
    elif article.get("_official_x_post"):
        w = 2000.0 if live_safety_signal_match(article) else 950.0
    elif "blotter" in src_l:
        w = 750.0
    elif any(x in src_l for x in ("gazette", "times union", "news10", "cbs6", "wteng")):
        w = 1100.0
    else:
        w = 850.0

    ong = 700.0 if ongoing_public_safety_relevance(article) else 0.0
    return float(rec) + float(w) + float(ong)


def classify_feed_tab(article) -> str:
    """
    Live vs News — real-time tracker rules (no automatic Live by official source label).

    1) Scanner / Nixle / realtime public-safety copy and age ≤ 6h → live.
    2) age > 12h → news.
    3) High-severity keywords in title/description → live.
    4) age ≤ 3h → live.
    5) Else → news.
    """
    if article.get("_scanner_feed_link"):
        return "news"

    age_hours = get_article_age_hours(article)
    combined = _article_combined_text(article)

    if age_hours is not None and age_hours > LIVE_MAX_AGE_HOURS:
        return "news"

    # 1) Scanner / dispatch / EMS / fire lane — last 6 hours always live when applicable
    if age_hours is not None and age_hours <= 6.0:
        if article.get("_scanner_call") and (
            article.get("_scanner_critical_live") or article.get("_scanner_recent_live")
        ):
            return "live"
        if article.get("_nixle_item"):
            return "live"
        if is_realtime_public_safety(article):
            return "live"

    # 2) Stale window
    if age_hours is not None and age_hours > 12.0:
        return "news"

    # 3) Major incidents (official/news 6–12h can still qualify)
    if any(k in combined for k in LIVE_TAB_HIGH_SEVERITY_KEYWORDS):
        return "live"

    # 4) Very fresh general coverage
    if age_hours is not None and age_hours <= 3.0:
        return "live"

    return "news"


def _is_gnews_item(art: dict) -> bool:
    """A Google News item: redirect URL on news.google.com, no real outlet URL."""
    link = (art.get("link") or "").lower()
    return "news.google.com" in link


def _dedup_should_replace_rep(rep: dict, cand: dict) -> bool:
    """
    Decide whether candidate should become the cluster representative.
    Priorities:
      1. Prefer a DIRECT-source / Bluesky / official item over a Google News
         item for the SAME story — direct items have real outlet URLs and
         trustworthy publication dates (Google News redirect URLs are laggy,
         opaque, and prone to stale/aggregated dates).
      2. Prefer fresher scanner/Nixle over stale official X posts.
    """
    # (1) Source-quality preference: a direct/non-gnews candidate replaces a
    # Google News representative regardless of small time differences.
    rep_is_gnews = _is_gnews_item(rep)
    cand_is_gnews = _is_gnews_item(cand)
    if rep_is_gnews and not cand_is_gnews:
        return True
    if cand_is_gnews and not rep_is_gnews:
        # Never let a Google News item replace a direct/official representative.
        return False

    try:
        dr = parsedate_to_datetime(rep.get("pubDate", "") or "")
        dc = parsedate_to_datetime(cand.get("pubDate", "") or "")
        if dr.tzinfo is None:
            dr = dr.replace(tzinfo=timezone.utc)
        if dc.tzinfo is None:
            dc = dc.replace(tzinfo=timezone.utc)
    except Exception:
        return False
    if dc.timestamp() <= dr.timestamp():
        return False
    age_rep_h = (datetime.now(timezone.utc) - dr).total_seconds() / 3600

    cand_op = bool(cand.get("_scanner_call") or cand.get("_nixle_item"))
    rep_off = bool(rep.get("_official_x_post"))
    if cand_op and rep_off and age_rep_h >= 2.5:
        return True
    if cand.get("_scanner_call") and rep_off and (dc - dr).total_seconds() >= 600:
        return True
    if cand.get("_nixle_item") and rep_off and age_rep_h >= 1.5:
        return True
    return False

# =============================================================================
# GEOCODING — Albany County locations with coordinates
# =============================================================================
ALBANY_LOCATIONS = {
    "albany": (42.6526, -73.7562),
    "downtown albany": (42.6496, -73.7550),
    "center square": (42.6530, -73.7630),
    "arbor hill": (42.6620, -73.7570),
    "south end": (42.6400, -73.7530),
    "west hill": (42.6580, -73.7730),
    "pine hills": (42.6620, -73.7860),
    "buckingham pond": (42.6630, -73.7870),
    "helderberg": (42.6360, -73.7830),
    "north albany": (42.6730, -73.7470),
    "sheridan hollow": (42.6560, -73.7550),
    "washington park": (42.6560, -73.7680),
    "lark street": (42.6550, -73.7630),
    "central ave": (42.6630, -73.7970),
    "central avenue": (42.6630, -73.7970),
    "madison ave": (42.6510, -73.7670),
    "madison avenue": (42.6510, -73.7670),
    "state street": (42.6510, -73.7560),
    "pearl street": (42.6500, -73.7520),
    "broadway": (42.6570, -73.7510),
    "clinton avenue": (42.6600, -73.7570),
    "new scotland": (42.6080, -73.8890),
    "state farm road": (42.6180, -73.9050),
    "colonie": (42.7179, -73.8340),
    "loudonville": (42.7000, -73.7680),
    "latham": (42.7470, -73.7570),
    "cohoes": (42.7743, -73.7001),
    "watervliet": (42.7301, -73.7013),
    "bethlehem": (42.5880, -73.8140),
    "delmar": (42.6180, -73.8310),
    "slingerlands": (42.6340, -73.8540),
    "guilderland": (42.6850, -73.9000),
    "altamont": (42.7010, -74.0340),
    "voorheesville": (42.6520, -73.9290),
    "ravena": (42.4680, -73.8130),
    "coeymans": (42.4740, -73.7960),
    "selkirk": (42.5360, -73.8130),
    "menands": (42.6890, -73.7250),
    "green island": (42.7470, -73.6910),
    "westerlo": (42.5080, -74.0360),
    "feura bush": (42.5680, -73.8750),
    "clarksville": (42.5670, -73.9650),
    "elsmere": (42.6080, -73.8010),
    "glenmont": (42.5710, -73.7870),
    "roessleville": (42.7030, -73.8060),
    # ── Town of Colonie hamlets/CDPs ──
    "boght corners": (42.7780, -73.7600),
    "lisha kill": (42.7400, -73.8400),
    "newtonville": (42.7560, -73.8170),
    "verdoy": (42.7380, -73.7760),
    "schuyler heights": (42.7260, -73.7300),
    "west albany": (42.6960, -73.7960),
    # ── Town of Bethlehem hamlets ──
    "north bethlehem": (42.6280, -73.8100),
    "south bethlehem": (42.5300, -73.7930),
    # ── Town of Guilderland hamlets ──
    "westmere": (42.6953, -73.8694),
    "mckownville": (42.6750, -73.8320),
    "meadowdale": (42.6800, -73.9350),
    "guilderland center": (42.6880, -73.9560),
    "dunnsville": (42.7050, -73.9700),
    "fort hunter": (42.7150, -73.9800),
    "hartmans corners": (42.6700, -73.9450),
    "parkers corners": (42.6950, -73.9250),
    # ── Town of Coeymans hamlets ──
    "alcove": (42.4500, -73.9050),
    "coeymans hollow": (42.4550, -73.8570),
    "aquetuck": (42.4700, -73.7800),
    # ── Town of New Scotland hamlets ──
    "new salem": (42.6070, -73.9660),
    "onesquethaw": (42.5530, -73.9170),
    "unionville": (42.5700, -73.9470),
    # ── Town of Berne hamlets ──
    "berne": (42.6100, -74.1750),
    "east berne": (42.6180, -74.0950),
    "reidsville": (42.5900, -74.1400),
    "south berne": (42.5780, -74.1600),
    # ── Town of Knox ──
    "knox": (42.6880, -74.0800),
    # ── Town of Rensselaerville hamlets ──
    "rensselaerville": (42.5100, -74.1500),
    "medusa": (42.4700, -74.1100),
    "preston hollow": (42.4830, -74.1670),
    "potter hollow": (42.4950, -74.1820),
    # ── Town of Westerlo hamlets ──
    "dormansville": (42.4970, -74.0700),
    "lambs corner": (42.5150, -74.0450),
    "south westerlo": (42.4800, -74.0200),
    "newry": (42.5200, -74.0100),
    # ── Other ──
    "karner": (42.7160, -73.8860),
    "morris street": (42.6420, -73.7530),
    "washington avenue": (42.6590, -73.7660),
    "western avenue": (42.6570, -73.7990),
    "new scotland avenue": (42.6470, -73.7770),
    "morton avenue": (42.6400, -73.7610),
    "south pearl": (42.6440, -73.7520),
    "north pearl": (42.6560, -73.7510),
    "quail street": (42.6570, -73.7720),
    "ontario street": (42.6590, -73.7500),
    "i-787": (42.6540, -73.7470),
    "i-87": (42.6700, -73.8100),
    "i-90": (42.6850, -73.8200),
    "troy": (42.7284, -73.6918),
    "schenectady": (42.8142, -73.9396),
    "mvp arena": (42.6549, -73.7572),
    "crossgates": (42.6900, -73.8500),
    "crossgates mall": (42.6900, -73.8500),
    "stuyvesant plaza": (42.6620, -73.8240),
    "thruway": (42.6700, -73.8100),
    "wolf road": (42.7080, -73.8130),
    "fuller road": (42.6850, -73.8070),
    "manning boulevard": (42.6570, -73.7820),
    "second avenue": (42.6580, -73.7520),
    "third street": (42.6560, -73.7530),
    "elk street": (42.6470, -73.7570),
    "dove street": (42.6550, -73.7600),
    "hamilton street": (42.6520, -73.7600),
    "hudson avenue": (42.6610, -73.7510),
    "livingston avenue": (42.6560, -73.7500),
    "ten broeck": (42.6590, -73.7530),
    "suny albany": (42.6872, -73.8228),
    "university at albany": (42.6872, -73.8228),
    "albany medical center": (42.6490, -73.7650),
    "albany airport": (42.7483, -73.8018),
}

# Neighborhood groupings for pattern detection
NEIGHBORHOODS = {
    "Downtown": ["downtown albany", "state street", "pearl street", "broadway", "north pearl", "south pearl", "elk street"],
    "Arbor Hill": ["arbor hill", "clinton avenue", "livingston avenue", "ten broeck"],
    "Pine Hills": ["pine hills", "buckingham pond", "manning boulevard", "western avenue"],
    "South End": ["south end", "morton avenue", "morris street"],
    "West Hill": ["west hill", "central ave", "central avenue", "quail street"],
    "Center Square": ["center square", "lark street", "dove street", "hamilton street", "madison ave", "madison avenue"],
    "North Albany": ["north albany", "hudson avenue"],
    # ── Cities ────────────────────────────────────────────────────────
    "Cohoes": ["cohoes"],
    "Watervliet": ["watervliet"],
    # ── Towns & their hamlets/CDPs ────────────────────────────────────
    "Colonie": [
        "colonie", "latham", "loudonville", "wolf road", "roessleville", "karner",
        "colonie center", "boght corners", "lisha kill", "mannsville", "maplewood",
        "maywood", "newtonville", "schuyler heights", "stanford heights", "verdoy",
        "west albany",
    ],
    "Bethlehem": [
        "bethlehem", "delmar", "elsmere", "glenmont", "north bethlehem", "selkirk",
        "slingerlands", "south bethlehem",
    ],
    "Guilderland": [
        "guilderland", "guilderland center", "altamont", "crossgates",
        "crossgates mall", "fuller road", "westmere", "mckownville",
        "meadowdale", "dunnsville", "fort hunter", "fullers",
        "hartmans corners", "parkers corners",
    ],
    "Coeymans": ["coeymans", "ravena", "alcove", "aquetuck", "coeymans hollow", "roah hook"],
    "New Scotland": [
        "new scotland", "voorheesville", "clarksville", "feura bush",
        "new salem", "onesquethaw", "unionville",
    ],
    "Berne": ["berne", "east berne", "reidsville", "south berne"],
    "Knox": ["knox"],
    "Rensselaerville": ["rensselaerville", "medusa", "preston hollow", "potter hollow"],
    "Westerlo": ["westerlo", "dormansville", "lambs corner", "newry", "south westerlo"],
    "Green Island": ["green island"],
    "Menands": ["menands"],
    # ── Institutions ──────────────────────────────────────────────────
    "SUNY Albany": ["suny albany", "university at albany"],
}

http_client: Optional[httpx.AsyncClient] = httpx.AsyncClient(
    timeout=settings.external_timeout_seconds,
    follow_redirects=True,
    headers={"User-Agent": "AlbanyCrimeTracker/5.0 (albany-crime-tracker.repl.co)"},
)
_AI_SITUATION_REFRESH_IN_FLIGHT = False


@asynccontextmanager
async def lifespan(_app):
    global http_client
    if http_client is None:
        http_client = httpx.AsyncClient(
            timeout=settings.external_timeout_seconds,
            follow_redirects=True,
            headers={"User-Agent": "AlbanyCrimeTracker/5.0 (albany-crime-tracker.repl.co)"},
        )
    if has_database():
        try:
            await init_database()
            logger.info("database_initialized")
        except Exception as exc:
            logger.warning("database_init_failed error=%s", exc)
    # Start background stream monitor (Broadcastify → Whisper → keyword alerts)
    await start_stream_monitor()
    # Prime RSS/OpenMHz → crime pipeline → Postgres; Home only calls /api/incidents (read-only).
    await start_background_crime_ingest()
    # Optional fast scanner cache warm-refresh; opt-in via SCANNER_INGEST_SECONDS.
    await start_background_scanner_ingest()
    # Optional APD-Socrata refresh into incidents table; opt-in via
    # SOCRATA_INGEST_SECONDS=1800 (30 min) or 3600 (1 hour).
    await start_background_socrata_ingest()
    # Gap-fill: synthesize "ongoing activity" cards when feed goes quiet
    await start_gap_fill_monitor()
    yield
    await stop_gap_fill_monitor()
    await stop_background_socrata_ingest()
    await stop_background_scanner_ingest()
    await stop_background_crime_ingest()
    await stop_stream_monitor()
    if http_client is not None:
        await http_client.aclose()
        http_client = None
    await close_database()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health_router)
install_error_handlers(app)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    req_id = request.headers.get("x-request-id") or f"req-{int(time.time() * 1000)}"
    set_request_id(req_id)
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    logger.info(
        "request_complete",
        extra={
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "elapsed_ms": elapsed_ms,
        },
    )
    response.headers["x-request-id"] = req_id
    return response


def get_cached(key):
    return cache_backend.get(key)


def set_cached(key, data):
    cache_backend.set(key, data, ttl_seconds=CACHE_TTL.get(key, 300))


# =============================================================================
# RSS PARSING
# =============================================================================
# URL path fragments that indicate a digest/newsletter/roundup page. These
# re-publish older top stories with a fresh send-date, so they pollute the
# live feed with stale content dressed up as current events.
_DIGEST_URL_MARKERS = (
    "/newsletter", "newsletter-daily", "/daily-digest", "/daily-brief",
    "/email/", "/digest/", "/roundup", "/week-in-review", "/recap/",
    "/this-week", "/morning-brief", "/evening-brief", "/top-stories-",
)

# Hard maximum age for any live-feed article. The home window is 48h; this is
# a backstop so a feed handing us a wrong/fresh date on old content can't slip
# multi-week-old stories into "current events".
_FEED_MAX_AGE_HOURS = float(os.getenv("FEED_MAX_AGE_HOURS", "72"))


def _is_digest_url(url: str) -> bool:
    low = (url or "").lower()
    if not low:
        return False
    return any(m in low for m in _DIGEST_URL_MARKERS)


def _pubdate_within_max_age(article: dict) -> bool:
    """True if the article's pubDate is within the hard max-age window.
    Articles with NO parseable date are kept (handled elsewhere); only those
    with a clearly OLD date are dropped."""
    raw = article.get("pubDate") or ""
    if not raw:
        return True
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except Exception:
        return True
    age_h = (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
    # Allow small future skew; drop anything older than the backstop.
    return age_h <= _FEED_MAX_AGE_HOURS


# Article thumbnail cache: link/guid -> image_url. Populated in parse_rss on
# every feed fetch, read by the News endpoint. Decouples thumbnails from the
# incident-persistence pipeline (which transforms articles and can drop the
# field), so images reliably show as long as the source feed carries one.
_ARTICLE_IMAGE_CACHE: dict[str, str] = {}
_ARTICLE_IMAGE_CACHE_MAX = 1500


def _cache_article_image(link: str, guid: str, image_url: str) -> None:
    if not image_url:
        return
    for key in (link, guid):
        k = (key or "").strip().split("?")[0].rstrip("/").lower()
        if k:
            _ARTICLE_IMAGE_CACHE[k] = image_url
    if len(_ARTICLE_IMAGE_CACHE) > _ARTICLE_IMAGE_CACHE_MAX:
        for k in list(_ARTICLE_IMAGE_CACHE.keys())[: len(_ARTICLE_IMAGE_CACHE) - _ARTICLE_IMAGE_CACHE_MAX]:
            _ARTICLE_IMAGE_CACHE.pop(k, None)


def _lookup_article_image(*urls: str) -> str:
    for u in urls:
        k = (u or "").strip().split("?")[0].rstrip("/").lower()
        if k and k in _ARTICLE_IMAGE_CACHE:
            return _ARTICLE_IMAGE_CACHE[k]
    return ""


# Media RSS namespace URIs (media:content / media:thumbnail).
_MEDIA_NS = "{http://search.yahoo.com/mrss/}"
# Reject tracking pixels / spacers / logos that aren't real article art.
_BAD_IMG_MARKERS = ("spacer", "pixel", "1x1", "transparent", "feedburner",
                    "doubleclick", "/ads/", "blank.gif", "icon", "favicon")


def _is_real_image(url: str) -> bool:
    low = (url or "").lower()
    if not low.startswith("http"):
        return False
    if any(b in low for b in _BAD_IMG_MARKERS):
        return False
    return any(low.split("?")[0].endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif")) \
        or "image" in low or "/media/" in low or "/photo" in low or "wp-content" in low or "cdn" in low


def _extract_rss_image(item, raw_desc: str, content_encoded: str = "") -> str:
    """Pull a real article thumbnail from an RSS <item>.
    Checks media:content, media:thumbnail, enclosure, then <img> in the
    description / content:encoded HTML. Returns "" when none is usable."""
    # 1. media:content / media:thumbnail (Media RSS — most feeds with images)
    for tag in (_MEDIA_NS + "content", _MEDIA_NS + "thumbnail", "media:content", "media:thumbnail"):
        for el in item.iter():
            t = el.tag
            if t == tag or t.endswith("}content") or t.endswith("}thumbnail"):
                u = el.get("url") or ""
                if _is_real_image(u):
                    return u
    # 2. <enclosure type="image/..." url="...">
    for enc in item.findall("enclosure"):
        et = (enc.get("type") or "").lower()
        u = enc.get("url") or ""
        if (et.startswith("image") or _is_real_image(u)) and u.startswith("http"):
            if _is_real_image(u):
                return u
    # 3. <img src="..."> inside content:encoded or description HTML
    for html in (content_encoded or "", raw_desc or ""):
        m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.I)
        if m and _is_real_image(m.group(1)):
            return m.group(1)
    return ""


def parse_rss(xml_text, default_source=None):
    articles = []
    try:
        root = ET.fromstring(xml_text)
        for item in root.findall(".//item"):
            title_el = item.find("title")
            link_el = item.find("link")
            pub_el = item.find("pubDate")
            desc_el = item.find("description")
            source_el = item.find("source")
            content_el = item.find("{http://purl.org/rss/1.0/modules/content/}encoded")

            title = title_el.text.strip() if title_el is not None and title_el.text else ""
            link = link_el.text.strip() if link_el is not None and link_el.text else ""
            pub_date = pub_el.text.strip() if pub_el is not None and pub_el.text else ""
            desc = desc_el.text.strip() if desc_el is not None and desc_el.text else ""

            title = title.replace("&nbsp;", " ").replace("&amp;", "&")

            # Strip " - Source Name" suffix injected by Google News
            if source_el is not None and source_el.text:
                src_suffix = " - " + source_el.text.strip()
                if title.endswith(src_suffix):
                    title = title[:-len(src_suffix)]

            source = default_source
            source_url = ""
            if source_el is not None and source_el.text:
                source = source_el.text.strip()
                for suffix in [" (.gov)", " (Press Release)", " (Official)"]:
                    source = source.replace(suffix, "")
                # Google News <source url="https://..."> — capture for LOCAL_DOMAINS check
                source_url = source_el.get("url", "") or ""

            raw_desc_html = desc  # keep HTML before stripping for <img> extraction
            content_encoded = content_el.text if (content_el is not None and content_el.text) else ""
            image_url = _extract_rss_image(item, raw_desc_html, content_encoded)
            if image_url:
                _guid_for_img = (item.find("guid").text if item.find("guid") is not None and item.find("guid").text else "")
                _cache_article_image(link, _guid_for_img, image_url)

            desc = re.sub(r"<[^>]+>", "", desc).strip()
            desc = desc.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            desc = re.sub(r"\s{2,}", " ", desc).strip()
            if len(desc) > 400:
                desc = desc[:400] + "..."

            if title:
                guid_el = item.find("guid")
                guid_txt = (
                    guid_el.text.strip()
                    if guid_el is not None and guid_el.text
                    else (link or title)
                )
                articles.append({
                    "title": title,
                    "link": link,
                    "pubDate": pub_date,
                    "description": desc,
                    "source": source or "Local News",
                    "source_url": source_url,
                    "guid": guid_txt,
                    "image_url": image_url,
                })
    except ET.ParseError:
        pass
    return articles


# =============================================================================
# STRICT ALBANY COUNTY, NY — single gate for all feed types
# =============================================================================
# National/federal social and wire posts were admitted because is_albany_related()
# bypassed text checks for _official_x_post / _nixle_item and used loose "capital region" rules.

NATIONAL_FEDERAL_SOURCE_MARKERS = (
    "official @icegov",
    "@icegov",
    "ice.gov",
    "/icegov/",
    "official @cbp",
    "@cbp",
    "cbp.gov",
    "/cbp/",
    "official @deahq",
    "@deahq",
    "dea.gov",
    "official @dhsgov",
    "@dhsgov",
    "whitehouse.gov",
    "justice.gov",
    "ice boston",
    "ice texas",
    "u.s. customs",
    "customs and border protection",
    "homeland security investigations",
    "h.s.i.",
    "official @hsi",
    "@hsi_hq",
    "hsi special agent",
    "official @fbipressoffice",
    "twitter.com/fbi",
    "fbi press",
    "doj.gov",
    "department of justice",
)

# Geography / narrative that is not Albany County, NY unless copy is locally anchored
OUT_OF_AREA_GEO_MARKERS = (
    "boston",
    "massachusetts",
    "texas",
    "illinois",
    "san juan",
    "puerto rico",
    "dominican republic",
    "florida",
    "arizona",
    "california",
    "oregon",
    "albany, or",
    "albany, oregon",
    "albany oregon",
    "linn county",
    "georgia",
    "washington, d.c",
    "washington dc",
    "d.c.",
    "houston",
    "miami",
    "chicago",
    "los angeles",
    "philadelphia",
    "atlanta",
    "detroit",
    "denver",
    "seattle",
    "phoenix",
    "nashville",
    "ohio",
    "michigan",
    "pennsylvania",
    "virginia",
    "maryland",
    "new jersey",
    "connecticut",
    "vermont",
    "new hampshire",
    "maine",
    "rhode island",
    "national border",
    "southern border",
    "northern border",
    "mexico border",
    "afghanistan",
    "framingham",
    "international fugitive",
    "u.s. border",
    "border wall",
    # Georgia / other-state stories that collide with NY locality tokens
    "gbi investigating",
    "georgia bureau of investigation",
    "georgia bureau",
    "ocilla",
    "put the guns down",
    "delmar, md",
    "delmar md",
)

# Phrases that prove Albany County / City of Albany NY (multi-word first in scan)
_STRICT_LOCALITY_PHRASES: tuple[str, ...] = tuple(
    sorted(
        frozenset(
            list(ALBANY_KEYWORDS)
            + list(ALBANY_TIER1)
            + [
                "albany county",
                "albany, ny",
                "albany ny",
                "albany new york",
                "city of albany",
                "town of colonie",
                "town of bethlehem",
                "town of guilderland",
                "town of new scotland",
                "town of coeymans",
                "town of westerlo",
                "town of berne",
                "town of knox",
                "town of rensselaerville",
                "altamont",
                "roessleville",
                "feura bush",
                "clarksville",
                "westmere",
                "selkirk",
                "karner",
                "elsmere",
            ]
        ),
        key=len,
        reverse=True,
    )
)

_ALBANY_COMMA_NY_RE = re.compile(r"\balbany\s*,\s*n\.?y\.?\b", re.IGNORECASE)
_ALBANY_SPACE_NY_RE = re.compile(r"\balbany\s+ny\b", re.IGNORECASE)

# For bare "albany" token — require explicit NY / local LE (not Troy/Schenectady alone)
_ALBANY_TOKEN_NY_ANCHORS = frozenset(
    [
        "albany county",
        "new york",
        "n.y.",
        " nys ",
        "ny state",
        "state of new york",
        "upstate new york",
        "upstate ny",
        "albany police",
        "albany pd",
        "albany county sheriff",
        "a-c-s-o",
        "colonie police",
        "bethlehem police",
        "guilderland police",
        "nysp",
        "state police",
        "new york state police",
        "troop g",
        "troopers.ny.gov",
        "capital district ny",
        "capital district new york",
        "capital region ny",
        "capital region new york",
    ]
)

_DIR_LOCALITY_SIGNALS_CACHE: Optional[frozenset[str]] = None


def _directory_locality_signals() -> frozenset[str]:
    """Extra locality anchors learned from le_directory.json (cities/municipal labels)
    AND data/agencies.json (canonical Albany-County agency aliases). The agency
    file is the source of truth for new entities; the legacy le_directory.json
    layer is preserved for backward compatibility."""
    global _DIR_LOCALITY_SIGNALS_CACHE
    if _DIR_LOCALITY_SIGNALS_CACHE is not None:
        return _DIR_LOCALITY_SIGNALS_CACHE
    vals: set[str] = set()
    try:
        d = _le_dir_cache()
        for m in d.get("municipalities") or []:
            n = (m.get("name") or "").strip().lower()
            if n and len(n) >= 4:
                vals.add(n)
        for ag in d.get("agencies") or []:
            c = ((ag.get("contact") or {}).get("city") or "").strip().lower()
            if c and len(c) >= 4:
                vals.add(c)
            abb = (ag.get("abbreviation") or "").strip().lower()
            if abb and 3 <= len(abb) <= 10:
                vals.add(abb)
    except Exception:
        pass
    # Pull canonical agency aliases + Albany-County municipality names from
    # data/agencies.json. Restricted to operational-live-relevant agencies so
    # disambiguation-only entries (TSA, FPS, IRS-CI etc.) don't broaden
    # locality acceptance. Defensive try/except so a missing or malformed
    # agency file never breaks the locality gate at startup.
    try:
        from app.services.agency_registry import (
            operational_live_agency_anchors,
            albany_county_municipality_set,
        )
        for s in operational_live_agency_anchors():
            if s and len(s) >= 3:
                vals.add(s)
        for s in albany_county_municipality_set():
            if s and len(s) >= 4:
                vals.add(s)
    except Exception:
        pass
    _DIR_LOCALITY_SIGNALS_CACHE = frozenset(vals)
    return _DIR_LOCALITY_SIGNALS_CACHE


def _strict_blob(article: dict) -> str:
    # Do not include article["source"] — force_labels (e.g. fake "Official · …") must not prove locality.
    parts = [
        article.get("title", "") or "",
        article.get("description", "") or "",
        article.get("link", "") or "",
        article.get("source_url", "") or "",
        article.get("x_post_url", "") or "",
        article.get("guid", "") or "",
    ]
    h = article.get("handle")
    if h:
        parts.append(str(h))
    return " ".join(parts).lower()


def _strict_phrase_in_blob(phrase: str, blob: str) -> bool:
    pl = phrase.lower().strip()
    if not pl:
        return False
    if " " in pl or "-" in pl:
        return pl in blob
    return bool(re.search(rf"(?<![a-z0-9]){re.escape(pl)}(?![a-z0-9])", blob))


def _strong_albany_county_anchor(blob: str) -> Optional[str]:
    """Return a short reason if text proves Albany County NY locality; else None."""
    if "albany county, ga" in blob or "albany county georgia" in blob:
        return None
    if "albany county" in blob and "georgia" not in blob and ", ga" not in blob:
        return "explicit_albany_county_ny"
    if _ALBANY_COMMA_NY_RE.search(blob) or _ALBANY_SPACE_NY_RE.search(blob):
        return "albany_city_ny"
    if "albany new york" in blob:
        return "albany_new_york"
    if "city of albany" in blob:
        return "city_of_albany"
    for phrase in _STRICT_LOCALITY_PHRASES:
        if phrase in ("albany ny", "albany, ny", "albany county", "albany new york", "city of albany"):
            continue
        if _strict_phrase_in_blob(phrase, blob):
            return f"locality:{phrase[:48]}"
    return None


def _national_federal_source_hit(article: dict) -> bool:
    sl = (
        (article.get("source", "") or "")
        + " "
        + (article.get("link", "") or "")
        + " "
        + (article.get("x_post_url", "") or "")
    ).lower()
    src = (article.get("source", "") or "").lower()
    if "fbialbany" in sl or "fbi albany" in sl:
        return False
    if src.startswith("official @fbi") and "albany" not in src:
        return True
    return any(m in sl for m in NATIONAL_FEDERAL_SOURCE_MARKERS)


_ALBANY_COUNTY_MUNIS_NORM: frozenset = frozenset({
    "albany", "albany county",
    "cohoes", "watervliet", "colonie", "bethlehem", "guilderland",
    "coeymans", "new scotland", "berne", "knox", "rensselaerville", "westerlo",
    "green island", "menands",
    "altamont", "ravena", "voorheesville",
    "delmar", "latham", "loudonville", "slingerlands", "selkirk", "elsmere",
    "glenmont", "clarksville", "feura bush", "medusa",
    "east berne", "newtonville", "westmere", "mckownville",
    "south bethlehem",
})


def _normalize_muni(raw: str) -> str:
    s = raw.lower().strip()
    for prefix in ("city of ", "town of ", "village of ", "hamlet of "):
        if s.startswith(prefix):
            s = s[len(prefix):]
    return s.strip(" ,.-")


def _is_nysp_blotter_article(article: dict) -> bool:
    return bool(article.get("_nysp_pdf_url") or article.get("_nysp_incident_number"))


def _nysp_muni_from_title(title: str) -> str:
    """Extract municipality from title suffix: 'NYSP: <incident> — <municipality>'."""
    for sep in (" \u2014 ", " - "):
        idx = title.rfind(sep)
        if idx > 0:
            return title[idx + len(sep):].strip()
    return ""


def evaluate_strict_albany_county(article: dict) -> tuple[bool, str]:
    """
    True only when the item is genuinely anchored to Albany County, New York.
    Sets debug fields via is_albany_related caller.
    """
    if article.get("_scanner_call") or article.get("_scanner_feed_link"):
        return True, "albany_county_scanner_feed"

    if _is_nysp_blotter_article(article):
        raw_muni = (article.get("municipality") or "").strip()
        if not raw_muni:
            raw_muni = _nysp_muni_from_title(article.get("title") or "")
        norm = _normalize_muni(raw_muni)
        if norm and norm in _ALBANY_COUNTY_MUNIS_NORM:
            return True, "nysp_albany_municipality_accept"
        return False, "no_albany_county_locality_evidence"

    blob = _strict_blob(article)
    if not blob.strip():
        return False, "empty_text"

    for fp in FALSE_POSITIVE_INDICATORS:
        if fp in blob:
            return False, f"false_positive:{fp[:40]}"

    if article.get("_511_incident") or article.get("_ny_alert"):
        anch = _strong_albany_county_anchor(blob)
        if anch:
            return True, f"operational_{anch}"
        for phrase in sorted(ALBANY_TIER1, key=len, reverse=True):
            if _strict_phrase_in_blob(phrase, blob):
                return True, "operational_tier1_locality"
        return False, "operational_no_albany_county_anchor"

    src_low = (article.get("source", "") or "").lower()
    for nls in NON_LOCAL_SOURCES:
        if nls in src_low:
            return False, f"non_local_source:{nls[:40]}"

    anchor = _strong_albany_county_anchor(blob)

    # Weak locality:* anchors (e.g. "delmar" alone) must not override clear out-of-area copy.
    if anchor and anchor.startswith("locality:"):
        for m in OUT_OF_AREA_GEO_MARKERS:
            if m in blob:
                return False, f"out_of_area:{m[:40]}"

    if not anchor:
        for m in OUT_OF_AREA_GEO_MARKERS:
            if m in blob:
                return False, f"out_of_area:{m[:40]}"
        if _national_federal_source_hit(article):
            return False, "federal_national_source_no_local_anchor"
        if any(g in blob for g in GENERIC_REGION_TERMS):
            return False, "capital_region_without_county_anchor"
        if re.search(r"\balbany\b", blob):
            # Accept plain "Albany" when strong city/public-safety context is present
            # and there is no conflicting out-of-area marker.
            if re.search(r"\bin\s+albany\b", blob):
                return True, "albany_plain_city_context"
            if (
                "albany police" in blob
                or "albany pd" in blob
                or "albany sheriff" in blob
                or "albany fire" in blob
                or "city of albany" in blob
            ):
                return True, "albany_public_safety_context"
            if not any(a in blob for a in _ALBANY_TOKEN_NY_ANCHORS):
                if any(s in blob for s in _directory_locality_signals()):
                    return True, "albany_token_with_directory_locality_signal"
                # Only reject if there is ALSO a conflicting out-of-area signal
                if any(m in blob for m in OUT_OF_AREA_GEO_MARKERS):
                    return False, "albany_token_without_ny_confirmation"
                return True, "albany_token_without_conflict_marker"
        return False, "no_albany_county_locality_evidence"

    if "albany county, ga" in blob or "albany county georgia" in blob:
        return False, "albany_county_wrong_state"

    if _national_federal_source_hit(article):
        return True, f"{anchor}+federal_locally_anchored"

    return True, anchor


def is_albany_related(article: dict) -> bool:
    """Strict Albany County, NY gate — used for all feeds before dedupe and in /api/crimes."""
    global _GEO_FILTER_STATS
    ok, reason = evaluate_strict_albany_county(article)
    if ok:
        _GEO_FILTER_STATS["accepted"] = int(_GEO_FILTER_STATS.get("accepted", 0)) + 1
        article["locality_match_reason"] = reason
        article.pop("rejected_reason", None)
    else:
        _GEO_FILTER_STATS["rejected"] = int(_GEO_FILTER_STATS.get("rejected", 0)) + 1
        rs = _GEO_FILTER_STATS.get("reasons") or {}
        rs[reason] = int(rs.get(reason, 0)) + 1
        _GEO_FILTER_STATS["reasons"] = rs
        article["rejected_reason"] = reason
        article.pop("locality_match_reason", None)
        # Per-article reject logging is opt-in: at ~800 rejects/tick it trips
        # Railway's 500 logs/sec limit and drops other logs. The aggregate
        # geo_filter_counts summary already reports reject reasons + counts.
        if os.getenv("LOG_GEO_REJECTS", "").strip().lower() in {"1", "true", "yes"}:
            t = (article.get("title") or "")[:90]
            print(f"[geo-reject] {reason} | {t!r}")
    return ok


# =============================================================================
# LIVE FEED FINAL GATE — Albany County incidents only (no junk / stale / federal RTs)
# =============================================================================

LIVE_SCANNER_MAX_AGE_HOURS = 1.5  # 90 minutes
LIVE_OFFICIAL_SOCIAL_MAX_AGE_HOURS = 12.0
LIVE_NEWS_RSS_MAX_AGE_HOURS = 24.0

_NYSP_SOURCE_HINTS = (
    "official @nyspolice",
    "@nyspolice",
    "nysp blotter",
    "troopers.ny.gov",
)

_NON_INCIDENT_PROMO_SOCIAL = (
    "now hiring", "we're hiring", "were hiring", "join our team", "join the team",
    "careers", "career fair", "apply today", "recruitment", "proud to serve",
    "congratulations to", "award ceremony", "community outreach day",
    "annual statistics", "nationwide seizure", "seizures nationwide",
    "year in review", "statistics for fiscal", "bragging rights",
)

_DISTANT_OR_NATIONAL_HUMAN_INTEREST = (
    "afghanistan", "iraq", "syria", "ukraine",
)

_RT_REPOST_MARKERS = (
    "rt @", "retweet", "reposted from",
)

# Title/description must show a real event (not source-only placeholders) to appear on Live
_LIVE_SUBSTANCE_KEYWORDS = frozenset(
    list(URGENT_KEYWORDS)
    + list(LIVE_SAFETY_SIGNAL_KEYWORDS)
    + [
        "arrest", "arrested", "charged", "crash", "collision", "mvc", "mva",
        "investigation", "fire", "smoke", "burglary", "robbery", "assault",
        "closure", "closed", "detour", "missing", "wanted", "suspect", "victim",
        "shooting", "stabbing", "homicide", "overdose", "pursuit", "standoff",
    ]
)

_LIVE_GENERIC_TITLE_ONLY = frozenset(
    [
        "openmhz", "scanner", "dispatch", "radio traffic", "live feed",
        "police activity", "breaking news", "alert",
    ]
)


def _live_plain_text(article: dict) -> tuple[str, str, str]:
    title = (article.get("title") or "").strip()
    desc = re.sub(r"<[^>]+>", "", (article.get("description") or "")).strip()
    combined = f"{title} {desc}".strip()
    return title, desc, combined


def live_has_useful_summary(article: dict) -> bool:
    """
    Live tab only: require human-meaningful event text (not source-only or empty blurbs).
    """
    title, desc, combined = _live_plain_text(article)
    low = combined.lower()
    if len(combined) < 12:
        return False

    if article.get("_511_incident") or article.get("_ny_alert"):
        return len(combined) >= 16

    if re.search(r"\d{2,5}\s+[a-z]", low):
        return True
    if _scanner_blob_matches_critical_live(low):
        return True
    if any(k in low for k in _LIVE_SUBSTANCE_KEYWORDS):
        return True
    if _strong_albany_county_anchor(low):
        return True

    if article.get("_scanner_call"):
        return bool(re.search(r"\d", combined)) and len(combined) >= 18

    if article.get("_official_x_post"):
        if len(title) < 18 and len(desc) < 25:
            return False

    tl = title.lower().strip()
    if tl in _LIVE_GENERIC_TITLE_ONLY and len(desc) < 30:
        return False
    if len(title) <= 22 and tl in _LIVE_GENERIC_TITLE_ONLY:
        return len(desc) >= 40

    src = (article.get("source") or "").strip().lower()
    if src and len(title) <= 36:
        if tl == src or tl in src or (len(src) < 40 and src in tl):
            if len(desc) < 28 and not re.search(r"\d", combined):
                return False

    return len(combined) >= 36


def is_scanner_noise(article: dict) -> bool:
    """True for empty / placeholder / duplicate 'Radio traffic' scanner rows."""
    if not article.get("_scanner_call"):
        return False
    t = (article.get("title") or "").strip().lower()
    d = (article.get("description") or "").strip().lower()
    blob = f"{t} {d}".strip()
    if not blob:
        return True
    if "radio traffic" in t:
        rest = t.replace("radio traffic", " ", 1)
        rest = re.sub(r"[\s:.\-]+", " ", rest).strip()
        if not rest or rest == "radio traffic" or t.count("radio traffic") >= 2:
            return True
    if len(blob) < 22 and not any(ch.isdigit() for ch in blob):
        return True
    if t == d and len(t) < 55 and ("radio traffic" in t or "routine traffic" in t):
        return True
    return False


def _scanner_call_has_actionable_incident(article: dict) -> bool:
    if article.get("_scanner_conventional"):
        return False
    blob = _article_combined_text(article)
    if article.get("_scanner_critical_live") or article.get("_scanner_recent_live"):
        return True
    if _scanner_blob_matches_critical_live(blob):
        return True
    if re.search(r"\d{2,5}\s+[a-z]", blob) and any(
        k in blob for k in ("ave", "st ", " rd", "blvd", "street", "road", "lane")
    ):
        return True
    return any(
        k in blob
        for k in (
            "mvc", "mva", "structure fire", "working fire", "overdose", "stabbing",
            "shooting", "pursuit", "burglary", "robbery", "assault", "alarm",
            "traffic stop", "domestic", "unconscious", "chest pain", "difficulty breathing",
        )
    )


def is_real_local_incident(article: dict) -> bool:
    """
    True when the item describes a local public-safety / crime / traffic incident,
    not agency PR, statistics brags, reposts, or distant human-interest stories.
    """
    if is_scanner_noise(article):
        return False
    blob = _strict_blob(article)
    combined = _article_combined_text(article)
    title_lower = (article.get("title") or "").lower()

    if article.get("_nixle_item"):
        return len(combined.strip()) > 10

    if article.get("_511_incident") or article.get("_ny_alert") or article.get("_nws_alert"):
        return len(combined.strip()) > 12

    if article.get("_scanner_call"):
        return _scanner_call_has_actionable_incident(article)

    if any(m in blob for m in _RT_REPOST_MARKERS):
        return False

    for w in _DISTANT_OR_NATIONAL_HUMAN_INTEREST:
        if w in blob:
            return False

    if any(p in blob for p in _NON_INCIDENT_PROMO_SOCIAL):
        return False

    if "marine veteran" in blob or "lost both legs" in blob:
        return False

    if "texas officers" in blob or "our texas" in blob:
        return False

    if "framingham" in blob:
        return False

    if "international fugitive" in title_lower and "albany county" not in blob:
        return False

    noise_hits = [fp for fp in NOISE_KEYWORDS if fp in combined]
    if noise_hits and not any(u in title_lower for u in URGENT_KEYWORDS):
        return False

    if article.get("_official_x_post"):
        if live_safety_signal_match(article) or ongoing_public_safety_relevance(article):
            return True
        if any(k in combined for k in URGENT_KEYWORDS):
            return True
        return any(
            k in combined
            for k in (
                "arrest", "arrested", "charged", "crash", "collision", "fire",
                "closure", "road closed", "missing person", "investigation",
                "burglary", "robbery", "shooting", "stabbing", "assault",
            )
        )

    if any(k in combined for k in URGENT_KEYWORDS):
        return True
    if live_safety_signal_match(article):
        return True
    return any(kw in combined for kw in CRIME_KEYWORDS)


def _nysp_missing_local_evidence(article: dict) -> bool:
    """NYSP posts need Troop G or explicit Albany County–area locality in copy."""
    src = (article.get("source") or "").lower()
    link = (article.get("link") or "").lower()
    if not any(h in src or h in link for h in _NYSP_SOURCE_HINTS):
        return False
    blob = _strict_blob(article)
    if "troop g" in blob:
        return False
    if _strong_albany_county_anchor(blob):
        return False
    return True


def live_feed_max_age_ok(article: dict) -> tuple[bool, str]:
    age_h = get_article_age_hours(article)
    if age_h is None:
        return False, "rejected_stale"

    ongoing = ongoing_public_safety_relevance(article)
    critical = bool(article.get("_scanner_critical_live"))

    if article.get("_scanner_call"):
        if age_h <= LIVE_SCANNER_MAX_AGE_HOURS:
            return True, ""
        if ongoing or critical:
            return True, ""
        return False, "rejected_stale"

    if article.get("_official_x_post") or article.get("_nixle_item"):
        if age_h <= LIVE_OFFICIAL_SOCIAL_MAX_AGE_HOURS:
            return True, ""
        if ongoing:
            return True, ""
        return False, "rejected_stale"

    if age_h <= LIVE_NEWS_RSS_MAX_AGE_HOURS:
        return True, ""
    blob_age = _article_combined_text(article)
    if ongoing and any(
        k in blob_age
        for k in ("closure", "road closed", "missing", "search", "alert", "active", "shelter")
    ):
        return True, ""
    return False, "rejected_stale"


def _map_strict_fail_to_live_code(reason: str) -> str:
    if reason == "federal_national_source_no_local_anchor":
        return "rejected_federal_generic"
    if reason == "albany_token_without_ny_confirmation":
        return "rejected_ambiguous_albany"
    if reason == "capital_region_without_county_anchor":
        return "rejected_ambiguous_albany"
    if reason.startswith("false_positive:") or reason.startswith("out_of_area:"):
        return "rejected_non_local"
    if reason.startswith("non_local_source:"):
        return "rejected_non_local"
    return "rejected_non_local"


def _log_live_feed_gate(code: str, article: dict) -> None:
    if not code:
        return
    t = (article.get("title") or "")[:110]
    print(f"[live-feed] {code} | {t!r}")


# Locality reasons from evaluate_strict_albany_county() that we treat as strong
# positive evidence the story really is Albany County, NY. Anything outside this
# set means the article only passed on weak signals (bare "albany" + NY hint).
_STRONG_LOCALITY_ANCHORS = (
    "albany_county",
    "albany_ny",
    "city_of_albany",
    "tier1:",
    "locality:",
    "scanner:",
    "nixle:",
    "official_x:",
    "open_data:",
    "nws:",
)


def locality_confidence_tier(article: dict) -> tuple[str, str]:
    """
    Tier an article's Albany County locality confidence for Live-feed gating.

    Returns (tier, reason) where tier is one of:
      "strong"   — explicit Albany County / Albany, NY anchor or a tier-1 source.
                   Safe for the Live "Now" lane.
      "medium"   — passed strict gate on domain authority or multiple NY signals;
                   safe for Live but not prioritized.
      "quarantine" — passed strict gate only on weak evidence AND low source
                   reliability, AND no geocode. Withheld from Live but still
                   persisted and surfaced in Confirmed/Context lanes.

    This does NOT re-filter for locality; it only tiers items already accepted
    by evaluate_strict_albany_county(). The goal is to prevent ambiguous items
    (bare "albany" token in low-reliability national wire) from appearing as
    "happening now" without silently dropping them from the dataset.
    """
    ok, reason = evaluate_strict_albany_county(article)
    if not ok:
        return "rejected", reason or "rejected"

    reason_l = (reason or "").lower()
    if any(reason_l.startswith(p) or p in reason_l for p in _STRONG_LOCALITY_ANCHORS):
        if not reason_l.startswith("weak:"):
            return "strong", reason

    reliability = get_source_reliability(article.get("source", ""))
    has_geo = bool(article.get("latitude") and article.get("longitude"))
    blob = ((article.get("title") or "") + " " + (article.get("description") or "")).lower()
    ny_hits = sum(1 for s in NY_CONFIRMATION_SIGNALS if s in blob)

    if reliability >= 0.85 or has_geo or ny_hits >= 2:
        return "medium", reason

    return "quarantine", reason


def should_include_in_live_feed(article: dict, *, log_rejects: bool = True) -> tuple[bool, str]:
    """
    Single final gate for the Live tab. Requires strict Albany County locality,
    real incident/public-safety content, recency rules, and no scanner/federal/social noise.
    """
    def _rej(code: str) -> tuple[bool, str]:
        article["live_reject_reason"] = code
        if log_rejects:
            _log_live_feed_gate(code, article)
        return False, code

    ok_loc, loc_reason = evaluate_strict_albany_county(article)
    if not ok_loc:
        return _rej(_map_strict_fail_to_live_code(loc_reason))

    # Locality confidence gate: ambiguous items (weak anchor + low reliability +
    # no geocode) are withheld from the Live lane but still persisted for
    # Confirmed/Context lanes. Scanner / official / open_data rows are always
    # "strong" so this does not affect operational Now detection.
    tier, _tier_reason = locality_confidence_tier(article)
    article["locality_confidence_tier"] = tier
    if tier == "quarantine":
        return _rej("rejected_locality_quarantine")

    if _nysp_missing_local_evidence(article):
        return _rej("rejected_non_local")

    if is_scanner_noise(article):
        return _rej("rejected_scanner_noise")

    if _national_federal_source_hit(article) and not is_real_local_incident(article):
        return _rej("rejected_federal_generic")

    if not is_real_local_incident(article):
        return _rej("rejected_not_incident")

    age_ok, _stale = live_feed_max_age_ok(article)
    if not age_ok:
        return _rej("rejected_stale")

    if not live_has_useful_summary(article):
        return _rej("rejected_weak_summary")

    article.pop("live_reject_reason", None)
    return True, ""


def strict_incident_pipeline_ok(article: dict, *, log_rejects: bool = False) -> tuple[bool, str]:
    """
    Albany + substance gates for the unified incident pipeline (three-lane model).
    Unlike should_include_in_live_feed, does not cap RSS age — incident_intelligence routes by window.
    """
    def _rej(code: str) -> tuple[bool, str]:
        article["live_reject_reason"] = code
        if log_rejects:
            _log_live_feed_gate(code, article)
        return False, code

    ok_loc, loc_reason = evaluate_strict_albany_county(article)
    if not ok_loc:
        return _rej(_map_strict_fail_to_live_code(loc_reason))

    if _nysp_missing_local_evidence(article):
        return _rej("rejected_non_local")

    if is_scanner_noise(article):
        return _rej("rejected_scanner_noise")

    if _national_federal_source_hit(article) and not is_real_local_incident(article):
        return _rej("rejected_federal_generic")

    if not is_real_local_incident(article):
        return _rej("rejected_not_incident")

    if not live_has_useful_summary(article):
        return _rej("rejected_weak_summary")

    article.pop("live_reject_reason", None)
    return True, ""


def _scanner_live_fingerprint(a: dict) -> str:
    """Normalize scanner copy so near-duplicate cards collapse to one row."""
    title = (a.get("title") or "").strip().lower()
    desc = re.sub(r"<[^>]+>", "", (a.get("description") or "")).strip().lower()
    raw = f"{title} {desc}"
    raw = re.sub(r"\s+", " ", raw).strip()
    raw = re.sub(r"\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b", " ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:240] if raw else "_"


def dedupe_redundant_live_scanner_cards(live_items: list[dict]) -> list[dict]:
    """Drop redundant scanner rows (same normalized text); keep the freshest per fingerprint."""
    non_scan = [x for x in live_items if not x.get("_scanner_call")]
    scan = [x for x in live_items if x.get("_scanner_call")]
    best_by_fp: dict[str, dict] = {}
    for x in scan:
        fp = _scanner_live_fingerprint(x)
        if fp not in best_by_fp:
            best_by_fp[fp] = x
            continue
        prev = best_by_fp[fp]
        am_new = x.get("age_minutes")
        am_old = prev.get("age_minutes")
        if am_new is None:
            continue
        if am_old is None or am_new < am_old:
            best_by_fp[fp] = x
    return non_scan + list(best_by_fp.values())


def live_presentation_priority_tier(x: dict) -> int:
    """
    Higher tier sorts first on Live. Ordering:
      1) Fresh scanner with actionable event/location
      2) Road closures / missing persons / ongoing alerts (incl. Nixle)
      3) Recent local arrests / crashes / investigations
      4) Other clearly relevant rows
    """
    blob = _article_combined_text(x).lower()
    age_h = x.get("age_hours")
    age_h = float(age_h) if isinstance(age_h, (int, float)) else 999.0

    ongoing = ongoing_public_safety_relevance(x)
    crit = bool(x.get("_scanner_critical_live"))
    sc = bool(x.get("_scanner_call"))

    closure_missing = any(
        k in blob
        for k in (
            "road closed",
            "road closure",
            "lane closed",
            "lanes closed",
            "missing person",
            "amber alert",
            "silver alert",
            "active search",
            "shelter in place",
            "shelter-in-place",
        )
    )

    tier3_kw = (
        "arrest",
        "arrested",
        "charged",
        "crash",
        "collision",
        "investigation",
        "shooting",
        "stabbing",
        "fire",
        "robbery",
        "burglary",
        "assault",
    )

    if sc:
        if age_h <= LIVE_SCANNER_MAX_AGE_HOURS and _scanner_call_has_actionable_incident(x):
            if re.search(r"\d", blob) or _scanner_blob_matches_critical_live(blob):
                return 110
            return 105
        if age_h <= 3.0 and crit:
            return 95
        if age_h <= 6.0 and _scanner_call_has_actionable_incident(x):
            return 82
        if age_h <= 12.0:
            return 58
        return 35

    if closure_missing and (ongoing or age_h <= 12.0):
        return 88 if age_h <= 8.0 else 75

    if x.get("_nixle_item") and age_h <= LIVE_OFFICIAL_SOCIAL_MAX_AGE_HOURS:
        return 80

    if x.get("_official_x_post") and live_safety_signal_match(x) and age_h <= 6.0:
        return 72

    if age_h <= 8.0 and any(k in blob for k in tier3_kw):
        return 65
    if age_h <= 12.0 and any(k in blob for k in tier3_kw):
        return 52

    return 42


def live_presentation_sort_key(x: dict) -> tuple:
    """
    Sort Live descending: tier, ongoing boost, freshness (newer first), then live_score.
    """
    tier = live_presentation_priority_tier(x)
    ongoing = 1 if ongoing_public_safety_relevance(x) else 0
    crit = 1 if x.get("_scanner_critical_live") else 0
    am = x.get("age_minutes")
    am = float(am) if isinstance(am, (int, float)) else 99999.0
    score = float(x.get("live_score") or 0.0)
    return (tier, ongoing, crit, -am, score)


def compute_article_confidence(article) -> float:
    """
    Returns a confidence score 0.0–1.0 that this article is genuinely
    about Albany County, NY.
    """
    title = article.get("title", "") or ""
    desc = article.get("description", "") or ""
    text = (title + " " + desc).lower()
    link = (article.get("link", "") or "").lower()
    source_url = (article.get("source_url", "") or "").lower()

    score = 0.55  # baseline (passed the filter)

    # "albany county" or "albany, ny" → very high confidence
    if "albany county" in text:
        score = max(score, 0.97)
    elif any(p in text for p in ("albany, ny", "albany ny", "albany new york")):
        score = max(score, 0.95)

    # Specific tier-1 locality match
    for loc in ALBANY_TIER1:
        if loc in text:
            score = max(score, 0.90)
            break

    # Local domain (check both link and source_url for Google News articles)
    if any(d in link for d in LOCAL_DOMAINS) or any(d in source_url for d in LOCAL_DOMAINS):
        score = min(score + 0.06, 1.0)

    # Each NY confirmation signal adds a small boost
    ny_count = sum(1 for sig in NY_CONFIRMATION_SIGNALS if sig in text)
    score = min(score + ny_count * 0.025, 1.0)

    # Source reliability factor
    reliability = get_source_reliability(article.get("source", ""))
    score = min(score * 0.5 + reliability * 0.5 * score + score * 0.1, 1.0)

    return round(min(score, 1.0), 2)


def is_crime_related(article) -> bool:
    if article.get("_scanner_feed_link"):
        return False
    if is_scanner_noise(article):
        return False
    if article.get("_scanner_call"):
        return _scanner_call_has_actionable_incident(article)

    blob = (
        (article.get("title", "") + " " + (article.get("description", "") or "") + " "
         + (article.get("source", "") or ""))
    ).lower()

    if article.get("_nixle_item"):
        return len(blob.strip()) > 8

    if article.get("_official_x_post"):
        if any(m in blob for m in _RT_REPOST_MARKERS):
            return False
        for w in _DISTANT_OR_NATIONAL_HUMAN_INTEREST:
            if w in blob:
                return False
        if any(p in blob for p in _NON_INCIDENT_PROMO_SOCIAL):
            return False
        return (
            any(kw in blob for kw in CRIME_KEYWORDS)
            or live_safety_signal_match(article)
            or any(u in blob for u in URGENT_KEYWORDS)
        )

    text = (article.get("title", "") + " " + (article.get("description", "") or "")).lower()
    for w in _DISTANT_OR_NATIONAL_HUMAN_INTEREST:
        if w in text:
            return False
    return any(kw in text for kw in CRIME_KEYWORDS)


# Precompiled regex: extracts location candidates after prepositions,
# optionally preceded by a street number.
# Examples matched:
#   "on Clinton Avenue"         → "Clinton Avenue"
#   "at 143 Quail Street"       → "Quail Street"
#   "near Crossgates Mall"      → "Crossgates Mall"
#   "in downtown Albany"        → "downtown Albany"
_ADDR_PREP_RE = re.compile(
    r'\b(?:on|at|near|along|in|from|off)\s+'
    r'(?:\d{1,4}\s+)?'          # optional house number
    r'([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,4})',
    re.IGNORECASE,
)

# Street-type suffixes to try when the extracted phrase lacks one
_STREET_SUFFIXES = ("street", "avenue", "ave", "boulevard", "blvd",
                    "road", "lane", "place", "drive", "way", "court")

def _extract_location_hints(raw_text: str) -> list[str]:
    """
    Return lowercased candidate location strings extracted by scanning for
    preposition-led phrases in the raw article text.

    E.g.  "shot on Clinton Avenue"     → ["clinton avenue"]
          "at 143 Quail Street"        → ["quail street"]
          "near Crossgates Mall"       → ["crossgates mall", "crossgates"]
    """
    seen: set[str] = set()
    results: list[str] = []
    for m in _ADDR_PREP_RE.finditer(raw_text):
        phrase = m.group(1).strip().lower()
        # Remove trailing conjunctions / articles
        phrase = re.sub(r'\s+(?:and|in|the|a|an|of)\s*$', '', phrase).strip()
        if len(phrase) < 4 or phrase in seen:
            continue
        seen.add(phrase)
        results.append(phrase)
        # Also try with appended street-type suffixes
        for sfx in _STREET_SUFFIXES:
            if not phrase.endswith(sfx):
                candidate = f"{phrase} {sfx}"
                if candidate not in seen:
                    seen.add(candidate)
                    results.append(candidate)
    return results


def geocode_article(article):
    """
    Match article text to ALBANY_LOCATIONS and return precise coordinates.

    Priority:
      1. Direct keyword scan — all ALBANY_LOCATIONS keys (longest first so most
         specific location wins, e.g. "crossgates mall" beats "crossgates").
      2. Preposition-extracted hints — handles address numbers and prepositions:
         "shot at 143 Quail Street" → extracts "quail street" → looks up in dict.
      3. No match → latitude/longitude = None.
         The article still appears in the news list/sidebar but gets NO map pin.

    IMPORTANT: The previous random-jitter fallback on a generic "albany" match
    has been intentionally removed.  Placing a pin at a random coordinate within
    ±800 m of City Hall is misleading and was the root cause of pins appearing
    in arbitrary locations unrelated to the actual incident.
    """
    text = (article.get("title", "") + " " + article.get("description", "")).lower()
    raw_text = article.get("title", "") + " " + article.get("description", "")

    # ── Pass 1: direct keyword match (longest key first) ─────────────────────
    specific_keys = sorted(
        (k for k in ALBANY_LOCATIONS if k != "albany"),
        key=len, reverse=True
    )
    for loc_name in specific_keys:
        if loc_name in text:
            lat, lng = ALBANY_LOCATIONS[loc_name]
            return {
                **article,
                "latitude": lat,
                "longitude": lng,
                "matched_location": loc_name,
                "location_accuracy": "specific",
            }

    # ── Pass 2: preposition-extracted candidates ──────────────────────────────
    for hint in _extract_location_hints(raw_text):
        if hint in ALBANY_LOCATIONS:
            lat, lng = ALBANY_LOCATIONS[hint]
            return {
                **article,
                "latitude": lat,
                "longitude": lng,
                "matched_location": hint,
                "location_accuracy": "specific",
            }

    # ── No specific location matched ──────────────────────────────────────────
    # Article shown in sidebar / news list but excluded from map.
    return {
        **article,
        "latitude": None,
        "longitude": None,
        "matched_location": None,
        "location_accuracy": None,
    }


def classify_crime_type(article) -> str:
    text = (article.get("title", "") + " " + article.get("description", "")).lower()
    violent_kw = ["murder", "homicide", "shooting", "stabbing", "assault",
                  "robbery", "rape", "manslaughter", "kidnapping", "sexual",
                  "weapon", "domestic", "gang", "fatal", "standoff", "gunfire",
                  "gunshot", "fired at", "opened fire"]
    property_kw = ["burglary", "larceny", "theft", "stolen", "vandalism",
                   "arson", "trespass", "criminal mischief", "auto theft",
                   "break-in", "fraud", "embezzle", "shoplifting", "breaking and entering"]
    for kw in violent_kw:
        if kw in text:
            return "violent"
    for kw in property_kw:
        if kw in text:
            return "property"
    return "other"


def get_neighborhood(location_name: str) -> str:
    if not location_name:
        return "Other"
    for hood, locs in NEIGHBORHOODS.items():
        if location_name in locs:
            return hood
    return "Other"


# =============================================================================
# PATTERN DETECTION
# =============================================================================
def detect_patterns(crime_data):
    if not crime_data:
        return {"hotspots": [], "type_breakdown": {}, "insights": [], "neighborhood_counts": {}}

    def _row_counts_for_stats(c: dict) -> bool:
        if c.get("_stats_eligible") is not None:
            return bool(c["_stats_eligible"])
        return not is_scanner_noise(c) and is_real_local_incident(c)

    crime_data = [c for c in crime_data if _row_counts_for_stats(c)]
    if not crime_data:
        return {"hotspots": [], "type_breakdown": {}, "insights": [], "neighborhood_counts": {}}

    hood_counts = Counter()
    hood_types = defaultdict(Counter)
    now = datetime.now(timezone.utc)
    recent_48h = []
    older = []

    for c in crime_data:
        hood = get_neighborhood(c.get("matched_location", ""))
        hood_counts[hood] += 1
        hood_types[hood][c.get("crime_type", "other")] += 1

        pub = c.get("pubDate", "")
        if pub:
            try:
                dt = parsedate_to_datetime(pub)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if (now - dt).total_seconds() < 48 * 3600:
                    recent_48h.append(c)
                else:
                    older.append(c)
            except Exception:
                older.append(c)

    type_counts = Counter(c.get("crime_type", "other") for c in crime_data)

    hotspots = []
    for hood, count in hood_counts.most_common(5):
        dominant_type = hood_types[hood].most_common(1)[0][0] if hood_types[hood] else "other"
        hotspots.append({
            "neighborhood": hood,
            "count": count,
            "dominant_type": dominant_type,
            "violent": hood_types[hood].get("violent", 0),
            "property": hood_types[hood].get("property", 0),
        })

    insights = []
    total = len(crime_data)
    violent_count = type_counts.get("violent", 0)
    property_count = type_counts.get("property", 0)

    if violent_count > 0:
        violent_pct = round(violent_count / total * 100)
        insights.append({
            "type": "stat",
            "icon": "alert",
            "text": f"{violent_count} violent incident{'s' if violent_count != 1 else ''} ({violent_pct}% of total)",
            "severity": "high" if violent_pct > 30 else "medium",
        })

    if property_count > 0:
        property_pct = round(property_count / total * 100)
        insights.append({
            "type": "stat",
            "icon": "property",
            "text": f"{property_count} property crime{'s' if property_count != 1 else ''} ({property_pct}% of total)",
            "severity": "medium" if property_pct > 40 else "low",
        })

    if hotspots:
        top = hotspots[0]
        insights.append({
            "type": "hotspot",
            "icon": "location",
            "text": f"{top['neighborhood']} is the most active area with {top['count']} incident{'s' if top['count'] != 1 else ''}",
            "severity": "high" if top["count"] > 5 else "medium",
        })

    recent_count = len(recent_48h)
    if recent_count > 0:
        insights.append({
            "type": "recency",
            "icon": "clock",
            "text": f"{recent_count} incident{'s' if recent_count != 1 else ''} reported in the last 48 hours",
            "severity": "high" if recent_count > 10 else "medium" if recent_count > 3 else "low",
        })

    return {
        "hotspots": hotspots,
        "type_breakdown": dict(type_counts),
        "insights": insights,
        "neighborhood_counts": dict(hood_counts),
        "recent_48h": recent_count,
        "total": total,
    }


# =============================================================================
# xAI / GROK HELPERS
# =============================================================================
# =============================================================================
# LLM INCIDENT FUSION — Grok-powered clean, structured incident summaries
# =============================================================================
# Raw source titles are messy (Bluesky post text, Google News cruft, blotter
# legalese). This background pass sends the newest incidents to Grok in ONE
# batched call to produce a clean headline + one-line "what happened" +
# normalized incident type. Results are cached by incident id, so the API
# response stays fast (no per-request LLM latency).
_INCIDENT_FUSION_CACHE: dict[str, dict[str, Any]] = {}
_FUSION_CACHE_MAX = 400
_fusion_task: Optional[asyncio.Task] = None

_FUSION_SYSTEM = (
    "You are the lead editor for an Albany County, NY police/emergency activity "
    "tracker. You receive raw incident items (messy titles from news, scanner, "
    "social, blotters). For EACH item, produce a clean, factual, scannable entry. "
    "Rules: Ground every word in the provided text — never invent suspects, "
    "charges, locations, or outcomes. Keep the City of Albany vs Albany County "
    "distinction. If the item is not a real Albany County public-safety incident, "
    "set drop=true. Output STRICT JSON only."
)


def _fusion_prompt(items: list[dict]) -> str:
    lines = []
    for it in items:
        lines.append(json.dumps({
            "id": it.get("id"),
            "title": (it.get("short_title") or it.get("title") or "")[:200],
            "desc": (it.get("description") or it.get("summary") or "")[:300],
            "muni": it.get("municipality") or "",
            "source": it.get("source_name") or it.get("source") or "",
        }, ensure_ascii=True))
    return (
        "For each incident below, return a JSON array of objects with keys: "
        "id (echo), headline (<=80 chars, factual, no clickbait), "
        "summary (<=160 chars, what/where/who-if-stated), "
        "incident_type (one of: shooting, stabbing, assault, robbery, burglary, "
        "theft, arrest, crash, fire, missing_person, pursuit, dwi, weapons, "
        "overdose, hazard, weather, police_activity, other), "
        "drop (true if not a real Albany County incident). "
        "Items:\n" + "\n".join(lines)
    )


def _parse_fusion_response(text: str) -> list[dict]:
    if not text:
        return []
    s = text.strip()
    # Strip code fences if the model wrapped the JSON.
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    start = s.find("[")
    end = s.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        arr = json.loads(s[start:end + 1])
        return arr if isinstance(arr, list) else []
    except Exception:
        return []


async def fuse_recent_incidents(limit: int = 15) -> int:
    """Generate clean Grok summaries for the newest un-cached incidents.
    Returns the number of incidents enriched. Safe no-op without an API key."""
    if not XAI_API_KEY:
        return 0
    try:
        items = await query_incidents(limit=limit, sort_by="newest")
    except Exception:
        return 0
    pending = [it for it in items if it.get("id") and it["id"] not in _INCIDENT_FUSION_CACHE]
    if not pending:
        return 0
    pending = pending[:12]  # bound per call
    try:
        content = await call_grok(
            [
                {"role": "system", "content": _FUSION_SYSTEM},
                {"role": "user", "content": _fusion_prompt(pending)},
            ],
            max_tokens=900,
            temperature=0.2,
            timeout=40.0,
        )
    except Exception as exc:
        logger.warning("fusion_grok_error: %s", exc)
        return 0
    parsed = _parse_fusion_response(content or "")
    n = 0
    for obj in parsed:
        iid = obj.get("id")
        if not iid:
            continue
        _INCIDENT_FUSION_CACHE[iid] = {
            "headline": (obj.get("headline") or "").strip()[:120],
            "summary": (obj.get("summary") or "").strip()[:200],
            "incident_type": (obj.get("incident_type") or "").strip().lower(),
            "drop": bool(obj.get("drop")),
        }
        n += 1
    # Evict oldest entries when the cache grows too large.
    if len(_INCIDENT_FUSION_CACHE) > _FUSION_CACHE_MAX:
        for k in list(_INCIDENT_FUSION_CACHE.keys())[: len(_INCIDENT_FUSION_CACHE) - _FUSION_CACHE_MAX]:
            _INCIDENT_FUSION_CACHE.pop(k, None)
    if n:
        logger.info("incident_fusion_enriched count=%d cache=%d", n, len(_INCIDENT_FUSION_CACHE))
    return n


def _apply_fusion(it: dict) -> dict:
    """Overlay cached Grok fusion (clean headline/summary/type) onto an incident."""
    fused = _INCIDENT_FUSION_CACHE.get(it.get("id"))
    if not fused:
        return it
    if fused.get("headline"):
        it["short_title"] = fused["headline"]
        it["_fused"] = True
    if fused.get("summary"):
        it["ai_summary"] = fused["summary"]
    if fused.get("incident_type"):
        it["fused_incident_type"] = fused["incident_type"]
    return it


async def call_grok(
    messages,
    max_tokens=400,
    stream=False,
    temperature=0.35,
    timeout: Optional[float] = None,
):
    body = {
        "model": XAI_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
    }
    t_out = timeout if timeout is not None else (90.0 if stream else 45.0)
    resp = await post_xai_chat(body, timeout=t_out)
    if stream:
        return resp
    if resp.status_code == 200:
        return resp.json()["choices"][0]["message"]["content"]
    return None


def _to_ascii_safe_text(value: str) -> str:
    normalized = value.translate(ASCII_PUNCT_TRANSLATION)
    normalized = unicodedata.normalize("NFKD", normalized)
    return normalized.encode("ascii", "ignore").decode("ascii")


def _to_ascii_safe_json(value: Any) -> Any:
    if isinstance(value, str):
        return _to_ascii_safe_text(value)
    if isinstance(value, list):
        return [_to_ascii_safe_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_ascii_safe_json(item) for key, item in value.items()}
    return value


async def post_xai_chat(body: dict, timeout: float = 20.0):
    headers = {
        "Authorization": f"Bearer {XAI_API_KEY}",
        "Content-Type": "application/json",
    }
    safe_body = _to_ascii_safe_json(body)
    payload = json.dumps(safe_body, ensure_ascii=True).encode("ascii")
    return await http_client.post(
        f"{XAI_BASE}/chat/completions",
        headers=headers,
        content=payload,
        timeout=timeout,
    )


SITUATION_SYSTEM = (
    "Albany County, NY Crime Tracker — lead analyst. Geography: City of Albany + Albany County towns/villages "
    "(Colonie, Guilderland, Bethlehem, Cohoes, Watervliet, etc.) only; reject other 'Albany' cities.\n"
    "Rules: Ground every claim in the incident lines; no invented suspects/charges. Prefer specific place names. "
    "threat_level = low|moderate|elevated|high from verified severity + recency only. "
    "confidence = high|medium|low from source mix (official > local media > scanner).\n"
    "Output one JSON object only: {\"situation\":\"...\",\"threat_level\":\"...\",\"confidence\":\"...\"} — no markdown or extra text."
)


async def generate_situation_report(crime_data, patterns):
    cache_key = "ai_summaries"
    cached = get_cached(cache_key)
    if cached:
        return cached

    if not crime_data:
        return {
            "situation": "No recent crime reports to analyze for Albany County, NY.",
            "threat_level": "low",
            "confidence": "low",
        }

    # Live rows: preserve /api/crimes order (presentation tier + freshness sort).
    live_rows = [a for a in crime_data if a.get("feed_tab") == "live"]
    other_rows = [a for a in crime_data if a.get("feed_tab") != "live"]
    context_pool = live_rows[:18] + other_rows[:8]

    context_lines = []
    for a in context_pool[:22]:
        conf = a.get("confidence", 0.7)
        conf_label = "HIGH" if conf >= 0.90 else "MEDIUM" if conf >= 0.75 else "LOW"
        reliability = get_source_reliability(a.get("source", ""))
        src = a.get("source", "Unknown")
        loc = a.get("matched_location", "")
        tab = a.get("feed_tab", "?")
        line = f"- [Tab:{tab}|Conf:{conf_label}|Rel:{reliability:.0%}] [{src}] {a['title']}"
        if loc:
            line += f" (Location: {loc})"
        context_lines.append(line)

    pattern_ctx = ""
    if patterns.get("hotspots"):
        top_hoods = [h["neighborhood"] for h in patterns["hotspots"][:3]]
        pattern_ctx = f"\nMost active areas: {', '.join(top_hoods)}"
    type_b = patterns.get("type_breakdown", {})
    pattern_ctx += (
        f"\nViolent: {type_b.get('violent', 0)}, "
        f"Property: {type_b.get('property', 0)}, "
        f"Other: {type_b.get('other', 0)}"
    )

    prompt = f"""Live situation brief for Albany County, NY — dashboard users expect a pulse of *right now*.

Input: Live-tab-heavy incident lines (Tab:live first), then News, each tagged Conf/Rel/source; plus pattern counts.
1) Drop non-local noise (wrong Albany, no NY anchor).
2) Prioritize freshest items from the last 12 hours, especially critical scanner traffic, official X posts, Nixle alerts, and verified blotter entries.
3) Never stitch uncertain mixed-source incidents into one confirmed narrative. If signals are mixed, summarize conservatively as multiple incidents of note.
4) situation: ONE dense sentence (max 32 words) — blend official + scanner + blotter themes, name geography where data supports it.
5) threat_level + confidence per system rules.

{chr(10).join(context_lines)}
{pattern_ctx}

JSON only: {{"situation":"...","threat_level":"...","confidence":"..."}}"""

    try:
        result = await call_grok(
            [
                {"role": "system", "content": SITUATION_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            max_tokens=500,
            temperature=0.25,
            timeout=55.0,
        )

        if result:
            json_match = re.search(r'\{[^{}]*"situation"[^{}]*\}', result, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                set_cached(cache_key, parsed)
                return parsed
    except Exception as e:
        print(f"AI situation error: {e}")

    return {
        "situation": "AI analysis temporarily unavailable.",
        "threat_level": "unknown",
        "confidence": "low",
    }


def _conservative_situation_report(crime_data: list[dict], patterns: dict[str, Any]) -> dict[str, str]:
    """Fast deterministic fallback: avoid stitched narratives across unrelated incidents."""
    total = int(patterns.get("total", 0) or 0)
    type_b = patterns.get("type_breakdown", {}) or {}
    violent = int(type_b.get("violent", 0) or 0)
    prop = int(type_b.get("property", 0) or 0)
    other = int(type_b.get("other", 0) or 0)
    recent_48h = int(patterns.get("recent_48h", 0) or 0)

    if total <= 0:
        return {
            "situation": "No recent incidents of note across Albany County in the current feed window.",
            "threat_level": "low",
            "confidence": "medium",
        }

    top_type = "other"
    top_count = other
    if violent >= prop and violent >= other:
        top_type, top_count = "violent", violent
    elif prop >= violent and prop >= other:
        top_type, top_count = "property", prop

    mixed = sum(1 for n in (violent, prop, other) if n > 0) >= 2
    confidences = [
        float(c.get("confidence"))
        for c in crime_data
        if isinstance(c.get("confidence"), (int, float))
    ]
    avg_conf = (sum(confidences) / len(confidences)) if confidences else 0.0

    if mixed or avg_conf < 0.78:
        situation = (
            f"{total} incidents of note are in the current Albany County feed "
            f"({recent_48h} reported in the last 48 hours). Sources are mixed; treat cards as separate events."
        )
    else:
        situation = (
            f"{total} incidents of note are in the current Albany County feed, led by {top_count} "
            f"{top_type} reports ({recent_48h} in the last 48 hours)."
        )

    threat = "low"
    if violent >= 4 or recent_48h >= 12:
        threat = "elevated"
    elif violent >= 2 or recent_48h >= 6 or total >= 10:
        threat = "moderate"

    confidence = "high" if avg_conf >= 0.86 else "medium" if avg_conf >= 0.72 else "low"
    return {"situation": situation, "threat_level": threat, "confidence": confidence}


async def _refresh_situation_ai_cache(crime_data: list[dict], patterns: dict[str, Any]) -> None:
    global _AI_SITUATION_REFRESH_IN_FLIGHT
    if _AI_SITUATION_REFRESH_IN_FLIGHT:
        return
    _AI_SITUATION_REFRESH_IN_FLIGHT = True
    try:
        await generate_situation_report(crime_data, patterns)
    except Exception as e:
        print(f"AI situation background refresh error: {e}")
    finally:
        _AI_SITUATION_REFRESH_IN_FLIGHT = False


# =============================================================================
# NYSP TROOP G BLOTTER PDF SCRAPER
# https://publicapps.troopers.ny.gov/Media_Reports/
# =============================================================================

_NYSP_BLOTTER_BASE = "https://publicapps.troopers.ny.gov/media/TroopG/"
_NYSP_DAY_ABBREVS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_NYSP_ZONES = [1, 2, 3, 4]

# Albany County municipalities for matching NYSP blotter locations
_NYSP_ALBANY_LOCALITIES = {
    "albany", "cohoes", "watervliet", "colonie", "bethlehem", "guilderland",
    "coeymans", "new scotland", "berne", "knox", "rensselaerville", "westerlo",
    "green island", "menands", "delmar", "latham", "loudonville", "ravena",
    "voorheesville", "altamont", "slingerlands", "selkirk", "elsmere",
    "glenmont", "clarksville", "feura bush", "medusa",
    "east berne", "newtonville", "westmere", "mckownville",
}

_NYSP_LIGATURE_BYTE = "\x00"

_NYSP_HEADER_RE = re.compile(
    r"New\s+York\s+State\s+Police\s+Public\s+Information\s+Report"
    r".*?TAX\s+(?:[-–]\s*)?Tax\s+Law\s*",
    re.IGNORECASE | re.DOTALL,
)
_NYSP_FILEPATH_RE = re.compile(r"file:///\S+\s*\d+/\d+")
_NYSP_CREATION_RE = re.compile(
    r"Creation\s+Date:.*?Page\s+\d+\s+of\s+\d+",
    re.IGNORECASE | re.DOTALL,
)
_NYSP_DASHES_RE = re.compile(r"-{10,}")
_NYSP_BLOCK_SPLIT_RE = re.compile(
    r"(?=Incident\s+Information:\s*Incident\s+Number:\s*NY)",
    re.IGNORECASE,
)


def _nysp_blotter_urls_for_window(days_back: int = 2) -> list[str]:
    """Build PDF URLs for the last `days_back` days, all zones."""
    urls = []
    now = datetime.now(timezone.utc)
    for d in range(days_back):
        dt = now - timedelta(days=d)
        day_name = _NYSP_DAY_ABBREVS[dt.weekday()]
        for z in _NYSP_ZONES:
            urls.append(f"{_NYSP_BLOTTER_BASE}Media{day_name}{z}.pdf")
    return urls


def _clean_nysp_pdf_text(text: str) -> str:
    """Strip headers, footers, OCR artefacts, and file-path noise from NYSP PDF text."""
    if not text:
        return ""
    text = text.replace(_NYSP_LIGATURE_BYTE, "ti")
    text = _NYSP_HEADER_RE.sub("", text)
    text = _NYSP_FILEPATH_RE.sub("", text)
    text = _NYSP_CREATION_RE.sub("", text)
    text = _NYSP_DASHES_RE.sub("", text)
    text = re.sub(r"NYSP Law Categories:\s*", "", text, flags=re.I)
    text = re.sub(r"Law Title Codes:\s*", "", text, flags=re.I)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_nysp_fields(block: str) -> dict[str, Any]:
    """Extract structured fields from a single NYSP incident block."""
    f: dict[str, Any] = {}

    def _get(pattern: str, text: str = block, flags: int = re.I | re.S) -> str:
        m = re.search(pattern, text, flags)
        return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""

    f["incident_number"] = _get(r"Incident\s+Number:\s*(NY\w+)")
    f["incident_category"] = _get(
        r"Incident\s+Category:\s*(.+?)(?=\s*(?:Date/Time|Incident\s+(?:Number|Type|Status|Information))\b|$)"
    )
    f["date_time_reported"] = _get(
        r"Date/Time\s+Reported:\s*(.+?)(?=\s+Station:)"
    )
    f["station"] = _get(r"(?<!\bof )Station:\s*(.+?)(?=\n|Location\s+Code:)")
    f["location_code"] = _get(r"Location\s+Code:\s*(.+?)(?=\s*Incident\s+Status:)")
    f["incident_status"] = _get(
        r"Incident\s+Status:\s*(.+?)(?=\n|Defendant|Driver|Arrest\s+Information|Incident\s+Information|$)"
    )

    f["defendant_name"] = _get(r"Defendant\s*\(\d+\)\s*Name:\s*(.+?)(?=\s+Age:)")
    f["defendant_age"] = _get(r"Defendant\s*\(\d+\)\s*Name:.*?Age:\s*(\d+)")
    f["arrestee_status"] = _get(
        r"Arrestee\s+Status:\s*(.+?)(?=\n|Location\s+of|Bail|$)"
    )

    f["num_vehicles"] = _get(r"Number\s+of\s+Vehicles:\s*(\d+)")
    f["num_killed"] = _get(r"Number\s+Killed:\s*(\d+)")
    f["num_injured"] = _get(r"Number\s+Injured:\s*(\d+)")
    f["road"] = _get(r"Road/Highway:\s*(.+?)(?=\n|Intersection|$)")

    charges: list[str] = []
    for cm in re.finditer(
        r"(?:PL|VTL|ECL|PHL|NAV|ABC|FCA|PRL|TL|AM)\s+\S+\s+\S+\s+\S\s+"
        r"(Misdemeanor|Felony|Violation|Infraction)\s+(.+?)\s+\d+\s*$",
        block,
        re.I | re.M,
    ):
        charges.append(f"{cm.group(2).strip()} ({cm.group(1)})")
    f["charges"] = charges
    return f


def _parse_nysp_datetime(raw: str) -> Optional[datetime]:
    """Parse NYSP date/time strings in the formats found in blotter PDFs."""
    if not raw:
        return None
    raw = raw.strip()
    for fmt in (
        "%B %d, %Y %I:%M %p",
        "%B %d, %Y %H:%M",
        "%B %d, %Y %I:%M%p",
        "%m/%d/%Y %I:%M %p",
        "%m/%d/%Y %H:%M",
        "%m/%d/%y %I:%M %p",
        "%m/%d/%y %H:%M",
    ):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _extract_nysp_municipality(location_code: str) -> str:
    """Extract municipality name from location codes like 'TOWN - NASSAU - 4255'."""
    if not location_code:
        return "Albany County"
    m = re.match(
        r"(?:TOWN|CITY|VILLAGE|HAMLET)\s*[-–]\s*(.+?)\s*[-–]\s*\d+",
        location_code,
        re.I,
    )
    if m:
        return m.group(1).strip().title()
    return "Albany County"


def _nysp_severity(category: str, status: str, fields: dict) -> str:
    """Map NYSP incident category + status to ACT severity."""
    cat = category.lower()
    st = status.lower()
    arr_st = (fields.get("arrestee_status") or "").lower()
    desc_blob = (cat + " " + st + " " + " ".join(str(c) for c in fields.get("charges", []))).lower()
    closed = "closed" in st or "cleared" in st

    if any(w in desc_blob for w in ("homicide", "murder", "fatal")):
        return "critical"
    killed = fields.get("num_killed", "0")
    if killed and killed != "0":
        return "critical"

    is_arrest = "arrest" in st or bool(arr_st)
    has_violent_cat = any(w in cat for w in (
        "assault", "robbery", "weapons", "sex offense",
        "menacing", "death", "shooting", "stabbing",
    ))

    if has_violent_cat and not closed:
        return "high"
    if "felony" in desc_blob:
        return "high"
    if has_violent_cat and closed:
        return "medium"

    if is_arrest:
        return "medium"

    injured = fields.get("num_injured", "0")
    if injured and injured != "0":
        return "medium"

    return "low"


def _nysp_crime_type(category: str) -> str:
    """Map NYSP category to ACT crime_type."""
    cat = category.lower()
    if any(w in cat for w in (
        "assault", "robbery", "weapons", "sex offense", "menacing",
        "domestic", "harassment", "death", "kidnap",
    )):
        return "violent"
    if any(w in cat for w in (
        "larceny", "burglary", "property", "forgery", "fraud",
        "identity theft", "trespass", "criminal mischief",
    )):
        return "property"
    if any(w in cat for w in ("dwi", "dui", "dwai", "accident", "vehicle", "road")):
        return "traffic"
    if any(w in cat for w in ("drug", "narcotic")):
        return "drugs"
    return "other"


def _build_nysp_title(category: str, status: str, municipality: str, fields: dict) -> str:
    """Build a concise, noise-free title for an NYSP blotter incident."""
    cat = category.lower()
    st = status.lower()
    arr_st = (fields.get("arrestee_status") or "").lower()
    is_arrest = "arrest" in st or bool(arr_st)

    if any(w in cat for w in ("dwi", "dui", "dwai")) and is_arrest:
        label = "NYSP DWI Arrest"
    elif is_arrest:
        label = f"NYSP Arrest: {category}"
    else:
        label = f"NYSP: {category}"

    if municipality and municipality != "Albany County":
        label = f"{label} — {municipality}"
    return label[:200]


def _build_nysp_description(fields: dict) -> str:
    """Build a clean, structured description from parsed incident fields."""
    parts: list[str] = []

    cat = fields.get("incident_category", "")
    if cat:
        parts.append(cat)

    st = fields.get("incident_status", "")
    if st:
        parts.append(f"Status: {st}")

    station = fields.get("station", "")
    if station:
        parts.append(f"Station: {station}")

    defendant = fields.get("defendant_name", "")
    if defendant:
        age = fields.get("defendant_age", "")
        age_str = f", age {age}" if age else ""
        parts.append(f"Defendant: {defendant}{age_str}")

    arr_status = fields.get("arrestee_status", "")
    if arr_status:
        parts.append(f"Arrestee status: {arr_status}")

    charges = fields.get("charges", [])
    if charges:
        parts.append("Charges: " + "; ".join(charges[:3]))

    nv = fields.get("num_vehicles", "")
    if nv:
        detail = f"{nv} vehicle(s)"
        nk = fields.get("num_killed", "0")
        ni = fields.get("num_injured", "0")
        if nk and nk != "0":
            detail += f", {nk} killed"
        if ni and ni != "0":
            detail += f", {ni} injured"
        parts.append(detail)

    road = fields.get("road", "")
    if road:
        parts.append(f"Road: {road}")

    return ". ".join(parts)[:500]


def _parse_nysp_blotter_pdf(pdf_bytes: bytes, pdf_url: str) -> list[dict]:
    """Extract incidents from a NYSP Public Information Report PDF."""
    try:
        import pdfplumber
    except ImportError:
        logger.warning("pdfplumber not installed — skipping NYSP blotter PDF parsing")
        return []

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            raw_pages = [p.extract_text() or "" for p in pdf.pages]
    except Exception as e:
        logger.warning("nysp_pdf_parse_error url=%s error=%s", pdf_url, e)
        return []

    full_text = _clean_nysp_pdf_text("\n".join(raw_pages))
    if not full_text:
        return []

    troop_zone = ""
    m_tz = re.search(r"Troop:\s*(\w+)\s+Zone:\s*(\d+)", full_text, re.I)
    if m_tz:
        troop_zone = f"Troop {m_tz.group(1)}, Zone {m_tz.group(2)}"

    date_range = ""
    m_dr = re.search(
        r"(\w+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)"
        r"\s*[-–]\s*"
        r"(\w+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)",
        full_text,
        re.I,
    )
    if not m_dr:
        m_dr = re.search(
            r"(\d{1,2}/\d{1,2}/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)"
            r"\s*[-–]\s*"
            r"(\d{1,2}/\d{1,2}/\d{2,4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)",
            full_text,
            re.I,
        )
    if m_dr:
        date_range = m_dr.group(0).strip()

    blocks = _NYSP_BLOCK_SPLIT_RE.split(full_text)
    items: list[dict] = []

    for block in blocks:
        block = block.strip()
        if len(block) < 30:
            continue

        fields = _extract_nysp_fields(block)
        inc_number = fields.get("incident_number", "")
        if not inc_number:
            continue

        category = fields.get("incident_category", "")
        status = fields.get("incident_status", "")
        location_code = fields.get("location_code", "")
        municipality = _extract_nysp_municipality(location_code)

        incident_dt = _parse_nysp_datetime(fields.get("date_time_reported", ""))
        if not incident_dt and m_dr:
            incident_dt = _parse_nysp_datetime(m_dr.group(1))
        if not incident_dt:
            incident_dt = datetime.now(timezone.utc)

        check_text = f"{location_code} {municipality} {fields.get('station', '')}".lower()
        is_albany = any(loc in check_text for loc in _NYSP_ALBANY_LOCALITIES)
        if not is_albany:
            is_albany = "albany" in check_text or "troop g" in troop_zone.lower()

        title = _build_nysp_title(category, status, municipality, fields)
        description = _build_nysp_description(fields)
        sev = _nysp_severity(category, status, fields)
        crime_type = _nysp_crime_type(category)

        item = {
            "title": title,
            "description": description,
            "link": pdf_url,
            "pubDate": format_datetime(incident_dt),
            "guid": f"nysp-{inc_number}",
            "source": "NYSP Troop G Blotter",
            "source_type": "official",
            "source_name": "NYSP Troop G Blotter",
            "source_priority": 5,
            "_feed_reliability": 1.0,
            "verification_level": "official",
            "verification_label": "Official",
            "severity": sev,
            "crime_type": crime_type,
            "municipality": municipality,
            "matched_location": municipality,
            "_nysp_troop_zone": troop_zone,
            "_nysp_date_range": date_range,
            "_nysp_pdf_url": pdf_url,
            "_nysp_incident_number": inc_number,
            "_nysp_incident_category": category,
            "_nysp_station": fields.get("station", ""),
            "_nysp_incident_status": status,
        }
        items.append(item)

    logger.info("nysp_blotter_parsed url=%s incidents=%d", pdf_url, len(items))
    return items


async def fetch_nysp_blotter_pdfs() -> list[dict]:
    """Fetch and parse NYSP Troop G blotter PDFs for the last 3 days.
    Extended to 3 days because blotters are not always posted on time."""
    all_items: list[dict] = []
    urls = _nysp_blotter_urls_for_window(days_back=3)
    logger.info("nysp_blotter_fetching urls=%d", len(urls))

    async def _fetch_one(url: str) -> list[dict]:
        try:
            resp = await fetch_with_retry(
                http_client,
                url,
                timeout=20.0,
                retries=1,
            )
            if resp and resp.status_code == 200:
                ct = (resp.headers.get("content-type") or "").lower()
                if "pdf" in ct or url.endswith(".pdf"):
                    return _parse_nysp_blotter_pdf(resp.content, url)
            elif resp and resp.status_code == 404:
                pass  # Expected — not all day/zone combos exist
            else:
                logger.debug("nysp_blotter_non200 url=%s status=%s", url, resp.status_code if resp else "none")
        except Exception as e:
            logger.debug("nysp_blotter_fetch_error url=%s error=%s", url, e)
        return []

    results = await asyncio.gather(*[_fetch_one(u) for u in urls])
    for batch in results:
        all_items.extend(batch)

    logger.info("nysp_blotter_total_items=%d", len(all_items))
    return all_items


# =============================================================================
# OFFICIAL SOURCES FETCHER
# =============================================================================
async def fetch_official_sources() -> list:
    """
    Fetch from official police X/Twitter accounts (via nitter RSS),
    department blotters, and Nixle alerts. Returns a list of article dicts
    pre-tagged with source_priority=4 and the official label.

    This is called as part of fetch_all_feeds() — the results are merged
    into the main feed and sorted to the top of the Live tab.

    Sources tried:
      • Nitter RSS for @albanypolice, @ACSOTWEET, @colonie_police,
        @PdBethlehem, @nyspolice (best-effort; fails gracefully)
      • Google News targeted searches for each department (reliable backbone)
      • NYSP troopers.ny.gov RSS
      • Nixle Albany County alerts
      • Daily Gazette crime blotter
    """
    results = []
    async def _fetch(key, cfg):
        url = cfg["url"]
        is_gnews = "news.google.com" in url
        if is_gnews and _check_gnews_blocked(url):
            return []
        try:
            timeout = cfg.get("timeout", 15)
            resp = await fetch_with_retry(
                http_client,
                url,
                timeout=float(timeout),
                retries=1 if is_gnews else settings.external_retry_attempts,
            )
            if resp and resp.status_code == 200:
                parsed = parse_rss(
                    resp.text,
                    default_source=(None if is_gnews else cfg.get("label")),
                )
                for a in parsed:
                    rel = float(cfg.get("reliability", 0.97))
                    prio = 4
                    if is_gnews:
                        rel = min(rel, 0.78)
                        prio = min(prio, 2)
                    a["_feed_reliability"] = rel
                    a["source_priority"] = prio
                    if cfg.get("force_label") and cfg.get("label") and not is_gnews:
                        a["source"] = cfg["label"]
                    elif is_gnews and cfg.get("label"):
                        a["_query_label"] = cfg["label"]
                filter_mode = cfg.get("filter")
                if filter_mode in ("strict", "albany"):
                    pass
                elif filter_mode == "crime":
                    parsed = [a for a in parsed if any(
                        kw in (a.get("title","") + " " + a.get("description","")).lower()
                        for kw in CRIME_KEYWORDS
                    )]
                return parsed
            if is_gnews and resp and resp.status_code in (403, 429, 503):
                _check_gnews_blocked(url, resp.status_code)
        except Exception as e:
            if not (is_gnews and _check_gnews_blocked(url)):
                logger.warning("official_feed_error key=%s error=%s", key, e)
        return []

    tasks = [_fetch(k, v) for k, v in RSS_FEEDS_OFFICIAL.items()]
    batches = await asyncio.gather(*tasks)
    for batch in batches:
        results.extend(batch)
    return results


# =============================================================================
# UNIFIED FEED FETCHER
# =============================================================================
async def fetch_all_feeds(strict_live_sources: bool = False):
    global _GEO_FILTER_STATS
    articles = []

    async def fetch_one(key, cfg):
        url = cfg["url"]
        is_gnews = "news.google.com" in url
        if is_gnews and _check_gnews_blocked(url):
            return []
        try:
            # Google News blocks datacenter IPs that burst with a bot UA.
            # Use a browser UA + throttle concurrency so we stay under its
            # rate limit (the root cause of the recurring "feed stale" gaps).
            req_headers = None
            if is_gnews:
                req_headers = {
                    "User-Agent": _GNEWS_BROWSER_UA,
                    "Accept": "application/rss+xml, application/xml, text/xml, */*",
                    "Accept-Language": "en-US,en;q=0.9",
                }
            if is_gnews:
                async with _GNEWS_SEMAPHORE:
                    resp = await fetch_with_retry(
                        http_client,
                        url,
                        timeout=settings.external_timeout_seconds,
                        retries=1,
                        headers=req_headers,
                    )
                    # Small spacing between GNews hits to avoid burst-detection.
                    await asyncio.sleep(0.25)
            else:
                resp = await fetch_with_retry(
                    http_client,
                    url,
                    timeout=settings.external_timeout_seconds,
                    retries=settings.external_retry_attempts,
                )
            if resp and resp.status_code == 200:
                parsed = parse_rss(
                    resp.text,
                    default_source=(None if is_gnews else cfg.get("label")),
                )

                feed_reliability = float(cfg.get("reliability", 0.70))
                feed_priority = int(cfg.get("priority", 1))
                if is_gnews:
                    feed_reliability = min(feed_reliability, 0.78)
                    feed_priority = min(feed_priority, 2)
                _rss_source_class = "rss_gnews" if is_gnews else "rss_local_news"
                for a in parsed:
                    if not a.get("_feed_reliability"):
                        a["_feed_reliability"] = feed_reliability
                    a["source_priority"] = max(a.get("source_priority", 0), feed_priority)
                    if cfg.get("force_label") and cfg.get("label") and not is_gnews:
                        a["source"] = cfg["label"]
                    elif is_gnews and cfg.get("label"):
                        a["_query_label"] = cfg["label"]
                    if "provenance" not in a:
                        a["provenance"] = _build_incident_provenance(
                            source_class=_rss_source_class,
                            source_id=key,
                            trust_tier=cfg.get("trust_tier", "tier_3"),
                            lane=cfg.get("lane", "developing_incidents"),
                            ingestion_method="rss_poll",
                            feed_url=url,
                            captured_at=datetime.now(timezone.utc).isoformat(),
                            content_type="rss_item",
                            capture_method="rss_poll",
                        )
                if cfg.get("tag_511"):
                    for a in parsed:
                        a["_511_incident"] = True
                if cfg.get("tag_ny_alert"):
                    for a in parsed:
                        a["_ny_alert"] = True

                filter_mode = cfg.get("filter")
                if filter_mode in ("strict", "albany"):
                    pass
                elif filter_mode == "crime":
                    def has_crime_kw(a):
                        t = (a.get("title","") + " " + a.get("description","")).lower()
                        return any(kw in t for kw in CRIME_KEYWORDS)
                    parsed = [a for a in parsed if has_crime_kw(a)]
                elif filter_mode is None:
                    pass

                return parsed
            if is_gnews and resp and resp.status_code in (403, 429, 503):
                _check_gnews_blocked(url, resp.status_code)
        except Exception as e:
            if not (is_gnews and _check_gnews_blocked(url)):
                logger.warning("feed_fetch_error key=%s error=%s", key, e)
        return []

    all_feeds = {
        **RSS_FEEDS_LOCAL,
        **RSS_FEEDS_GNEWS,
        **RSS_FEEDS_OFFICIAL,
        **build_directory_rss_feeds(),
        **build_operational_rss_feeds(),
    }
    tasks = [fetch_one(key, cfg) for key, cfg in all_feeds.items()]
    results = await asyncio.gather(*tasks)

    for feed_articles in results:
        articles.extend(feed_articles)

    # Real-time layers from directory + OpenMHz / Nixle / Bluesky / Grok mirrors (parallel)
    _extra_batches = await asyncio.gather(
        fetch_nixle_directory_articles(),
        # fetch_official_social_posts(),
        # fetch_nitter_official_x_rss_posts(),
        fetch_scanner_directory_items(),
        fetch_tier1_sources(limit_per_source=80, strict_live_sources=strict_live_sources),
        fetch_nysp_blotter_pdfs(),
        fetch_bluesky_posts(limit_per_account=20),
        fetch_nws_alerts(limit=25),
        return_exceptions=True,
    )
    for batch in _extra_batches:
        if isinstance(batch, Exception):
            if strict_live_sources:
                raise batch
            logger.warning("live_feed_extra_batch_error error=%s", batch)
            continue
        articles.extend(batch)

    _GEO_FILTER_STATS = {"accepted": 0, "rejected": 0, "reasons": {}}
    articles = [a for a in articles if is_albany_related(a)]
    # Reject digest/newsletter/roundup URLs — these re-surface OLD stories with
    # a fresh send-date, making 2-month-old articles appear as current events
    # (e.g. a CBS6 "newsletter-daily" link to an April shooting showing in June).
    before_digest = len(articles)
    articles = [a for a in articles if not _is_digest_url(a.get("link", ""))]
    if before_digest != len(articles):
        logger.info("digest_url_filtered removed=%d", before_digest - len(articles))
    # Freshness guard: drop anything whose pubDate is older than the hard
    # max-age window even if a feed handed it a misleading recent date.
    articles = [a for a in articles if _pubdate_within_max_age(a)]

    def _norm_link(u: str) -> str:
        return (u or "").strip().lower().split("?")[0].rstrip("/")

    # Collapse exact same URL (Google News / syndication) — keep highest source_priority
    _by_link: dict[str, dict] = {}
    _no_link: list[dict] = []
    for a in articles:
        lk = _norm_link(a.get("link", "") or "")
        if not lk:
            _no_link.append(a)
            continue
        prev = _by_link.get(lk)
        if prev is None or a.get("source_priority", 0) > prev.get("source_priority", 0):
            _by_link[lk] = a
    articles = list(_by_link.values()) + _no_link

    def _pub_ts_pre(a: dict) -> float:
        try:
            dt = parsedate_to_datetime(a.get("pubDate", "") or "")
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except Exception:
            return 0.0

    # ── Smart deduplication ──────────────────────────────────────────────────
    # Newest first, then operational layers — so dedupe groups see fresh scanner/Nixle before stale social.
    def _dedup_presort_key(a: dict) -> tuple:
        pub = _pub_ts_pre(a)
        op = 0
        if a.get("_scanner_call"):
            op = 3
        elif a.get("_nixle_item"):
            op = 2
        elif a.get("_official_x_post"):
            op = 1
        return (op, pub)

    articles.sort(key=_dedup_presort_key, reverse=True)

    _STOP = frozenset({
        "the","a","an","in","on","at","to","of","and","or","for","is","was",
        "after","with","man","woman","police","albany","county","new","york",
        "one","two","three","that","this","from","his","her","they","were",
    })

    _MAX_COMBINED_SOURCES = 8

    # Phrase → canonical bucket for "same incident" merge (2+ shared buckets within 8 h).
    _CRITICAL_MERGE_TAGS = [
        ("shooting", "shooting"),
        ("shot and killed", "shooting"),
        ("shots fired", "shooting"),
        ("stabbing", "stabbing"),
        ("stabbed", "stabbing"),
        ("arrested", "arrest"),
        ("arrest made", "arrest"),
        ("suspect arrested", "arrest"),
        ("man arrested", "arrest"),
        ("woman arrested", "arrest"),
        ("person arrested", "arrest"),
        ("charged with", "charged"),
        ("faces charges", "charged"),
        ("facing charges", "charged"),
        ("taken into custody", "custody"),
        ("in custody", "custody"),
        ("pursuit", "pursuit"),
        ("high-speed chase", "pursuit"),
        ("vehicle pursuit", "pursuit"),
        ("foot pursuit", "pursuit"),
        ("chase", "chase"),
        ("standoff", "standoff"),
        ("barricaded", "standoff"),
        ("officer-involved", "officer"),
        ("officer involved", "officer"),
        ("officer", "officer"),
    ]

    def _norm_title(t: str) -> str:
        return re.sub(r"\s+", " ", (t or "").lower()).strip()

    def _title_sequence_ratio(ta: str, tb: str) -> float:
        a, b = _norm_title(ta), _norm_title(tb)
        if not a or not b:
            return 0.0
        return SequenceMatcher(None, a, b).ratio()

    def _title_words(t: str) -> frozenset:
        norm = re.sub(r"[^a-z0-9]", " ", t.lower())
        return frozenset(norm.split()) - _STOP

    def _similarity(a: str, b: str) -> float:
        wa, wb = _title_words(a), _title_words(b)
        if not wa or not wb:
            return 0.0
        inter = len(wa & wb)
        union = len(wa | wb)
        return inter / union if union else 0.0

    def _hours_apart(a: dict, b: dict) -> Optional[float]:
        try:
            da = parsedate_to_datetime(a.get("pubDate", ""))
            db = parsedate_to_datetime(b.get("pubDate", ""))
            if da.tzinfo is None:
                da = da.replace(tzinfo=timezone.utc)
            if db.tzinfo is None:
                db = db.replace(tzinfo=timezone.utc)
            return abs((da - db).total_seconds()) / 3600
        except Exception:
            return None

    def _combined_words(article: dict) -> frozenset:
        title = article.get("title", "") or ""
        desc = (article.get("description", "") or "")[:400]
        return _title_words(title + " " + desc)

    def _critical_merge_tags(full_text: str) -> frozenset:
        t = (full_text or "").lower()
        found: set[str] = set()
        for needle, tag in _CRITICAL_MERGE_TAGS:
            if needle in t:
                found.add(tag)
        return frozenset(found)

    def _same_incident(art: dict, rep: dict) -> bool:
        """Same story if titles match strongly OR shared critical incident signals in time window."""
        t1 = art.get("title", "") or ""
        t2 = rep.get("title", "") or ""
        full_a = (t1 + " " + (art.get("description", "") or ""))[:1200]
        full_b = (t2 + " " + (rep.get("description", "") or ""))[:1200]
        hrs = _hours_apart(art, rep)
        op_a = bool(art.get("_scanner_call") or art.get("_nixle_item") or art.get("_official_x_post"))
        op_b = bool(rep.get("_scanner_call") or rep.get("_nixle_item") or rep.get("_official_x_post"))
        op_pair = op_a and op_b

        la = _norm_link(art.get("link", "") or "")
        lb = _norm_link(rep.get("link", "") or "")
        if la and lb and la == lb:
            return True
        ga = _norm_link(str(art.get("guid", "") or ""))
        gb = _norm_link(str(rep.get("guid", "") or ""))
        if ga and gb and ga == gb:
            return True

        sta = art.get("_scanner_tg")
        strp = rep.get("_scanner_tg")
        if sta and strp and str(sta) == str(strp) and hrs is not None and hrs <= 1.5:
            if _title_sequence_ratio(t1, t2) >= 0.45 or _similarity(t1, t2) >= 0.45:
                return True

        if _norm_title(t1) == _norm_title(t2) and hrs is not None and hrs <= 6.0:
            if (
                art.get("_scanner_critical_live")
                or rep.get("_scanner_critical_live")
                or art.get("_scanner_recent_live")
                or rep.get("_scanner_recent_live")
            ):
                return True

        if _title_sequence_ratio(t1, t2) >= 0.85:
            return True

        jac_title = _similarity(t1, t2)
        if jac_title >= 0.85:
            return True

        wa_full = _combined_words(art)
        wb_full = _combined_words(rep)
        if wa_full and wb_full:
            inter = len(wa_full & wb_full)
            union = len(wa_full | wb_full)
            jac_full = inter / union if union else 0.0
            if jac_full >= 0.85:
                return True

        ca = _critical_merge_tags(full_a)
        cb = _critical_merge_tags(full_b)
        shared = ca & cb
        if len(shared) >= 2 and hrs is not None and hrs <= 8.0:
            return True

        if (not op_pair) and jac_title >= 0.65 and len(shared) >= 1 and hrs is not None and hrs <= 6.0:
            return True

        if (not op_pair) and jac_title >= 0.55 and hrs is not None and hrs <= 4.0:
            return True

        w1, w2 = _title_words(t1), _title_words(t2)
        if w1 and w2 and hrs is not None and hrs <= 12.0:
            tw = len(w1 & w2)
            if (not op_pair) and _title_sequence_ratio(t1, t2) >= 0.52 and tw >= 4:
                return True

        return False

    def _source_norm_key(src: str) -> str:
        return re.sub(r"\s+", " ", (src or "").strip().lower())

    groups: list[dict] = []

    for art in articles:
        placed = False
        for grp in groups:
            if _same_incident(art, grp["rep"]):
                if _dedup_should_replace_rep(grp["rep"], art):
                    old_rep = grp["rep"]
                    grp["rep"] = art
                    old_s = old_rep.get("source", "")
                    if old_s:
                        sko = _source_norm_key(old_s)
                        if sko and sko not in grp["_source_keys"]:
                            grp["_source_keys"].add(sko)
                            grp["sources"].append(old_s)
                src = art.get("source", "")
                if src:
                    sk = _source_norm_key(src)
                    if sk and sk not in grp["_source_keys"]:
                        grp["_source_keys"].add(sk)
                        grp["sources"].append(src)
                placed = True
                break
        if not placed:
            grp_sources = []
            s = art.get("source", "")
            sk_set: set[str] = set()
            if s:
                grp_sources.append(s)
                sk_set.add(_source_norm_key(s))
            groups.append({"rep": art, "sources": grp_sources, "_source_keys": sk_set})

    deduped = []
    for grp in groups:
        rep = grp["rep"]
        rep["sources"] = grp["sources"][:_MAX_COMBINED_SOURCES]
        deduped.append(rep)

    def _pub_ts_final(a: dict) -> float:
        try:
            dt = parsedate_to_datetime(a.get("pubDate", "") or "")
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except Exception:
            return 0.0

    # Pipeline order: newest operational items first (Live scoring happens in /api/crimes).
    def _post_dedup_key(a: dict) -> tuple:
        pub = _pub_ts_final(a)
        op = 0
        if a.get("_scanner_call"):
            op = 3
        elif a.get("_nixle_item"):
            op = 2
        elif a.get("_official_x_post"):
            op = 1
        return (op, pub)

    deduped.sort(key=_post_dedup_key, reverse=True)

    # Keep only articles from the last 5 days (hard cutoff for both Live feed and map)
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAP_CUTOFF_DAYS)
    recent = []
    for a in deduped:
        pub = a.get("pubDate", "")
        if pub:
            try:
                dt = parsedate_to_datetime(pub)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if dt >= cutoff:
                    recent.append(a)
            except Exception:
                pass
    return recent


# =============================================================================
# API ENDPOINTS
# =============================================================================

@app.get("/api/config")
async def get_public_config():
    """Return non-secret public configuration needed by the frontend."""
    print("SERVER MAP KEY PREFIX:", (settings.google_maps_api_key or "")[:12])
    return {
        "google_maps_api_key": settings.google_maps_api_key or "",
    }


@app.get("/api/news")
async def get_news():
    cached = get_cached("merged_news")
    if cached:
        sources = set(a.get("source", "Unknown") for a in cached)
        return {"status": "ok", "source": "cache", "count": len(cached), "source_count": len(sources), "articles": cached}

    deduped = await refresh_guard.run_once("refresh_news", fetch_all_feeds)
    set_cached("merged_news", deduped)
    sources = set(a.get("source", "Unknown") for a in deduped)
    return {"status": "ok", "source": "live", "count": len(deduped), "source_count": len(sources), "articles": deduped}


def _operational_signal_article(a: dict) -> bool:
    return bool(a.get("_511_incident") or a.get("_ny_alert") or a.get("_nws_alert"))


@app.get("/api/crimes")
async def get_crimes(
    force_refresh: bool = False,
    source_type: Optional[str] = None,
    strict_live_sources: Optional[str] = None,
):
    cached = get_cached(CRIME_ARTICLES_CACHE_KEY)
    if cached and not force_refresh:
        return cached

    strict_live = _parse_optional_bool(strict_live_sources) is True
    refresh_key = "refresh_crimes_feed_strict_live" if strict_live else "refresh_crimes_feed"
    try:
        all_articles = await refresh_guard.run_once(
            refresh_key,
            lambda: fetch_all_feeds(strict_live_sources=strict_live),
        )
    except Exception as exc:
        if strict_live:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "strict_live_sources_failed",
                    "message": str(exc),
                    "socrata": socrata_runtime_status(),
                },
            )
        logger.warning("refresh_crimes_feed_error: %s", exc)
        all_articles = []

    def _in_crime_pipeline(a: dict) -> bool:
        if not is_albany_related(a):
            return False
        if not _include_scanner_item_in_crime_feed(a):
            return False
        return is_crime_related(a) or _operational_signal_article(a)

    crime_articles = [a for a in all_articles if _in_crime_pipeline(a)]
    if (source_type or "").lower() == "open_data":
        crime_articles = [a for a in crime_articles if str(((a.get("incident") or {}).get("source_type") or "")).lower() == "open_data"]

    enriched: list[dict] = []
    for a in crime_articles:
        geo = geocode_article(a)
        # If the dictionary geocoder found no coords, use the enhanced
        # local-first geocoder: street/intersection extraction from the
        # title/description + local Albany gazetteer (free, no token) +
        # Mapbox for precise addresses. Greatly increases map density.
        if geo.get("latitude") is None and geo.get("longitude") is None:
            geo = await geocode_article_local_first(geo)
        geo["crime_type"] = classify_crime_type(a)
        geo["neighborhood"] = get_neighborhood(geo.get("matched_location", ""))
        geo["confidence"] = compute_article_confidence(a)
        geo["source_reliability"] = get_source_reliability(a.get("source", ""))
        age_h = get_article_age_hours(a)
        age_m = get_article_age_minutes(a)
        geo["age_hours"] = round(age_h, 1) if age_h is not None else None
        geo["age_minutes"] = round(age_m, 1) if age_m is not None else None
        geo["_stats_eligible"] = not is_scanner_noise(geo) and is_real_local_incident(geo)
        geo["_federal_national_hit"] = _national_federal_source_hit(geo)
        src_l = (a.get("source") or "").lower()
        lk = (a.get("link") or "").lower()
        blob_m = f"{a.get('title', '')} {a.get('description', '')}".lower()
        if "city of albany" in src_l or "albanyny.gov" in lk:
            if any(
                k in blob_m
                for k in (
                    "closure", "road closed", "detour", "emergency", "alert",
                    "missing", "evacuat", "shelter",
                )
            ):
                geo["_municipal_emergency"] = True
        gcopy = {**geo}
        ok_strict, _ = strict_incident_pipeline_ok(gcopy, log_rejects=False)
        geo["_strict_live_ok"] = ok_strict
        enriched.append(geo)

    normalized = [intel.normalize_from_enriched(x) for x in enriched]
    fused = intel.fuse_incident_batch(normalized)
    scored = intel.apply_scores_and_eligibility(fused)

    now_scored = [x for x in scored if x.get("feed_lane") == intel.FEED_LANE_NOW]
    conf_scored = [x for x in scored if x.get("feed_lane") == intel.FEED_LANE_CONFIRMED]
    nctx_scored = [x for x in scored if x.get("feed_lane") == intel.FEED_LANE_NEWS_CONTEXT]

    now_scored.sort(key=intel.live_sort_key, reverse=True)
    conf_scored.sort(key=intel.live_sort_key, reverse=True)
    nctx_scored.sort(key=lambda x: -intel.news_sort_ts(x))

    now_rows = [intel.incident_to_api_row(x) for x in now_scored]
    now_rows = dedupe_redundant_live_scanner_cards(now_rows)

    def _live_rank(row: dict) -> tuple[int, int, float]:
        age_h = row.get("age_hours")
        try:
            age_h_f = float(age_h) if age_h is not None else 999.0
        except Exception:
            age_h_f = 999.0
        fresh12 = 1 if age_h_f <= 12.0 else 0
        p = 0
        if row.get("_scanner_critical_live"):
            p = 5
        elif row.get("_official_x_post"):
            p = 4
        elif row.get("_nixle_item"):
            p = 3
        else:
            blob = _article_combined_text(row)
            if "arrest" in blob or "charged" in blob or "in custody" in blob:
                p = 2
            else:
                p = 1
        # Higher first: fresh<=12h, then source/incident class, then recency.
        return (fresh12, p, -age_h_f)

    now_rows.sort(key=_live_rank, reverse=True)
    conf_rows = [intel.incident_to_api_row(x) for x in conf_scored]
    nctx_rows = [intel.incident_to_api_row(x) for x in nctx_scored]

    geocoded = now_rows + conf_rows + nctx_rows
    for row in geocoded:
        row["is_active_incident"] = compute_is_active_incident(row)
        row["normalized_incident"] = article_to_incident(row).model_dump(mode="json")

    # Persist normalized incidents for map/timeline/source querying.
    # Fallback to raw feed rows if the filtered crime list is temporarily empty,
    # but the fallback MUST still pass the Albany-County locality gate — otherwise
    # false-local items (Albany, GA; Albany, OR; federal noise) leak into the DB
    # and surface on the map/timeline without ever touching the strict pipeline.
    if geocoded:
        rows_for_persistence = geocoded
    else:
        rows_for_persistence = [a for a in all_articles if is_albany_related(a)][:250]
    persistence_stats = await persist_articles_as_incidents(rows_for_persistence)
    if persistence_stats.get("inserted", 0) > 0:
        _mark_real_incident_arrived()

    global _LAST_INCIDENT_PIPELINE
    diag = intel.build_pipeline_diagnostics(enriched, normalized, fused, scored)
    diag["filler_reject_count"] = sum(
        1 for x in enriched if is_scanner_noise(x) or not live_has_useful_summary(x)
    )
    _LAST_INCIDENT_PIPELINE = {
        "diagnostics": diag,
        "operational": intel.build_operational_summary(scored),
        "debug_lists": intel.debug_top_lists(scored, 50),
    }

    def _row_age_hours(r: dict) -> float:
        try:
            ah = r.get("age_hours")
            if ah is not None:
                return float(ah)
            pub = r.get("pubDate", "")
            if pub:
                dt = parsedate_to_datetime(pub)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
        except Exception:
            pass
        return 999.0

    def _is_arrestish(r: dict) -> bool:
        blob = _article_combined_text(r)
        return ("arrest" in blob) or ("charged" in blob) or ("in custody" in blob)

    live_active_now = list(now_rows)
    for r in conf_rows:
        ah = _row_age_hours(r)
        if ah <= 12.0 and (
            r.get("_official_x_post")
            or r.get("_nixle_item")
            or r.get("_scanner_call")
            or _is_arrestish(r)
        ):
            live_active_now.append(r)
    live_recent_local = [
        r
        for r in (conf_rows + nctx_rows)
        if _row_age_hours(r) <= 120.0 and r not in live_active_now
    ]

    payload = {
        "status": "ok",
        "source": "live",
        "data": geocoded,
        "total": len(geocoded),
        "count": len(geocoded),
        "accepted_count": int(_GEO_FILTER_STATS.get("accepted", 0)),
        "rejected_count": int(_GEO_FILTER_STATS.get("rejected", 0)),
        "rejection_reasons": dict(
            sorted(
                (_GEO_FILTER_STATS.get("reasons") or {}).items(),
                key=lambda kv: kv[1],
                reverse=True,
            )[:10]
        ),
        "persistence": persistence_stats,
        "feeds": {
            "now": now_rows,
            "live_active_now": live_active_now,
            "live_recent_local": live_recent_local,
            "confirmed": conf_rows,
            "news_context": nctx_rows,
        },
        "feeds_total": {
            "now": len(now_rows),
            "live_active_now": len(live_active_now),
            "live_recent_local": len(live_recent_local),
            "confirmed": len(conf_rows),
            "news_context": len(nctx_rows),
        },
        "structured_sources": {
            "socrata_records": sum(1 for r in geocoded if str(((r.get("incident") or {}).get("source_type") or "")).lower() == "open_data"),
            "socrata_runtime": socrata_runtime_status(),
        },
    }
    logger.info(
        "geo_filter_counts accepted=%s rejected=%s top_reasons=%s",
        payload["accepted_count"],
        payload["rejected_count"],
        payload["rejection_reasons"],
    )
    set_cached(CRIME_ARTICLES_CACHE_KEY, payload)
    return payload


# --- Background ingest loops ----------------------------------------------
# Two independent loops:
#   * crime/news loop  — full feed refresh + Postgres persistence via get_crimes()
#                        cadence: BACKGROUND_CRIME_INGEST_SECONDS (default 120s)
#   * scanner cache loop — operational scanner cache refresh via
#                          _merge_scanner_calls_from_sources(write_cache=True)
#                          cadence: SCANNER_INGEST_SECONDS (default 0 = disabled)
# Keeping these split lets Railway run scanner-warm refreshes at a faster
# cadence than the heavier RSS/news pipeline without doubling work on either.
_crime_ingest_bg_task: Optional[asyncio.Task] = None
_scanner_ingest_bg_task: Optional[asyncio.Task] = None
# Socrata loop: pulls APD open-data datasets (crimes, arrests, calls for
# service, use of force) into the incidents table on a slow cadence. Daily
# data, so 30-60 minute ticks are appropriate. Disabled by default; opt in
# on Railway via SOCRATA_INGEST_SECONDS=1800 (30m) or 3600 (1h).
_socrata_ingest_bg_task: Optional[asyncio.Task] = None

_BACKGROUND_INGEST_STATS: dict[str, Any] = {
    "crime": {"enabled": False, "interval_s": 0.0, "last_tick_at": "", "last_error": ""},
    "scanner": {
        "enabled": False, "interval_s": 0.0, "last_tick_at": "",
        "last_merged_count": 0, "last_error": "",
    },
    "socrata": {
        "enabled": False, "interval_s": 0.0, "last_tick_at": "",
        "last_persisted_count": 0, "last_error": "",
    },
}


def _background_crime_ingest_interval_s() -> float:
    """Seconds between full feed refresh + persistence ticks. 0 or negative disables the loop."""
    raw = os.getenv("BACKGROUND_CRIME_INGEST_SECONDS", "60").strip()
    try:
        return float(raw)
    except ValueError:
        return 120.0


async def _background_crime_ingest_loop(interval_s: float) -> None:
    await asyncio.sleep(8.0)
    while True:
        try:
            try:
                # Cached get_crimes() returns early without running persist_articles_as_incidents.
                await get_crimes(force_refresh=True)
                st = last_upsert_stats()
                _BACKGROUND_INGEST_STATS["crime"]["last_tick_at"] = (
                    datetime.now(timezone.utc).isoformat()
                )
                _BACKGROUND_INGEST_STATS["crime"]["last_error"] = ""
                logger.info(
                    "background_crime_ingest_tick inserted=%s updated=%s skipped_as_duplicate=%s processed=%s backend=%s",
                    st.get("inserted", 0),
                    st.get("updated", 0),
                    st.get("skipped_as_duplicate", 0),
                    st.get("processed", 0),
                    st.get("backend", ""),
                )
                # LLM fusion: enrich newest incidents with clean Grok summaries
                # (cached by id; best-effort, never blocks ingest).
                try:
                    await fuse_recent_incidents(limit=15)
                except Exception as fexc:
                    logger.debug("fusion_tick_skipped: %s", fexc)
            except Exception as exc:
                _BACKGROUND_INGEST_STATS["crime"]["last_error"] = f"{type(exc).__name__}: {exc}"
                logger.warning("background_crime_ingest_tick_error error=%s", exc)
            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            break


async def start_background_crime_ingest() -> None:
    global _crime_ingest_bg_task
    interval_s = _background_crime_ingest_interval_s()
    _BACKGROUND_INGEST_STATS["crime"]["interval_s"] = float(interval_s)
    if interval_s <= 0:
        _BACKGROUND_INGEST_STATS["crime"]["enabled"] = False
        logger.info(
            "background_crime_ingest_disabled BACKGROUND_CRIME_INGEST_SECONDS=%s",
            os.getenv("BACKGROUND_CRIME_INGEST_SECONDS", ""),
        )
        return
    _BACKGROUND_INGEST_STATS["crime"]["enabled"] = True
    _crime_ingest_bg_task = asyncio.create_task(_background_crime_ingest_loop(interval_s))
    logger.info("background_crime_ingest_started interval_s=%s", interval_s)


async def stop_background_crime_ingest() -> None:
    global _crime_ingest_bg_task
    if _crime_ingest_bg_task is None:
        return
    _crime_ingest_bg_task.cancel()
    try:
        await _crime_ingest_bg_task
    except (asyncio.CancelledError, Exception):
        pass
    _crime_ingest_bg_task = None
    _BACKGROUND_INGEST_STATS["crime"]["enabled"] = False


# =============================================================================
# GAP-FILLING — "Albany Pulse" synthetic activity cards
# =============================================================================
# When no new incident arrives for GAP_FILL_THRESHOLD_SECONDS, the system
# generates lightweight "ongoing activity" incident cards from scanner
# intelligence so the Live feed never appears dead.

_GAP_FILL_THRESHOLD_S = int(os.getenv("GAP_FILL_THRESHOLD_SECONDS", "300"))  # 5 minutes
_gap_fill_task: Optional[asyncio.Task] = None
_last_real_incident_ts: float = time.time()
_gap_fill_cards: list[dict[str, Any]] = []
_GAP_FILL_MAX = 8


def _mark_real_incident_arrived():
    """Called whenever a genuinely NEW incident is inserted."""
    global _last_real_incident_ts
    _last_real_incident_ts = time.time()


async def _newest_incident_age_seconds() -> float:
    """Check the actual age of the newest incident in the database.
    This is the ground truth — doesn't matter when DB writes happened."""
    try:
        items = await query_incidents(limit=1, sort_by="newest")
        if items:
            raw_dt = items[0].get("published_at") or items[0].get("occurred_at")
            if raw_dt:
                dt = datetime.fromisoformat(str(raw_dt).replace("Z", "+00:00"))
                return max(0, (datetime.now(timezone.utc) - dt).total_seconds())
    except Exception:
        pass
    return _seconds_since_last_real_incident()


def _seconds_since_last_real_incident() -> float:
    return time.time() - _last_real_incident_ts


def _build_gap_fill_card(scanner_alerts: list[dict], stream_status: dict) -> Optional[dict[str, Any]]:
    """Synthesize an 'ongoing activity' card from scanner intelligence or time-aware status."""
    now = datetime.now(timezone.utc)
    gap_minutes = int(_seconds_since_last_real_incident() / 60)

    # Only use scanner alerts that are RECENT (<30 min) and not hallucinated
    fresh_alerts = [
        a for a in scanner_alerts
        if (time.time() - (a.get("timestamp") or 0)) < 1800
        and not _is_ad_or_noise(a.get("text", ""))
        and a.get("alert_level", "none") != "none"
    ]

    if fresh_alerts:
        top = fresh_alerts[0]
        analysis = top.get("analysis") or {}
        cand = analysis.get("incident_candidate") or {}
        muni = cand.get("municipality") or "Albany County"
        if muni.lower() == "albany":
            muni = "City of Albany"
        itype = cand.get("incident_type") or "Police activity"
        summary = analysis.get("summary") or top.get("text", "")[:120]
        feed_name = top.get("feed_name", "Scanner")

        title = f"Ongoing: {itype} in {muni}"
        description = (
            f"{summary} "
            f"(Cross-referenced from live scanner transcription · {feed_name})"
        )
        return {
            "id": f"gap_fill_{int(now.timestamp())}_{muni.replace(' ', '_')[:20]}",
            "title": title,
            "description": description,
            "link": "",
            "pubDate": now.isoformat(),
            "source": "Albany Pulse",
            "municipality": muni,
            "severity": "medium",
            "category": itype.lower() if itype else "police activity",
            "confidence": 0.6,
            "feed_tab": "live",
            "_gap_fill": True,
            "_gap_minutes": gap_minutes,
            "lat": None,
            "lon": None,
        }

    # Fallback: always generate a status card when gap threshold is met
    monitor_running = stream_status.get("monitor_running", False)
    alert_count = stream_status.get("alert_count", 0)
    hour = datetime.now(timezone.utc).hour
    # Time-aware messaging
    if 0 <= hour < 6:
        period = "Overnight monitoring"
        desc_prefix = "Low activity period (overnight)."
    elif 6 <= hour < 9:
        period = "Early morning monitoring"
        desc_prefix = "Morning shift starting."
    elif 22 <= hour < 24:
        period = "Late evening monitoring"
        desc_prefix = "Activity winding down for the evening."
    else:
        period = "Active monitoring"
        desc_prefix = f"No new confirmed incidents in the past {gap_minutes} minutes."

    return {
        "id": f"gap_fill_monitoring_{int(now.timestamp())}",
        "title": f"Albany County · {period}",
        "description": (
            f"{desc_prefix} "
            f"{'Scanner pipeline active — ' + str(alert_count) + ' transmission(s) captured.' if monitor_running else 'All ' + str(stream_status.get('sources_total', 57)) + ' sources being polled.'} "
            "Feed updates immediately when activity is detected from any source."
        ),
        "link": "",
        "pubDate": now.isoformat(),
        "source": "Albany Pulse",
        "municipality": "Albany County",
        "severity": "low",
        "category": "monitoring",
        "confidence": 1.0,
        "feed_tab": "live",
        "_gap_fill": True,
            "_gap_minutes": gap_minutes,
            "lat": None,
            "lon": None,
        }
    return None


async def _gap_fill_loop() -> None:
    """Background loop that keeps the feed alive during quiet periods.
    Generates time-stamped status cards every 5 minutes when no real
    news is publishing, so the feed always has recent content."""
    global _gap_fill_cards
    await asyncio.sleep(20.0)
    while True:
        try:
            gap_s = await _newest_incident_age_seconds()
            if gap_s >= _GAP_FILL_THRESHOLD_S:
                async with _stream_alerts_lock:
                    recent_alerts = list(_stream_alerts[:10])
                stream_status = {
                    "monitor_running": _stream_monitor_task is not None and not _stream_monitor_task.done(),
                    "alert_count": len(_stream_alerts),
                    "sources_total": _total_source_count(),
                }

                # Generate a card; de-duplicate by title so the feed doesn't
                # accumulate multiple identical "Active monitoring" cards.
                card = _build_gap_fill_card(recent_alerts, stream_status)
                if card:
                    existing = next((c for c in _gap_fill_cards if c.get("title") == card["title"]), None)
                    if existing:
                        existing["pubDate"] = card["pubDate"]  # refresh timestamp only
                        existing["description"] = card["description"]
                    else:
                        _gap_fill_cards.insert(0, card)
                    # Keep at most 2 distinct gap-fill cards.
                    if len(_gap_fill_cards) > 2:
                        _gap_fill_cards = _gap_fill_cards[:2]

                logger.debug("gap_fill_tick total=%d gap_min=%d",
                             len(_gap_fill_cards), int(gap_s / 60))
            else:
                if _gap_fill_cards:
                    _gap_fill_cards.clear()
            # Generate a new card every 5 minutes during gaps
            await asyncio.sleep(300)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.warning("gap_fill_loop_error: %s", exc)
            await asyncio.sleep(300)


async def start_gap_fill_monitor() -> None:
    global _gap_fill_task, _stream_alerts, _gap_fill_cards
    if _GAP_FILL_THRESHOLD_S <= 0:
        return
    # Purge stale alerts on startup (>1 hour old are useless for gap-fill)
    cutoff = time.time() - 3600
    async with _stream_alerts_lock:
        _stream_alerts[:] = [a for a in _stream_alerts if (a.get("timestamp") or 0) > cutoff]
    # Generate an initial gap-fill card immediately if there's a gap
    try:
        gap_s = await _newest_incident_age_seconds()
        if gap_s >= _GAP_FILL_THRESHOLD_S:
            stream_status = {
                "monitor_running": _stream_monitor_task is not None and not _stream_monitor_task.done(),
                "alert_count": len(_stream_alerts),
                "sources_total": _total_source_count(),
            }
            card = _build_gap_fill_card([], stream_status)
            if card:
                _gap_fill_cards.append(card)
                logger.info("gap_fill_initial_card generated (gap=%dm)", int(gap_s / 60))
    except Exception as exc:
        logger.warning("gap_fill_initial_error: %s", exc)
    _gap_fill_task = asyncio.create_task(_gap_fill_loop())
    logger.info("gap_fill_monitor_started threshold_s=%s", _GAP_FILL_THRESHOLD_S)


async def stop_gap_fill_monitor() -> None:
    global _gap_fill_task
    if _gap_fill_task:
        _gap_fill_task.cancel()
        try:
            await _gap_fill_task
        except (asyncio.CancelledError, Exception):
            pass
        _gap_fill_task = None


def _background_scanner_ingest_interval_s() -> float:
    """Seconds between scanner cache warm-refresh ticks. 0 or negative disables the loop.

    Kept separate from BACKGROUND_CRIME_INGEST_SECONDS so scanner/operational
    sources can run at a faster cadence (e.g. 30s) than the full crime/news
    refresh (default 120s). Defaults to 0 (disabled) so existing deploys
    retain their current behavior until Railway explicitly sets the var.
    """
    raw = os.getenv("SCANNER_INGEST_SECONDS", "0").strip()
    try:
        return float(raw)
    except ValueError:
        return 0.0


async def _background_scanner_ingest_loop(interval_s: float) -> None:
    # Slight offset from crime loop's 8s startup sleep so first ticks don't
    # collide on cold start.
    await asyncio.sleep(4.0)
    while True:
        try:
            try:
                merged, _sources, _rr = await _merge_scanner_calls_from_sources(write_cache=True)
                _BACKGROUND_INGEST_STATS["scanner"]["last_tick_at"] = (
                    datetime.now(timezone.utc).isoformat()
                )
                _BACKGROUND_INGEST_STATS["scanner"]["last_merged_count"] = len(merged or [])
                _BACKGROUND_INGEST_STATS["scanner"]["last_error"] = ""
                logger.info(
                    "background_scanner_ingest_tick merged=%s interval_s=%s",
                    len(merged or []),
                    interval_s,
                )
            except Exception as exc:
                _BACKGROUND_INGEST_STATS["scanner"]["last_error"] = f"{type(exc).__name__}: {exc}"
                logger.warning("background_scanner_ingest_tick_error error=%s", exc)
            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            break


async def start_background_scanner_ingest() -> None:
    global _scanner_ingest_bg_task
    interval_s = _background_scanner_ingest_interval_s()
    _BACKGROUND_INGEST_STATS["scanner"]["interval_s"] = float(interval_s)
    if interval_s <= 0:
        _BACKGROUND_INGEST_STATS["scanner"]["enabled"] = False
        logger.info(
            "background_scanner_ingest_disabled SCANNER_INGEST_SECONDS=%s",
            os.getenv("SCANNER_INGEST_SECONDS", ""),
        )
        return
    _BACKGROUND_INGEST_STATS["scanner"]["enabled"] = True
    _scanner_ingest_bg_task = asyncio.create_task(_background_scanner_ingest_loop(interval_s))
    logger.info("background_scanner_ingest_started interval_s=%s", interval_s)


async def stop_background_scanner_ingest() -> None:
    global _scanner_ingest_bg_task
    if _scanner_ingest_bg_task is None:
        return
    _scanner_ingest_bg_task.cancel()
    try:
        await _scanner_ingest_bg_task
    except (asyncio.CancelledError, Exception):
        pass
    _scanner_ingest_bg_task = None
    _BACKGROUND_INGEST_STATS["scanner"]["enabled"] = False


def _background_socrata_ingest_interval_s() -> float:
    """Seconds between APD-Socrata refresh ticks. 0 disables the loop.

    Socrata datasets (crimes, arrests, calls for service, use of force) update
    daily, so 30 minutes (1800s) or 1 hour (3600s) is the right operational
    cadence. Defaults to 0 so existing deploys keep current behavior until
    Railway sets SOCRATA_INGEST_SECONDS explicitly.
    """
    raw = os.getenv("SOCRATA_INGEST_SECONDS", "0").strip()
    try:
        return float(raw)
    except ValueError:
        return 0.0


async def _background_socrata_ingest_loop(interval_s: float) -> None:
    # Long startup offset so we don't compete with the crime/news loop on
    # cold start and so the Socrata portal probe has time to settle.
    await asyncio.sleep(20.0)
    while True:
        try:
            try:
                rows = await fetch_albany_open_data(limit=500, offset=0)
                rows = rows if isinstance(rows, list) else []
                # Reuse the standard incident-persistence path so dedupe,
                # canonical-source normalization, and locality gating all
                # apply. fetch_albany_open_data() already shapes rows as
                # incident-articles.
                if rows:
                    await persist_articles_as_incidents(rows)
                _BACKGROUND_INGEST_STATS["socrata"]["last_tick_at"] = (
                    datetime.now(timezone.utc).isoformat()
                )
                _BACKGROUND_INGEST_STATS["socrata"]["last_persisted_count"] = len(rows)
                _BACKGROUND_INGEST_STATS["socrata"]["last_error"] = ""
                logger.info(
                    "background_socrata_ingest_tick rows=%s interval_s=%s",
                    len(rows),
                    interval_s,
                )
            except Exception as exc:
                _BACKGROUND_INGEST_STATS["socrata"]["last_error"] = (
                    f"{type(exc).__name__}: {exc}"
                )
                logger.warning("background_socrata_ingest_tick_error error=%s", exc)
            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            break


async def start_background_socrata_ingest() -> None:
    global _socrata_ingest_bg_task
    interval_s = _background_socrata_ingest_interval_s()
    _BACKGROUND_INGEST_STATS["socrata"]["interval_s"] = float(interval_s)
    if interval_s <= 0:
        _BACKGROUND_INGEST_STATS["socrata"]["enabled"] = False
        logger.info(
            "background_socrata_ingest_disabled SOCRATA_INGEST_SECONDS=%s",
            os.getenv("SOCRATA_INGEST_SECONDS", ""),
        )
        return
    _BACKGROUND_INGEST_STATS["socrata"]["enabled"] = True
    _socrata_ingest_bg_task = asyncio.create_task(_background_socrata_ingest_loop(interval_s))
    logger.info("background_socrata_ingest_started interval_s=%s", interval_s)


async def stop_background_socrata_ingest() -> None:
    global _socrata_ingest_bg_task
    if _socrata_ingest_bg_task is None:
        return
    _socrata_ingest_bg_task.cancel()
    try:
        await _socrata_ingest_bg_task
    except (asyncio.CancelledError, Exception):
        pass
    _socrata_ingest_bg_task = None
    _BACKGROUND_INGEST_STATS["socrata"]["enabled"] = False


def _parse_iso_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def _parse_optional_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    v = str(value).strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off"):
        return False
    return None


def _parse_tags(value: Optional[str]) -> Optional[list[str]]:
    if not value:
        return None
    tags = [t.strip() for t in str(value).split(",") if t.strip()]
    return tags or None


_FALSE_LOCAL_SOURCES = frozenset([
    "kezi", "kval", "kmtr", "albany democrat-herald",
    "walb", "wfxl", "albany herald",
])

# Low-credibility / scraped / off-area sources that flood the Live feed with
# junk via Google News. Dropped from the LIVE feed so it shows trustworthy
# Albany County reporting. (Substring match on source name.)
_LOW_QUALITY_SOURCES = frozenset([
    "facebook.com",          # scraped FB posts — unreliable as a primary source
    "aol.com", "msn", "yahoo", "ground.news",
    "newport dispatch",      # Rhode Island
    "dailyvoice.com", "daily voice",
    "theunionstar.com", "union star",
    "philomath news", "philomath",   # Albany, OREGON area
    "wfmz", "wfmz.com",      # Allentown, PA
    "lehigh valley", "lehighvalleylive", "morning call",
    "wyomingnewsnow", "kgab", "cap city news", "county 10",  # Albany County, WYOMING
    "world israel news",     # "Bethlehem"/IDF West Bank
    "wyoming tribune", "laramie",
])

# Albany-County primary/credible source markers — these always pass the
# credibility gate even if a name partially matches above.
_CREDIBLE_SOURCE_MARKERS = (
    "news10", "wten", "cbs6", "wrgb", "wnyt", "wamc", "times union",
    "daily gazette", "spotlight", "spectrum", "fox23", "fox 23",
    "nysp", "state police", "troop", "sheriff", "acso", "albany police",
    "official", "nixle", "scanner", "us attorney", "district attorney",
    "department of justice", "albany pulse", "bluesky", "albany proper",
    "albany scanner", "nws", "511",
)


def _is_low_quality_source(item: dict) -> bool:
    src = str(item.get("source_name") or item.get("source") or "").lower().strip()
    if not src:
        return False
    if any(c in src for c in _CREDIBLE_SOURCE_MARKERS):
        return False
    return any(bad and bad in src for bad in _LOW_QUALITY_SOURCES)


def _is_false_local_incident(item: dict) -> bool:
    """Detect incidents clearly NOT in Albany County, NY.
    CONSERVATIVE: only reject items from confirmed wrong-state sources."""
    src = str(item.get("source_name") or "").lower().strip()
    if any(bad in src for bad in _FALSE_LOCAL_SOURCES):
        return True
    return False


# Specific Albany-County municipalities → high locality confidence.
_ALBANY_MUNI_SET = frozenset({
    "city of albany", "colonie", "bethlehem", "guilderland", "cohoes",
    "watervliet", "green island", "menands", "coeymans", "new scotland",
    "berne", "knox", "westerlo", "rensselaerville", "ravena", "voorheesville",
    "altamont", "latham", "loudonville", "delmar", "slingerlands", "glenmont",
    "selkirk", "feura bush", "clarksville", "westmere", "mckownville",
})

# Non-Albany-County places. When one dominates a title AND no Albany
# municipality is present, the item is demoted (it merely MENTIONS Albany —
# e.g. "Albany County Court" — but actually happened elsewhere).
_OTHER_COUNTY_PLACES = frozenset({
    "rotterdam", "schenectady", "troy", "saratoga", "ballston", "clifton park",
    "poughkeepsie", "kingston", "catskill", "hudson", "johnsonville", "mohawk",
    "pittsfield", "amsterdam", "gloversville", "glens falls", "queensbury",
    "rensselaer", "east greenbush", "north greenbush", "mechanicville",
    "malta", "wilton", "greenwich", "cambridge", "fonda", "broadalbin",
    "northumberland", "stillwater", "halfmoon", "waterford", "scotia",
    "cobleskill", "schoharie", "philomath", "allentown", "corvallis",
})

_ALBANY_TITLE_TOKENS = (
    "albany", "colonie", "bethlehem", "guilderland", "cohoes", "watervliet",
    "menands", "green island", "coeymans", "new scotland", "delmar", "latham",
    "loudonville", "ravena", "voorheesville", "altamont", "slingerlands",
    "glenmont", "selkirk", "berne", "knox", "westerlo",
)

_TITLE_KEY_STOP = frozenset({
    "the", "a", "an", "in", "on", "at", "to", "of", "and", "or", "for", "after",
    "with", "from", "is", "was", "were", "as", "by", "near", "into", "over",
})


def _locality_confidence(it: dict) -> int:
    """2 = specific Albany-County municipality; 1 = Albany-tied; 0 = clearly elsewhere."""
    muni = (it.get("municipality") or "").strip().lower()
    if muni in _ALBANY_MUNI_SET:
        return 2
    title = (it.get("short_title") or it.get("title") or "").lower()
    names_albany = any(t in title for t in _ALBANY_TITLE_TOKENS)
    names_other = any(p in title for p in _OTHER_COUNTY_PLACES)
    if names_other and not names_albany:
        return 0
    if muni == "albany county" or names_albany:
        return 1
    return 1


def _title_dedup_key(title: str) -> str:
    """Normalized significant-word signature for collapsing repeated titles."""
    low = re.sub(r"[^a-z0-9\s]", " ", (title or "").lower())
    words = [w for w in low.split() if len(w) > 3 and w not in _TITLE_KEY_STOP]
    if len(words) < 3:
        return ""
    return " ".join(sorted(set(words))[:10])


_STREET_PHRASE_RE = re.compile(
    r"\b(north|south|east|west)?\s?([a-z]{3,})\s+"
    r"(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|drive|dr)\b"
)
_KNOWN_AREAS = (
    "south pearl", "north pearl", "pine hills", "arbor hill", "south end",
    "west hill", "center square", "downtown", "washington park", "mansion",
    "park south", "sheridan hollow", "north albany",
)


def _incident_signature(it: dict) -> str:
    """A (location + incident-type) signature that catches the SAME incident
    reported by different outlets with different wording — e.g. three South
    Pearl Street robbery stories. Empty when no clear location is present."""
    title = (it.get("short_title") or it.get("title") or "").lower()
    itype = (it.get("fused_incident_type") or it.get("crime_type") or "").strip().lower()
    if not itype or itype in ("other", "police_activity"):
        return ""
    loc = ""
    for area in _KNOWN_AREAS:
        if area in title:
            loc = area
            break
    if not loc:
        m = _STREET_PHRASE_RE.search(title)
        if m:
            loc = ((m.group(1) or "") + " " + m.group(2)).strip()
    if not loc:
        return ""
    return f"{loc}|{itype}"


def _merge_duplicate_source(kept: dict, dupe: dict) -> None:
    """Fold a duplicate's source attribution into the kept incident."""
    linked = kept.get("linked_sources")
    if not isinstance(linked, list):
        linked = []
        own = kept.get("source_name") or kept.get("source")
        if own:
            linked.append({"name": own, "url": kept.get("source_url") or kept.get("link") or ""})
    dupe_name = dupe.get("source_name") or dupe.get("source")
    if dupe_name and not any((s.get("name") == dupe_name) for s in linked):
        linked.append({"name": dupe_name, "url": dupe.get("source_url") or dupe.get("link") or ""})
    kept["linked_sources"] = linked


def _polish_incidents(items: list[dict]) -> list[dict]:
    """Output-quality pass for the Live feed:
      1. Normalize bare "Albany" → "City of Albany"
      2. Collapse near-identical repeated titles (merge source attribution)
      3. Demote clearly-out-of-county items to the bottom (stable otherwise)
    """
    for it in items:
        if (it.get("municipality") or "").strip().lower() == "albany":
            it["municipality"] = "City of Albany"
        # Overlay cached LLM fusion (clean headline/summary) when available.
        _apply_fusion(it)

    # Drop items the LLM flagged as not-real-Albany-incidents.
    items = [
        it for it in items
        if not (_INCIDENT_FUSION_CACHE.get(it.get("id"), {}).get("drop"))
    ]

    seen_title: dict[str, dict] = {}
    seen_sig: dict[str, dict] = {}
    deduped: list[dict] = []
    for it in items:
        if it.get("_gap_fill"):
            deduped.append(it)
            continue
        tkey = _title_dedup_key(it.get("short_title") or it.get("title") or "")
        skey = _incident_signature(it)
        # A duplicate if EITHER the title signature OR the location+type
        # signature has already been seen.
        kept = (seen_title.get(tkey) if tkey else None) or (seen_sig.get(skey) if skey else None)
        if kept is not None:
            _merge_duplicate_source(kept, it)
            continue
        if tkey:
            seen_title[tkey] = it
        if skey:
            seen_sig[skey] = it
        deduped.append(it)

    in_area = [it for it in deduped if _locality_confidence(it) >= 1 or it.get("_gap_fill")]
    out_area = [it for it in deduped if _locality_confidence(it) < 1 and not it.get("_gap_fill")]
    # Out-of-county items (Rotterdam, Poughkeepsie, Johnsonville, Pittsfield…)
    # don't belong in an ALBANY COUNTY tracker. Drop them entirely when we have
    # enough genuine local content; only keep them as a last resort so the feed
    # is never empty.
    if len(in_area) >= 5:
        return in_area
    return in_area + out_area


@app.get("/api/incidents")
async def get_incidents(
    limit: int = 100,
    offset: int = 0,
    municipality: Optional[str] = None,
    incident_type: Optional[str] = None,
    status: Optional[str] = None,
    source_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    has_coordinates: Optional[str] = None,
    verification_level: Optional[str] = None,
    severity: Optional[str] = None,
    tags: Optional[str] = None,
    q: Optional[str] = None,
    sort_by: str = "newest",
):
    sort_mode = (sort_by or "newest").lower()
    if sort_mode not in ("newest", "severity", "verification", "priority", "operational"):
        sort_mode = "newest"
    items = await query_incidents(
        limit=limit,
        offset=offset,
        municipality=municipality,
        incident_type=incident_type,
        status=status,
        source_type=source_type,
        start_date=_parse_iso_dt(start_date),
        end_date=_parse_iso_dt(end_date),
        has_coordinates=_parse_optional_bool(has_coordinates),
        verification_level=verification_level,
        severity=severity,
        tags=_parse_tags(tags),
        q=q,
        sort_by=sort_mode,
    )
    # Filter out false-local (wrong-state) + low-credibility/scraped sources
    # so the Live feed shows trustworthy Albany County reporting, not Google
    # News junk (facebook scrapes, out-of-area aggregators, content farms).
    items = [
        it for it in items
        if not _is_false_local_incident(it) and not _is_low_quality_source(it)
    ]
    # Output-quality polish: dedup repeats, normalize City of Albany, demote
    # clearly-out-of-county items (skip when a specific query/municipality
    # filter is active so we don't reorder targeted results).
    if not q and not municipality:
        items = _polish_incidents(items)
    # Merge gap-fill cards when the feed is quiet (keeps Live feed alive)
    gap_cards = list(_gap_fill_cards) if _gap_fill_cards else []
    if gap_cards and not q:
        items = list(items) + gap_cards

    # Compute real gap from the TRUE newest non-gap-fill item (min age across
    # all items — not the first, since operational sort puts the highest-
    # severity item first, which may be older than the actual newest).
    real_gap_s = 0
    now_utc = datetime.now(timezone.utc)
    ages: list[int] = []
    for it in items:
        if it.get("_gap_fill"):
            continue
        raw_dt = it.get("published_at") or it.get("occurred_at") or it.get("pubDate")
        if raw_dt:
            try:
                dt = datetime.fromisoformat(str(raw_dt).replace("Z", "+00:00"))
                ages.append(max(0, int((now_utc - dt).total_seconds())))
            except Exception:
                pass
    if ages:
        real_gap_s = min(ages)

    payload = {
        "status": "ok",
        "source": incident_store_backend(),
        "count": len(items),
        "incidents": items,
        "pulse": {
            "seconds_since_last_incident": real_gap_s or int(_seconds_since_last_real_incident()),
            "gap_fill_active": bool(gap_cards),
            "sources_active": _total_source_count(),
            "scanner_pipeline_active": _stream_monitor_task is not None and not _stream_monitor_task.done(),
        },
    }
    return payload


@app.get("/api/incidents/pulse")
async def get_incidents_pulse():
    """Real-time feed health/freshness status for the Albany Pulse bar."""
    gap_s = await _newest_incident_age_seconds()
    total_sources = _total_source_count()
    gnews_status = gnews_runtime_status()
    scanner_running = _stream_monitor_task is not None and not _stream_monitor_task.done()
    return {
        "status": "ok",
        "seconds_since_last_incident": int(gap_s),
        "gap_fill_active": bool(_gap_fill_cards),
        "gap_fill_count": len(_gap_fill_cards),
        "sources_total": total_sources,
        "gnews_status": gnews_status.get("status", "unknown"),
        "scanner_pipeline_active": scanner_running,
        "scanner_alert_count": len(_stream_alerts),
        "feed_state": "live" if gap_s < 300 else ("aging" if gap_s < 900 else "quiet"),
    }


@app.get("/api/incidents/stream")
async def incidents_stream():
    """SSE endpoint — pushes new incident notifications to connected clients.
    Clients subscribe via EventSource; server sends a heartbeat every 15s and
    a 'new_incidents' event whenever the background ingest tick produces changes."""

    async def event_generator():
        last_count = 0
        last_gap_state = ""
        while True:
            try:
                current_items = await query_incidents(limit=5, sort_by="newest")
                current_count = len(current_items)
                gap_s = _seconds_since_last_real_incident()
                gap_state = "live" if gap_s < 300 else ("aging" if gap_s < 900 else "quiet")

                if current_count != last_count or gap_state != last_gap_state:
                    newest = current_items[0] if current_items else {}
                    payload = json.dumps({
                        "type": "update",
                        "newest_title": newest.get("title", ""),
                        "newest_id": newest.get("id", ""),
                        "count": current_count,
                        "gap_state": gap_state,
                        "seconds_since_last": int(gap_s),
                    })
                    yield f"event: new_incidents\ndata: {payload}\n\n"
                    last_count = current_count
                    last_gap_state = gap_state
                else:
                    yield f": heartbeat {int(time.time())}\n\n"

                await asyncio.sleep(15)
            except asyncio.CancelledError:
                break
            except Exception:
                yield f": error-retry\n\n"
                await asyncio.sleep(30)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/incidents/{incident_id}/provenance")
async def get_incident_provenance(incident_id: str):
    items = await query_incidents(limit=1, q=incident_id, sort_by="newest")
    match = None
    for it in items:
        if it.get("id") == incident_id:
            match = it
            break
    if not match:
        items = await query_incidents(limit=50, sort_by="newest")
        for it in items:
            if it.get("id") == incident_id:
                match = it
                break
    if not match:
        return {"status": "not_found", "incident_id": incident_id, "provenance": {}}
    prov = match.get("provenance") or {}
    return {
        "status": "ok",
        "incident_id": incident_id,
        "title": match.get("title", ""),
        "source_type": match.get("source_type", ""),
        "provenance": prov,
    }


@app.get("/api/incidents/map")
async def get_incidents_map(
    limit: int = 500,
    offset: int = 0,
    municipality: Optional[str] = None,
    incident_type: Optional[str] = None,
    status: Optional[str] = None,
    source_type: Optional[str] = None,
    verification_level: Optional[str] = None,
    severity: Optional[str] = None,
    tags: Optional[str] = None,
    q: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    has_coordinates: Optional[str] = "true",
    sort_by: str = "newest",
):
    map_limit = max(1, min(limit, 1000))
    sort_mode = (sort_by or "newest").lower()
    if sort_mode not in ("newest", "severity", "verification", "priority", "operational"):
        sort_mode = "newest"
    items = await query_incidents(
        limit=map_limit,
        offset=max(0, offset),
        municipality=municipality,
        incident_type=incident_type,
        status=status,
        source_type=source_type,
        start_date=_parse_iso_dt(start_date),
        end_date=_parse_iso_dt(end_date),
        has_coordinates=_parse_optional_bool(has_coordinates),
        verification_level=verification_level,
        severity=severity,
        tags=_parse_tags(tags),
        q=q,
        sort_by=sort_mode,
    )
    albany_bounds = (42.4, 42.85, -74.1, -73.55)
    markers = []
    for it in items:
        lat = it.get("latitude")
        lon = it.get("longitude")
        cq = str(it.get("coordinate_quality") or "missing").lower()
        if cq == "missing" or lat is None or lon is None:
            continue
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except (TypeError, ValueError):
            continue
        if not (albany_bounds[0] <= lat_f <= albany_bounds[1] and albany_bounds[2] <= lon_f <= albany_bounds[3]):
            continue
        markers.append({
            "id": it.get("id"),
            "title": it.get("short_title") or it.get("title"),
            "incident_type": it.get("incident_type"),
            "severity": it.get("severity"),
            "status": it.get("status"),
            "municipality": it.get("municipality"),
            "latitude": lat_f,
            "longitude": lon_f,
            "occurred_at": it.get("occurred_at") or it.get("published_at"),
            "human_time": it.get("human_time") or "",
            "source_type": it.get("source_type"),
            "source_name": it.get("source_name"),
            "verification_level": it.get("verification_level"),
            "coordinate_quality": cq,
            "confidence_score": it.get("confidence_score"),
            "source_url": it.get("source_url"),
        })
    return {
        "status": "ok",
        "source": incident_store_backend(),
        "count": len(markers),
        "markers": markers,
    }


@app.get("/api/incidents/summary")
async def get_incidents_summary(window: str = "7d"):
    return {"status": "ok", "source": incident_store_backend(), **(await summarize_incidents(window=window))}


@app.get("/api/incidents/trends")
async def get_incidents_trends(window: str = "30d"):
    return {"status": "ok", "source": incident_store_backend(), **(await incident_trends(window=window))}


# =============================================================================
# ALBANY COUNTY NEWS FEED  (law enforcement · news · laws/courts · emergency)
# =============================================================================
# The News tab is a real local-news reader, not just a re-render of crime
# incidents. These Google-News queries cover the four topic buckets the user
# asked for, scoped to Albany County municipalities.
_ALBANY_GEO = (
    '("Albany County" OR "Albany, NY" OR "Albany New York" OR Colonie OR '
    'Guilderland OR Bethlehem OR Cohoes OR Watervliet OR Menands OR '
    '"Green Island" OR Coeymans OR Ravena OR Voorheesville OR Altamont OR '
    'Latham OR Loudonville OR Delmar OR Slingerlands OR Glenmont)'
)
NEWS_TOPIC_FEEDS = {
    "law_enforcement": {
        "label": "Law Enforcement",
        "terms": '(police OR sheriff OR "state police" OR trooper OR arrest OR '
                 'arrested OR investigation OR charged OR indicted OR "law enforcement")',
        "when": "3d",
    },
    "emergency_services": {
        "label": "Emergency Services",
        "terms": '(fire OR firefighter OR EMS OR paramedic OR rescue OR crash OR '
                 'accident OR hazmat OR evacuation OR "first responders" OR ambulance)',
        "when": "3d",
    },
    "courts_law": {
        "label": "Courts & Law",
        "terms": '(court OR sentenced OR sentencing OR lawsuit OR trial OR verdict OR '
                 '"district attorney" OR legislation OR "new law" OR pleads OR conviction)',
        "when": "4d",
    },
    "local_news": {
        "label": "Local News",
        "terms": '(news OR mayor OR "county executive" OR "common council" OR '
                 '"public safety" OR community OR "city of albany")',
        "when": "2d",
    },
}


def _build_news_feed_url(cfg: dict) -> str:
    q = f"{_ALBANY_GEO} {cfg['terms']} when:{cfg.get('when', '3d')}"
    return (
        "https://news.google.com/rss/search?q="
        + quote_plus(q)
        + "&hl=en-US&gl=US&ceid=US:en"
    )


def _relative_time(dt: Optional[datetime]) -> str:
    if not dt:
        return ""
    try:
        secs = max(0, (datetime.now(timezone.utc) - dt).total_seconds())
    except Exception:
        return ""
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if secs < 86400:
        return f"{int(secs // 3600)}h ago"
    return f"{int(secs // 86400)}d ago"


# "Albany" and "Bethlehem" are NOT unique to NY — there's an Albany County in
# WYOMING, an Albany in GEORGIA and OREGON, a Bethlehem in PA and the West Bank.
# Google News returns all of them. These terms hard-disqualify an article.
_NEWS_BLOCK_TERMS = (
    "wyoming", "laramie", "snowy range", "reservoir lake", "albany, wy",
    "northampton", "lehigh", "allentown", "bethlehem, pa", "whitehall",
    "west bank", "idf", "palestin", "gaza", "hamas",
    "williamstown", "berkshire", "albany, ga", "albany georgia",
    "albany, or", "albany oregon", "linn county", "dougherty county",
)
# Names that are effectively unique to Albany County, NY.
_ALBANY_NY_UNIQUE = frozenset({
    "colonie", "guilderland", "cohoes", "watervliet", "menands", "green island",
    "coeymans", "ravena", "voorheesville", "altamont", "loudonville",
    "slingerlands", "glenmont", "selkirk", "new scotland", "feura bush",
    "clarksville", "westmere", "mckownville", "delmar", "latham",
    "troop g", "albany county sheriff", "albany police department",
    "colonie police", "guilderland police", "bethlehem police",
    "town of bethlehem", "capital region", "albany med",
})
_NY_CONTEXT_MARKERS = (
    "new york", " ny ", " ny.", ",ny", ", ny", "n.y", " nys ", "upstate",
    "hudson valley", "capital district", "capital region",
)


def _is_albany_ny(title: str, desc: str, source: str) -> bool:
    """Strict Albany County, NY gate — rejects Wyoming/GA/OR/PA/West-Bank lookalikes."""
    title_l = str(title or "").lower()
    body = title_l + " " + str(desc or "").lower()
    src = str(source or "").lower()
    blob = body + " " + src
    if any(b in blob for b in _NEWS_BLOCK_TERMS):
        return False
    if any(m in blob for m in _ALBANY_NY_UNIQUE):
        return True
    credible = any(c in src for c in _CREDIBLE_SOURCE_MARKERS)
    if "albany" in body and (credible or any(c in blob for c in _NY_CONTEXT_MARKERS)):
        return True
    return False


def _news_article_ok(article: dict) -> bool:
    """Albany-County locality + credibility gate for news articles."""
    src = str(article.get("source") or "").lower()
    if not any(c in src for c in _CREDIBLE_SOURCE_MARKERS):
        if any(bad and bad in src for bad in _LOW_QUALITY_SOURCES):
            return False
    if not _is_albany_ny(article.get("title") or "", article.get("description") or "", article.get("source") or ""):
        return False
    title = str(article.get("title") or "").lower()
    blob = title + " " + str(article.get("description") or "").lower()
    names_other = any(p in title for p in _OTHER_COUNTY_PLACES)
    names_albany_muni = any(m in blob for m in _ALBANY_NY_UNIQUE) or (
        "albany county" in blob and any(c in blob for c in _NY_CONTEXT_MARKERS)
    )
    if names_other and not names_albany_muni:
        return False
    return True


def _news_incident_ok(it: dict) -> bool:
    """Strict Albany-County gate for incidents shown on the News tab."""
    title = str(it.get("short_title") or it.get("title") or "")
    desc = str(it.get("description") or "")
    src = str(it.get("source_name") or "")
    if any(b in (title + " " + desc).lower() for b in _NEWS_BLOCK_TERMS):
        return False
    muni = str(it.get("municipality") or "").strip().lower()
    if muni in _ALBANY_MUNI_SET:
        return True
    return _is_albany_ny(title, desc, src)


_NEWS_FEED_CACHE: dict[str, Any] = {"ts": 0.0, "items": []}
_NEWS_FEED_TTL = 420  # 7 minutes
_NEWS_FEED_LOCK = asyncio.Lock()


async def _fetch_albany_news() -> list[dict]:
    """Fetch + filter Albany County news across the four topic buckets.

    Cached for _NEWS_FEED_TTL so the News tab stays snappy and we don't hammer
    Google News. Returns entries in the /api/home/news output shape.
    """
    now_ts = time.time()
    if (now_ts - float(_NEWS_FEED_CACHE.get("ts") or 0)) < _NEWS_FEED_TTL and _NEWS_FEED_CACHE.get("items"):
        return list(_NEWS_FEED_CACHE["items"])

    async with _NEWS_FEED_LOCK:
        # Re-check after acquiring the lock (another request may have refreshed).
        now_ts = time.time()
        if (now_ts - float(_NEWS_FEED_CACHE.get("ts") or 0)) < _NEWS_FEED_TTL and _NEWS_FEED_CACHE.get("items"):
            return list(_NEWS_FEED_CACHE["items"])

        if http_client is None:
            return list(_NEWS_FEED_CACHE.get("items") or [])

        gnews_headers = {
            "User-Agent": _GNEWS_BROWSER_UA,
            "Accept": "application/rss+xml, application/xml, text/xml, */*",
            "Accept-Language": "en-US,en;q=0.9",
        }

        async def _one(topic: str, cfg: dict) -> list[dict]:
            url = _build_news_feed_url(cfg)
            if _check_gnews_blocked(url):
                return []
            try:
                async with _GNEWS_SEMAPHORE:
                    resp = await fetch_with_retry(
                        http_client, url, timeout=settings.external_timeout_seconds,
                        retries=1, headers=gnews_headers,
                    )
                    await asyncio.sleep(0.2)
            except Exception:
                return []
            if not resp or resp.status_code != 200:
                return []
            out = []
            for a in parse_rss(resp.text):
                a["_topic"] = topic
                a["_topic_label"] = cfg["label"]
                out.append(a)
            return out

        try:
            batches = await asyncio.gather(
                *[_one(t, c) for t, c in NEWS_TOPIC_FEEDS.items()],
                return_exceptions=True,
            )
        except Exception:
            batches = []

        seen: set[str] = set()
        entries: list[dict] = []
        for batch in batches:
            if not isinstance(batch, list):
                continue
            for a in batch:
                if not _news_article_ok(a):
                    continue
                title = str(a.get("title") or "").strip()
                key = title.lower()[:60]
                if not title or key in seen:
                    continue
                # Freshness backstop (drop republished/stale items).
                pub_dt = None
                try:
                    if a.get("pubDate"):
                        pub_dt = parsedate_to_datetime(a["pubDate"])
                        if pub_dt and pub_dt.tzinfo is None:
                            pub_dt = pub_dt.replace(tzinfo=timezone.utc)
                except Exception:
                    pub_dt = None
                if pub_dt and (datetime.now(timezone.utc) - pub_dt) > timedelta(hours=120):
                    continue
                seen.add(key)
                iso = pub_dt.astimezone(timezone.utc).isoformat() if pub_dt else ""
                entries.append({
                    "id": "news_" + hashlib.md5((a.get("link") or title).encode()).hexdigest()[:12],
                    "title": title,
                    "summary": str(a.get("description") or "")[:240],
                    "municipality": "",
                    "occurred_at": iso,
                    "published_at": iso,
                    "human_time": _relative_time(pub_dt),
                    "severity": "unknown",
                    "incident_type": a.get("_topic") or "",
                    "topic": a.get("_topic_label") or "",
                    "source_name": a.get("source") or "Local News",
                    "source_url": a.get("link") or "",
                    "source_type": "news",
                    "verification_level": "media",
                    "coordinate_quality": "missing",
                    "image_url": a.get("image_url") or _lookup_article_image(a.get("link") or ""),
                    "is_news": True,
                })

        entries.sort(key=lambda e: e.get("published_at") or "", reverse=True)
        _NEWS_FEED_CACHE["items"] = entries
        _NEWS_FEED_CACHE["ts"] = time.time()
        return list(entries)


_LOGO_CACHE: dict[str, tuple[bytes, str]] = {}
_LOGO_CACHE_MAX = 400
# Tiny transparent 1x1 PNG used when no logo can be resolved.
_LOGO_BLANK = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d4944415478da6364f80f00010101005a4d6f000000000049454e44"
    "ae426082"
)
_LOGO_DOMAIN_RE = re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}$")


@app.get("/api/logo")
async def get_source_logo(domain: str = ""):
    """Same-origin publisher-logo proxy.

    Safari ITP / privacy blockers drop third-party favicon requests
    (google.com/gstatic.com/duckduckgo.com), so logos never rendered in the
    browser. Proxying through our own origin makes them load reliably.
    """
    d = (domain or "").strip().lower().lstrip(".")
    if not d or not _LOGO_DOMAIN_RE.match(d) or len(d) > 100:
        return Response(content=_LOGO_BLANK, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=86400"})
    if d in _LOGO_CACHE:
        body, ctype = _LOGO_CACHE[d]
        return Response(content=body, media_type=ctype,
                        headers={"Cache-Control": "public, max-age=604800"})

    providers = [
        f"https://www.google.com/s2/favicons?sz=128&domain={quote(d)}",
        f"https://icons.duckduckgo.com/ip3/{quote(d)}.ico",
        f"https://logo.clearbit.com/{quote(d)}?size=128",
    ]
    body, ctype = b"", ""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=6.0) as client:
            for url in providers:
                try:
                    r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                    if r.status_code == 200 and r.content and len(r.content) > 70:
                        ct = r.headers.get("content-type", "")
                        if ct.startswith("image/"):
                            body, ctype = r.content, ct
                            break
                except Exception:
                    continue
    except Exception:
        pass

    if not body:
        return Response(content=_LOGO_BLANK, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=3600"})

    if len(_LOGO_CACHE) >= _LOGO_CACHE_MAX:
        _LOGO_CACHE.pop(next(iter(_LOGO_CACHE)), None)
    _LOGO_CACHE[d] = (body, ctype)
    return Response(content=body, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/home/news")
async def get_home_news():
    now = datetime.now(timezone.utc)
    items_raw = await query_incidents(
        limit=300,
        sort_by="newest",
        start_date=now - timedelta(hours=120),
    )
    # News tab is Albany-County only and credible-source only — no scraped
    # facebook posts, no out-of-county (Troy/Saratoga/Coxsackie) noise.
    items_48h = [
        it for it in items_raw
        if not it.get("_gap_fill")
        and not _is_low_quality_source(it)
        and not _is_false_local_incident(it)
        and _news_incident_ok(it)
    ]

    def _score(it: dict) -> float:
        sev = {"critical": 50, "high": 35, "medium": 18, "low": 6}.get(
            str(it.get("severity") or "").lower(), 4
        )
        ver = {"official": 28, "multi_source": 24, "media": 14, "scanner": 8, "inferred": 5}.get(
            str(it.get("verification_level") or "").lower(), 4
        )
        recency = 0
        raw_dt = it.get("occurred_at") or it.get("published_at")
        if raw_dt:
            try:
                dt = datetime.fromisoformat(str(raw_dt).replace("Z", "+00:00"))
                hours_old = max(0, (now - dt).total_seconds() / 3600.0)
                recency = max(0, 20 - hours_old)
            except Exception:
                pass
        return sev + ver + recency

    scored = sorted(items_48h, key=_score, reverse=True)

    def _entry(it: dict) -> dict:
        title = str(it.get("short_title") or it.get("title") or "").strip()
        muni = it.get("municipality") or ""
        if muni.lower() == "albany":
            muni = "City of Albany"
        prov = it.get("provenance") if isinstance(it.get("provenance"), dict) else {}
        image_url = (
            prov.get("image_url")
            or _lookup_article_image(it.get("source_url") or "", it.get("external_ref") or "")
            or ""
        )
        return {
            "id": it.get("id"),
            "title": title,
            "summary": str(it.get("description") or "")[:240],
            "municipality": muni,
            "occurred_at": it.get("occurred_at") or it.get("published_at"),
            "published_at": it.get("published_at"),
            "human_time": it.get("human_time") or "",
            "severity": it.get("severity") or "unknown",
            "incident_type": it.get("incident_type") or "",
            "source_name": it.get("source_name") or "",
            "source_url": it.get("source_url") or "",
            "source_type": it.get("source_type") or "",
            "verification_level": it.get("verification_level") or "unknown",
            "coordinate_quality": it.get("coordinate_quality") or "missing",
            "image_url": image_url,
            "priority_score": round(_score(it), 1),
        }

    # Pull real Albany-County news (law enforcement / emergency / courts /
    # local) and blend it with verified incidents so the News tab reads like
    # an actual local-news desk, not a crime-incident mirror.
    try:
        news_entries = await _fetch_albany_news()
    except Exception:
        logger.exception("albany news fetch failed")
        news_entries = []

    def _entry_freshness(e: dict) -> float:
        ver = {"official": 28, "multi_source": 24, "media": 16, "scanner": 8, "inferred": 5}.get(
            str(e.get("verification_level") or "").lower(), 12
        )
        sev = {"critical": 24, "high": 16, "medium": 8, "low": 3}.get(
            str(e.get("severity") or "").lower(), 5
        )
        recency = 0.0
        raw = e.get("published_at") or e.get("occurred_at")
        if raw:
            try:
                dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                hrs = max(0.0, (now - dt).total_seconds() / 3600.0)
                recency = max(0.0, 36 - hrs)
            except Exception:
                pass
        return ver + sev + recency

    incident_entries = [_entry(it) for it in scored]

    seen_titles: set[str] = set()

    def _take(entry: dict) -> bool:
        key = str(entry.get("title") or "").lower()[:60]
        if not key or key in seen_titles:
            return False
        seen_titles.add(key)
        return True

    # Developing: live/scanner/active incidents (kept distinct + first dibs).
    developing_stories: list[dict[str, Any]] = []
    for it in scored:
        ver_lev = str(it.get("verification_level") or "").lower()
        status = str(it.get("status") or "").lower()
        if ver_lev in ("scanner", "inferred") or status == "active":
            e = _entry(it)
            if _take(e):
                developing_stories.append(e)
        if len(developing_stories) >= 5:
            break

    # Top stories: freshest, most credible mix of real news + verified incidents.
    combined = news_entries + incident_entries
    combined_sorted = sorted(combined, key=_entry_freshness, reverse=True)
    major_stories: list[dict[str, Any]] = []
    for e in combined_sorted:
        if _take(e):
            major_stories.append(e)
        if len(major_stories) >= 6:
            break

    # Headlines: everything else, most-recent first.
    chrono = sorted(combined, key=lambda x: str(x.get("published_at") or x.get("occurred_at") or ""), reverse=True)
    headlines: list[dict[str, Any]] = []
    for e in chrono:
        if _take(e):
            headlines.append(e)
        if len(headlines) >= 20:
            break

    summary_24h = await summarize_incidents(window="24h")
    summary_7d = await summarize_incidents(window="7d")
    summary_30d = await summarize_incidents(window="30d")

    def _recap(s: dict) -> dict:
        groups = s.get("groups") or {}
        return {
            "total": s.get("total", 0),
            "delta_count": s.get("delta_count", 0),
            "top_types": (groups.get("incident_type") or [])[:3],
            "top_locations": (groups.get("municipality") or [])[:3],
        }

    return {
        "status": "ok",
        "source": incident_store_backend(),
        "news_feed_count": len(news_entries),
        "major_stories": major_stories,
        "developing_stories": developing_stories,
        "headlines": headlines,
        "recap_24h": _recap(summary_24h),
        "recap_7d": _recap(summary_7d),
        "recap_30d": _recap(summary_30d),
        "top_categories": (summary_24h.get("groups") or {}).get("incident_type", [])[:5],
        "top_locations": (summary_24h.get("groups") or {}).get("municipality", [])[:5],
    }


SOURCE_METHODOLOGY = {
    "lane_model": [
        "Verified Incidents",
        "Developing Incidents",
        "Official Updates",
        "Trends & Map",
    ],
    "source_types": {
        "official": "Highest trust structured/open-data/government records and agency updates.",
        "federal": "US Department of Justice / US Attorney press releases and federal prosecution updates.",
        "open_data": "City of Albany structured Socrata/open-data records (highest trust for mapped precision).",
        "scanner": "Early signal only; not an official incident record until corroborated.",
        "media": "Corroboration and enrichment from local reporting.",
        "inferred": "Fused/inferred signal from multiple partial sources; preliminary.",
    },
    "verification_levels": {
        "official": "Direct official/public record source.",
        "multi_source": "Corroborated by multiple independent sources.",
        "media": "Media-confirmed but may still evolve.",
        "scanner": "Scanner-derived early signal; unconfirmed.",
        "inferred": "Model/system inferred from partial evidence.",
    },
    "coordinate_quality": {
        "exact": "Precise incident-level location.",
        "approximate": "Area-level location, not exact address.",
        "missing": "No reliable location available for map placement.",
    },
    "freshness": {
        "incidents_refresh_seconds": 45,
        "scanner_refresh_seconds": 20,
        "social_refresh_seconds": 900,
    },
}

SOURCE_EXPANSION_HOOKS = [
    {"id": "albany-pd-civicalerts-rss", "label": "Albany PD CivicAlerts / RSS", "enabled": False},
    {"id": "albany-county-da-press", "label": "Albany County DA press releases", "enabled": True},
    {"id": "nysp-troopg-news-blotter", "label": "NYSP Troop G newsroom + daily blotter", "enabled": True},
    {"id": "usao-ndny-rss", "label": "USAO NDNY press releases", "enabled": True},
    {"id": "city-albany-openalbany", "label": "City of Albany Socrata/openAlbany", "enabled": True},
    {"id": "ny-open-data-public-safety", "label": "NY Open Data public safety datasets", "enabled": False},
    {"id": "511ny", "label": "511NY Events API — traffic incidents with coordinates", "enabled": True},
    {"id": "fbi-cde-fbi-albany", "label": "FBI CDE / FBI Albany", "enabled": False},
    {"id": "ualbany-pd-log", "label": "UAlbany PD incident log", "enabled": False},
    {"id": "daily-voice-albany", "label": "Daily Voice Albany", "enabled": False},
    {"id": "patch-municipality-pages", "label": "Patch municipality pages", "enabled": False},
    {"id": "news10-rss", "label": "NEWS10 crime/local RSS", "enabled": False},
    {"id": "cbs6-rss", "label": "CBS6 local/crime RSS where available", "enabled": False},
    {"id": "wnyt-google-news-fallback", "label": "WNYT via Google News RSS fallback", "enabled": False},
    {"id": "spectrum-public-safety-rss", "label": "Spectrum News public safety RSS", "enabled": False},
    {"id": "wamc-news", "label": "WAMC news", "enabled": False},
    {"id": "spotlight-daily-gazette", "label": "Spotlight / Daily Gazette", "enabled": False},
    {"id": "spotcrime", "label": "SpotCrime", "enabled": False},
    {"id": "scanner-transcription-openai", "label": "Optional scanner transcription pipeline using OPENAI_API_KEY", "enabled": False},
]


@app.get("/api/methodology")
async def get_methodology():
    methodology = dict(SOURCE_METHODOLOGY)
    methodology["socrata_runtime"] = socrata_runtime_status()
    return {
        "status": "ok",
        "methodology": methodology,
        "planned_hooks": SOURCE_EXPANSION_HOOKS,
    }


@app.get("/api/geocoding/stats")
async def geocoding_stats():
    """Mapbox geocoding cache stats for monitoring."""
    return {"status": "ok", "geocoding": geocode_cache_stats()}


@app.get("/api/incidents/operational-summary")
async def incidents_operational_summary():
    """Normalized-incident situational snapshot (prime pipeline via /api/crimes first, or we refresh here)."""
    await get_crimes()
    op = _LAST_INCIDENT_PIPELINE.get("operational") or {}
    return {"status": "ok", **op}


@app.get("/api/incidents/debug")
async def incidents_debug():
    """Tuning: counts, rejection reasons, top live/rejected incidents (last /api/crimes build)."""
    await get_crimes()
    return {
        "status": "ok",
        "diagnostics": _LAST_INCIDENT_PIPELINE.get("diagnostics", {}),
        "debug": _LAST_INCIDENT_PIPELINE.get("debug_lists", {}),
    }


@app.get("/api/nysp-blotter/debug")
async def nysp_blotter_debug():
    """Debug: fetch NYSP Troop G blotter PDFs and return parsed incidents."""
    try:
        items = await fetch_nysp_blotter_pdfs()
        return {
            "status": "ok",
            "count": len(items),
            "urls_tried": _nysp_blotter_urls_for_window(days_back=2),
            "items": items[:50],  # Cap at 50 for readability
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


@app.get("/api/bluesky/debug")
async def bluesky_debug(discover: bool = False):
    """Debug: fetch Bluesky (AT Protocol) Capital Region posts and report rows."""
    try:
        rows = await fetch_bluesky_posts(limit_per_account=25, discover=discover)
        return {
            "status": "ok",
            "runtime": bluesky_runtime_status(),
            "count": len(rows),
            "items": [
                {
                    "source": r.get("source_name"),
                    "severity": r.get("incident", {}).get("severity"),
                    "crime_type": r.get("event_type"),
                    "title": r.get("title"),
                    "link": r.get("link"),
                    "pubDate": r.get("pubDate"),
                }
                for r in rows[:25]
            ],
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/nws/debug")
async def nws_debug():
    """Debug: fetch active NWS weather-emergency alerts for the Capital Region."""
    try:
        rows = await fetch_nws_alerts(limit=25)
        return {
            "status": "ok",
            "runtime": nws_runtime_status(),
            "count": len(rows),
            "items": [
                {
                    "severity": r.get("severity"),
                    "municipality": r.get("municipality"),
                    "title": r.get("title"),
                    "pubDate": r.get("pubDate"),
                }
                for r in rows
            ],
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/broadcastify/debug")
async def broadcastify_debug():
    """Debug: show Broadcastify config, attempt playlist + API fetch, report results."""
    has_key = bool(settings.broadcastify_api_key)
    uuid = settings.broadcastify_playlist_uuid
    sys_id = settings.broadcastify_system_id or "8553"

    results = {"status": "ok", "config": {
        "has_api_key": has_key,
        "api_key_prefix": settings.broadcastify_api_key[:8] + "..." if has_key else "(not set)",
        "system_id": sys_id,
        "playlist_uuid": uuid,
        "playlist_url": f"https://www.broadcastify.com/calls/playlists/?uuid={uuid}&view=console" if uuid else "(not set)",
    }}

    try:
        # Test the node API
        api_calls = await _fetch_broadcastify_calls()
        results["api_node_calls"] = len(api_calls)
        if api_calls:
            results["api_sample"] = api_calls[:3]
    except Exception as e:
        results["api_error"] = str(e)

    try:
        # Test the playlist fetcher
        pl_calls = await _fetch_broadcastify_playlist_calls()
        results["playlist_calls"] = len(pl_calls)
        if pl_calls:
            results["playlist_sample"] = pl_calls[:3]
    except Exception as e:
        results["playlist_error"] = str(e)

    return results


@app.get("/api/trends")
async def get_trends():
    cached = get_cached("dcjs_trends")
    if cached:
        return {"status": "ok", "source": "cache", "data": cached}
    try:
        resp = await fetch_with_retry(
            http_client,
            DCJS_URL,
            timeout=settings.external_timeout_seconds,
            retries=settings.external_retry_attempts,
        )
        if resp and resp.status_code == 200:
            data = resp.json()
            set_cached("dcjs_trends", data)
            return {"status": "ok", "source": "live", "data": data}
        return {"status": "error", "message": f"HTTP {(resp.status_code if resp else 'timeout')}", "data": []}
    except Exception as e:
        logger.warning("trends_fetch_error error=%s", e)
        return {"status": "error", "message": str(e), "data": []}


@app.get("/api/situation")
async def get_situation():
    """AI-powered situation report with patterns, stats, and crime counts."""
    # Fetch fresh crime data (uses cache internally)
    crimes_resp = await get_crimes()
    crime_data = crimes_resp.get("data", [])

    patterns = detect_patterns(crime_data)

    # Build stats from pattern data
    type_b = patterns.get("type_breakdown", {})
    stats = {
        "violent": type_b.get("violent", 0),
        "property": type_b.get("property", 0),
        "other": type_b.get("other", 0),
        "recent_48h": patterns.get("recent_48h", 0),
        "total_articles": len(crime_data),
        "source_count": len(set(a.get("source", "") for a in crime_data if a.get("source"))),
    }

    # Crime counts for header chips
    feed_tabs = {}
    for a in crime_data:
        tab = a.get("feed_tab", "")
        feed_tabs[tab] = feed_tabs.get(tab, 0) + 1
    crime_counts = {
        "visible_feed_count": len(crime_data),
        "live_now_count": feed_tabs.get("verified", 0) + feed_tabs.get("live", 0) + feed_tabs.get("now", 0),
        "recent_48h_count": patterns.get("recent_48h", 0),
        "stats_total_incidents": len(crime_data),
    }

    # Generate AI situation (cached, with deterministic fallback)
    try:
        situation_data = await generate_situation_report(crime_data, patterns)
    except Exception as exc:
        logger.warning("situation report error: %s", exc)
        situation_data = _conservative_situation_report(crime_data, patterns)

    return {
        "status": "ok",
        "situation": situation_data.get("situation", "Analyzing..."),
        "threat_level": situation_data.get("threat_level", "unknown"),
        "confidence": situation_data.get("confidence", "low"),
        "stats": stats,
        "crime_counts": crime_counts,
        "patterns": patterns,
    }


@app.get("/api/patterns")
async def get_patterns():
    """Real-time pattern detection: hotspots, type breakdown, insights."""
    cached = get_cached("patterns")
    if cached:
        return cached
    crimes_resp = await get_crimes()
    crime_data = crimes_resp.get("data", [])
    patterns = detect_patterns(crime_data)
    result = {"status": "ok", **patterns}
    set_cached("patterns", result, 60)
    return result


@app.get("/api/search")
async def search_incidents(
    q: str = "",
    limit: int = 50,
):
    """Full-text search across persisted incidents."""
    query = (q or "").strip()
    if len(query) < 2:
        return {"status": "ok", "results": [], "query": query, "total": 0}
    search_limit = max(1, min(limit, 200))
    items = await query_incidents(limit=search_limit, q=query, sort_by="newest")
    return {
        "status": "ok",
        "results": items,
        "query": query,
        "total": len(items),
    }


@app.get("/api/monthly_summary")
async def get_monthly_summary():
    """AI-generated monthly crime highlights for Albany County, NY."""
    cached = get_cached("monthly_summary")
    if cached:
        return cached

    if not XAI_API_KEY:
        return {"status": "error", "summary": "AI not configured.", "highlights": [], "trend": "unknown", "month": ""}

    crimes_resp = await get_crimes()
    crime_data = crimes_resp.get("data", [])

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    monthly = []
    for a in crime_data:
        pub = a.get("pubDate", "")
        if pub:
            try:
                dt = parsedate_to_datetime(pub)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if dt >= month_start:
                    monthly.append(a)
            except Exception:
                pass

    crime_list = "\n".join(
        f"- {a['title']} [{a.get('source', 'unknown')}]"
        for a in monthly[:25]
    )

    payload = {
        "model": XAI_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a senior crime intelligence analyst covering Albany County, NY. "
                    "Albany County includes the City of Albany plus the towns of Bethlehem, Colonie, "
                    "Guilderland, New Scotland, and Coeymans; cities Cohoes and Watervliet; and villages "
                    "Altamont, Green Island, Menands, Ravena, and Voorheesville.\n\n"
                    "Produce a professional monthly crime intelligence report. "
                    "Return ONLY valid JSON with exactly these keys:\n"
                    '{"summary": "2-3 sentences characterizing the month\'s crime landscape — '
                    'specific locations, incident types, and notable patterns", '
                    '"highlights": ["3-5 specific notable incidents or trends with location detail"], '
                    '"trend": "up|down|stable", '
                    '"primary_crime_type": "violent|property|other", '
                    '"projection": "2-3 sentences forecasting what to watch for the next 30 days '
                    'based on current month patterns — specific areas and crime types", '
                    '"watch_areas": ["2-4 specific neighborhoods or municipalities warranting attention"]}'
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Albany County crime intelligence report — {now.strftime('%B %Y')} "
                    f"({len(monthly)} incidents this month so far):\n\n"
                    f"{crime_list or 'No reports found this month.'}\n\n"
                    "Generate a complete monthly intelligence report with overview, highlights, "
                    "trend assessment, 30-day projection, and areas to watch."
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.25,
        "max_tokens": 900,
    }

    try:
        resp = await post_xai_chat(payload)
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            result = json.loads(content)
            result["status"] = "ok"
            result["month"] = now.strftime("%B %Y")
            result["crime_count"] = len(monthly)
            set_cached("monthly_summary", result)
            return result
        else:
            print(f"Monthly summary HTTP error: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"Monthly summary error: {e}")

    return {
        "status": "error",
        "summary": "Summary unavailable.",
        "highlights": [],
        "trend": "unknown",
        "projection": "",
        "watch_areas": [],
        "month": now.strftime("%B %Y"),
        "crime_count": len(monthly),
    }


@app.get("/api/daily_summary")
async def get_daily_summary():
    """AI-generated daily briefing: today's top incidents, threat assessment."""
    cached = get_cached("daily_summary")
    if cached:
        return cached

    if not XAI_API_KEY:
        return {"status": "error", "briefing": "AI not configured.", "top_incidents": [], "threat_level": "unknown"}

    crimes_resp = await get_crimes()
    crime_data = crimes_resp.get("data", [])

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_start = today_start - timedelta(hours=24)

    # Include articles from the last 24 hours
    todays = []
    for a in crime_data:
        pub = a.get("pubDate", "")
        if pub:
            try:
                dt = parsedate_to_datetime(pub)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if dt >= yesterday_start:
                    todays.append(a)
            except Exception:
                pass

    if not todays:
        result = {
            "status": "ok",
            "date": _format_display_date(now),
            "incident_count": 0,
            "briefing": "No crime incidents reported in Albany County in the last 24 hours.",
            "top_incidents": [],
            "threat_level": "low",
        }
        set_cached("daily_summary", result)
        return result

    incident_list = "\n".join(
        f"- [{a.get('crime_type','other').upper()}] {a['title']} "
        f"[{a.get('source','?')}] {a.get('neighborhood','')}"
        for a in todays[:20]
    )

    payload = {
        "model": XAI_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are the duty intelligence analyst for Albany County, NY law enforcement. "
                    "Produce a concise daily crime briefing — the kind an on-duty sergeant would read "
                    "at shift change. Be specific about locations, suspect descriptions if known, "
                    "and patterns. Do not pad or speculate beyond what the data shows.\n\n"
                    "Return ONLY valid JSON:\n"
                    '{"briefing": "2-3 sentence executive summary of today\'s crime picture", '
                    '"top_incidents": ['
                    '{"title": "short incident title", "type": "violent|property|other", '
                    '"location": "specific area", "significance": "one sentence why notable"}], '
                    '"threat_level": "low|moderate|elevated|high", '
                    '"patterns": ["1-2 patterns if any visible across today\'s incidents"]}'
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Albany County — last 24 hours ({len(todays)} incidents reported):\n\n"
                    f"{incident_list}\n\n"
                    "Generate the daily crime briefing. Include only what the data supports."
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": 700,
    }

    try:
        resp = await post_xai_chat(payload)
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            result = json.loads(content)
            result["status"] = "ok"
            result["date"] = _format_display_date(now)
            result["incident_count"] = len(todays)
            set_cached("daily_summary", result)
            return result
        else:
            print(f"Daily summary HTTP error: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"Daily summary error: {e}")

    return {
        "status": "error",
        "date": _format_display_date(now),
        "incident_count": len(todays),
        "briefing": "Daily briefing unavailable.",
        "top_incidents": [],
        "threat_level": "unknown",
    }


@app.get("/api/social_intel")
async def get_social_intel():
    """
    Use xAI Grok live search to pull recent Albany County law enforcement
    social media posts from X (@AlbanyPolice, @NYSP_TroopG, Sheriff, Colonie PD).
    """
    cached = get_cached("social_intel")
    if cached is not None:
        return {"status": "ok", "source": "cache", "items": cached}

    if not XAI_API_KEY:
        return {"status": "error", "items": [], "message": "AI not configured"}

    # xAI live search (search_parameters) is deprecated as of 2025.
    # We use the tools-based approach: ask Grok for law enforcement X/social
    # intelligence using its up-to-date knowledge.
    payload = {
        "model": XAI_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a real-time law enforcement social media monitor for Albany County, NY. "
                    "Based on your most recent knowledge, report what @AlbanyPolice, @NYSP_TroopG "
                    "(NY State Police Troop G), Albany County Sheriff, and Colonie Police have "
                    "recently posted about on X/Twitter regarding public safety incidents. "
                    "Focus on: active incidents, arrests, road closures, missing persons, public alerts. "
                    'Return ONLY valid JSON: {"items": [{"source": "account name", "handle": "@handle", '
                    '"text": "post content", "time": "time description", "type": "police|fire|ems|general"}]}. '
                    "If you have no specific recent posts, return {\"items\": []}."
                ),
            },
            {
                "role": "user",
                "content": (
                    "What are the most recent public safety posts from Albany County NY law enforcement "
                    "accounts? Include any active incidents, alerts, or notable activity from "
                    "@AlbanyPolice, @NYSP_TroopG, Albany County Sheriff, Colonie Police."
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
        "max_tokens": 1000,
    }

    try:
        resp = await post_xai_chat(payload)
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            result = json.loads(content)
            items = result.get("items", [])
            set_cached("social_intel", items)
            return {"status": "ok", "source": "live", "items": items}
        print(f"Social intel HTTP error: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"Social intel error: {e}")

    return {"status": "error", "items": [], "message": "Unable to fetch social intel"}


@app.get("/api/sources")
async def get_sources():
    registry = load_source_registry()
    audited = audit_entries(registry)
    audited_by_id = {str(x.get("source_id") or ""): x for x in audited}
    socrata_state = socrata_runtime_status()
    socrata_by_id = {
        str(x.get("dataset_id") or ""): x
        for x in (socrata_state.get("datasets") or [])
        if isinstance(x, dict)
    }
    sources = [
        {
            "name": x.get("source_name"),
            "type": x.get("category"),
            "trust_tier": x.get("trust_tier"),
            "active_status": bool(x.get("active_status")),
            "source_status": (
                socrata_by_id.get(str((x.get("canonical_url") or "").split("/")[-1].replace(".json", "")), {}).get("source_status")
                if str(x.get("category") or "") == "official_structured"
                else None
            ),
            "last_success_at": (
                socrata_by_id.get(str((x.get("canonical_url") or "").split("/")[-1].replace(".json", "")), {}).get("last_success_at")
                if str(x.get("category") or "") == "official_structured"
                else None
            ),
            "last_error": (
                socrata_by_id.get(str((x.get("canonical_url") or "").split("/")[-1].replace(".json", "")), {}).get("last_error")
                if str(x.get("category") or "") == "official_structured"
                else None
            ),
            "dataset_url": (
                socrata_by_id.get(str((x.get("canonical_url") or "").split("/")[-1].replace(".json", "")), {}).get("dataset_url")
                if str(x.get("category") or "") == "official_structured"
                else None
            ),
            "record_count_last_fetch": (
                socrata_by_id.get(str((x.get("canonical_url") or "").split("/")[-1].replace(".json", "")), {}).get("record_count_last_fetch")
                if str(x.get("category") or "") == "official_structured"
                else None
            ),
            "implemented_ingestor": (audited_by_id.get(str(x.get("source_id") or ""), {}) or {}).get("implemented_ingestor", "no"),
            "validated_live": (audited_by_id.get(str(x.get("source_id") or ""), {}) or {}).get("validated_live", "no"),
            "unsuitable_flag": (audited_by_id.get(str(x.get("source_id") or ""), {}) or {}).get("unsuitable_flag", "no"),
            "duplicate_flag": (audited_by_id.get(str(x.get("source_id") or ""), {}) or {}).get("duplicate_flag", "no"),
            "audit_class": (audited_by_id.get(str(x.get("source_id") or ""), {}) or {}).get("audit_class", ""),
            "audit_reason": (audited_by_id.get(str(x.get("source_id") or ""), {}) or {}).get("reason", ""),
        }
        for x in registry
    ]
    cached = get_cached("merged_news") or []
    methodology = dict(SOURCE_METHODOLOGY)
    methodology["socrata_runtime"] = socrata_state
    return {
        "status": "ok",
        "total_articles": len(cached) if isinstance(cached, list) else 0,
        "source_count": len(sources),
        "sources": sources,
        "socrata_runtime": socrata_state,
        "registry_summary": source_registry_summary(registry),
        "audit_summary": audit_counts(audited),
        "methodology": methodology,
        "planned_hooks": SOURCE_EXPANSION_HOOKS,
        "upstream_status": {
            "radioreference": radioreference_runtime_status(),
            "google_news": gnews_runtime_status(),
        },
    }


@app.get("/api/sources/health")
async def get_sources_health():
    """Lightweight operational-health surface for ACT sources.

    Returns counters + last-tick timestamps for the background ingest loops,
    plus the live geo filter accept/reject stats already tracked in memory.
    No auth: read-only, no PII, cheap to compute. Intended for dashboards
    and quick "is live actually live right now?" spot-checks.
    """
    geo = _GEO_FILTER_STATS or {}
    reasons = dict(geo.get("reasons") or {})
    top_reasons = sorted(reasons.items(), key=lambda kv: kv[1], reverse=True)[:10]

    # Quarantine counters (DB if available, fall back to 0 on error so the
    # endpoint never 500s when the DB is transiently down).
    quarantine_total = 0
    try:
        from sqlalchemy import text as _sql_text
        sf = get_session_factory()
        if sf is not None:
            async with sf() as session:
                r = await session.execute(
                    _sql_text(
                        "SELECT COUNT(*) FROM incidents "
                        "WHERE tags @> to_jsonb(ARRAY['false_local_quarantine']::text[])"
                    )
                )
                quarantine_total = int(r.scalar() or 0)
    except Exception as exc:
        logger.warning("sources_health_quarantine_count_error error=%s", exc)

    # Scanner talkgroup → canonical-agency mapping coverage. Surfaces how
    # complete data/scanner_aliases.json is relative to the canonical
    # agency registry, so we can spot talkgroups that need a new alias or
    # a new agency record. Defensive try/except: missing data file or
    # malformed JSON returns zeros instead of 500ing the endpoint.
    talkgroup_coverage = {"total": 0, "canonical_resolved": 0, "unmapped": 0}
    try:
        from app.services.agency_registry import talkgroup_mapping_coverage
        talkgroup_coverage = talkgroup_mapping_coverage()
    except Exception as exc:
        logger.warning("sources_health_talkgroup_coverage_error error=%s", exc)

    return {
        "status": "ok",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "geo_filter": {
            "accepted": int(geo.get("accepted", 0)),
            "rejected": int(geo.get("rejected", 0)),
            "top_rejection_reasons": [
                {"reason": r, "count": int(c)} for r, c in top_reasons
            ],
        },
        "ingest_loops": {
            "crime": dict(_BACKGROUND_INGEST_STATS.get("crime") or {}),
            "scanner": dict(_BACKGROUND_INGEST_STATS.get("scanner") or {}),
            "socrata": dict(_BACKGROUND_INGEST_STATS.get("socrata") or {}),
        },
        "incidents": {
            "quarantined_total": quarantine_total,
            "store_backend": incident_store_backend(),
        },
        "scanner_talkgroup_mapping": talkgroup_coverage,
        "upstream": {
            "radioreference": radioreference_runtime_status(),
            "google_news": gnews_runtime_status(),
        },
    }


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    user_message = body.get("message", "")
    history = body.get("history", [])

    if not user_message.strip():
        return {"status": "error", "message": "Empty message"}

    crimes_resp = await get_crimes()
    crime_data = crimes_resp.get("data", [])

    crime_context = ""
    for a in crime_data[:20]:
        src = a.get("source", "Local News")
        hood = a.get("neighborhood", "")
        conf = a.get("confidence", 0.7)
        reliability = a.get("source_reliability", 0.7)
        conf_label = "HIGH" if conf >= 0.90 else "MED" if conf >= 0.75 else "LOW"
        tab = a.get("feed_tab", "?")
        loc = a.get("matched_location", "")
        sev = a.get("severity", "")
        age_m = a.get("age_minutes")
        age_str = f"{int(age_m)}m ago" if age_m and age_m < 120 else f"{round(age_m / 60, 1)}h ago" if age_m else ""

        crime_context += f"- [{tab}|{conf_label}|{reliability:.0%}|{src}] {a['title']}"
        if loc:
            crime_context += f" @ {loc}"
        elif hood and hood != "Other":
            crime_context += f" — {hood}"
        if sev and sev != "low":
            crime_context += f" [{sev.upper()}]"
        if age_str:
            crime_context += f" ({age_str})"
        crime_context += "\n"

    patterns = detect_patterns(crime_data)
    pattern_text = ""
    if patterns.get("hotspots"):
        pattern_text = "\n**Hotspot areas:** " + ", ".join(
            f"{h['neighborhood']} ({h['count']}, {h.get('dominant_type', 'mixed')})" for h in patterns["hotspots"][:5]
        )
    if patterns.get("insights"):
        pattern_text += "\n**Key patterns:**\n" + "\n".join(
            f"- [{i.get('severity', 'low').upper()}] {i['text']}" for i in patterns["insights"]
        )
    type_b = patterns.get("type_breakdown", {})
    if type_b:
        pattern_text += f"\n**Type breakdown:** Violent: {type_b.get('violent', 0)}, Property: {type_b.get('property', 0)}, Other: {type_b.get('other', 0)}"
    r48 = patterns.get("recent_48h", 0)
    if r48:
        pattern_text += f"\n**Last 48h:** {r48} incidents"

    # Current situation context for the AI
    situation_ctx = ""
    try:
        sit_cached = get_cached("ai_summaries")
        if sit_cached:
            situation_ctx = f"\n**Current situation:** {sit_cached.get('situation', '')} (Threat: {sit_cached.get('threat_level', 'unknown')})"
    except Exception:
        pass

    news_resp = await get_news()
    news_data = news_resp.get("articles", [])
    news_sources = sorted(set(a.get("source", "") for a in news_data))

    system_prompt = (
        "You are the principal analyst for the Albany County, NY Crime Tracker, using the full Grok 3 model. "
        "Your answers inform residents and stakeholders; accuracy and brevity outweigh speculation.\n\n"
        "JURISDICTION: Albany County, New York only — City of Albany; towns (Bethlehem, Coeymans, Colonie, "
        "Guilderland, Knox, New Scotland, Rensselaerville, Westerlo, Berne); cities (Cohoes, Watervliet); "
        "villages (Altamont, Green Island, Menands, Ravena, Voorheesville). "
        "If the user or data could mean another Albany (GA, OR, etc.), state that explicitly and do not treat it as local.\n\n"
        "METHOD:\n"
        "- Ground every factual claim in the incident feed or patterns below. If something is not in the data, say "
        "\"not in the current feed\" rather than guessing.\n"
        "- Cite provenance: name the outlet or official source and interpret CONF/MED/HIGH labels as "
        "HIGH ≥ 90%, MED ≥ 75%, LOW < 75% article confidence; reliability percentages are shown per line.\n"
        "- Prefer specific locations (street, intersection, hamlet, town) over generic regional wording.\n"
        "- Keep answers structured: short direct answer first, then bullets or ### sections if detail is needed.\n"
        "- Use markdown: **bold** for critical facts, lists for multiple incidents, `###` subheads for long replies.\n"
        "- Use > blockquotes only for actionable public-safety warnings supported by the feed.\n"
        "- Map coordinates: if asked, output a single ```json code block with "
        "[{\"label\": \"...\", \"lat\": 42.xxx, \"lng\": -73.xxx}] only for places you can justify from the data.\n\n"
        f"**Source universe ({len(news_sources)} feeds):** {', '.join(news_sources[:12])}\n\n"
        f"**Verified incident lines ({len(crime_data)} items):**\n{crime_context}"
        f"{pattern_text}"
        f"{situation_ctx}"
    )

    messages = [{"role": "system", "content": system_prompt}]
    for msg in history[-10:]:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_message})

    try:
        resp = await post_xai_chat({
            "model": XAI_MODEL,
            "messages": messages,
            "max_tokens": 1500,
            "temperature": 0.35,
            "stream": True,
        }, timeout=90.0)

        if resp.status_code != 200:
            return {"status": "error", "message": f"AI error: {resp.status_code}"}

        async def generate():
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].lstrip()
                if data_str.strip() == "[DONE]":
                    yield "data: [DONE]\n\n"
                    break
                try:
                    chunk = json.loads(data_str)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    raw = delta.get("content")
                    if raw is None:
                        content = ""
                    elif isinstance(raw, list):
                        content = "".join(
                            p if isinstance(p, str) else (p.get("text") or "")
                            for p in raw
                            if isinstance(p, (str, dict))
                        )
                    else:
                        content = raw if isinstance(raw, str) else str(raw)
                    if content:
                        yield f"data: {json.dumps({'content': content})}\n\n"
                except json.JSONDecodeError:
                    pass

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    except Exception as e:
        return {"status": "error", "message": str(e)}


# =============================================================================
# FBI NIBRS / AGENCY DATA
# =============================================================================
ALBANY_NIBRS_AGENCIES = [
    {"ori": "NY0010100", "name": "Albany Police Department", "type": "City", "nibrs": True, "population": 99224},
    {"ori": "NY0015300", "name": "Colonie Town Police Department", "type": "City", "nibrs": True, "population": 83604},
    {"ori": "NY0015100", "name": "Bethlehem Town Police Department", "type": "City", "nibrs": True, "population": 35142},
    {"ori": "NY0010000", "name": "Albany County Sheriff's Office", "type": "County", "nibrs": False, "population": None},
    {"ori": "NY0010200", "name": "Cohoes Police Department", "type": "City", "nibrs": False, "population": 18851},
    {"ori": "NY0010300", "name": "Watervliet Police Department", "type": "City", "nibrs": False, "population": 10689},
    {"ori": "NY0015200", "name": "Guilderland Town Police Department", "type": "City", "nibrs": False, "population": 37283},
    {"ori": "NY0012000", "name": "Green Island Village Police Department", "type": "City", "nibrs": False, "population": 2628},
    {"ori": "NY0012100", "name": "Altamont Village Police Department", "type": "City", "nibrs": False, "population": 1741},
    {"ori": "NY0012500", "name": "Menands Village Police Department", "type": "City", "nibrs": False, "population": 4355},
    {"ori": "NY0015800", "name": "Coeymans Town Police Department", "type": "City", "nibrs": False, "population": 7460},
    {"ori": "NY201UN00", "name": "SUNY Albany Police", "type": "University", "nibrs": False, "population": None},
    {"ori": "NY0017500", "name": "SUNY Albany (Plaza)", "type": "University", "nibrs": False, "population": None},
]

FBI_CDE_API_KEY = settings.fbi_api_key or "DEMO_KEY"
FBI_CDE_BASE = "https://api.usa.gov/crime/fbi/cde"


@app.get("/api/nibrs/agencies")
async def get_nibrs_agencies():
    return {
        "status": "ok",
        "county": "Albany",
        "state": "NY",
        "agencies": ALBANY_NIBRS_AGENCIES,
        "nibrs_count": sum(1 for a in ALBANY_NIBRS_AGENCIES if a["nibrs"]),
        "total_count": len(ALBANY_NIBRS_AGENCIES),
        "data_year": 2024,
        "source": "FBI Crime Data Explorer",
        "source_url": "https://nibrs.fbi.gov/2024/",
    }


@app.get("/api/nibrs/agency/{ori}")
async def get_nibrs_agency_detail(ori: str):
    cache_key = f"nibrs_{ori}"
    cached = get_cached(cache_key)
    if cached:
        return cached

    agency = next((a for a in ALBANY_NIBRS_AGENCIES if a["ori"] == ori), None)
    if not agency:
        return {"status": "error", "message": "Agency not found"}

    try:
        url = f"{FBI_CDE_BASE}/agency/{ori}/offenses/count/national/offense-category"
        params = {"api_key": FBI_CDE_API_KEY, "year": 2022}
        resp = await fetch_with_retry(
            http_client,
            url,
            params=params,
            timeout=settings.external_timeout_seconds,
            retries=settings.external_retry_attempts,
        )
        if resp and resp.status_code == 200:
            data = resp.json()
            result = {
                "status": "ok",
                "agency": agency,
                "offense_data": data,
                "source": "FBI Crime Data Explorer",
                "year": 2022,
            }
            set_cached(cache_key, result)
            return result
    except Exception as e:
        logger.warning("fbi_cde_error ori=%s error=%s", ori, e)

    return {
        "status": "ok",
        "agency": agency,
        "offense_data": None,
        "message": "FBI CDE data temporarily unavailable",
        "source": "FBI Crime Data Explorer",
        "year": 2022,
    }


# ── Multi-source scanner: OpenMHz + Broadcastify + RadioReference ──────

_OMHZ_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://openmhz.com/",
    "Origin": "https://openmhz.com",
}


async def _fetch_openmhz_calls() -> list[dict]:
    """Fetch decoded calls from OpenMHz (free, no auth).

    Tries the primary API endpoint first; falls back to an alternative
    path if Cloudflare blocks the primary or returns non-JSON.
    """
    OPENMHZ_SYSTEM = "albanycony"
    urls = [
        f"https://api.openmhz.com/{OPENMHZ_SYSTEM}/calls",
        f"https://openmhz.com/api/{OPENMHZ_SYSTEM}/calls",
    ]
    for url in urls:
        try:
            resp = await http_client.get(
                url,
                params={"num": 40},
                headers=_OMHZ_HEADERS,
                timeout=12.0,
            )
            if resp.status_code != 200:
                logger.warning("OpenMHz returned status %d from %s", resp.status_code, url)
                continue
            content_type = resp.headers.get("content-type", "")
            if "text/html" in content_type:
                logger.warning("OpenMHz returned HTML from %s (likely Cloudflare challenge)", url)
                continue
            data = resp.json()
            calls = []
            for call in data.get("calls", [])[:40]:
                audio_url = call.get("url", "")
                tg_num = str(call.get("talkgroup", "") or "")
                if not tg_num:
                    m = re.search(r"/(\d{4,6})/", audio_url)
                    if m:
                        tg_num = m.group(1)
                calls.append({
                    "id": f"omhz_{call.get('_id', '')}",
                    "time": call.get("time", ""),
                    "talkgroup_num": tg_num,
                    "talkgroup_tag": call.get("talkgroup_tag", "") or call.get("talkgroupTag", ""),
                    "talkgroup_description": call.get("talkgroup_description", "") or call.get("talkgroupDescription", ""),
                    "audio_url": audio_url,
                    "duration": call.get("len", 0) or call.get("duration", 0),
                    "freq": call.get("freq", 0),
                    "source": "openmhz",
                })
            if calls:
                return calls
        except Exception as e:
            logger.warning("OpenMHz fetch error from %s: %s", url, e)
            continue
    return []


async def _fetch_broadcastify_calls() -> list[dict]:
    """Fetch decoded calls from Broadcastify Calls API (requires API key)."""
    api_key = settings.broadcastify_api_key
    system_id = settings.broadcastify_system_id or "8553"
    if not api_key:
        # Optional source — skipped quietly when no key is configured.
        logger.debug("broadcastify_calls_skipped — optional API source, no BROADCASTIFY_API_KEY")
        return []

    try:
        # Broadcastify Calls API - fetch recent calls for Albany County system
        resp = await http_client.get(
            f"https://api.broadcastify.com/calls/node/{system_id}",
            params={"apiKey": api_key, "type": "json", "num": 40},
            timeout=12.0,
        )
        if resp.status_code != 200:
            logger.warning("Broadcastify API returned %d", resp.status_code)
            return []

        data = resp.json()
        calls_raw = data if isinstance(data, list) else data.get("calls", [])
        calls = []
        for call in calls_raw[:40]:
            tg = str(call.get("talkgroupID", "") or call.get("talkgroup", "") or "")
            calls.append({
                "id": f"bcfy_{call.get('id', call.get('callId', ''))}",
                "time": call.get("startTime", "") or call.get("time", ""),
                "talkgroup_num": tg,
                "talkgroup_tag": call.get("talkgroupAlpha", "") or call.get("talkgroup_tag", ""),
                "talkgroup_description": call.get("talkgroupDescription", "") or call.get("talkgroup_description", ""),
                "audio_url": call.get("audioUrl", "") or call.get("url", ""),
                "duration": call.get("duration", 0) or call.get("len", 0),
                "freq": call.get("freq", 0),
                "source": "broadcastify",
                # Extra Broadcastify metadata
                "enc": call.get("enc", 0),  # encrypted flag
                "emergency": call.get("emergency", 0),  # emergency flag
                "unit_ids": call.get("srcList", []),  # responding units
            })
        return calls
    except Exception as e:
        logger.warning("Broadcastify fetch error: %s", e)
        return []


# ── Broadcastify Calls Playlist fetcher ──────────────────────────────────
# Playlist: https://www.broadcastify.com/calls/playlists/?uuid=<UUID>&view=console
# The console is a JS app with no public JSON API for playlists.
# Strategy: scrape the playlist page HTML for embedded call data / JS state,
# then fall back to the Calls API using system IDs that the playlist covers.

_BCFY_PLAYLIST_CACHE: list[dict] = []
_BCFY_PLAYLIST_CACHE_TS: float = 0.0
_BCFY_PLAYLIST_CACHE_TTL: float = 45.0  # seconds

# System IDs covered by the Albany County playlist
# 8553 = Albany County P25 system (primary)
_BCFY_PLAYLIST_SYSTEM_IDS = ["8553"]


def _normalize_bcfy_call(call: dict, source_tag: str = "broadcastify_playlist") -> dict:
    """Normalize a Broadcastify call dict into our standard format."""
    tg = str(call.get("talkgroupID", "") or call.get("talkgroup", "") or call.get("tg", "") or "")
    ts = call.get("startTime", "") or call.get("start_time", "") or call.get("time", "") or call.get("ts", "") or ""
    audio = call.get("audioUrl", "") or call.get("audio_url", "") or call.get("url", "") or call.get("filename", "") or ""
    if audio and not audio.startswith("http"):
        audio = f"https://calls.broadcastify.com/{audio}"
    return {
        "id": f"bcfy_pl_{call.get('id', call.get('callId', tg + '_' + str(ts)))}",
        "time": ts,
        "talkgroup_num": tg,
        "talkgroup_tag": call.get("talkgroupAlpha", "") or call.get("talkgroup_tag", "") or call.get("tgAlpha", "") or "",
        "talkgroup_description": call.get("talkgroupDescription", "") or call.get("talkgroup_description", "") or call.get("tgDescr", "") or "",
        "audio_url": audio,
        "duration": call.get("duration", 0) or call.get("len", 0) or call.get("callDuration", 0),
        "freq": call.get("freq", 0) or call.get("frequency", 0),
        "source": source_tag,
        "enc": call.get("enc", 0),
        "emergency": call.get("emergency", 0),
        "unit_ids": call.get("srcList", []) or call.get("sources", []),
        "_playlist_uuid": settings.broadcastify_playlist_uuid,
    }


async def _fetch_broadcastify_playlist_calls() -> list[dict]:
    """
    Fetch recent calls for the Albany County Broadcastify Calls playlist.

    Approach (in priority order):
      1) Scrape the playlist console page for any embedded JSON/JS call data
      2) Hit the Calls API for each system ID the playlist covers
      3) Try the public calls listing page for the system
    """
    global _BCFY_PLAYLIST_CACHE, _BCFY_PLAYLIST_CACHE_TS

    uuid = settings.broadcastify_playlist_uuid
    if not uuid:
        return []

    # Short-lived cache
    if _BCFY_PLAYLIST_CACHE and (time.time() - _BCFY_PLAYLIST_CACHE_TS) < _BCFY_PLAYLIST_CACHE_TTL:
        return _BCFY_PLAYLIST_CACHE

    calls: list[dict] = []

    # ── Strategy 1: Scrape the playlist console page for embedded data ────
    try:
        console_url = f"https://www.broadcastify.com/calls/playlists/?uuid={uuid}&view=console"
        resp = await http_client.get(
            console_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            timeout=15.0,
            follow_redirects=True,
        )
        if resp.status_code == 200:
            html = resp.text
            # Look for embedded JSON data (Broadcastify often injects call data into the page)
            for pattern in [
                r'(?:initialCalls|callData|recentCalls|calls)\s*[:=]\s*(\[[\s\S]*?\])\s*[;,]',
                r'data-calls=["\'](\[[\s\S]*?\])["\']',
                r'"calls"\s*:\s*(\[[\s\S]*?\])',
            ]:
                match = re.search(pattern, html)
                if match:
                    try:
                        raw = json.loads(match.group(1))
                        if isinstance(raw, list) and len(raw) > 0:
                            for c in raw[:60]:
                                if isinstance(c, dict):
                                    calls.append(_normalize_bcfy_call(c))
                            logger.info("bcfy_playlist_scraped_html calls=%d", len(calls))
                            break
                    except (json.JSONDecodeError, Exception):
                        continue

            # Also extract system IDs referenced in the page for Strategy 2
            sys_matches = re.findall(r'systemId["\s:=]+["\']?(\d{3,6})["\']?', html)
            if sys_matches:
                for sid in sys_matches:
                    if sid not in _BCFY_PLAYLIST_SYSTEM_IDS:
                        _BCFY_PLAYLIST_SYSTEM_IDS.append(sid)
                logger.debug("bcfy_playlist_systems_from_html systems=%s", _BCFY_PLAYLIST_SYSTEM_IDS)
        else:
            logger.debug("bcfy_playlist_console_non200 status=%d", resp.status_code)
    except Exception as e:
        logger.debug("bcfy_playlist_console_error error=%s", e)

    # ── Strategy 2: Optional Calls API enrichment for each system ID ──────
    # The API key is NOT required — the scrape strategies above and the public
    # live-audio → Whisper pipeline already work without it. When a key happens
    # to be configured we use the official API as a higher-fidelity source.
    if not calls:
        api_key = settings.broadcastify_api_key
        if api_key:
            for sys_id in _BCFY_PLAYLIST_SYSTEM_IDS:
                try:
                    resp = await http_client.get(
                        f"https://api.broadcastify.com/calls/node/{sys_id}",
                        params={"apiKey": api_key, "type": "json", "num": 50},
                        timeout=12.0,
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        raw = data if isinstance(data, list) else data.get("calls", [])
                        for c in raw[:50]:
                            if isinstance(c, dict):
                                calls.append(_normalize_bcfy_call(c))
                        if calls:
                            logger.info("bcfy_playlist_api_fetched sys=%s calls=%d", sys_id, len(calls))
                    else:
                        logger.debug("bcfy_playlist_api_non200 sys=%s status=%d", sys_id, resp.status_code)
                except Exception as e:
                    logger.debug("bcfy_playlist_api_error sys=%s error=%s", sys_id, e)
        else:
            # No key configured — expected; the optional API enrichment is simply skipped.
            logger.debug("bcfy_playlist_api_enrichment_skipped — no BROADCASTIFY_API_KEY (optional)")

    # ── Strategy 3: Scrape the public system calls page ───────────────────
    if not calls:
        for sys_id in _BCFY_PLAYLIST_SYSTEM_IDS:
            try:
                sys_url = f"https://www.broadcastify.com/calls/node/{sys_id}"
                resp = await http_client.get(
                    sys_url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Accept": "text/html,*/*",
                    },
                    timeout=12.0,
                    follow_redirects=True,
                )
                if resp.status_code == 200:
                    # Look for call data in the public page
                    for pattern in [
                        r'(?:calls|recentCalls|callData)\s*[:=]\s*(\[[\s\S]*?\])\s*[;,]',
                        r'"calls"\s*:\s*(\[[\s\S]*?\])',
                    ]:
                        match = re.search(pattern, resp.text)
                        if match:
                            try:
                                raw = json.loads(match.group(1))
                                if isinstance(raw, list):
                                    for c in raw[:50]:
                                        if isinstance(c, dict):
                                            calls.append(_normalize_bcfy_call(c))
                                    if calls:
                                        logger.info("bcfy_playlist_page_scraped sys=%s calls=%d", sys_id, len(calls))
                                    break
                            except Exception:
                                continue
            except Exception as e:
                logger.debug("bcfy_playlist_page_error sys=%s error=%s", sys_id, e)

    if not calls:
        # Non-blocking: the playlist console is login-walled for guests, so this
        # path may legitimately return nothing. Live scanner coverage comes from
        # the public live-audio → Whisper pipeline (/api/scanner/stream-alerts);
        # no Broadcastify API key is required for the app to work.
        logger.debug(
            "bcfy_playlist_empty — no calls from playlist scrape (expected when console requires login). "
            "Playlist UUID=%s, systems=%s",
            uuid, _BCFY_PLAYLIST_SYSTEM_IDS,
        )

    _BCFY_PLAYLIST_CACHE = calls
    _BCFY_PLAYLIST_CACHE_TS = time.time()
    return calls


async def _fetch_radioreference_talkgroups() -> dict[str, dict]:
    """Merged RadioReference SOAP + Albany/Schenectady P25 wiki seed (TalkgroupMapper)."""
    return await get_talkgroup_mapper().get_merged_talkgroups()


def _enrich_call_with_rr(call: dict, rr_talkgroups: dict[str, dict]) -> dict:
    """Enrich a scanner call with RadioReference talkgroup metadata."""
    return get_radioreference_ws_adapter().enrich_call(call, rr_talkgroups)


def _dedupe_calls(all_calls: list[dict]) -> list[dict]:
    """Deduplicate calls across sources by talkgroup + time proximity (30s)."""
    deduped = []
    seen = {}
    for call in all_calls:
        tg = call.get("talkgroup_num", "")
        t = call.get("time", "")
        try:
            ts = datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() if t else 0
        except Exception:
            ts = 0
        key = f"{tg}_{int(ts // 30)}"
        if key in seen:
            # Prefer Broadcastify sources (more metadata) over OpenMHz
            src = call.get("source", "")
            prev_src = seen[key].get("source", "")
            if src in ("broadcastify", "broadcastify_playlist") and prev_src == "openmhz":
                # Replace with Broadcastify version
                for i, d in enumerate(deduped):
                    if d is seen[key]:
                        deduped[i] = call
                        seen[key] = call
                        break
            continue
        seen[key] = call
        deduped.append(call)
    return deduped


def _scanner_call_tgid(call: dict[str, Any]) -> str:
    raw = call.get("talkgroup_num") if call.get("talkgroup_num") is not None else call.get("talkgroup")
    if raw is None:
        return ""
    s = str(raw).strip()
    if s.isdigit():
        s = str(int(s))
    return s


async def _merge_scanner_calls_from_sources(
    *, write_cache: bool = False
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    """Shared merge path for /api/scanner/calls and live-feed priority P25 rows."""
    openmhz_task = _fetch_openmhz_calls()
    broadcastify_task = _fetch_broadcastify_calls()
    bcfy_playlist_task = _fetch_broadcastify_playlist_calls()
    rr_task = _fetch_radioreference_talkgroups()

    openmhz_calls, bcfy_calls, bcfy_playlist_calls, rr_talkgroups = await asyncio.gather(
        openmhz_task, broadcastify_task, bcfy_playlist_task, rr_task,
        return_exceptions=True,
    )

    if isinstance(openmhz_calls, Exception):
        logger.warning("OpenMHz exception: %s", openmhz_calls)
        openmhz_calls = []
    if isinstance(bcfy_calls, Exception):
        logger.warning("Broadcastify exception: %s", bcfy_calls)
        bcfy_calls = []
    if isinstance(bcfy_playlist_calls, Exception):
        logger.warning("Broadcastify playlist exception: %s", bcfy_playlist_calls)
        bcfy_playlist_calls = []
    rr_map: dict[str, Any] = {}
    if isinstance(rr_talkgroups, Exception):
        logger.warning("RadioReference exception: %s", rr_talkgroups)
        rr_talkgroups = {}
    if isinstance(rr_talkgroups, dict):
        rr_map = rr_talkgroups
    if not rr_map:
        rr_map = get_talkgroup_mapper().merge_rr_with_wiki({})

    sources_used: list[str] = []
    if openmhz_calls:
        sources_used.append("openmhz")
    if bcfy_calls:
        sources_used.append("broadcastify")
    if bcfy_playlist_calls:
        sources_used.append("broadcastify_playlist")
    if rr_map:
        sources_used.append("radioreference")

    all_calls = list(openmhz_calls) + list(bcfy_calls) + list(bcfy_playlist_calls)
    all_calls.sort(key=lambda c: c.get("time", ""), reverse=True)
    merged = _dedupe_calls(all_calls)
    if rr_map:
        merged = [_enrich_call_with_rr(c, rr_map) for c in merged]
    for call in merged:
        if call.get("emergency"):
            call["is_emergency"] = True
        if call.get("unit_ids"):
            call["responding_units"] = call.get("unit_ids", [])
    if merged and sources_used:
        merged[0] = {**merged[0], "_sources": sources_used}
    if write_cache and merged:
        set_cached("scanner_calls", merged)
    return merged, sources_used, rr_map


async def _priority_p25_scanner_signal_articles(
    merged_calls: list[dict[str, Any]],
    *,
    merged_tg_index: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    """
    One feed row per priority talkgroup hit (deduped per minute) with provenance + optional 511NY snapshot.
    """
    mapper = get_talkgroup_mapper()
    pri = mapper.priority_ids()
    tg_index = merged_tg_index if merged_tg_index is not None else await mapper.get_merged_talkgroups()
    try:
        fusion_rows = await get_511_adapter().fetch_rows(limit_per_source=10)
    except Exception as exc:
        logger.warning("priority_p25_511_fusion_error error=%s", exc)
        fusion_rows = []
    fusion_snap = [
        {
            "title": r.get("title"),
            "link": r.get("link"),
            "municipality": r.get("municipality"),
        }
        for r in fusion_rows[:6]
        if isinstance(r, dict)
    ]

    articles: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, int, str]] = set()
    for call in merged_calls:
        tg = _scanner_call_tgid(call)
        if not tg or tg not in pri:
            continue
        t_raw = str(call.get("time", "") or "")
        try:
            ts = datetime.fromisoformat(t_raw.replace("Z", "+00:00")).timestamp() if t_raw else 0.0
        except Exception:
            ts = 0.0
        bkey = (tg, int(ts // 60), str(call.get("source") or ""))
        if bkey in seen_keys:
            continue
        seen_keys.add(bkey)

        row = tg_index.get(tg) or {}
        label = (
            str(call.get("wiki_channel_label") or row.get("wiki_channel_label") or row.get("alpha") or f"TG {tg}")
        )
        wiki_long = str(row.get("wiki_description") or "")
        emergency = bool(call.get("emergency") or call.get("is_emergency"))
        conf = TalkgroupMapper.confidence_01(call, row)

        audio = str(call.get("audio_url") or "").strip()
        src = str(call.get("source") or "scanner")
        aid = f"p25_pri_{tg}_{int(ts)}_{src}".replace(" ", "_")[:120]
        muni = str(row.get("municipality") or row.get("jurisdiction_hint") or "Albany County")
        title = f"P25 priority · {label} (TG {tg})"
        if emergency:
            title = f"Emergency · {title}"
        desc_parts = [wiki_long] if wiki_long else []
        desc_parts.append(f"Source: {src}. Scanner audio metadata only — not verified as a published incident.")
        if audio:
            desc_parts.append("Audio clip available.")
        description = " ".join(x for x in desc_parts if x)[:900]

        articles.append(
            {
                "id": aid,
                "guid": aid,
                "title": title,
                "summary": description,
                "description": description,
                "link": audio or "https://openmhz.com/system/albanycony",
                "pubDate": t_raw
                if t_raw
                else format_datetime(datetime.now(timezone.utc), usegmt=True),
                "source": "Scanner · Albany/Schenectady P25 (priority TG)",
                "source_name": "Albany/Schenectady P25 priority talkgroup",
                "source_url": audio or str(SCANNER_ALBANY_P25_MAIN.get("wiki_reference") or ""),
                "confidence": conf,
                "event_type": "scanner_signal",
                "municipality": muni,
                "matched_location": muni,
                "_scanner_call": True,
                "_scanner_priority_p25": True,
                "_scanner_critical_live": emergency,
                "_scanner_recent_live": not emergency,
                "_scanner_tg": tg,
                "source_priority": SOURCE_PRIORITY_SCANNER_CRITICAL if emergency else SOURCE_PRIORITY_SCANNER_RECENT,
                "_feed_reliability": 0.55,
                "incident": {
                    "id": aid,
                    "event_type": "scanner_signal",
                    "status": "active" if emergency else "recent",
                    "severity": "high" if emergency else "medium",
                    "source_type": "scanner",
                    "source_name": "Albany/Schenectady P25 priority TG",
                    "source_url": audio or "",
                    "verification_level": "scanner",
                    "confidence_score": conf,
                    "municipality": muni,
                    "operational_badges": [
                        "scanner",
                        "priority_p25",
                        "radioreference" if row.get("rr_row_present") else "wiki_seed",
                    ],
                },
                "raw_payload": {
                    "source_class": "scanner_priority_p25",
                    "trust_tier": "tier_3",
                    "lane": "developing_incidents",
                    "ingestion": "scanner_albany_p25_main",
                    "registry": {
                        "system_id": SCANNER_ALBANY_P25_MAIN.get("system_id"),
                        "wacn": SCANNER_ALBANY_P25_MAIN.get("wacn"),
                        "radioreference_sid": SCANNER_ALBANY_P25_MAIN.get("radioreference_sid"),
                        "ctid": SCANNER_ALBANY_P25_MAIN.get("ctid"),
                    },
                    "provenance": {
                        "raw_call": {
                            "source": call.get("source"),
                            "time": call.get("time"),
                            "talkgroup_num": call.get("talkgroup_num"),
                            "audio_url": call.get("audio_url"),
                            "duration": call.get("duration"),
                            "emergency": call.get("emergency"),
                        },
                        "merged_talkgroup_row": row,
                        "verification_note": (
                            "Raw scanner metadata + RR/wiki mapping; not an official record until corroborated."
                        ),
                        "511ny_fusion_snapshot": fusion_snap,
                    },
                    "raw_vs_verified": {
                        "has_audio_url": bool(audio),
                        "rr_metadata": bool(row.get("rr_row_present")),
                        "wiki_seed": bool(row.get("wiki_seeded")),
                    },
                },
                "provenance": _build_incident_provenance(
                    source_class="scanner_priority_p25",
                    source_id="scanner_albany_p25_main",
                    trust_tier="tier_3",
                    lane="developing_incidents",
                    ingestion_method="openmhz_api",
                    feed_url=audio or "https://openmhz.com/system/albanycony",
                    captured_at=t_raw or datetime.now(timezone.utc).isoformat(),
                    raw_fields_hash=hashlib.sha256(
                        f"{tg}:{t_raw}:{audio}".encode("utf-8", errors="ignore")
                    ).hexdigest()[:16],
                    content_type="scanner_call",
                    capture_method="soap" if row.get("rr_row_present") else "wiki",
                ),
            }
        )
    return articles


@app.get("/api/scanner/calls")
async def get_scanner_calls(channel: Optional[str] = None):
    """Merged scanner calls from OpenMHz / Broadcastify / playlist.

    Optional `channel` filter restricts to calls whose talkgroup is a
    member of the named virtual channel from data/scanner_channels.json
    (e.g. `apd`, `bethlehem_public_safety`, `nysp_troop_g`). Every
    returned call also carries `channel_id` + `channel_label` stamped
    in via app.services.scanner_channels.enrich_call_with_channel so
    the UI can group without re-walking the registry.
    """
    from app.services.scanner_channels import (
        call_matches_channel,
        enrich_call_with_channel,
    )

    cache_key = "scanner_calls"
    cached = get_cached(cache_key)
    if cached:
        merged = list(cached)
        sources_used_local = cached[0].get("_sources", []) if cached else []
        source_label = "cache"
    else:
        merged_fresh, sources_used_fresh, _rr_map = await _merge_scanner_calls_from_sources(write_cache=True)
        merged = list(merged_fresh)
        sources_used_local = sources_used_fresh
        source_label = (
            "multi" if len(sources_used_fresh) > 1
            else (sources_used_fresh[0] if sources_used_fresh else "unavailable")
        )

    # Stamp channel attribution on every call. Defensive try/except so
    # a missing/malformed scanner_channels.json never breaks the
    # endpoint — the calls list still returns, just without the stamp.
    try:
        for c in merged:
            enrich_call_with_channel(c)
    except Exception as exc:
        logger.warning("scanner_channel_enrich_failed error=%s", exc)

    if channel:
        try:
            merged = [c for c in merged if call_matches_channel(c, channel)]
        except Exception as exc:
            logger.warning("scanner_channel_filter_failed channel=%s error=%s",
                           channel[:60], exc)

    return {
        "status": "ok",
        "source": source_label,
        "sources_used": sources_used_local,
        "channel": channel or None,
        "calls": merged,
    }


@app.get("/api/scanner/channels")
async def get_scanner_channels():
    """Virtual channel registry — agency / region rollups of P25
    talkgroups so the scanner UI can present "Bethlehem Public Safety"
    or "Albany City Unified" without depending on a single live stream.

    Backed by data/scanner_channels.json. Read-only, no auth, cheap
    enough to compute that no caching is needed (small static file)."""
    from app.services.scanner_channels import channels_payload
    try:
        payload = channels_payload()
    except Exception as exc:
        logger.warning("scanner_channels_payload_failed error=%s", exc)
        return {"status": "error", "channels": [], "regions": [],
                "talkgroup_index": {}, "message": "channel registry unavailable"}
    return {
        "status": "ok",
        **payload,
    }


@app.post("/api/scanner/summarize")
async def scanner_summarize(request: Request):
    openai_key = settings.openai_api_key
    if not openai_key:
        return {"status": "error", "message": "OPENAI_API_KEY not configured"}
    try:
        body = await request.json()
    except Exception:
        return {"status": "error", "message": "invalid request body"}
    calls = body.get("calls") if isinstance(body, dict) else None
    if not isinstance(calls, list) or not calls:
        return {"status": "error", "message": "no calls provided"}

    batch = calls[:5]
    call_descriptions = []
    for i, c in enumerate(batch):
        tag = str(c.get("talkgroup_tag") or c.get("talkgroup_description") or "unknown")
        dur = c.get("duration") or c.get("len") or 0
        tg = str(c.get("talkgroup_num") or c.get("talkgroup") or "?")
        freq = c.get("freq") or 0
        freq_mhz = f"{freq / 1e6:.4f}" if freq else "?"
        call_descriptions.append(
            f"Call {i+1}: talkgroup={tg}, tag={tag}, duration={dur}s, freq={freq_mhz} MHz"
        )

    prompt_text = (
        "You are a public safety radio analyst for Albany County, NY. "
        "For each scanner call below, produce a structured summary.\n\n"
        "Calls:\n" + "\n".join(call_descriptions) + "\n\n"
        "For each call return JSON: {\"summaries\": [{\"index\": 0, \"agency\": \"...\", "
        "\"discipline\": \"police|fire|ems\", \"call_type\": \"...\", "
        "\"location_hint\": \"...\", \"keywords\": [\"...\"], "
        "\"summary\": \"one concise sentence\"}]}\n"
        "Return ONLY valid JSON."
    )

    try:
        resp = await http_client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {openai_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt_text}],
                "response_format": {"type": "json_object"},
                "temperature": 0.15,
                "max_tokens": 600,
            },
            timeout=15.0,
        )
        if resp.status_code != 200:
            return {"status": "error", "message": f"openai_http_{resp.status_code}"}
        result = resp.json()
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        parsed = _json.loads(content)
        return {"status": "ok", "summaries": parsed.get("summaries", [])}
    except Exception as exc:
        logger.warning("scanner_summarize_error: %s", exc)
        return {"status": "error", "message": str(exc)}


# ── Whisper transcription for scanner audio ──────────────────────────────

# Critical keywords to flag in transcriptions (police codes, emergency terms)
SCANNER_ALERT_KEYWORDS = [
    # Violent
    "shooting", "shot", "shots fired", "gunshot", "gun", "firearm", "weapon",
    "stabbing", "stabbed", "knife", "assault", "fight", "domestic",
    # Pursuit / tactical
    "pursuit", "chase", "fleeing", "foot chase", "vehicle pursuit",
    "standoff", "barricade", "swat", "hostage", "armed",
    # Critical
    "officer down", "officer involved", "ois", "10-13", "signal 99",
    "robbery", "robbery in progress", "burglary in progress",
    "missing", "abduction", "amber alert",
    "homicide", "doa", "deceased", "fatality",
    # Fire / EMS critical
    "structure fire", "working fire", "entrapment", "rescue",
    "cardiac arrest", "unresponsive", "overdose", "od",
    "mass casualty", "mci", "hazmat",
    # General urgency
    "emergency", "urgent", "expedite", "code 3", "priority",
]

# In-memory transcription cache: audio_url -> {text, keywords, alert_level, timestamp}
_whisper_cache: dict[str, dict] = {}
_whisper_lock = asyncio.Lock()

# Rate limiting: max concurrent transcriptions
_whisper_semaphore = asyncio.Semaphore(3)

# Whisper 429 circuit breaker. OpenAI returns 429 when the account is rate-
# limited / over quota. Hammering it (47/47 failed calls in prod) just burns
# the limit and floods logs. When we hit 429 we open the breaker for a cooldown
# so the pipeline stops calling Whisper, then auto-recovers when quota frees up.
_whisper_429_until: float = 0.0
_WHISPER_429_COOLDOWN_S = 300.0  # 5 min backoff after a 429
# Last transcription failure (for /api/scanner/stream-status diagnostics).
_LAST_TRANSCRIBE_ERROR: dict[str, Any] = {"provider": "", "status": 0, "body": "", "at": ""}


def _whisper_breaker_open() -> bool:
    return time.time() < _whisper_429_until


def _trip_whisper_breaker(retry_after: Optional[str] = None) -> None:
    global _whisper_429_until
    cooldown = _WHISPER_429_COOLDOWN_S
    if retry_after:
        try:
            cooldown = max(cooldown, float(retry_after))
        except (TypeError, ValueError):
            pass
    _whisper_429_until = time.time() + cooldown
    logger.warning("whisper_429_breaker_open cooldown_s=%.0f (transcription provider rate-limited/over quota)", cooldown)


def _transcription_provider() -> tuple[str, str, str, str]:
    """Pick the speech-to-text provider. Returns (url, api_key, model, provider).

    Priority (override with TRANSCRIBE_PROVIDER=xai|groq|openai):
      1. xAI Grok STT (api.x.ai/v1/stt, model grok-stt) using the existing
         XAI_API_KEY — preferred, since that key already powers Grok fusion.
      2. Groq Whisper-large-v3-turbo (free, OpenAI-compatible).
      3. OpenAI Whisper.
    Note: xAI STT uses a DIFFERENT multipart shape than the OpenAI-compatible
    providers — request building branches on the provider name.
    """
    pref = (os.getenv("TRANSCRIBE_PROVIDER") or "").strip().lower()
    xai = (XAI_API_KEY or "").strip()
    groq = (os.getenv("GROQ_API_KEY") or "").strip()
    openai_key = (settings.openai_api_key or "").strip()

    def _xai():
        return ("https://api.x.ai/v1/stt", xai,
                (os.getenv("XAI_TRANSCRIBE_MODEL") or "grok-stt").strip(), "xai")

    def _groq():
        return ("https://api.groq.com/openai/v1/audio/transcriptions", groq,
                (os.getenv("GROQ_TRANSCRIBE_MODEL") or "whisper-large-v3-turbo").strip(), "groq")

    def _openai():
        return ("https://api.openai.com/v1/audio/transcriptions", openai_key,
                (os.getenv("SCANNER_TRANSCRIBE_MODEL") or "whisper-1").strip(), "openai")

    if pref == "xai" and xai:
        return _xai()
    if pref == "groq" and groq:
        return _groq()
    if pref == "openai" and openai_key:
        return _openai()
    # Default preference order.
    if xai:
        return _xai()
    if groq:
        return _groq()
    return _openai()


def _build_transcription_files(provider: str, model: str, filename: str, mime: str,
                               audio_bytes: bytes, hint: str = "") -> dict:
    """Build the multipart payload for the chosen STT provider.
    xAI STT uses `format`/`keyterm`; OpenAI-compatible uses `prompt`."""
    if provider == "xai":
        # xAI STT — match the official docs payload (no `model` field; endpoint
        # defaults to grok-stt). NOTE: keyterm has a hard 50-char limit.
        files: dict = {
            "file": (filename, io.BytesIO(audio_bytes), mime),
            "format": (None, "true"),
            "language": (None, "en"),
            "keyterm": (None, "Albany County police fire EMS dispatch"),  # 38 chars
        }
        return files
    # OpenAI-compatible (OpenAI / Groq)
    files = {
        "file": (filename, io.BytesIO(audio_bytes), mime),
        "model": (None, model),
        "language": (None, "en"),
    }
    if hint:
        files["prompt"] = (None, hint)
    return files


_AD_NOISE_PATTERNS = [
    "broadcastify", "broadcast", "scanner radio",
    "premium", "subscribe", "subscription",
    "commercial", "advertisement", "sponsor",
    "brought to you by", "this feed is provided",
    "radioreference", "radio reference",
    "visit us at", "visit our website", "visit www",
    "for more information visit", "more information",
    "download the app", "available on",
    "thank you for listening", "thanks for listening",
    "support this feed", "feed provider",
    "listeners", "streaming",
    "sign up", "free trial", "upgrade",
    "promo code", "discount",
    "holiday sale", "black friday",
    "dot com", ".com", ".gov", ".org", ".net",
    "limited time", "act now", "call now",
    "toll free", "1-800", "1-888", "1-877",
    "money back", "guarantee",
    "customer service", "satisfaction",
    "fema", "ready.gov", "preparedness",
    "every mile", "opportunity", "discover something",
    "weather service", "national weather",
    "public service announcement",
    "this is a test", "test of the",
    "emergency alert system", "eas test",
]

_AD_NOISE_THRESHOLD = 2


def _is_ad_or_noise(text: str) -> bool:
    """Detect Broadcastify ad breaks, promos, Whisper hallucinations, and non-dispatch audio."""
    if not text:
        return True
    lower = text.lower().strip()
    if len(lower) < 15:
        return True
    # Whisper prompt echo — model outputs the prompt when audio is silence/noise
    if "10-codes, signal codes, street names" in lower:
        return True
    if "common streets" in lower and "10-codes" in lower:
        return True
    if lower.startswith("10-codes"):
        return True
    # Count ad-pattern matches
    hits = sum(1 for p in _AD_NOISE_PATTERNS if p in lower)
    if hits >= _AD_NOISE_THRESHOLD:
        return True
    # Catch repetitive filler (Whisper hallucinates on silence/music)
    words = lower.split()
    if len(words) >= 6:
        unique = set(words)
        if len(unique) <= len(words) * 0.3:
            return True
    if lower.count("thank you") >= 3 or lower.count("you") >= 8:
        return True
    return False


def _scan_for_keywords(text: str) -> list[str]:
    """Find critical keywords in transcription text."""
    lower = text.lower()
    found = []
    for kw in SCANNER_ALERT_KEYWORDS:
        if kw in lower:
            found.append(kw)
    return found


def _alert_level(keywords: list[str]) -> str:
    """Determine alert level from matched keywords."""
    if not keywords:
        return "none"
    critical = {
        "shooting", "shots fired", "shot", "officer down", "officer involved",
        "ois", "10-13", "signal 99", "homicide", "hostage", "armed",
        "mass casualty", "mci", "amber alert", "abduction",
    }
    high = {
        "gun", "firearm", "weapon", "stabbing", "stabbed", "pursuit",
        "chase", "standoff", "barricade", "swat", "robbery",
        "structure fire", "working fire", "entrapment", "cardiac arrest",
        "overdose", "unresponsive",
    }
    for kw in keywords:
        if kw in critical:
            return "critical"
    for kw in keywords:
        if kw in high:
            return "high"
    return "medium"


def _merge_scanner_keywords(base_keywords: list[str], analysis: Optional[dict[str, Any]]) -> list[str]:
    merged: list[str] = []
    for kw in list(base_keywords or []) + list((analysis or {}).get("keywords") or []):
        kw_s = str(kw or "").strip()
        if kw_s and kw_s not in merged:
            merged.append(kw_s)
    return merged


def _max_scanner_alert_level(base_level: str, analysis: Optional[dict[str, Any]]) -> str:
    rank = {"none": 0, "medium": 1, "high": 2, "critical": 3}
    analysis_level = str((analysis or {}).get("alert_level") or "none").strip().lower()
    if analysis_level not in rank:
        analysis_level = "none"
    current_level = str(base_level or "none").strip().lower()
    if current_level not in rank:
        current_level = "none"
    return analysis_level if rank[analysis_level] > rank[current_level] else current_level


def _scanner_call_channel_name(call: dict[str, Any]) -> str:
    return str(
        call.get("talkgroup_tag")
        or call.get("talkgroup_description")
        or call.get("talkgroup_num")
        or call.get("feed_name")
        or "scanner"
    ).strip()


def _scanner_call_source_name(call: dict[str, Any]) -> str:
    return str(call.get("source") or call.get("feed_name") or "scanner").strip()


def _scanner_call_timestamp(call: dict[str, Any]) -> str:
    return str(call.get("time") or call.get("startTime") or datetime.now(timezone.utc).isoformat()).strip()


def _scanner_call_municipality_hint(call: dict[str, Any]) -> str:
    raw = str(call.get("municipality") or call.get("matched_location") or "Albany County").strip()
    if raw.lower() == "albany":
        return "City of Albany"
    return raw


_SCANNER_TRANSCRIBE_PROMPT_BASE = (
    "Albany County NY police fire EMS dispatch radio. "
    "10-codes, signal codes, street names, locations. "
    "Common streets: Central, Washington, State, New Scotland, Western, "
    "Delaware, Lark, Madison, Pearl, Broadway. "
    "Municipalities: Albany, Colonie, Bethlehem, Guilderland, Cohoes, "
    "Watervliet, Green Island, Menands, Ravena, Voorheesville, Altamont."
)

_SCANNER_TRANSCRIBE_PROMPT_POLICE = (
    _SCANNER_TRANSCRIBE_PROMPT_BASE
    + " Police dispatch: expect 10-codes, signal 99, officer needed assist, "
    "BOLO, subject descriptions, plates, traffic stop, pursuit, foot pursuit, "
    "shots fired, weapon, suspect, felony stop."
)

_SCANNER_TRANSCRIBE_PROMPT_FIRE = (
    _SCANNER_TRANSCRIBE_PROMPT_BASE
    + " Fire dispatch: expect structure fire, working fire, engine, truck, "
    "ladder, rescue, tones, box alarm, mutual aid, hydrant, smoke showing, "
    "all clear, command, tanker, chief."
)

_SCANNER_TRANSCRIBE_PROMPT_EMS = (
    _SCANNER_TRANSCRIBE_PROMPT_BASE
    + " EMS dispatch: expect ALS, BLS, medic, ambulance, cardiac arrest, "
    "stroke alert, STEMI, overdose, unresponsive, CPR, trauma alert, "
    "transport, receiving hospital, Albany Med, St. Peter's, Ellis."
)


def _scanner_discipline_from_call(call: dict[str, Any]) -> str:
    """Classify a scanner call as 'police', 'fire', 'ems', or 'unknown'
    based on talkgroup tag/description. Used only to pick the Whisper
    prompt — all downstream logic remains neutral.
    """
    blob = " ".join(
        str(v or "").lower() for v in (
            call.get("talkgroup_tag"),
            call.get("talkgroup_description"),
            call.get("tgAlpha"),
            call.get("tgDescr"),
            call.get("feed_name"),
        )
    )
    if not blob.strip():
        return "unknown"
    # EMS first so "fire/ems" talkgroups don't get misclassified as fire.
    if any(k in blob for k in ("ems", "medic", "ambulance", "paramedic", "rescue ems")):
        return "ems"
    if any(k in blob for k in ("fire", "fd ", "fd-", " fd", "rescue", "engine", "ladder")):
        return "fire"
    if any(k in blob for k in (
        "police", "pd ", "pd-", " pd", "law", "sheriff", "state police",
        "trooper", "nysp", "patrol",
    )):
        return "police"
    return "unknown"


_SCANNER_DISCIPLINE_HINTS = {
    "police": (
        "Police dispatch: 10-codes, signal 99, officer needed assist, "
        "BOLO, subject descriptions, plates, traffic stop, pursuit, "
        "foot pursuit, shots fired, weapon, suspect, felony stop."
    ),
    "fire": (
        "Fire dispatch: structure fire, working fire, engine, truck, "
        "ladder, rescue, tones, box alarm, mutual aid, hydrant, "
        "smoke showing, all clear, command, tanker, chief."
    ),
    "ems": (
        "EMS dispatch: ALS, BLS, medic, ambulance, cardiac arrest, "
        "stroke alert, STEMI, overdose, unresponsive, CPR, trauma alert, "
        "transport, receiving hospital, Albany Med, St. Peter's, Ellis."
    ),
}

# Per-region proper-noun hints. Whisper's `prompt` field biases the model
# toward listed terms — these augment the base prompt so transcripts of
# Bethlehem-area calls are more likely to spell "Slingerlands" / "Selkirk"
# correctly than the generic Albany-City-leaning base prompt would. Only
# the regions where local proper nouns differ meaningfully from the base
# need entries here; capital_albany / county_wide rely on the base.
_REGION_PROMPT_HINTS = {
    "bethlehem_area": (
        "Bethlehem area landmarks: Delaware Avenue, Delmar, Elsmere, "
        "Slingerlands, Selkirk, Glenmont, North Bethlehem."
    ),
    "colonie_area": (
        "Colonie area landmarks: Wolf Road, Latham, Loudonville, "
        "Newtonville, Westmere, Central Avenue."
    ),
    "guilderland_area": (
        "Guilderland area landmarks: Western Avenue, Western Turnpike, "
        "Crossgates Mall, Altamont, Voorheesville, McKownville."
    ),
    "coeymans_ravena": (
        "Coeymans / Ravena landmarks: Route 144, Route 9W, "
        "Coeymans Landing, Selkirk, Mountain Road."
    ),
    "cohoes_watervliet_green_island": (
        "Cohoes / Watervliet / Green Island landmarks: "
        "Saratoga Street, Mohawk Street, 9th Street, 19th Street, "
        "George Street, Hudson River, Mohawk River."
    ),
    "hilltowns": (
        "Albany County hilltowns: Berne, Knox, New Scotland, "
        "Rensselaerville, Westerlo, East Berne, Medusa, Clarksville, "
        "Feura Bush."
    ),
    "capitol": (
        "State Capitol campus: Empire State Plaza, Capitol building, "
        "Legislative Office Building, Egg, State Street, Washington Avenue."
    ),
    "thruway": (
        "I-90 NYS Thruway corridor: Exit 22, Exit 23, Exit 24, Exit 25, "
        "Berkshire Connector, Castleton, mile markers."
    ),
}


def _scanner_channel_for_call(call: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Resolve the registry channel a call belongs to.

    Two paths:
      1. call.channel_id stamped by /api/scanner/calls (commit c25379c).
      2. Reverse lookup via talkgroup ID through
         scanner_channels.channels_for_talkgroup, picking the most
         specific (single-agency) channel — same preference order as
         enrich_call_with_channel.

    Defensive — any import/registry failure returns None so the caller
    falls back to the discipline-classifier path.
    """
    try:
        from app.services.scanner_channels import (
            channel_by_id, channels_for_talkgroup,
        )
    except Exception:
        return None

    cid = (call.get("channel_id") or "").strip().lower()
    if cid:
        try:
            return channel_by_id(cid)
        except Exception:
            return None

    for field in ("talkgroup_num", "talkgroupID", "talkgroup", "tg"):
        v = call.get(field)
        if v in (None, ""):
            continue
        try:
            matches = channels_for_talkgroup(v)
        except Exception:
            return None
        if not matches:
            continue
        # Preference: single-agency, then high-priority, mirroring
        # _preferred_channel in scanner_channels.
        single = [c for c in matches if c.get("agency_id")]
        pool = single if single else matches
        pool.sort(key=lambda c: (
            0 if str(c.get("priority") or "") == "high" else
            1 if str(c.get("priority") or "") == "medium" else 2
        ))
        return pool[0] if pool else None
    return None


def _scanner_transcribe_prompt_for_channel(channel: dict[str, Any]) -> str:
    """Compose a Whisper prompt biased to this channel's disciplines and
    region. Multi-discipline channels (e.g. albany_city_unified) get all
    relevant discipline hints concatenated so the model isn't biased
    toward only one. Region hint appended when the channel's region has
    a curated landmark list."""
    disciplines = [d.lower() for d in (channel.get("disciplines") or [])
                   if isinstance(d, str)]
    parts = [_SCANNER_TRANSCRIBE_PROMPT_BASE]
    for d in ("police", "fire", "ems"):  # stable order
        if d in disciplines and d in _SCANNER_DISCIPLINE_HINTS:
            parts.append(_SCANNER_DISCIPLINE_HINTS[d])
    region = str(channel.get("region") or "").strip().lower()
    if region in _REGION_PROMPT_HINTS:
        parts.append(_REGION_PROMPT_HINTS[region])
    label = str(channel.get("label") or "").strip()
    if label:
        parts.append(f"Channel: {label}.")
    return " ".join(parts)


def _scanner_transcribe_prompt(call: dict[str, Any]) -> str:
    """Select the most-targeted Whisper prompt for a scanner call.

    Resolution order (most specific to least):
      1. Channel-based: when the call resolves to a channel in
         data/scanner_channels.json, compose discipline + region +
         channel-label hints.
      2. Discipline-based: when no channel resolves, fall back to the
         single-discipline prompts based on talkgroup tag/description
         classification (legacy behavior preserved exactly).
      3. Base prompt: when discipline can't be determined.

    Canonical agency name is appended in all cases when the agency
    registry resolves a record. Defensive — any registry/file failure
    leaves the base prompt unchanged.
    """
    base: Optional[str] = None
    try:
        channel = _scanner_channel_for_call(call)
        if channel:
            base = _scanner_transcribe_prompt_for_channel(channel)
    except Exception:
        base = None

    if base is None:
        disc = _scanner_discipline_from_call(call)
        if disc == "police":
            base = _SCANNER_TRANSCRIBE_PROMPT_POLICE
        elif disc == "fire":
            base = _SCANNER_TRANSCRIBE_PROMPT_FIRE
        elif disc == "ems":
            base = _SCANNER_TRANSCRIBE_PROMPT_EMS
        else:
            base = _SCANNER_TRANSCRIBE_PROMPT_BASE

    # Canonical agency hint: defensive — any registry failure leaves the
    # base prompt unchanged.
    try:
        from app.services.agency_registry import call_canonical_agency_summary
        ag = call_canonical_agency_summary(call)
        if ag.get("short_name") or ag.get("canonical_name"):
            hint = f" Agency: {ag.get('canonical_name') or ag.get('short_name')}"
            if ag.get("short_name") and ag["short_name"].lower() != (ag.get("canonical_name") or "").lower():
                hint += f" ({ag['short_name']})"
            hint += "."
            return base + hint
    except Exception:
        pass
    return base


def _stamp_attribution_on_analysis(
    analysis: Any,
    call_or_feed: dict[str, Any],
) -> Any:
    """Decorate a scanner-analysis result dict with channel + canonical-
    agency attribution so downstream consumers (the in-memory whisper
    cache, incident extraction, future UI) can read attribution
    directly from the analysis instead of re-deriving from the source
    call.

    Composes the same identity bits the channel-aware Whisper prompt
    (commit e0a4cef) and structured-analysis context (commit c5c92c8)
    already see. Idempotent — calling twice produces the same result.
    Defensive — any registry/import failure leaves the analysis dict
    unchanged.

    Returns the analysis dict (mutated in place AND returned for
    chaining). Pass-through when analysis is not a dict so the function
    is safe to call on None / error responses.
    """
    if not isinstance(analysis, dict):
        return analysis
    if not isinstance(call_or_feed, dict):
        return analysis
    attribution: dict[str, Any] = {}
    try:
        chan = _scanner_channel_for_call(call_or_feed)
        if chan:
            cid = str(chan.get("channel_id") or "")
            label = str(chan.get("label") or "")
            region = str(chan.get("region") or "")
            disciplines = [
                str(d) for d in (chan.get("disciplines") or [])
                if isinstance(d, str) and d
            ]
            if cid:
                attribution["channel_id"] = cid
            if label:
                attribution["channel_label"] = label
            if disciplines:
                attribution["channel_disciplines"] = disciplines
            if region:
                attribution["channel_region"] = region
    except Exception:
        pass
    try:
        from app.services.agency_registry import call_canonical_agency_summary
        ag = call_canonical_agency_summary(call_or_feed)
        # Normalize summary keys so the attribution shape is flat and
        # consistent: agency_id / agency_short_name / agency_canonical_name
        # / agency_type. (call_canonical_agency_summary returns
        # agency_id / short_name / canonical_name / agency_type.)
        if ag.get("agency_id"):
            attribution["agency_id"] = ag["agency_id"]
        if ag.get("short_name"):
            attribution["agency_short_name"] = ag["short_name"]
        if ag.get("canonical_name"):
            attribution["agency_canonical_name"] = ag["canonical_name"]
        if ag.get("agency_type"):
            attribution["agency_type"] = ag["agency_type"]
    except Exception:
        pass
    # Stream-monitor path has no talkgroup but does carry feed_id /
    # feed_name / feed_priority — preserve those when present so the
    # attribution block is never empty for live-stream alerts.
    for feed_key in ("feed_id", "feed_name", "feed_priority"):
        v = call_or_feed.get(feed_key)
        if v not in (None, ""):
            attribution[feed_key] = v

    if attribution:
        existing = analysis.get("attribution") if isinstance(analysis.get("attribution"), dict) else {}
        merged = {**existing, **attribution}
        analysis["attribution"] = merged
    return analysis


def _scanner_call_local_reference_context(call: dict[str, Any]) -> str:
    bits = [
        f"talkgroup_num={call.get('talkgroup_num') or call.get('talkgroupID') or ''}",
        f"talkgroup_tag={call.get('talkgroup_tag') or ''}",
        f"talkgroup_description={call.get('talkgroup_description') or ''}",
        f"frequency_hz={call.get('freq') or 0}",
        f"duration_seconds={call.get('duration') or call.get('len') or 0}",
        f"source={call.get('source') or ''}",
        f"matched_location={call.get('matched_location') or ''}",
        f"municipality={call.get('municipality') or ''}",
    ]
    # Canonical agency identity from data/agencies.json. When the registry
    # resolves the talkgroup, hand the structured analysis prompt the
    # canonical short_name + agency_id so the model's output can attribute
    # incidents consistently across calls instead of guessing each time.
    try:
        from app.services.agency_registry import call_canonical_agency_summary
        ag = call_canonical_agency_summary(call)
        if ag.get("agency_id"):
            bits.append(f"canonical_agency_id={ag['agency_id']}")
        if ag.get("short_name"):
            bits.append(f"canonical_agency_short_name={ag['short_name']}")
        if ag.get("canonical_name"):
            bits.append(f"canonical_agency_name={ag['canonical_name']}")
        if ag.get("agency_type"):
            bits.append(f"canonical_agency_type={ag['agency_type']}")
    except Exception:
        pass
    # Scanner-channel context from data/scanner_channels.json. Mirrors the
    # channel-aware Whisper prompt (commit e0a4cef) so the structured
    # analysis prompt sees the same operational framing: which agency /
    # region / discipline mix the call came from. Without this, the
    # downstream OpenAI structured-analysis pass had to re-derive
    # channel attribution from raw talkgroup text every call. Defensive
    # try/except — any registry/file failure leaves the line out
    # rather than blocking analysis.
    try:
        chan = _scanner_channel_for_call(call)
        if chan:
            cid = str(chan.get("channel_id") or "")
            label = str(chan.get("label") or "")
            region = str(chan.get("region") or "")
            disciplines = [
                str(d) for d in (chan.get("disciplines") or [])
                if isinstance(d, str) and d
            ]
            if cid:
                bits.append(f"channel_id={cid}")
            if label:
                bits.append(f"channel_label={label}")
            if disciplines:
                bits.append(f"channel_disciplines={','.join(disciplines)}")
            if region:
                bits.append(f"channel_region={region}")
    except Exception:
        pass
    unit_ids = call.get("unit_ids")
    if isinstance(unit_ids, list) and unit_ids:
        bits.append("unit_ids=" + ",".join(str(x) for x in unit_ids[:12] if str(x).strip()))
    if call.get("emergency"):
        bits.append("emergency_flag=1")
    if call.get("enc"):
        bits.append("encrypted_flag=1")
    bits.append("jurisdiction=Albany County, New York")
    return " | ".join(bit for bit in bits if bit and not bit.endswith("="))


@app.post("/api/scanner/transcribe")
async def scanner_transcribe(request: Request):
    """Transcribe scanner audio using the configured provider (Groq/OpenAI)."""
    _txc_url, openai_key, _txc_model, _txc_provider = _transcription_provider()
    if not openai_key:
        return {"status": "error", "message": "no transcription provider configured (set GROQ_API_KEY or OPENAI_API_KEY)"}

    try:
        body = await request.json()
    except Exception:
        return {"status": "error", "message": "invalid request body"}

    calls = body.get("calls") if isinstance(body, dict) else None
    if not isinstance(calls, list) or not calls:
        return {"status": "error", "message": "no calls provided"}

    # Process up to 5 calls per request
    batch = calls[:5]
    results = []

    for c in batch:
        audio_url = c.get("audio_url") or c.get("url") or ""
        call_id = c.get("id") or audio_url

        if not audio_url:
            results.append({"id": call_id, "status": "skip", "reason": "no_audio_url"})
            continue

        # Check cache first
        if audio_url in _whisper_cache:
            cached = _whisper_cache[audio_url]
            results.append({
                "id": call_id,
                "status": "ok",
                "source": "cache",
                "text": cached["text"],
                "keywords": cached["keywords"],
                "alert_level": cached["alert_level"],
                "analysis": cached.get("analysis"),
            })
            continue

        # Transcribe with rate limiting
        async with _whisper_semaphore:
            try:
                # Download audio file
                audio_resp = await http_client.get(audio_url, timeout=10.0)
                if audio_resp.status_code != 200:
                    results.append({"id": call_id, "status": "error", "reason": "audio_download_failed"})
                    continue

                audio_bytes = audio_resp.content
                if len(audio_bytes) > 25 * 1024 * 1024:  # 25MB Whisper limit
                    results.append({"id": call_id, "status": "error", "reason": "file_too_large"})
                    continue

                # Determine file extension from URL
                ext = ".m4a"
                if ".mp3" in audio_url:
                    ext = ".mp3"
                elif ".wav" in audio_url:
                    ext = ".wav"

                # Send to transcription API.
                # Default stays whisper-1 for prod safety; Railway can set
                # SCANNER_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe for faster/
                # cheaper live transcription, or gpt-4o-transcribe for
                # high-priority rechecks.
                import io
                # Talkgroup-aware prompt: police/fire/EMS get discipline-tuned
                # jargon hints. Falls back to generic base prompt for unknown
                # talkgroups so nothing regresses below prior behavior.
                _transcribe_prompt = _scanner_transcribe_prompt(c)
                _mime = "audio/mpeg" if ext == ".mp3" else ("audio/wav" if ext == ".wav" else "audio/mp4")
                files = _build_transcription_files(
                    _txc_provider, _txc_model, f"scanner_call{ext}", _mime, audio_bytes, _transcribe_prompt
                )
                if _whisper_breaker_open():
                    results.append({"id": call_id, "status": "skip", "reason": "rate_limited_cooldown"})
                    continue
                whisper_resp = await http_client.post(
                    _txc_url,
                    headers={"Authorization": f"Bearer {openai_key}"},
                    files=files,
                    timeout=30.0,
                )

                if whisper_resp.status_code == 429:
                    _trip_whisper_breaker(whisper_resp.headers.get("Retry-After"))
                    results.append({"id": call_id, "status": "skip", "reason": "rate_limited_429"})
                    break
                if whisper_resp.status_code != 200:
                    results.append({
                        "id": call_id,
                        "status": "error",
                        "reason": f"whisper_http_{whisper_resp.status_code}",
                    })
                    continue

                transcript_data = whisper_resp.json()
                text = transcript_data.get("text", "").strip()

                # Filter ads/promos that sometimes appear in call audio
                if _is_ad_or_noise(text):
                    results.append({"id": call_id, "status": "skip", "reason": "ad_or_noise"})
                    continue

                # Scan for critical keywords
                keywords = _scan_for_keywords(text)
                level = _alert_level(keywords)
                analysis = await analyze_scanner_transcript(
                    transcript=text,
                    channel_name=_scanner_call_channel_name(c),
                    source_name=_scanner_call_source_name(c),
                    timestamp=_scanner_call_timestamp(c),
                    municipality_hint=_scanner_call_municipality_hint(c),
                    local_reference_context=_scanner_call_local_reference_context(c),
                )
                # Stamp channel + agency attribution on the analysis dict
                # so the cached / persisted result carries operational
                # identity forward without re-derivation downstream.
                analysis = _stamp_attribution_on_analysis(analysis, c)
                keywords = _merge_scanner_keywords(keywords, analysis)
                level = _max_scanner_alert_level(level, analysis)

                # Cache the result
                _whisper_cache[audio_url] = {
                    "text": text,
                    "keywords": keywords,
                    "alert_level": level,
                    "analysis": analysis,
                    "timestamp": time.time(),
                }

                # Evict old cache entries (keep last 200)
                if len(_whisper_cache) > 200:
                    oldest_keys = sorted(
                        _whisper_cache, key=lambda k: _whisper_cache[k]["timestamp"]
                    )[:50]
                    for k in oldest_keys:
                        _whisper_cache.pop(k, None)

                results.append({
                    "id": call_id,
                    "status": "ok",
                    "source": "whisper",
                    "text": text,
                    "keywords": keywords,
                    "alert_level": level,
                    "analysis": analysis,
                })

            except Exception as exc:
                logger.warning("whisper_transcribe_error: %s", exc)
                results.append({"id": call_id, "status": "error", "reason": str(exc)})

    return {"status": "ok", "transcriptions": results}


# ── Broadcastify Live Stream Monitor ─────────────────────────────────────
# Captures audio chunks from Broadcastify CDN streams, transcribes with
# Whisper, and scans for critical keywords in real time.

# Configurable feeds — Albany County area
BROADCASTIFY_FEEDS = [
    {
        "id": "3626",
        "name": "Albany City & Colonie Police/Fire/EMS",
        "bcfy_name": "Albany City and Colonie, Police, Fire and EMS",
        "priority": "high", "type": "police",
        "county": "Albany County, NY",
        "coverage": "City of Albany + Town of Colonie",
        "system": "Albany City Fire P25 (Phase 1) + Colonie public safety — Gre PSR600 scanner",
        "genre": "Public Safety",
    },
    {
        "id": "1440",
        "name": "Albany City Fire",
        "bcfy_name": "Albany City Fire",
        "priority": "medium", "type": "fire",
        "county": "Albany County, NY",
        "coverage": "City of Albany",
        "system": "Albany Fire Department P25 trunked radio system",
        "genre": "Public Safety",
    },
    {
        "id": "37206",
        "name": "Albany County Volunteer Fire",
        "bcfy_name": "Albany County Volunteer Fire Departments",
        "priority": "medium", "type": "fire",
        "county": "Albany County, NY",
        "coverage": "Bethlehem, Colonie, Coeymans, Green Island, Guilderland, Hilltowns, New Scotland, Watervliet, Cohoes",
        "system": "Albany-Schenectady P25 Phase II trunk (county + metro sites)",
        "genre": "Public Safety",
    },
    # Feed 7581 (Colonie EMS/Fire) removed — its CDN URLs 401 (premium/auth required).
    {
        "id": "21216",
        "name": "NYS Thruway - Albany Division",
        "bcfy_name": "New York State Thruway Authority - Albany Division",
        "priority": "low", "type": "other",
        "county": "Albany / Capital Region, NY",
        "coverage": "NYSTA Zone 2 · I-90 Exits 19 (Kingston)–29 (Canajoharie) + Berkshire Connector",
        "system": "NYS Thruway Authority Albany Division (Zone 2) radio",
        "genre": "Public Safety",
    },
]

# Stream alerts buffer — most recent keyword-flagged transcriptions
_stream_alerts: list[dict] = []
_stream_alerts_lock = asyncio.Lock()
_STREAM_ALERTS_MAX = 50

# Background task handle
_stream_monitor_task: Optional[asyncio.Task] = None


async def _capture_audio_chunk(stream_url: str, duration_secs: int = 30) -> Optional[bytes]:
    """Capture an audio chunk from a live stream.
    Prefers ffmpeg (produces clean WAV), falls back to raw HTTP stream
    capture (returns MP3 bytes — Whisper accepts MP3 directly)."""
    if shutil.which("ffmpeg"):
        return await _capture_audio_chunk_ffmpeg(stream_url, duration_secs)
    return await _capture_audio_chunk_http(stream_url, duration_secs)


async def _capture_audio_chunk_ffmpeg(stream_url: str, duration_secs: int = 30) -> Optional[bytes]:
    """Capture via ffmpeg — produces 16kHz mono WAV ideal for Whisper."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-t", str(duration_secs),
            "-i", stream_url,
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            "-f", "wav",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=duration_secs + 15)
        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")[-200:] if stderr else "unknown"
            logger.warning("ffmpeg error (feed): %s", err_msg)
            return None
        if len(stdout) < 1000:
            return None
        return stdout
    except asyncio.TimeoutError:
        logger.warning("ffmpeg capture timed out")
        return None
    except Exception as e:
        logger.warning("Audio capture ffmpeg error: %s", e)
        return None


async def _capture_audio_chunk_http(stream_url: str, duration_secs: int = 30) -> Optional[bytes]:
    """Fallback: capture raw MP3 bytes from a Broadcastify CDN stream via HTTP.
    No ffmpeg required — Whisper API accepts MP3 directly. Collects bytes for
    `duration_secs` then returns the buffer."""
    try:
        chunks: list[bytes] = []
        total_bytes = 0
        target_bytes = duration_secs * 16000  # ~128kbps stream ≈ 16KB/s

        async with http_client.stream("GET", stream_url, timeout=duration_secs + 10) as resp:
            if resp.status_code != 200:
                logger.warning("HTTP stream capture failed: status %d", resp.status_code)
                return None
            start = time.time()
            async for chunk in resp.aiter_bytes(chunk_size=4096):
                chunks.append(chunk)
                total_bytes += len(chunk)
                elapsed = time.time() - start
                if elapsed >= duration_secs or total_bytes >= target_bytes * 2:
                    break

        if total_bytes < 2000:
            return None
        return b"".join(chunks)
    except Exception as e:
        logger.warning("HTTP stream capture error: %s", e)
        return None


async def _transcribe_audio_bytes(audio_bytes: bytes) -> Optional[str]:
    """Send audio to the configured transcription provider. Accepts WAV or MP3."""
    url, api_key, model, provider = _transcription_provider()
    if not api_key or not audio_bytes:
        return None
    if _whisper_breaker_open():
        return None  # cooling down after a 429 — skip without burning quota

    is_wav = audio_bytes[:4] == b"RIFF"
    filename = "stream_chunk.wav" if is_wav else "stream_chunk.mp3"
    mime = "audio/wav" if is_wav else "audio/mpeg"

    try:
        files = _build_transcription_files(
            provider, model, filename, mime, audio_bytes, _SCANNER_TRANSCRIBE_PROMPT_BASE
        )
        resp = await http_client.post(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            files=files,
            timeout=30.0,
        )
        if resp.status_code == 429:
            _trip_whisper_breaker(resp.headers.get("Retry-After"))
            return None
        if resp.status_code != 200:
            # Surface the provider's error body so format issues are visible.
            body = ""
            try:
                body = resp.text[:300]
            except Exception:
                pass
            logger.warning("transcription_non200 provider=%s status=%s body=%s",
                           provider, resp.status_code, body)
            _LAST_TRANSCRIBE_ERROR.update(provider=provider, status=resp.status_code, body=body,
                                          at=datetime.now(timezone.utc).isoformat())
            return None
        return (resp.json().get("text") or "").strip()
    except Exception as e:
        logger.warning("Stream transcription error: %s", e)
        _LAST_TRANSCRIBE_ERROR.update(provider=provider, status=0, body=str(e)[:300],
                                      at=datetime.now(timezone.utc).isoformat())
        return None


async def _monitor_single_feed(feed: dict):
    """Monitor a single Broadcastify feed continuously."""
    feed_id = feed["id"]
    feed_name = feed["name"]
    feed_priority = feed["priority"]

    # Try both CDN URL patterns
    stream_urls = [
        f"https://broadcastify.cdnstream1.com/{feed_id}",
        f"https://audio.broadcastify.com/{feed_id}.mp3",
    ]

    # Capture duration based on priority
    chunk_secs = 25 if feed_priority == "high" else 40
    # Pause between captures
    pause_secs = 5 if feed_priority == "high" else 15

    working_url = None
    fail_count = 0

    while True:
        try:
            # Try URLs until one works
            urls_to_try = [working_url] if working_url else stream_urls
            audio = None
            for url in urls_to_try:
                if not url:
                    continue
                audio = await _capture_audio_chunk(url, chunk_secs)
                if audio:
                    working_url = url
                    fail_count = 0
                    break

            if not audio:
                fail_count += 1
                if fail_count > 5:
                    # Back off significantly after repeated failures
                    logger.info("Feed %s: backing off after %d failures", feed_id, fail_count)
                    await asyncio.sleep(120)
                    working_url = None  # Reset to try both URLs again
                    fail_count = 0
                else:
                    await asyncio.sleep(30)
                continue

            # Transcribe the audio chunk
            text = await _transcribe_audio_bytes(audio)
            if not text or len(text.strip()) < 5:
                await asyncio.sleep(pause_secs)
                continue

            # Filter out ads, promos, and non-dispatch audio
            if _is_ad_or_noise(text):
                logger.debug("stream_monitor_ad_filtered feed=%s text=%s", feed_id, text[:80])
                await asyncio.sleep(pause_secs)
                continue

            # Scan for keywords
            keywords = _scan_for_keywords(text)
            level = _alert_level(keywords)
            analysis = await analyze_scanner_transcript(
                transcript=text,
                channel_name=feed_name,
                source_name="broadcastify_stream_monitor",
                timestamp=datetime.now(timezone.utc).isoformat(),
                municipality_hint="Albany County",
                local_reference_context=(
                    f"feed_id={feed_id} | feed_name={feed_name} | feed_priority={feed_priority} "
                    "| jurisdiction=Albany County, New York | source=broadcastify live stream"
                ),
            )
            # Stream-monitor path has no talkgroup; stamp whatever feed
            # metadata we have. _stamp_attribution_on_analysis is
            # defensive against missing channel/agency lookups.
            analysis = _stamp_attribution_on_analysis(analysis, {
                "feed_id": feed_id,
                "feed_name": feed_name,
                "feed_priority": feed_priority,
            })
            keywords = _merge_scanner_keywords(keywords, analysis)
            level = _max_scanner_alert_level(level, analysis)

            # Store if significant (any keywords found, or high-priority feed)
            if keywords or feed_priority == "high":
                alert = {
                    "feed_id": feed_id,
                    "feed_name": feed_name,
                    "text": text,
                    "keywords": keywords,
                    "alert_level": level,
                    "analysis": analysis,
                    "timestamp": time.time(),
                    "iso_time": datetime.now(timezone.utc).isoformat(),
                }
                async with _stream_alerts_lock:
                    _stream_alerts.insert(0, alert)
                    # Trim to max size
                    while len(_stream_alerts) > _STREAM_ALERTS_MAX:
                        _stream_alerts.pop()

                if level in ("critical", "high"):
                    logger.info(
                        "STREAM ALERT [%s] %s: %s | keywords: %s",
                        level.upper(), feed_name, text[:100], ", ".join(keywords)
                    )

            await asyncio.sleep(pause_secs)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("Stream monitor error (feed %s): %s", feed_id, e)
            await asyncio.sleep(30)


async def start_stream_monitor():
    """Start background stream monitoring for all configured feeds.
    Uses ffmpeg when available for optimal audio quality; falls back to
    direct HTTP stream capture (MP3) when ffmpeg is not installed."""
    global _stream_monitor_task
    if not settings.openai_api_key:
        logger.info("Stream monitor disabled — no OPENAI_API_KEY")
        return

    has_ffmpeg = shutil.which("ffmpeg") is not None
    if not has_ffmpeg:
        logger.info("Stream monitor starting WITHOUT ffmpeg (using HTTP MP3 capture fallback)")

    # Only monitor high and medium priority feeds to save API costs
    feeds_to_monitor = [f for f in BROADCASTIFY_FEEDS if f["priority"] in ("high", "medium")]
    if not feeds_to_monitor:
        return

    logger.info("Starting stream monitor for %d feeds (ffmpeg=%s)", len(feeds_to_monitor), has_ffmpeg)
    tasks = [asyncio.create_task(_monitor_single_feed(f)) for f in feeds_to_monitor]
    _stream_monitor_task = asyncio.gather(*tasks, return_exceptions=True)


async def stop_stream_monitor():
    """Stop all stream monitoring tasks."""
    global _stream_monitor_task
    if _stream_monitor_task:
        _stream_monitor_task.cancel()
        try:
            await _stream_monitor_task
        except (asyncio.CancelledError, Exception):
            pass
        _stream_monitor_task = None


@app.get("/api/scanner/stream-alerts")
async def get_stream_alerts(limit: int = 20):
    """Return recent keyword-flagged stream transcriptions."""
    async with _stream_alerts_lock:
        alerts = _stream_alerts[:min(limit, _STREAM_ALERTS_MAX)]
    return {
        "status": "ok",
        "count": len(alerts),
        "feeds_monitored": [f["name"] for f in BROADCASTIFY_FEEDS if f["priority"] in ("high", "medium")],
        "alerts": alerts,
    }


@app.get("/api/scanner/stream-status")
async def get_stream_status():
    """Return stream monitor status."""
    running = _stream_monitor_task is not None and not _stream_monitor_task.done()
    has_ffmpeg = shutil.which("ffmpeg") is not None
    return {
        "status": "ok",
        "monitor_running": running,
        "feeds": BROADCASTIFY_FEEDS,
        "ffmpeg_available": has_ffmpeg,
        "http_fallback_active": running and not has_ffmpeg,
        "whisper_configured": bool(_transcription_provider()[1]),
        "transcription_provider": _transcription_provider()[3],
        "whisper_rate_limited": _whisper_breaker_open(),
        "whisper_cooldown_remaining_s": max(0, int(_whisper_429_until - time.time())),
        "last_transcribe_error": _LAST_TRANSCRIBE_ERROR,
        "alert_count": len(_stream_alerts),
    }


@app.get("/api/scanner/live-feeds")
async def get_scanner_live_feeds():
    """Public Broadcastify live stream feeds — no API key required.
    Returns feed metadata + CDN stream URLs for direct playback."""
    return {
        "status": "ok",
        "feeds": [
            {
                "id": f["id"],
                "name": f["name"],
                "bcfy_name": f.get("bcfy_name", f["name"]),
                "type": f.get("type", "other"),
                "priority": f["priority"],
                "county": f.get("county", "Albany County, NY"),
                "coverage": f.get("coverage", ""),
                "system": f.get("system", ""),
                "genre": f.get("genre", "Public Safety"),
                "provider": "Broadcastify",
                "stream_url": f"https://broadcastify.cdnstream1.com/{f['id']}",
                "page_url": f"https://www.broadcastify.com/listen/feed/{f['id']}",
            }
            for f in BROADCASTIFY_FEEDS
        ],
    }


@app.get("/api/scanner/talkgroups")
async def get_scanner_talkgroups():
    """Enriched P25 talkgroup metadata merged with le_directory.json agencies."""
    ck = "scanner_talkgroups"
    cached = get_cached(ck)
    if cached:
        return {
            "status": "ok",
            "source": "cache",
            "talkgroups": cached.get("talkgroups", {}),
            "system": cached.get("system"),
            "dispatch_center": cached.get("dispatch_center"),
        }
    payload = _build_scanner_talkgroups_payload()
    set_cached(ck, payload)
    return {
        "status": "ok",
        "source": "live",
        "talkgroups": payload["talkgroups"],
        "system": payload.get("system"),
        "dispatch_center": payload.get("dispatch_center"),
    }


# =============================================================================
# LAW ENFORCEMENT DIRECTORY (le_directory.json)
# =============================================================================
_LE_DIRECTORY_CACHE: Optional[dict[str, Any]] = None


def _le_dir_cache() -> dict[str, Any]:
    global _LE_DIRECTORY_CACHE
    if _LE_DIRECTORY_CACHE is None:
        _path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "le_directory.json")
        with open(_path, "r", encoding="utf-8") as _fh:
            _LE_DIRECTORY_CACHE = _json.load(_fh)
    return _LE_DIRECTORY_CACHE


def _load_le_directory() -> dict[str, Any]:
    """Compatibility helper: single loader for all directory-derived source expansion."""
    return _le_dir_cache()


def _scanner_tg_dept_loc(
    agencies_by_id: dict[str, Any],
    agency_id: Optional[str],
    channel: str,
    fallback_dept: str,
    fallback_loc: str,
) -> tuple[str, str, Optional[str]]:
    if agency_id and agency_id in agencies_by_id:
        ag = agencies_by_id[agency_id]
        abb = (ag.get("abbreviation") or "").strip()
        contact = ag.get("contact") or {}
        city = (contact.get("city") or "").strip()
        loc = city or fallback_loc
        if abb:
            dept = f"{abb} {channel}".strip() if channel else abb
        else:
            name = (ag.get("name") or "").strip()
            dept = f"{name} — {channel}".strip() if channel else (name or fallback_dept)
        return dept, loc, agency_id
    return fallback_dept, fallback_loc, agency_id


def _build_scanner_talkgroups_payload() -> dict[str, Any]:
    data = _le_dir_cache()
    agencies_by_id = {a["id"]: a for a in (data.get("agencies") or []) if a.get("id")}
    se = data.get("scannerEcosystem") or {}
    sys_info = se.get("system") or {}

    # ── Comprehensive Albany/Schenectady Counties P25 Talkgroup Registry ────
    # Sources: Broadcastify Calls system 8553 + RadioReference — verified 2026-03-31
    # Format: (tg_id, agency_id, channel_label, display_name, location, category, priority)
    _rows: list[tuple[str, Optional[str], str, str, str, str, str]] = [
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — LAW DISPATCH
        # ═══════════════════════════════════════════════════════════════════════
        ("18301", "albany-pd",             "Police 1",            "Albany City LE / Police 1",           "City of Albany",      "police", "high"),
        ("10003", "albany-county-sheriff",  "County Law 1",       "Albany County LE / County Law 1",    "Albany County",       "police", "high"),
        ("11003", "albany-county-sheriff",  "County Law 2",       "Albany County LE / County Law 2",    "Albany County",       "police", "high"),
        ("11212", "albany-county-sheriff",  "Airport Detail",     "Albany County LE / Sheriff Airport",  "Albany Airport",      "police", "high"),
        ("10921", "bethlehem-pd",           "Police",             "Bethlehem PD",                        "Bethlehem",           "police", "high"),
        ("15002", "colonie-pd",             "Police Dispatch",    "Colonie LE / Police Dispatch",        "Colonie",             "police", "high"),
        ("10961", "guilderland-pd",         "Police Dispatch",    "Guilderland PD / Police Dispatch",    "Guilderland",         "police", "high"),
        ("15011", None,                     "Police Dispatch",    "Menands PD / Police Dispatch",        "Menands",             "police", "high"),
        ("18351", None,                     "Central Police",     "SUNY Albany / Central (Plaza) Police","SUNY Albany",         "police", "high"),
        ("18303", None,                     "Police Dispatch",    "SUNY Albany / Police Dispatch",       "SUNY Albany",         "police", "high"),
        ("18884", "nysp-troop-g",           "Capitol 1",          "NYSP Capitol 1",                     "Capital Region",      "police", "high"),
        ("18403", None,                     "Park Police",        "NYS Park Police Dispatch",            "Capital Region",      "police", "medium"),
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — LAW TAC
        # ═══════════════════════════════════════════════════════════════════════
        ("13031", "albany-pd",             "Special Ops",         "Albany City LE / Police Special Ops", "City of Albany",      "police", "high"),
        ("10068", "albany-county-sheriff",  "MVP Arena Detail",   "Albany County LE / Sheriff MVP Arena","City of Albany",      "police", "medium"),
        ("15008", "colonie-pd",             "Police Ops 1",       "Colonie LE / Police Ops 1",           "Colonie",             "police", "medium"),
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — MULTI-TAC / INTEROP / EMERGENCY
        # ═══════════════════════════════════════════════════════════════════════
        ("9991",  None,                     "Radio Emergency",    "Albany County Interagency / Countywide Emergency", "Albany County", "police", "high"),
        ("11312", None,                     "Airport Ops",        "Colonie Public Works / Airport Ops",  "Albany Airport",      "police", "medium"),
        ("10771", None,                     "Air to Ground",      "Systemwide / Air to Ground",          "Albany County",       "police", "medium"),
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — SECURITY
        # ═══════════════════════════════════════════════════════════════════════
        ("13102", None,                     "Public Safety",      "UHA Public Safety",                   "University Heights",  "police", "medium"),
        ("13301", None,                     "Security",           "Port of Albany Security",             "Port of Albany",      "police", "medium"),
        ("18201", None,                     "Security",           "NYS Capitol Security",                "Empire State Plaza",  "police", "medium"),
        ("18305", None,                     "Security",           "SUNY Albany Security",                "SUNY Albany",         "police", "medium"),
        ("18501", None,                     "Security",           "NYS DOH Wadsworth Center Security",   "Empire State Plaza",  "police", "low"),
        ("18510", None,                     "Security",           "NYS Library/Museum Security",         "Empire State Plaza",  "police", "low"),
        ("18511", None,                     "Emergency",          "NYS Cultural Ed Center Emergency",    "Empire State Plaza",  "police", "medium"),
        ("18514", None,                     "Security",           "NYS DOE Security",                    "Empire State Plaza",  "police", "low"),
        ("18601", None,                     "Security 1",         "Court of Appeals Security 1",         "Court of Appeals",    "police", "low"),
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — CORRECTIONS
        # ═══════════════════════════════════════════════════════════════════════
        ("18002", None,                     "Parole",             "NYS Parole",                          "Capital Region",      "police", "medium"),
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — FIRE DISPATCH
        # ═══════════════════════════════════════════════════════════════════════
        ("10702", None,                     "County Fire 1",      "AlbCo Fire 1",                       "Albany County",        "fire",   "high"),
        ("11702", None,                     "County Fire 2",      "AlbCo Fire 2",                       "Albany County",        "fire",   "high"),
        ("10927", None,                     "Fire Control",       "Bethlehem FD",                        "Bethlehem",            "fire",   "high"),
        ("10967", None,                     "Fire Dispatch",      "Guilderland FD",                      "Guilderland",          "fire",   "high"),
        ("13202", None,                     "Fire 1",             "AFD Fire 1",                          "City of Albany",       "fire",   "high"),
        ("15102", "colonie-pd",             "Fire Dispatch",      "Colonie FD Dispatch",                 "Colonie",              "fire",   "high"),
        ("15141", None,                     "Airport ARFF",       "Albany Airport ARFF",                 "Albany Airport",       "fire",   "medium"),
        # ── AFD Fire Station Alerts ───────────────────────────────────────────
        ("13211", None,                     "Midtown Alert",      "AFD Midtown Alert",                   "City of Albany",       "fire",   "medium"),
        ("13212", None,                     "Arbor Hill Alert",   "AFD Arbor Hill Alert",                "City of Albany",       "fire",   "medium"),
        ("13213", None,                     "Pine Bush Alert",    "AFD Pine Bush Alert",                 "City of Albany",       "fire",   "medium"),
        ("13214", None,                     "South End Alert",    "AFD South End Alert",                 "City of Albany",       "fire",   "medium"),
        ("13216", None,                     "Delaware Alert",     "AFD Delaware Alert",                  "City of Albany",       "fire",   "medium"),
        ("13217", None,                     "Brevator Alert",     "AFD Brevator Alert",                  "City of Albany",       "fire",   "medium"),
        # ── Fire Tac / Operations ────────────────────────────────────────────
        ("10729", None,                     "Fire Ops 9",         "AlbCo FD Ops 9",                     "Albany County",        "fire",   "medium"),
        ("10928", None,                     "Fire 1",             "Bethlehem FD 1",                      "Bethlehem",            "fire",   "medium"),
        ("10929", None,                     "Fire 2",             "Bethlehem FD 2",                      "Bethlehem",            "fire",   "low"),
        ("10968", None,                     "Fire Ops 1",         "Guilderland FD Ops 1",                "Guilderland",          "fire",   "medium"),
        ("11721", None,                     "Fire Ops 1",         "AlbCo FD Ops 1",                     "Albany County",        "fire",   "medium"),
        ("13203", None,                     "Fire 2",             "AFD Fire 2",                          "City of Albany",       "fire",   "medium"),
        ("13204", None,                     "Fire 3",             "AFD Fire 3",                          "City of Albany",       "fire",   "low"),
        ("15103", "colonie-pd",             "Fire Ops 1",         "Colonie FD Ops 1",                    "Colonie",              "fire",   "medium"),
        ("15104", "colonie-pd",             "Fire Ops 2",         "Colonie FD Ops 2",                    "Colonie",              "fire",   "low"),
        ("15108", "colonie-pd",             "Fire SpOps",         "Colonie FD Special Ops",              "Colonie",              "fire",   "medium"),
        # ── Fire Talk ────────────────────────────────────────────────────────
        ("13221", None,                     "Training",           "AFD Training",                        "City of Albany",       "fire",   "low"),
        ("15107", "colonie-pd",             "Fire Police",        "Colonie Fire Police",                 "Colonie",              "fire",   "low"),
        # ═══════════════════════════════════════════════════════════════════════
        #  ALBANY COUNTY — EMS DISPATCH
        # ═══════════════════════════════════════════════════════════════════════
        ("10925", None,                     "EMS Dispatch",       "Bethlehem EMS",                       "Bethlehem",            "ems",    "high"),
        ("10965", None,                     "EMS Dispatch",       "Guilderland EMS",                     "Guilderland",          "ems",    "high"),
        # ═══════════════════════════════════════════════════════════════════════
        #  SCHENECTADY COUNTY — LAW DISPATCH
        # ═══════════════════════════════════════════════════════════════════════
        ("10121", None,                     "Police Dispatch",    "Schenectady City PD / Police Dispatch","Schenectady",         "police", "high"),
        ("10116", None,                     "Sheriff Dispatch",   "Schenectady County LE / Sheriff",      "Schenectady County",  "police", "high"),
        # (18884 NYSP Capitol 1 and 18403 Park Police already listed above — shared statewide)
        # ═══════════════════════════════════════════════════════════════════════
        #  SCHOOLS
        # ═══════════════════════════════════════════════════════════════════════
        ("10974", None,                     "School Buses",       "Guilderland CSD Buses",               "Guilderland",          "other",  "low"),
        ("15701", None,                     "School Buses",       "South Colonie CSD Buses",             "Colonie",              "other",  "low"),
        ("15703", None,                     "School Ops",         "Colonie Central HS Ops",              "Colonie",              "other",  "low"),
        ("15801", None,                     "School Buses",       "North Colonie CSD Buses",             "Colonie",              "other",  "low"),
        # ═══════════════════════════════════════════════════════════════════════
        #  UTILITIES / TRANSPORTATION / MAINTENANCE
        # ═══════════════════════════════════════════════════════════════════════
        ("15512", None,                     "Water",              "Latham Water District",               "Latham",               "other",  "low"),
        ("15508", None,                     "Water",              "Colonie Pure Waters",                 "Colonie",              "other",  "low"),
        ("15602", None,                     "Highway",            "Menands Highway",                     "Menands",              "other",  "low"),
        ("10803", None,                     "Highway",            "Coeymans Highway Dept",               "Coeymans",             "other",  "low"),
        ("13801", None,                     "DGS Streets",        "Albany City DGS Streets",             "City of Albany",       "other",  "low"),
        ("10042", "albany-county-sheriff",  "Maintenance",        "ACSO Maintenance",                    "Albany County",        "other",  "low"),
        ("15504", "colonie-pd",             "Animal Control",     "Colonie Animal Control",              "Colonie",              "other",  "low"),
    ]

    talkgroups: dict[str, dict[str, Any]] = {}
    for tg, aid, ch, fb, floc, cat, pri in _rows:
        dept, loc, rid = _scanner_tg_dept_loc(agencies_by_id, aid, ch, fb, floc)
        talkgroups[str(tg)] = {
            "department": dept,
            "location": loc,
            "category": cat,
            "priority": pri,
            "agency_id": rid,
            "talkgroup_id": str(tg),
        }

    return {
        "talkgroups": talkgroups,
        "system": {
            "name": sys_info.get("name"),
            "type": sys_info.get("type"),
            "radio_reference_url": sys_info.get("radioReferenceUrl"),
            "counties": sys_info.get("counties"),
        },
        "dispatch_center": sys_info.get("dispatchCenter"),
    }


def _directory_domain(url: str) -> str:
    try:
        net = urlparse(url or "").netloc.lower()
        return net[4:] if net.startswith("www.") else net
    except Exception:
        return ""


def build_directory_rss_feeds() -> dict[str, dict[str, Any]]:
    """Merge-safe RSS configs built from le_directory.json (media + agency press surfaces)."""
    out: dict[str, dict[str, Any]] = {}
    seen_urls: set[str] = set()

    def _add(key: str, cfg: dict[str, Any]) -> None:
        u = cfg.get("url") or ""
        if not u or u in seen_urls:
            return
        seen_urls.add(u)
        out[key] = cfg

    try:
        data = _load_le_directory()
    except Exception as e:
        print(f"build_directory_rss_feeds: {e}")
        return out

    gnews_body = (
        "(albany+OR+\"albany+county\"+OR+colonie+OR+guilderland+OR+bethlehem+OR+cohoes+OR+"
        "watervliet+OR+latham+OR+menands+OR+altamont+OR+ravena+OR+coeymans+OR+capital+region)+"
        "(crime+OR+arrest+OR+police+OR+courts+OR+blotter+OR+shooting+OR+robbery+OR+crash+OR+investigation)+when:2d"
    )

    for ms in data.get("mediaSources") or []:
        mid = ms.get("id") or "media"
        name = ms.get("name") or mid
        blot = bool(ms.get("publishesBlotters"))
        priority = SOURCE_PRIORITY_DIRECTORY_BLOTTER if blot else 3
        lbl = f"Blotter · {name}" if blot else name
        pages = []
        for pu in (ms.get("crimeCourtsSectionUrl"), ms.get("website")):
            purl = (pu or "").strip()
            if purl:
                pages.append(purl)
        seen_dom_local: set[str] = set()
        for j, page in enumerate(pages):
            dom = _directory_domain(page)
            if not dom or dom in seen_dom_local:
                continue
            seen_dom_local.add(dom)
            q = f"site:{dom}+{gnews_body}"
            gurl = f"https://news.google.com/rss/search?q={quote(q, safe='')}&hl=en-US&gl=US&ceid=US:en"
            _add(
                f"dir_media_gnews_{mid}_{j}",
                {
                    "url": gurl,
                    "label": lbl,
                    "filter": "albany",
                    "reliability": 0.91 if blot else 0.84,
                    "priority": priority,
                    "force_label": blot,
                },
            )

    for ag in data.get("agencies") or []:
        if ag.get("active") is False:
            continue
        tier = ag.get("tier") or ""
        if tier not in ("municipal", "county", "state"):
            continue
        aid = ag.get("id") or "agency"
        aname = ag.get("name") or aid
        abb = (ag.get("abbreviation") or "").strip()
        for idx, surf in enumerate(ag.get("newsPressSurfaces") or []):
            su = (surf.get("url") or "").strip()
            if not su or not surf.get("hasRss"):
                continue
            low = su.lower()
            if any(x in low for x in (".rss", "/rss", "rssfeed", "/feed", "format=rss")):
                _add(
                    f"dir_agency_rss_{aid}_{idx}",
                    {
                        "url": su,
                        "label": f"Official · {aname}",
                        "filter": "albany",
                        "reliability": 0.96,
                        "priority": 4,
                        "force_label": True,
                    },
                )
        # Additive coverage: include every agency news/press URL via site-scoped Google RSS,
        # even when explicit RSS is unavailable.
        for idx, surf in enumerate(ag.get("newsPressSurfaces") or []):
            su = (surf.get("url") or "").strip()
            if not su:
                continue
            dom2 = _directory_domain(su)
            if not dom2:
                continue
            s_type = (surf.get("type") or "").lower()
            s_label = (surf.get("label") or s_type or "News").strip()
            is_blotterish = any(k in s_type or k in s_label.lower() for k in ("blotter", "incident", "crime", "arrest"))
            q3 = f"site:{dom2}+albany+county+police+arrest+crime+investigation+when:2d"
            g3 = f"https://news.google.com/rss/search?q={quote(q3, safe='')}&hl=en-US&gl=US&ceid=US:en"
            _add(
                f"dir_agency_surface_gnews_{aid}_{idx}",
                {
                    "url": g3,
                    "label": f"Blotter · {aname}" if is_blotterish else f"Official · {aname}",
                    "filter": "albany",
                    "reliability": 0.95 if is_blotterish else 0.90,
                    "priority": SOURCE_PRIORITY_DIRECTORY_BLOTTER if is_blotterish else 4,
                    "force_label": is_blotterish,
                },
            )
        qn = f"{aname} {abb + ' ' if abb else ''}police albany county arrest OR crime OR investigation when:2d"
        g2 = f"https://news.google.com/rss/search?q={quote_plus(qn)}&hl=en-US&gl=US&ceid=US:en"
        _add(
            f"dir_agency_gnews_{aid}",
            {
                "url": g2,
                "label": f"Official · {aname}",
                "filter": "albany",
                "reliability": 0.93,
                "priority": 4,
                "force_label": True,
            },
        )

    return out


_NIXLE_TRY_SUFFIXES = ("", "/rss/", "/rss", "/feed/", "/feed")

_OPENMHZ_SYS_RE = re.compile(r"openmhz\.com/system/([^/?#]+)", re.I)


async def fetch_nixle_directory_articles() -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    try:
        data = _le_dir_cache()
    except Exception:
        return collected

    bases: list[str] = []
    for c in data.get("communityPlatforms") or []:
        u = (c.get("url") or "").strip()
        if "nixle" in u.lower():
            bases.append(u.split("#")[0].split("?")[0].rstrip("/"))
    for ag in data.get("agencies") or []:
        for ch in ag.get("alertChannels") or []:
            if (ch.get("system") or "").lower() == "nixle" and ch.get("url"):
                bases.append(
                    (ch["url"] or "").strip().split("#")[0].split("?")[0].rstrip("/")
                )
    for city in ("Albany", "Colonie", "Guilderland", "Bethlehem", "Cohoes", "Watervliet"):
        bases.append(f"https://www.nixle.com/rss/?city={city}&state=NY")
    seen_bases: set[str] = set()

    for base in bases:
        if not base or base in seen_bases:
            continue
        seen_bases.add(base)
        for suf in _NIXLE_TRY_SUFFIXES:
            try_url = (base + suf) if suf else base
            try:
                resp = await http_client.get(try_url, timeout=10.0)
                if resp.status_code != 200:
                    continue
                head = resp.text[:1200].lower()
                if "<item" not in head and "<entry" not in head:
                    continue
                parsed = parse_rss(resp.text, default_source="Nixle alert")
                for a in parsed:
                    a["source_priority"] = max(
                        int(a.get("source_priority") or 0), SOURCE_PRIORITY_NIXLE
                    )
                    a["source"] = "Nixle alert"
                    a["_nixle_item"] = True
                    if not a.get("_feed_reliability"):
                        a["_feed_reliability"] = 1.0
                collected.extend(parsed)
                break
            except Exception as e:
                print(f"Nixle try [{try_url}]: {e}")
    return collected


_OFFICIAL_X_HANDLES_CORE = [
    "albanypolice",
    "ACSOTWEET",
    "colonie_police",
    "PdBethlehem",
    "guilderlandpd",
    "VlietPolice",
    "nyspolice",
    "albanypd",
    "FBIAlbany",
]

# Status URLs must use real snowflake IDs (typically 18–19 digits). Short IDs are rejected → profile fallback.
_OFFICIAL_X_STATUS_RE = re.compile(
    r"^https?://(?:www\.)?(?:twitter\.com|x\.com)/([^/]+)/status/(\d+)",
    re.IGNORECASE,
)


def _resolve_official_x_post_url(handle: str, url: str | None) -> str:
    """Prefer exact post URL https://x.com/{user}/status/{snowflake}; else profile."""
    h = (handle or "").strip().lstrip("@")
    profile = f"https://x.com/{h}" if h else "https://x.com/"
    if not h:
        return ((url or "") or "").strip() or profile
    raw = ((url or "") or "").strip()
    if not raw or raw.lower() in ("null", "none", "undefined", ""):
        return profile
    base = raw.split("?")[0].split("#")[0]
    m = _OFFICIAL_X_STATUS_RE.match(base)
    if m:
        uname, tid = m.group(1), m.group(2)
        if tid.isdigit() and len(tid) >= 18:
            return f"https://x.com/{uname}/status/{tid}"
    return profile


_SOCIAL_GROK_SYSTEM = (
    "You reply with a single JSON array only. No markdown, no commentary. "
    "Each element: {\"handle\":\"twitterhandle\",\"title\":\"short headline\","
    "\"summary\":\"1-2 sentences\","
    "\"url\":\"https://x.com/handle/status/ID or null\","
    "\"tweet_id\":\"numeric snowflake only if verified\","
    "\"published_iso\":\"2026-03-28T12:00:00Z\"}. "
    "CRITICAL: Prefer real post links. tweet_id must be the true status id (18–19 digits) when known; "
    "otherwise omit tweet_id. url must be the exact https://x.com/{handle}/status/{tweet_id} permalink "
    "or null. tweet_id / status id must be a real 18–19 digit snowflake — never invent or shorten. "
    "Only Albany County NY or immediate Capital District law-enforcement / public-safety posts."
)


def _official_x_handles_from_directory() -> list[str]:
    found: set[str] = set(_OFFICIAL_X_HANDLES_CORE)
    try:
        data = _load_le_directory()
        for ag in data.get("agencies") or []:
            if ag.get("active") is False:
                continue
            for acct in ag.get("socialAccounts") or []:
                plat = (acct.get("platform") or "").lower()
                if plat not in ("twitter", "x"):
                    continue
                h = (acct.get("handle") or "").strip().lstrip("@")
                if h:
                    found.add(h)
    except Exception:
        pass
    return sorted(found, key=str.lower)


async def fetch_official_social_posts() -> list[dict[str, Any]]:
    cached = get_cached("grok_official_x_posts")
    if cached:
        return cached
    out: list[dict[str, Any]] = []
    if not XAI_API_KEY:
        return out

    handles = _official_x_handles_from_directory()
    prompt = (
        "Using live X (Twitter) knowledge, list up to 1 substantive public post per account "
        f"(max {min(48, len(handles) or 1)} items total) from ONLY these handles — do not add any other account: "
        + ", ".join("@" + h for h in handles)
        + ". Time window: last 24 hours only. Topics: arrests, investigations, safety alerts, "
        "wanted/missing, crashes, fires, major police activity in Albany County NY or the immediate Capital District. "
        "Each item's url MUST be the real https://x.com/{handle}/status/{snowflake_id} for that exact post "
        "(snowflake ~18–19 digits), and/or include tweet_id with that same snowflake. "
        "If you cannot confirm the real id, set url and tweet_id to null (omit fake short IDs). "
        "handle must match one of the listed handles (case-insensitive). JSON array only."
    )
    try:
        text = await call_grok(
            [
                {"role": "system", "content": _SOCIAL_GROK_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            max_tokens=4500,
            temperature=0.08,
            timeout=120.0,
        )
        if not text:
            return out
        m = re.search(r"\[[\s\S]*\]", text)
        raw = m.group(0) if m else text
        items = json.loads(raw)
        if not isinstance(items, list):
            items = []
        allow_h = {x.lower() for x in handles}
        for it in items:
            if not isinstance(it, dict):
                continue
            h = (it.get("handle") or "").strip().lstrip("@")
            if h.lower() not in allow_h:
                continue
            title = (it.get("title") or it.get("summary") or "").strip()
            if not title:
                continue
            raw_u = it.get("url")
            if raw_u is not None and isinstance(raw_u, str):
                raw_u = raw_u.strip()
            else:
                raw_u = None
            tid_raw = it.get("tweet_id")
            if tid_raw is not None and isinstance(tid_raw, (int, float)):
                tid_s = str(int(tid_raw))
            elif isinstance(tid_raw, str):
                tid_s = tid_raw.strip()
            else:
                tid_s = ""
            if tid_s.isdigit() and len(tid_s) >= 18 and h:
                raw_u = raw_u or f"https://x.com/{h}/status/{tid_s}"
            link = _resolve_official_x_post_url(h, raw_u)
            x_post = link if "/status/" in link else ""
            desc = (it.get("summary") or "")[:400]
            pub_raw = (it.get("published_iso") or "").strip()
            try:
                dt = datetime.fromisoformat(pub_raw.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                pstr = format_datetime(dt, usegmt=True)
            except Exception:
                pstr = format_datetime(datetime.now(timezone.utc), usegmt=True)
            out.append(
                {
                    "title": title,
                    "link": link,
                    "x_post_url": x_post,
                    "pubDate": pstr,
                    "description": desc,
                    "source": f"Official @{h}" if h else "Official X",
                    "source_priority": SOURCE_PRIORITY_OFFICIAL_X_GROK,
                    "_official_x_post": True,
                    "_feed_reliability": 0.96,
                    "source_url": "",
                }
            )
    except Exception as e:
        print(f"fetch_official_social_posts: {e}")

    if out:
        set_cached("grok_official_x_posts", out)
    return out


def _nitter_link_to_x_status(url: str) -> str:
    """Map Nitter (or x.com) item link to canonical x.com/status URL with 18+ digit snowflake."""
    m = re.search(r"/([^/]+)/status/(\d{18,})", url or "", re.I)
    if m:
        return f"https://x.com/{m.group(1)}/status/{m.group(2)}"
    return ""


async def fetch_nitter_official_x_rss_posts() -> list[dict[str, Any]]:
    """
    Best-effort real X permalinks via public Nitter mirrors (no API key).
    Cached; failures return [] without breaking the feed.
    """
    cached = get_cached("nitter_official_x")
    if cached is not None:
        return cached
    out: list[dict[str, Any]] = []
    hosts = ("nitter.poast.org", "nitter.net", "nitter.it", "nitter.privacydev.net")
    handles_ordered: list[str] = []
    seen_h: set[str] = set()
    for h in list(_OFFICIAL_X_HANDLES_CORE) + sorted(
        _official_x_handles_from_directory(), key=str.lower
    ):
        key = h.lower()
        if key in seen_h:
            continue
        seen_h.add(key)
        handles_ordered.append(h)
        if len(handles_ordered) >= 40:
            break

    async def _pull_one(handle: str) -> list[dict[str, Any]]:
        got: list[dict[str, Any]] = []
        for host in hosts:
            try:
                rss_url = f"https://{host}/{handle}/rss"
                resp = await http_client.get(rss_url, timeout=9.0, follow_redirects=True)
                if resp.status_code != 200:
                    continue
                parsed = parse_rss(resp.text, default_source=f"Official @{handle}")
                for a in parsed[:6]:
                    xu = _nitter_link_to_x_status(a.get("link", "") or "")
                    if not xu:
                        continue
                    got.append(
                        {
                            "title": (a.get("title") or "").strip() or "Post",
                            "link": xu,
                            "x_post_url": xu,
                            "pubDate": a.get("pubDate")
                            or format_datetime(datetime.now(timezone.utc), usegmt=True),
                            "description": ((a.get("description") or "")[:400]),
                            "source": f"Official @{handle}",
                            "source_priority": SOURCE_PRIORITY_OFFICIAL_X_GROK,
                            "_official_x_post": True,
                            "_official_x_nitter_rss": True,
                            "_feed_reliability": 0.95,
                            "source_url": "",
                        }
                    )
                if got:
                    break
            except Exception:
                continue
        return got

    try:
        batches = await asyncio.gather(*[_pull_one(h) for h in handles_ordered])
        for b in batches:
            out.extend(b)
    except Exception as e:
        print(f"fetch_nitter_official_x_rss_posts: {e}")
    set_cached("nitter_official_x", out)
    return out


def _openmhz_call_age_hours(t_raw: str) -> Optional[float]:
    try:
        s = (t_raw or "").strip()
        if not s:
            return None
        if s.isdigit():
            n = int(s)
            if n > 10_000_000_000:
                n = n // 1000
            dt = datetime.fromtimestamp(n, tz=timezone.utc)
        elif "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        else:
            return None
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
    except Exception:
        return None


def _openmhz_time_to_rfc(raw: str) -> str:
    try:
        s = (raw or "").strip()
        if not s:
            return format_datetime(datetime.now(timezone.utc), usegmt=True)
        if s.isdigit():
            n = int(s)
            if n > 10_000_000_000:
                n = n // 1000
            dt = datetime.fromtimestamp(n, tz=timezone.utc)
            return format_datetime(dt, usegmt=True)
        if "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return format_datetime(dt, usegmt=True)
    except Exception:
        pass
    return format_datetime(datetime.now(timezone.utc), usegmt=True)


async def fetch_scanner_directory_items() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        data = _load_le_directory()
    except Exception:
        return out

    tg_map: dict[str, Any] = {}
    try:
        tg_map = _build_scanner_talkgroups_payload().get("talkgroups") or {}
    except Exception:
        tg_map = {}

    mapper = get_talkgroup_mapper()
    mapper_index: dict[str, dict[str, Any]] = {}
    try:
        mapper_index = await mapper.get_merged_talkgroups()
    except Exception:
        mapper_index = mapper.merge_rr_with_wiki({})
    pri_ids = mapper.priority_ids()

    def _lookup_tg_row(call: dict) -> tuple[Optional[dict], str]:
        raw = call.get("talkgroup_num") if call.get("talkgroup_num") is not None else call.get("talkgroup")
        tid = str(raw).strip() if raw is not None else ""
        if not tid:
            return None, ""
        norm = str(int(tid)) if tid.isdigit() else tid
        row = tg_map.get(tid) or tg_map.get(norm)
        if row is None:
            stripped = tid.lstrip("0") or "0"
            row = tg_map.get(stripped)
        return row, norm

    def _mapper_row(tid: str) -> dict[str, Any]:
        return mapper_index.get(tid) or {}

    def _build_provenance(tid: str, m_row: dict[str, Any]) -> dict[str, Any]:
        return {
            "source": "scanner",
            "system": "albany_p25",
            "talkgroup_id": tid,
            "priority": tid in pri_ids,
            "mapping_source": "soap" if m_row.get("rr_row_present") else "wiki",
        }

    agencies_by_id = {a.get("id"): a for a in (data.get("agencies") or []) if a.get("id")}
    se = data.get("scannerEcosystem") or {}
    feeds = se.get("feeds") or []
    for i, fd in enumerate(feeds):
        prov = (fd.get("provider") or "").lower()
        label = fd.get("label") or "Scanner"
        url = (fd.get("url") or "").strip()
        cov = (fd.get("coverageDescription") or "").strip()
        if prov == "openmhz":
            m = _OPENMHZ_SYS_RE.search(url)
            if not m:
                continue
            slug = m.group(1)
            try:
                resp = await http_client.get(
                    f"https://api.openmhz.com/{slug}/calls",
                    params={"num": OPENMHZ_CALLS_PER_SYSTEM},
                    timeout=14.0,
                )
                if resp.status_code != 200:
                    continue
                payload = resp.json()
                for call in (payload.get("calls") or [])[:OPENMHZ_CALLS_PER_SYSTEM]:
                    audio_url = call.get("url", "") or ""
                    tg_tag = (
                        call.get("talkgroup_tag", "")
                        or call.get("talkgroupTag", "")
                        or call.get("talkgroup_description", "")
                        or call.get("talkgroupDescription", "")
                        or "Radio traffic"
                    )
                    tg_desc = (
                        str(call.get("talkgroup_description", "") or call.get("talkgroupDescription", "") or "")
                    )
                    crit_blob = f"{tg_tag} {tg_desc}".strip()
                    t_raw = str(call.get("time", "") or "")
                    age_h = _openmhz_call_age_hours(t_raw)
                    if age_h is None:
                        age_h = 0.0
                    is_critical = _scanner_blob_matches_critical_live(crit_blob)
                    if age_h > LIVE_CUTOFF_HOURS:
                        continue
                    if not is_critical and age_h > SCANNER_OPENMHZ_RECENT_HOURS:
                        continue
                    row, tid_s = _lookup_tg_row(call)
                    m_row = _mapper_row(tid_s)
                    agency_name = (
                        m_row.get("agency")
                        or (row or {}).get("department")
                        or tg_tag
                    )
                    muni = (
                        m_row.get("municipality")
                        or m_row.get("jurisdiction_hint")
                        or (row or {}).get("location")
                        or ""
                    )
                    discipline = m_row.get("discipline") or m_row.get("discipline_hint") or ""
                    channel_label = (
                        m_row.get("wiki_channel_label")
                        or m_row.get("alpha")
                        or tg_tag
                    )
                    dept_loc = f"{agency_name} — {muni}" if muni else agency_name
                    is_priority = tid_s in pri_ids
                    desc_bits = [cov] if cov else []
                    if call.get("freq"):
                        hz = call.get("freq")
                        try:
                            mhz = float(hz) / 1e6 if float(hz) > 1e6 else float(hz)
                            desc_bits.append(f"{mhz:.4f} MHz")
                        except (TypeError, ValueError):
                            desc_bits.append(f"Freq {hz}")
                    if call.get("len") or call.get("duration"):
                        ln = call.get("len", 0) or call.get("duration", 0)
                        try:
                            desc_bits.append(f"{float(ln):.0f}s audio" if ln else "")
                        except (TypeError, ValueError):
                            pass
                    desc = " · ".join(x for x in desc_bits if x)[:400]
                    if is_critical or is_priority:
                        card_title = f"Critical radio · {dept_loc}: {channel_label}"
                        prio = SOURCE_PRIORITY_SCANNER_CRITICAL
                        crit_f, recent_f = True, False
                    else:
                        card_title = f"Radio · {dept_loc}: {channel_label}"
                        prio = SOURCE_PRIORITY_SCANNER_RECENT
                        crit_f, recent_f = False, True
                    conf = TalkgroupMapper.confidence_01(call, m_row) if m_row else 0.50
                    if is_priority:
                        conf = min(0.95, conf + 0.05)
                    tags: list[str] = ["scanner"]
                    if is_priority:
                        tags.append("priority_signal")
                    if discipline:
                        tags.append(discipline)
                    article: dict[str, Any] = {
                            "title": card_title,
                            "link": audio_url or f"https://openmhz.com/system/{slug}",
                            "pubDate": _openmhz_time_to_rfc(t_raw),
                            "description": (desc + " · " if desc else "") + crit_blob[:280],
                            "source": f"Scanner · {label}",
                            "source_priority": prio,
                            "confidence": conf,
                            "municipality": muni,
                            "_scanner_call": True,
                            "_scanner_critical_live": crit_f,
                            "_scanner_recent_live": recent_f,
                            "_scanner_tg": tid_s or None,
                            "_scanner_priority_p25": is_priority,
                            "_feed_reliability": 0.88,
                            "source_url": "",
                    }
                    if tid_s:
                        article["raw_payload"] = {
                            "source_class": "scanner_directory",
                            "trust_tier": "tier_3",
                            "lane": "developing_incidents",
                            "ingestion": "scanner_albany_p25_main" if m_row else "openmhz_directory",
                            "provenance": _build_provenance(tid_s, m_row),
                        }
                        article["provenance"] = _build_incident_provenance(
                            source_class="scanner_directory",
                            source_id="scanner_albany_p25_main" if m_row else "openmhz_directory",
                            trust_tier="tier_3",
                            lane="developing_incidents",
                            ingestion_method="openmhz_api",
                            feed_url=audio_url or f"https://openmhz.com/system/{slug}",
                            captured_at=t_raw or datetime.now(timezone.utc).isoformat(),
                            content_type="scanner_call",
                            capture_method="soap" if m_row.get("rr_row_present") else "wiki",
                        )
                    if tags:
                        article["incident"] = {
                            "source_type": "scanner",
                            "verification_level": "scanner",
                            "confidence_score": conf,
                            "municipality": muni,
                            "operational_badges": tags,
                        }
                    out.append(article)
            except Exception as e:
                print(f"OpenMHz directory [{label}]: {e}")
        elif prov == "broadcastify":
            ts = datetime.now(timezone.utc) - timedelta(seconds=i * 3)
            out.append(
                {
                    "title": f"Live scanner audio · {label}",
                    "link": url,
                    "pubDate": format_datetime(ts, usegmt=True),
                    "description": (
                        (cov + " · ") if cov else ""
                    )
                    + "Broadcastify stream — police / fire / EMS traffic (third-party relay).",
                    "source": f"Scanner · {label}",
                    "source_priority": SOURCE_PRIORITY_SCANNER_FEED_LINK,
                    "_scanner_call": True,
                    "_scanner_feed_link": True,
                    "_scanner_recent_live": True,
                    "_feed_reliability": 0.75,
                    "source_url": "",
                }
            )
    # Additive: include all listed conventional frequency channels as recent scanner rows.
    for i, cf in enumerate(se.get("conventionalFrequencies") or []):
        agency_id = (cf.get("agency") or "").strip()
        ag = agencies_by_id.get(agency_id) or {}
        ag_name = (ag.get("abbreviation") or ag.get("name") or agency_id or "Agency").strip()
        city = ((ag.get("contact") or {}).get("city") or "").strip()
        loc = city or "Albany County"
        freq = (cf.get("frequency") or "").strip()
        tone = (cf.get("tone") or "").strip()
        use = (cf.get("use") or "").strip() or "Conventional channel"
        mode = (cf.get("mode") or "").strip()
        ts = datetime.now(timezone.utc) - timedelta(seconds=(i + 1) * 4)
        detail = " · ".join(x for x in (freq, tone, mode) if x)
        out.append(
            {
                "title": f"SCANNER · {ag_name} — {loc}: {use}",
                "link": "",
                "pubDate": format_datetime(ts, usegmt=True),
                "description": ((detail + " · ") if detail else "") + "Directory conventional frequency listing.",
                "source": f"Scanner · {ag_name}",
                "source_priority": SOURCE_PRIORITY_SCANNER_RECENT,
                "_scanner_call": True,
                "_scanner_recent_live": True,
                "_scanner_conventional": True,
                "_feed_reliability": 0.86,
                "matched_location": loc,
                "municipality": loc,
                "source_url": "",
            }
        )
    try:
        cached_calls = get_cached("scanner_calls")
        if cached_calls is not None:
            merged_sig = list(cached_calls)
            tg_idx = await get_talkgroup_mapper().get_merged_talkgroups()
        else:
            merged_sig, _su, tg_idx = await _merge_scanner_calls_from_sources(write_cache=True)
        out.extend(await _priority_p25_scanner_signal_articles(merged_sig, merged_tg_index=tg_idx))
    except Exception as exc:
        logger.warning("priority_p25_directory_extend_error error=%s", exc)
    return out


@app.get("/api/directory/metadata")
async def directory_metadata():
    d = _le_dir_cache()
    return {"status": "ok", "metadata": d.get("metadata")}


@app.get("/api/directory/agencies")
async def directory_agencies():
    d = _le_dir_cache()
    return {"status": "ok", "agencies": d.get("agencies", [])}


@app.get("/api/directory/municipalities")
async def directory_municipalities():
    d = _le_dir_cache()
    return {"status": "ok", "municipalities": d.get("municipalities", [])}


@app.get("/api/directory/scanner")
async def directory_scanner():
    d = _le_dir_cache()
    return {"status": "ok", "scannerEcosystem": d.get("scannerEcosystem")}


@app.get("/api/directory/media")
async def directory_media():
    d = _le_dir_cache()
    return {"status": "ok", "mediaSources": d.get("mediaSources", [])}


@app.get("/api/directory/community")
async def directory_community():
    d = _le_dir_cache()
    return {"status": "ok", "communityPlatforms": d.get("communityPlatforms", [])}


@app.get("/api/dev/albany-open-data")
async def dev_albany_open_data(request: Request):
    try:
        qp = request.query_params
        limit = int(qp.get("limit", "100"))
        offset = int(qp.get("offset", "0"))
    except Exception:
        limit, offset = 100, 0
    try:
        data = await fetch_albany_open_data(limit=limit, offset=offset)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"/api/dev/albany-open-data error: {e}")
        return []


# =============================================================================
# SUPERFEEDR WEBHOOK + ADMIN
# =============================================================================

def require_superfeedr_admin(
    x_admin_token: Optional[str] = Header(default=None, alias="X-Admin-Token"),
) -> None:
    """Gate /api/dev/superfeedr/* endpoints behind SUPERFEEDR_ADMIN_TOKEN.

    401 when the token is missing (header absent or empty).
    403 when a token is provided but does not match the server value.
    503 when SUPERFEEDR_ADMIN_TOKEN is not configured on the server, so these
        endpoints cannot be reached in production without explicit setup.
    """
    configured = get_settings().superfeedr_admin_token
    if not configured:
        raise HTTPException(
            status_code=503,
            detail="SUPERFEEDR_ADMIN_TOKEN not configured on server",
        )
    if not x_admin_token:
        raise HTTPException(status_code=401, detail="admin token required")
    if not hmac.compare_digest(str(x_admin_token), str(configured)):
        raise HTTPException(status_code=403, detail="invalid admin token")


@app.get("/api/superfeedr/webhook")
async def superfeedr_webhook_verify(request: Request):
    """Handle PubSubHubbub verification and browser probes."""
    challenge = request.query_params.get("hub.challenge")
    if challenge:
        return PlainTextResponse(challenge)
    return {"status": "ok", "method": "POST", "detail": "Superfeedr webhook endpoint"}


@app.post("/api/superfeedr/webhook")
async def superfeedr_webhook(request: Request):
    """Receive Superfeedr push notifications and feed into ACT pipeline."""
    body_bytes = await request.body()
    secret = get_settings().superfeedr_secret
    if secret:
        sig = request.headers.get("X-Hub-Signature", "")
        if not superfeedr_svc.verify_signature(body_bytes, sig, secret):
            logger.warning("superfeedr_webhook_signature_mismatch")
            raise HTTPException(status_code=403, detail="signature mismatch")

    try:
        payload = await request.json()
    except Exception:
        logger.warning("superfeedr_webhook_invalid_json")
        return {"ok": True, "articles": 0}

    articles = superfeedr_svc.parse_notification(payload)
    if not articles:
        superfeedr_svc.record_notification(0, 0)
        return {"ok": True, "articles": 0}

    try:
        stats = await persist_articles_as_incidents(articles)
        persisted = stats.get("inserted", 0) + stats.get("updated", 0)
    except Exception as exc:
        logger.warning("superfeedr_webhook_persistence_error: %s", exc)
        superfeedr_svc.record_error()
        persisted = 0

    superfeedr_svc.record_notification(len(articles), persisted)
    logger.info(
        "superfeedr_webhook_processed articles=%s persisted=%s",
        len(articles),
        persisted,
    )
    return {"ok": True, "articles": len(articles), "persisted": persisted}


@app.get("/api/dev/superfeedr/status")
async def superfeedr_status(_: None = Depends(require_superfeedr_admin)):
    return {"status": "ok", **superfeedr_svc.runtime_status()}


@app.post("/api/dev/superfeedr/subscribe")
async def superfeedr_subscribe_endpoint(
    request: Request, _: None = Depends(require_superfeedr_admin)
):
    body = await request.json()
    feed_url = str(body.get("feed_url") or "").strip()
    if not feed_url:
        raise HTTPException(status_code=400, detail="feed_url required")
    s = get_settings()
    callback_base = s.superfeedr_callback_base_url
    if not callback_base:
        raise HTTPException(status_code=500, detail="SUPERFEEDR_CALLBACK_BASE_URL not set")
    callback = f"{callback_base}/api/superfeedr/webhook"
    result = await superfeedr_svc.subscribe(
        feed_url, callback, secret=s.superfeedr_secret,
    )
    return result


@app.post("/api/dev/superfeedr/unsubscribe")
async def superfeedr_unsubscribe_endpoint(
    request: Request, _: None = Depends(require_superfeedr_admin)
):
    body = await request.json()
    feed_url = str(body.get("feed_url") or "").strip()
    if not feed_url:
        raise HTTPException(status_code=400, detail="feed_url required")
    s = get_settings()
    callback_base = s.superfeedr_callback_base_url
    if not callback_base:
        raise HTTPException(status_code=500, detail="SUPERFEEDR_CALLBACK_BASE_URL not set")
    callback = f"{callback_base}/api/superfeedr/webhook"
    result = await superfeedr_svc.unsubscribe(feed_url, callback)
    return result


@app.get("/api/dev/superfeedr/subscriptions")
async def superfeedr_list_subscriptions(
    page: int = 1, _: None = Depends(require_superfeedr_admin)
):
    return await superfeedr_svc.list_subscriptions(page=page)


@app.post("/api/dev/superfeedr/seed")
async def superfeedr_seed_subscriptions(_: None = Depends(require_superfeedr_admin)):
    results = await superfeedr_svc.subscribe_seed_feeds()
    return {"status": "ok", "results": results}


@app.get("/api/dev/superfeedr/desired")
async def superfeedr_desired_subscriptions(_: None = Depends(require_superfeedr_admin)):
    """Return the registry-derived desired Superfeedr subscriptions."""
    from app.services.superfeedr_registry import desired_subscriptions
    desired = desired_subscriptions()
    return {
        "status": "ok",
        "count": len(desired),
        "feeds": [
            {
                "source_id": e.get("source_id"),
                "source_name": e.get("source_name"),
                "feed_url": e.get("feed_url"),
                "trust_tier": e.get("trust_tier"),
                "lane": e.get("lane"),
                "category": e.get("category"),
            }
            for e in desired
        ],
    }


@app.get("/api/dev/superfeedr/reconcile")
async def superfeedr_reconcile_preview(_: None = Depends(require_superfeedr_admin)):
    """Dry-run reconcile: diff desired vs active Superfeedr subscriptions."""
    from app.services.superfeedr_registry import reconcile
    return await reconcile(dry_run=True)


@app.post("/api/dev/superfeedr/reconcile")
async def superfeedr_reconcile_apply(_: None = Depends(require_superfeedr_admin)):
    """Apply reconcile plan: subscribe missing, unsubscribe extras, fix mismatches."""
    from app.services.superfeedr_registry import reconcile
    return await reconcile(dry_run=False)


# =============================================================================
# STATIC FILES — Must be last (catches all unmatched routes)
# =============================================================================
def _asset_version_token() -> str:
    """Per-deploy cache-bust token for app.js / style.css.

    Computed from the mtime hash of the two top-level frontend assets so it
    rolls every time either file changes on disk — which on Railway is once
    per deploy. Falls back to a process-start timestamp if the files cannot
    be stat'd, so the response never errors.
    """
    base = os.path.dirname(os.path.abspath(__file__))
    parts: list[str] = []
    for name in ("app.js", "style.css"):
        try:
            parts.append(str(int(os.path.getmtime(os.path.join(base, name)))))
        except OSError:
            parts.append("0")
    # Short stable hash so the version is opaque but deterministic.
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


@app.get("/")
async def root():
    index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            html = f.read()
        # Per-deploy cache-bust on app.js / style.css so browsers and any
        # edge cache fetch the freshly-built file after each Railway deploy.
        # Without this, production users see the previous bundle until they
        # hard-refresh — the exact symptom that masked the 9b92941 deploy.
        html = html.replace("__ASSET_VERSION__", _asset_version_token())
        # The HTML itself must be revalidated every request; the assets it
        # references are versioned so they can stay aggressively cached.
        return HTMLResponse(
            html,
            headers={
                "Cache-Control": "no-cache, must-revalidate",
                "Pragma": "no-cache",
            },
        )
    except Exception as e:
        return HTMLResponse(f"<h1>ERROR loading index.html</h1><pre>{str(e)}</pre>")


app.mount("/", StaticFiles(directory=os.path.dirname(os.path.abspath(__file__)), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("api_server:app", host="0.0.0.0", port=port)
