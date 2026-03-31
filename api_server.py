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
import json
import json as _json
import logging
import os
import re
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
from sources.tier1_official import fetch_tier1_sources
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse
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
from app.services.incident_persistence import persist_articles_as_incidents
from app.services.incident_repository import incident_trends
from app.services.incident_repository import incident_store_backend
from app.services.incident_repository import query_incidents
from app.services.incident_repository import summarize_incidents
from app.services.incident_transformers import article_to_incident
from app.services.geocoding import geocode_article_mapbox, geocode_cache_stats
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

# Non-local source names — reject regardless
NON_LOCAL_SOURCES = frozenset([
    "iceland review", "reykjavik grapevine", "manila bulletin",
    "the guardian", "bbc news", "sydney morning herald",
    "the australian", "times of india", "daily mail",
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
            "(%22Albany+County%22+OR+%22City+of+Albany%22+OR+Colonie+OR+Latham)"
            "+(crash+OR+fire+OR+shooting+OR+stabbing+OR+pursuit+OR+closure+OR+missing+OR+alert)"
            "+when:1d&hl=en-US&gl=US&ceid=US:en"
        ),
        "label": "Capital Region breaking",
        "filter": "strict",
        "reliability": 0.72,
        "priority": 2,
    },
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
}


def build_operational_rss_feeds() -> dict[str, dict]:
    """
    Optional 511NY / NY-Alert RSS layers. Set env to enable:
      NY511_CAPITAL_DISTRICT_RSS — regional traffic/incident RSS URL
      NY_ALERT_RSS_URL — state or campus alert RSS URL
    """
    out: dict[str, dict] = {}
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


def _dedup_should_replace_rep(rep: dict, cand: dict) -> bool:
    """
    Prefer fresher scanner/Nixle over stale official X when the cluster is the same story,
    so routine social posts do not swallow operational audio/alerts.
    """
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
    # Hamlets added in v6
    "westmere": (42.6953, -73.8694),     # Hamlet in Guilderland, along Western Ave
    "knox": (42.6880, -74.0800),          # Town of Knox, Albany County
    "berne": (42.6100, -74.1750),         # Town of Berne, Albany County
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
    "Colonie": ["colonie", "latham", "loudonville", "wolf road", "roessleville", "karner", "colonie center"],
    "Bethlehem": ["bethlehem", "delmar", "slingerlands", "selkirk", "glenmont", "elsmere"],
    "Cohoes": ["cohoes"],
    "Watervliet": ["watervliet"],
    "Guilderland": ["guilderland", "crossgates", "crossgates mall", "fuller road", "altamont"],
    "Green Island": ["green island"],
    "Menands": ["menands"],
    "Ravena/Coeymans": ["ravena", "coeymans", "selkirk"],
    "New Scotland": ["new scotland", "voorheesville", "feura bush", "clarksville", "westerlo"],
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
    yield
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
    """Extra locality anchors learned from le_directory.json (cities/municipal labels)."""
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
    _DIR_LOCALITY_SIGNALS_CACHE = frozenset(vals)
    return _DIR_LOCALITY_SIGNALS_CACHE


def _strict_blob(article: dict) -> str:
    parts = [
        article.get("title", "") or "",
        article.get("description", "") or "",
        article.get("source", "") or "",
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


def evaluate_strict_albany_county(article: dict) -> tuple[bool, str]:
    """
    True only when the item is genuinely anchored to Albany County, New York.
    Sets debug fields via is_albany_related caller.
    """
    if article.get("_scanner_call") or article.get("_scanner_feed_link"):
        return True, "albany_county_scanner_feed"

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

    if article.get("_511_incident") or article.get("_ny_alert"):
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
        try:
            timeout = cfg.get("timeout", 15)
            resp = await fetch_with_retry(
                http_client,
                cfg["url"],
                timeout=float(timeout),
                retries=settings.external_retry_attempts,
            )
            if resp and resp.status_code == 200:
                parsed = parse_rss(resp.text, default_source=cfg.get("label"))
                for a in parsed:
                    a["_feed_reliability"] = cfg.get("reliability", 0.97)
                    a["source_priority"] = 4
                    # Force the official label so it shows "Official @..." in the feed
                    if cfg.get("force_label"):
                        a["source"] = cfg["label"]
                filter_mode = cfg.get("filter")
                if filter_mode in ("strict", "albany"):
                    pass  # strict Albany County NY gate runs once after merge (fetch_all_feeds)
                elif filter_mode == "crime":
                    parsed = [a for a in parsed if any(
                        kw in (a.get("title","") + " " + a.get("description","")).lower()
                        for kw in CRIME_KEYWORDS
                    )]
                return parsed
        except Exception as e:
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
        try:
            resp = await fetch_with_retry(
                http_client,
                cfg["url"],
                timeout=settings.external_timeout_seconds,
                retries=settings.external_retry_attempts,
            )
            if resp and resp.status_code == 200:
                parsed = parse_rss(resp.text, default_source=cfg.get("label"))

                # Attach feed-level reliability and priority to articles
                feed_reliability = cfg.get("reliability", 0.70)
                feed_priority = cfg.get("priority", 1)
                for a in parsed:
                    if not a.get("_feed_reliability"):
                        a["_feed_reliability"] = feed_reliability
                    a["source_priority"] = max(a.get("source_priority", 0), feed_priority)
                    # Official sources: force our label so badge shows in the UI
                    if cfg.get("force_label") and cfg.get("label"):
                        a["source"] = cfg["label"]
                if cfg.get("tag_511"):
                    for a in parsed:
                        a["_511_incident"] = True
                if cfg.get("tag_ny_alert"):
                    for a in parsed:
                        a["_ny_alert"] = True

                # Apply location filter
                filter_mode = cfg.get("filter")
                if filter_mode in ("strict", "albany"):
                    pass  # strict Albany County NY gate runs once after merge (below)
                elif filter_mode == "crime":
                    # "crime" mode: location guaranteed (official PD X accounts);
                    # keep only posts that mention at least one crime keyword
                    def has_crime_kw(a):
                        t = (a.get("title","") + " " + a.get("description","")).lower()
                        return any(kw in t for kw in CRIME_KEYWORDS)
                    parsed = [a for a in parsed if has_crime_kw(a)]
                elif filter_mode is None:
                    pass  # strict geo + false positives in post-merge is_albany_related()

                return parsed
        except Exception as e:
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

    # Real-time layers from directory + OpenMHz / Nixle / Grok / Nitter RSS mirrors (parallel)
    _extra_batches = await asyncio.gather(
        fetch_nixle_directory_articles(),
        # fetch_official_social_posts(),
        # fetch_nitter_official_x_rss_posts(),
        fetch_scanner_directory_items(),
        fetch_tier1_sources(limit_per_source=80, strict_live_sources=strict_live_sources),
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
    return bool(a.get("_511_incident") or a.get("_ny_alert"))


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
        # Mapbox fallback: if dictionary geocoder found no coords, try Mapbox
        if geo.get("latitude") is None and geo.get("longitude") is None:
            geo = await geocode_article_mapbox(geo)
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
    # Fallback to raw feed rows if the filtered crime list is temporarily empty.
    rows_for_persistence = geocoded if geocoded else all_articles[:250]
    persistence_stats = await persist_articles_as_incidents(rows_for_persistence)

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
    if sort_mode not in ("newest", "severity", "verification", "priority"):
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
    payload = {
        "status": "ok",
        "source": incident_store_backend(),
        "count": len(items),
        "incidents": items,
    }
    return payload


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
    if sort_mode not in ("newest", "severity", "verification", "priority"):
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


@app.get("/api/home/news")
async def get_home_news():
    now = datetime.now(timezone.utc)
    items_48h = await query_incidents(
        limit=200,
        sort_by="newest",
        start_date=now - timedelta(hours=48),
    )

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

    major_stories: list[dict[str, Any]] = []
    developing_stories: list[dict[str, Any]] = []
    seen_titles: set[str] = set()
    for it in scored:
        title = str(it.get("short_title") or it.get("title") or "").strip()
        title_key = title.lower()[:60]
        if title_key in seen_titles:
            continue
        seen_titles.add(title_key)
        entry = {
            "id": it.get("id"),
            "title": title,
            "summary": str(it.get("description") or "")[:200],
            "municipality": it.get("municipality") or "",
            "occurred_at": it.get("occurred_at") or it.get("published_at"),
            "human_time": it.get("human_time") or "",
            "severity": it.get("severity") or "unknown",
            "source_name": it.get("source_name") or "",
            "source_type": it.get("source_type") or "",
            "verification_level": it.get("verification_level") or "unknown",
            "coordinate_quality": it.get("coordinate_quality") or "missing",
            "priority_score": round(_score(it), 1),
        }
        ver_lev = str(it.get("verification_level") or "").lower()
        status = str(it.get("status") or "").lower()
        if ver_lev in ("scanner", "inferred") or status == "active":
            developing_stories.append(entry)
        else:
            major_stories.append(entry)
        if len(major_stories) >= 3 and len(developing_stories) >= 3:
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
        "major_stories": major_stories[:3],
        "developing_stories": developing_stories[:3],
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


@app.get("/api/scanner/calls")
async def get_scanner_calls():
    cache_key = "scanner_calls"
    cached = get_cached(cache_key)
    if cached:
        return {"status": "ok", "source": "cache", "calls": cached}

    OPENMHZ_SYSTEM = "albanycony"  # Albany County NY system slug on OpenMHz
    try:
        resp = await http_client.get(
            f"https://api.openmhz.com/{OPENMHZ_SYSTEM}/calls",
            params={"num": 40},
            timeout=12.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            calls = []
            for call in data.get("calls", [])[:40]:
                # Extract TG number — OpenMHz embeds it in the audio URL path
                # e.g. /media/albanycony/10702/albanycony-10702-timestamp.m4a
                audio_url = call.get("url", "")
                tg_num = str(call.get("talkgroup", "") or "")
                if not tg_num:
                    import re as _re
                    m = _re.search(r"/(\d{4,6})/", audio_url)
                    if m:
                        tg_num = m.group(1)
                calls.append({
                    "id": call.get("_id", ""),
                    "time": call.get("time", ""),
                    "talkgroup_num": tg_num,
                    "talkgroup_tag": call.get("talkgroup_tag", "") or call.get("talkgroupTag", ""),
                    "talkgroup_description": call.get("talkgroup_description", "") or call.get("talkgroupDescription", ""),
                    "audio_url": audio_url,
                    "duration": call.get("len", 0) or call.get("duration", 0),
                    "freq": call.get("freq", 0),
                })
            set_cached(cache_key, calls)
            return {"status": "ok", "source": "live", "calls": calls}
    except Exception as e:
        print(f"Scanner error: {e}")

    # Fallback — no mock data
    return {"status": "ok", "source": "unavailable", "calls": []}


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

    _rows: list[tuple[str, Optional[str], str, str, str, str, str]] = [
        ("15202", "albany-county-sheriff", "Law Dispatch", "Albany County Law Dispatch", "County-wide", "police", "high"),
        ("10702", None, "", "Albany County Fire Dispatch", "County-wide", "fire", "high"),
        ("11702", None, "", "County Fire Tac", "County-wide", "fire", "medium"),
        ("10003", "albany-county-sheriff", "Dispatch", "Albany County Sheriff", "County-wide", "police", "high"),
        ("13102", "albany-pd", "Dispatch", "Albany PD Dispatch", "City of Albany", "police", "high"),
        ("13202", "albany-pd", "Ops", "Albany PD Ops", "City of Albany", "police", "high"),
        ("11003", None, "", "Albany County EMS", "County-wide", "ems", "high"),
        ("10921", None, "", "Albany County Interop", "County-wide", "police", "medium"),
        ("10922", None, "", "Multi-Agency Tac", "County-wide", "police", "medium"),
        ("10923", None, "", "Emergency Ops", "County-wide", "police", "high"),
        ("10925", None, "", "Albany County OEM", "County-wide", "police", "medium"),
        ("18301", "albany-county-sheriff", "Law Ops", "Albany County Law Ops", "County-wide", "police", "high"),
        ("18884", "nysp-troop-g", "Tac", "NYSP Troop G / Capitol", "Capital Region", "police", "high"),
        ("10354", None, "", "Metro Law Tac", "Capital Region", "police", "medium"),
        ("10401", "colonie-pd", "Dispatch", "Colonie PD Dispatch", "Latham · Colonie", "police", "high"),
        ("10402", "colonie-pd", "Tac", "Colonie PD Tac", "Colonie", "police", "medium"),
        ("10501", "guilderland-pd", "Dispatch", "Guilderland PD", "Guilderland", "police", "medium"),
        ("10502", "bethlehem-pd", "Dispatch", "Bethlehem PD", "Bethlehem · Delmar", "police", "medium"),
        ("10601", "cohoes-pd", "Dispatch", "Cohoes PD", "Cohoes", "police", "medium"),
        ("10602", "watervliet-pd", "Dispatch", "Watervliet PD", "Watervliet", "police", "medium"),
        ("8211", "colonie-pd", "Dispatch", "Colonie PD Dispatch", "Latham · Colonie", "police", "high"),
        ("8212", "colonie-pd", "Tac", "Colonie PD Tac", "Colonie", "police", "medium"),
        ("8215", "bethlehem-pd", "Dispatch", "Bethlehem PD", "Bethlehem · Delmar", "police", "medium"),
        ("8216", "guilderland-pd", "Dispatch", "Guilderland PD", "Guilderland", "police", "medium"),
        ("8206", "albany-county-sheriff", "Dispatch", "Albany County Sheriff", "County-wide", "police", "high"),
        ("8239", "albany-pd", "Fire Dispatch", "Albany Fire Dispatch", "City of Albany", "fire", "high"),
        ("8243", None, "", "Colonie Fire Dispatch", "Colonie", "fire", "high"),
        ("8259", None, "", "Albany County EMS", "County-wide", "ems", "high"),
        ("8260", None, "", "Albany EMS Dispatch", "City of Albany", "ems", "high"),
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

    def _lookup_tg_row(call: dict) -> tuple[Optional[dict], str]:
        raw = call.get("talkgroup_num") if call.get("talkgroup_num") is not None else call.get("talkgroup")
        tid = str(raw).strip() if raw is not None else ""
        if not tid:
            return None, ""
        row = tg_map.get(tid)
        if row is None and tid.isdigit():
            row = tg_map.get(str(int(tid)))
        if row is None and tid.isdigit():
            stripped = tid.lstrip("0") or "0"
            row = tg_map.get(stripped)
        return row, tid

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
                    dept = (row or {}).get("department") or tg_tag
                    loc = (row or {}).get("location") or ""
                    dept_loc = f"{dept} — {loc}" if loc else dept
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
                    if is_critical:
                        card_title = f"Critical radio · {dept_loc}: {tg_tag}"
                        prio = SOURCE_PRIORITY_SCANNER_CRITICAL
                        crit_f, recent_f = True, False
                    else:
                        card_title = f"Radio · {dept_loc}: {tg_tag}"
                        prio = SOURCE_PRIORITY_SCANNER_RECENT
                        crit_f, recent_f = False, True
                    out.append(
                        {
                            "title": card_title,
                            "link": audio_url or f"https://openmhz.com/system/{slug}",
                            "pubDate": _openmhz_time_to_rfc(t_raw),
                            "description": (desc + " · " if desc else "") + crit_blob[:280],
                            "source": f"Scanner · {label}",
                            "source_priority": prio,
                            "_scanner_call": True,
                            "_scanner_critical_live": crit_f,
                            "_scanner_recent_live": recent_f,
                            "_scanner_tg": tid_s or None,
                            "_feed_reliability": 0.88,
                            "source_url": "",
                        }
                    )
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
# STATIC FILES — Must be last (catches all unmatched routes)
# =============================================================================
@app.get("/")
async def root():
    index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    except Exception as e:
        return HTMLResponse(f"<h1>ERROR loading index.html</h1><pre>{str(e)}</pre>")


app.mount("/", StaticFiles(directory=os.path.dirname(os.path.abspath(__file__)), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("api_server:app", host="0.0.0.0", port=port)
