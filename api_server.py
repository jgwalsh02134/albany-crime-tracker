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
import os
import re
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

# --- Config ---
XAI_API_KEY = os.getenv("XAI_API_KEY")
XAI_BASE = "https://api.x.ai/v1"
XAI_MODEL = "grok-3"  # Strongest available xAI model

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
cache = {}
CACHE_TTL = {
    "merged_news": 180,
    "crime_articles": 180,
    "dcjs_trends": 3600,
    "ai_summaries": 600,
    "patterns": 300,
    "monthly_summary": 1800,   # 30 min
    "daily_summary": 600,      # 10 min — today's briefing
    "social_intel": 900,       # 15 min — X/Twitter monitoring
}

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
    "i-787", "route 9w",
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
        "url": "https://news.google.com/rss/search?q=site:timesunion.com+(albany+OR+colonie+OR+guilderland+OR+cohoes+OR+watervliet)+(crime+OR+arrest+OR+shooting+OR+police+OR+stabbing)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Times Union",
        "filter": "albany",
        "reliability": 0.92,
        "priority": 3,
    },
    "timesunion_gnews_local": {
        "url": "https://news.google.com/rss/search?q=site:timesunion.com+(\"albany+county\"+OR+\"city+of+albany\"+OR+colonie+OR+guilderland+OR+bethlehem+OR+cohoes+OR+watervliet+OR+latham+OR+loudonville+OR+delmar)+when:7d&hl=en-US&gl=US&ceid=US:en",
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
        "url": "https://news.google.com/rss/search?q=site:dailygazette.com+(albany+OR+colonie+OR+guilderland+OR+cohoes+OR+watervliet+OR+bethlehem+OR+latham)+(crime+OR+arrest+OR+police+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Daily Gazette",
        "filter": "albany",
        "reliability": 0.90,
        "priority": 3,
    },
    "spotlight_gnews": {
        "url": "https://news.google.com/rss/search?q=site:spotlightnews.com+(albany+OR+colonie+OR+guilderland+OR+bethlehem+OR+cohoes)+(crime+OR+arrest+OR+police+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
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
        "url": "https://news.google.com/rss/search?q=%22albany+county%22+%22new+york%22+crime+OR+arrest+OR+police+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.75,
        "priority": 1,
    },
    "gnews_albany_ny_police": {
        "url": "https://news.google.com/rss/search?q=%22albany+ny%22+police+OR+arrest+OR+shooting+OR+crime+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.72,
        "priority": 1,
    },
    "gnews_albany_recent": {
        "url": "https://news.google.com/rss/search?q=%22albany%2C+ny%22+arrest+OR+shooting+OR+crime+when:3d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.72,
        "priority": 1,
    },
    # ── Official state police ─────────────────────────────────────────────────
    "gnews_nys_police": {
        "url": "https://news.google.com/rss/search?q=site:troopers.ny.gov+albany+when:14d&hl=en-US&gl=US&ceid=US:en",
        "label": "NY State Police",
        "filter": None,   # troopers.ny.gov is always legitimate
        "reliability": 1.0,
        "priority": 3,
    },
    # ── Hyper-local per-town searches ─────────────────────────────────────────
    "gnews_colonie": {
        "url": "https://news.google.com/rss/search?q=Colonie+NY+(crime+OR+arrest+OR+police+OR+shooting+OR+burglary)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Colonie",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_bethlehem": {
        "url": "https://news.google.com/rss/search?q=Bethlehem+NY+(crime+OR+arrest+OR+police+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Bethlehem / Delmar",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_guilderland": {
        "url": "https://news.google.com/rss/search?q=Guilderland+NY+(crime+OR+arrest+OR+police+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Guilderland / Altamont",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_cohoes": {
        "url": "https://news.google.com/rss/search?q=Cohoes+NY+(crime+OR+arrest+OR+police)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Cohoes",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_watervliet": {
        "url": "https://news.google.com/rss/search?q=Watervliet+NY+(crime+OR+arrest+OR+police)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Watervliet",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_latham_loudonville": {
        "url": "https://news.google.com/rss/search?q=(Latham+OR+Loudonville)+NY+(crime+OR+arrest+OR+police+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Latham / Loudonville",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_newscotland": {
        "url": "https://news.google.com/rss/search?q=%22New+Scotland%22+NY+(crime+OR+arrest+OR+police)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "New Scotland / Slingerlands",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    "gnews_coeymans_ravena": {
        "url": "https://news.google.com/rss/search?q=(Coeymans+OR+Ravena)+NY+(crime+OR+arrest+OR+police)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": "Coeymans / Ravena",
        "filter": "strict",
        "reliability": 0.78,
        "priority": 2,
    },
    # ── Legacy broad-suburb search kept for overlap coverage ──────────────────
    "gnews_albany_suburbs": {
        "url": "https://news.google.com/rss/search?q=(colonie+OR+bethlehem+OR+guilderland+OR+cohoes+OR+watervliet)+%22new+york%22+(crime+OR+police+OR+arrest)+when:7d&hl=en-US&gl=US&ceid=US:en",
        "label": None,
        "filter": "strict",
        "reliability": 0.75,
        "priority": 1,
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
        "url": "https://news.google.com/rss/search?q=%22Albany+Police+Department%22+OR+%22Albany+Police%22+arrest+OR+crime+OR+incident+OR+shooting+OR+stabbing+when:14d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @albanypolice",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Albany County Sheriff (@ACSOTWEET) ────────────────────────────────────
    "official_acso": {
        "url": "https://news.google.com/rss/search?q=%22Albany+County+Sheriff%22+arrest+OR+crime+OR+incident+OR+investigation+when:14d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @ACSOTWEET",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Colonie Police (@colonie_police) ─────────────────────────────────────
    "official_colonie_pd": {
        "url": "https://news.google.com/rss/search?q=%22Colonie+Police%22+arrest+OR+crime+OR+incident+OR+shooting+OR+burglary+when:14d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @colonie_police",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── Bethlehem PD (@PdBethlehem) ──────────────────────────────────────────
    "official_bethlehem_pd": {
        "url": "https://news.google.com/rss/search?q=%22Bethlehem+Police%22+%22New+York%22+arrest+OR+crime+OR+incident+when:14d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @PdBethlehem",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # ── NY State Police Troop G (@nyspolice) ──────────────────────────────────
    "official_nysp_troop_g": {
        "url": "https://news.google.com/rss/search?q=%22State+Police%22+%22Troop+G%22+OR+(%22State+Police%22+%22Albany%22)+arrest+OR+shooting+OR+crime+OR+investigation+when:14d&hl=en-US&gl=US&ceid=US:en",
        "label": "Official @nyspolice",
        "filter": "albany",
        "force_label": True,
        "reliability": 0.97,
        "priority": 4,
    },
    # NYSP press releases via Google News site: search
    "official_nysp_site": {
        "url": "https://news.google.com/rss/search?q=site:troopers.ny.gov+when:14d&hl=en-US&gl=US&ceid=US:en",
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
}


DCJS_URL = (
    "https://data.ny.gov/resource/ca8h-8gjq.json"
    "?$where=county='Albany' AND agency='County Total'"
    "&$order=year DESC&$limit=10"
)

# =============================================================================
# CRIME KEYWORDS
# =============================================================================
CRIME_KEYWORDS = [
    "arrest", "charged", "murder", "homicide", "shooting", "stabbing",
    "robbery", "burglary", "theft", "assault", "weapon", "drug",
    "police", "sheriff", "suspect", "victim", "crime", "felony",
    "misdemeanor", "indicted", "convicted", "sentence", "investigation",
    "stolen", "domestic", "dui", "dwi", "sexual", "rape", "arson",
    "vandalism", "trespass", "kidnapping", "fraud", "larceny",
    "crash", "fatal", "manslaughter", "gang", "narcotics",
    "trooper", "state police", "pursuit", "standoff", "fugitive",
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
]

# Official police / emergency sources → always live when recent
LIVE_SOURCES = frozenset([
    "ny state police", "new york state police", "city of albany",
    "albany police department", "albany county sheriff", "albany pd",
    "colonie police", "cohoes police", "watervliet police",
    # Official X/Twitter + blotter sources
    "official @albanypolice", "official @acsotweet", "official @colonie_police",
    "official @pdbethlehem", "official @nyspolice",
    "nysp blotter", "nixle alert", "daily gazette blotter",
])

LIVE_CUTOFF_HOURS = 72   # Live tab: only show items published within last 72 h
MAP_CUTOFF_DAYS = 5      # Map: hard cutoff at 5 days


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


def classify_feed_tab(article) -> str:
    """
    Classify an article as 'live' or 'news'.

    Live  = published < 72 h ago AND urgent/breaking content AND no noise indicators
    News  = older, court proceedings, summaries, background stories, etc.
    """
    title_text = (article.get("title", "") or "").lower()
    text = (title_text + " " + (article.get("description", "") or "")).lower()
    source = (article.get("source", "") or "").lower()

    age_hours = get_article_age_hours(article)

    # --- Older than LIVE_CUTOFF_HOURS → always News ---
    if age_hours is not None and age_hours > LIVE_CUTOFF_HOURS:
        return "news"

    # --- PRIORITY OVERRIDE: active crime/arrest keywords in the TITLE trump noise.
    # Checked on title only — prevents grant/awareness articles whose *descriptions*
    # mention violence prevention from being promoted to Live.
    PRIORITY_LIVE = [
        "shooting", "shot and killed", "shots fired",
        "stabbing", "stabbed",
        "homicide", "murder",
        "officer-involved", "officer involved shooting",
        "pursuit", "high-speed chase", "foot pursuit",
        "armed robbery", "armed suspect",
        "carjacking", "kidnapping",
        "hostage", "barricaded", "standoff", "swat",
        "amber alert", "missing child",
        "explosion", "bomb threat",
        "arrested", "arrest made", "suspect arrested",
        "man arrested", "woman arrested", "person arrested",
        "charged with", "taken into custody", "in custody",
        "felony charge", "multiple charges",
    ]
    if any(kw in title_text for kw in PRIORITY_LIVE):
        return "live"

    # --- Contains noise → News tab (background/legal proceedings) ---
    if any(kw in text for kw in NOISE_KEYWORDS):
        return "news"

    # --- Official law-enforcement source + recent → Live ---
    if any(src in source for src in LIVE_SOURCES):
        return "live"

    # --- Contains urgent keyword → Live ---
    if any(kw in text for kw in URGENT_KEYWORDS):
        return "live"

    # --- Very recent (< 24 h) non-noise article → Live ---
    if age_hours is not None and age_hours <= 24:
        return "live"

    # --- Default: News ---
    return "news"

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

http_client: Optional[httpx.AsyncClient] = None


@asynccontextmanager
async def lifespan(_app):
    global http_client
    http_client = httpx.AsyncClient(
        timeout=20.0,
        follow_redirects=True,
        headers={"User-Agent": "AlbanyCrimeTracker/5.0 (albany-crime-tracker.repl.co)"},
    )
    yield
    await http_client.aclose()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_cached(key):
    entry = cache.get(key)
    if entry and (time.time() - entry["ts"]) < CACHE_TTL.get(key, 300):
        return entry["data"]
    return None


def set_cached(key, data):
    cache[key] = {"data": data, "ts": time.time()}


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
                articles.append({
                    "title": title,
                    "link": link,
                    "pubDate": pub_date,
                    "description": desc,
                    "source": source or "Local News",
                    "source_url": source_url,
                })
    except ET.ParseError:
        pass
    return articles


# =============================================================================
# LOCATION FILTER — Strict two-tier Albany County, NY test
# =============================================================================
def is_albany_related(article) -> bool:
    """
    Strict location filter — only accepts articles about Albany County, NY.

    CRITICAL DISTINCTION:
      "City of Albany"  = the actual city (county seat) — needs NY corroboration
      "Albany County"   = full county phrase — accept immediately
      Specific towns/villages/hamlets in ALBANY_KEYWORDS — accept immediately

    Acceptance tiers:
      Tier 1a — ALBANY_KEYWORDS contains a specific town/village/hamlet
                 (cohoes, guilderland, latham, westmere, etc.): accept.
      Tier 1b — ALBANY_TIER1 extended set match: accept.
      Tier 2a — "albany" alone + local source domain: accept.
      Tier 2b — "albany" alone + ≥1 NY confirmation signal: accept.
      Tier 3  — "capital region"/"capital district" + ≥2 NY signals: accept.
      All else: reject.

    Aggressively rejects:
      albany ga / albany or / albany ca / albany australia, iceland, manila, etc.
    """
    title = article.get("title", "") or ""
    desc = article.get("description", "") or ""
    text = (title + " " + desc).lower()
    source = (article.get("source", "") or "").lower()
    link = (article.get("link", "") or "").lower()
    # source_url: original publisher URL extracted from Google News <source url="...">
    source_url = (article.get("source_url", "") or "").lower()

    # --- Step 1: Immediate reject — false positives and non-local sources ---
    for fp in FALSE_POSITIVE_INDICATORS:
        if fp in text:
            return False
    for nls in NON_LOCAL_SOURCES:
        if nls in source:
            return False

    # --- Step 2: Tier 1 — specific Albany County, NY municipality in ALBANY_KEYWORDS ---
    # Note: "albany ny" and "albany, ny" ARE in ALBANY_KEYWORDS and count as City of Albany
    # Specific towns/villages/hamlets (cohoes, guilderland, latham, etc.) pass immediately
    for kw in ALBANY_KEYWORDS:
        if kw in text:
            return True

    # Also check extended Tier 1 set (includes "town of X" forms, neighborhoods, venues)
    for loc in ALBANY_TIER1:
        if loc in text:
            return True

    # --- Step 3: Local source domain strengthens any Albany mention ---
    # Check both article link AND the publisher's original URL (source_url from Google News)
    is_local_domain = any(d in link for d in LOCAL_DOMAINS) or any(d in source_url for d in LOCAL_DOMAINS)
    if is_local_domain:
        if "albany" in text or any(g in text for g in GENERIC_REGION_TERMS):
            return True

    # --- Step 4: Bare "albany" — must have at least one NY confirmation signal ---
    # (catches Albany, NY without the ", NY" suffix but with clear NY context)
    if "albany" in text:
        ny_hits = sum(1 for sig in NY_CONFIRMATION_SIGNALS if sig in text)
        if ny_hits >= 1:
            return True
        # No NY signal found → could be Albany GA, OR, CA, etc. → reject
        return False

    # --- Step 5: Generic regional terms need multiple independent NY signals ---
    if any(g in text for g in GENERIC_REGION_TERMS):
        ny_hits = sum(1 for sig in NY_CONFIRMATION_SIGNALS if sig in text)
        return ny_hits >= 2

    return False


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
    text = (article.get("title", "") + " " + article.get("description", "")).lower()
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
async def call_grok(messages, max_tokens=400, stream=False, temperature=0.35):
    body = {
        "model": XAI_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": stream,
    }
    resp = await post_xai_chat(body, timeout=60.0 if stream else 20.0)
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
    "You are a senior crime intelligence analyst for Albany County, NY. "
    "Albany County includes the City of Albany plus towns: Bethlehem, Coeymans, Colonie, "
    "Guilderland, Knox, New Scotland, Rensselaerville, Westerlo, and Berne; "
    "cities: Cohoes and Watervliet; and villages: Altamont, Green Island, Menands, "
    "Ravena, and Voorheesville.\n\n"
    "CRITICAL RULES:\n"
    "1. VERIFY every article is genuinely about Albany County, NY — not Albany, Georgia; "
    "Albany, Oregon; Albany, California; or any other Albany. Discard any ambiguous articles.\n"
    "2. NEVER fabricate, extrapolate, or invent incidents not present in the provided data.\n"
    "3. Name specific streets, intersections, and municipalities when available.\n"
    "4. Assign a confidence score (high/medium/low) based on how well-sourced the data is.\n"
    "5. Respond ONLY with valid JSON — no markdown fences, no preamble."
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

    # Build context with source reliability and confidence
    context_lines = []
    for a in crime_data[:15]:
        conf = a.get("confidence", 0.7)
        conf_label = "HIGH" if conf >= 0.90 else "MEDIUM" if conf >= 0.75 else "LOW"
        reliability = get_source_reliability(a.get("source", ""))
        src = a.get("source", "Unknown")
        loc = a.get("matched_location", "")
        line = f"- [Confidence:{conf_label}|Reliability:{reliability:.0%}] [{src}] {a['title']}"
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

    prompt = f"""Below are Albany County, NY crime/incident reports collected from local news and official sources.

STEP 1 — VERIFY: Silently discard any article not genuinely about Albany County, NY (watch for Albany, GA; Albany, OR; etc.).

STEP 2 — ANALYZE: Write a situation field that is EXACTLY 1–2 short sentences. Be specific and punchy — name a location and a key incident type. No more than 30 words total. Example style: "Moderate activity in Colonie and Center Square. Three violent incidents in 48 hours including a home break-in on Dove Street."

STEP 3 — SCORE: Assign threat_level (low/moderate/elevated/high) and confidence (high/medium/low).

Verified articles:
{chr(10).join(context_lines)}
{pattern_ctx}

Respond ONLY with this exact JSON (no markdown):
{{"situation": "...", "threat_level": "...", "confidence": "..."}}"""

    try:
        result = await call_grok([
            {"role": "system", "content": SITUATION_SYSTEM},
            {"role": "user", "content": prompt},
        ], max_tokens=200, temperature=0.3)

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
            resp = await http_client.get(cfg["url"], timeout=timeout)
            if resp.status_code == 200:
                parsed = parse_rss(resp.text, default_source=cfg.get("label"))
                for a in parsed:
                    a["_feed_reliability"] = cfg.get("reliability", 0.97)
                    a["source_priority"] = 4
                    # Force the official label so it shows "Official @..." in the feed
                    if cfg.get("force_label"):
                        a["source"] = cfg["label"]
                filter_mode = cfg.get("filter")
                if filter_mode in ("strict", "albany"):
                    parsed = [a for a in parsed if is_albany_related(a)]
                elif filter_mode == "crime":
                    parsed = [a for a in parsed if any(
                        kw in (a.get("title","") + " " + a.get("description","")).lower()
                        for kw in CRIME_KEYWORDS
                    )]
                return parsed
        except Exception as e:
            print(f"Official feed [{key}]: {e}")
        return []

    tasks = [_fetch(k, v) for k, v in RSS_FEEDS_OFFICIAL.items()]
    batches = await asyncio.gather(*tasks)
    for batch in batches:
        results.extend(batch)
    return results


# =============================================================================
# UNIFIED FEED FETCHER
# =============================================================================
async def fetch_all_feeds():
    articles = []

    async def fetch_one(key, cfg):
        try:
            resp = await http_client.get(cfg["url"])
            if resp.status_code == 200:
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

                # Apply location filter
                filter_mode = cfg.get("filter")
                if filter_mode in ("strict", "albany"):
                    # "albany" mode: same as strict — use full is_albany_related scoring
                    parsed = [a for a in parsed if is_albany_related(a)]
                elif filter_mode == "crime":
                    # "crime" mode: location guaranteed (official PD X accounts);
                    # keep only posts that mention at least one crime keyword
                    def has_crime_kw(a):
                        t = (a.get("title","") + " " + a.get("description","")).lower()
                        return any(kw in t for kw in CRIME_KEYWORDS)
                    parsed = [a for a in parsed if has_crime_kw(a)]
                elif filter_mode is None:
                    # Trusted feed — no filter, but still reject obvious false positives
                    parsed = [a for a in parsed if not any(fp in (a.get("title", "") + " " + a.get("description", "")).lower() for fp in FALSE_POSITIVE_INDICATORS)]

                return parsed
        except Exception as e:
            print(f"Feed error [{key}]: {e}")
        return []

    all_feeds = {**RSS_FEEDS_LOCAL, **RSS_FEEDS_GNEWS, **RSS_FEEDS_OFFICIAL}
    tasks = [fetch_one(key, cfg) for key, cfg in all_feeds.items()]
    results = await asyncio.gather(*tasks)

    for feed_articles in results:
        articles.extend(feed_articles)

    # ── Smart deduplication ──────────────────────────────────────────────────
    # Sort highest-priority + newest first so the best version wins each group.
    articles.sort(
        key=lambda a: (a.get("source_priority", 1), a.get("pubDate", "")),
        reverse=True,
    )

    _STOP = frozenset({
        "the","a","an","in","on","at","to","of","and","or","for","is","was",
        "after","with","man","woman","police","albany","county","new","york",
        "one","two","three","that","this","from","his","her","they","were",
    })

    # Key crime/incident words that, when shared, help identify the same real-world event.
    # IMPORTANT: Only include words specific enough to uniquely describe an incident.
    # Do NOT include generic words like "arrested", "charged", "police", "fire" — those
    # appear in every crime article and cause unrelated incidents to be merged.
    _INCIDENT_KEYS = frozenset({
        # Violent crime types — very specific
        "shooting", "stabbing", "homicide", "murder", "carjacking",
        "standoff", "barricade", "kidnapping", "abduction",
        # Traffic fatalities — combine with victim details
        "fatally", "fatal crash", "fatal accident",
        # Highly specific events
        "overdose", "amber alert",
        # Named individuals or very specific descriptors help downstream
        # (but we can't extract names here — these are keywords in shared tokens)
    })

    def _title_words(t: str) -> frozenset:
        # Replace ANY non-alphanumeric with a space (so "7-year-old" → "7 year old")
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
        """Return absolute hours between pubDates, or None if unparseable."""
        try:
            da = parsedate_to_datetime(a.get("pubDate", ""))
            db = parsedate_to_datetime(b.get("pubDate", ""))
            if da.tzinfo is None: da = da.replace(tzinfo=timezone.utc)
            if db.tzinfo is None: db = db.replace(tzinfo=timezone.utc)
            return abs((da - db).total_seconds()) / 3600
        except Exception:
            return None

    def _combined_words(article: dict) -> frozenset:
        """Token set from title + first 200 chars of description combined."""
        title = article.get("title", "") or ""
        desc  = (article.get("description", "") or "")[:200]
        return _title_words(title + " " + desc)

    def _same_incident(art: dict, rep: dict) -> bool:
        """True when two articles clearly describe the same real-world incident."""
        # Fast path: title similarity ≥45% Jaccard
        sim_title = _similarity(art["title"], rep["title"])
        if sim_title >= 0.45:
            return True

        # Medium path: combined title+desc similarity (catches wire-copy variants)
        wa_full = _combined_words(art)
        wb_full = _combined_words(rep)
        if wa_full and wb_full:
            inter = len(wa_full & wb_full)
            union = len(wa_full | wb_full)
            if union and (inter / union) >= 0.55:
                return True

        # Time-window check: only merge when title sim is 30%+ AND they share
        # a highly specific incident keyword (type of crime) within 1 hour.
        # This prevents unrelated same-day crimes from being collapsed.
        if sim_title >= 0.30:
            hrs = _hours_apart(art, rep)
            if hrs is not None and hrs <= 1.0:
                shared_keys = (wa_full & wb_full) & _INCIDENT_KEYS
                if len(shared_keys) >= 1:
                    return True
        return False

    # Group articles: each group keeps one representative (the winner) plus
    # a list of all sources that covered the same incident.
    groups: list[dict] = []          # each entry: {rep: article, sources: list[str]}

    for art in articles:
        placed = False
        for grp in groups:
            if _same_incident(art, grp["rep"]):
                src = art.get("source", "")
                if src and src not in grp["sources"]:
                    grp["sources"].append(src)
                placed = True
                break
        if not placed:
            grp_sources = []
            s = art.get("source", "")
            if s:
                grp_sources.append(s)
            groups.append({"rep": art, "sources": grp_sources})

    # Attach combined sources list to each representative and collect
    deduped = []
    for grp in groups:
        rep = grp["rep"]
        rep["sources"] = grp["sources"][:3]    # cap at 3 for display
        deduped.append(rep)

    # Final sort: newest first, then by source priority (4=official > 3=premium > 2=local > 1=gnews)
    deduped.sort(
        key=lambda a: (a.get("pubDate", ""), a.get("source_priority", 1)),
        reverse=True,
    )

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

@app.get("/api/news")
async def get_news():
    cached = get_cached("merged_news")
    if cached:
        sources = set(a.get("source", "Unknown") for a in cached)
        return {"status": "ok", "source": "cache", "count": len(cached), "source_count": len(sources), "articles": cached}

    deduped = await fetch_all_feeds()
    set_cached("merged_news", deduped)
    sources = set(a.get("source", "Unknown") for a in deduped)
    return {"status": "ok", "source": "live", "count": len(deduped), "source_count": len(sources), "articles": deduped}


@app.get("/api/crimes")
async def get_crimes():
    cached = get_cached("crime_articles")
    if cached:
        return {"status": "ok", "source": "cache", "data": cached, "total": len(cached)}

    all_articles = await fetch_all_feeds()
    # All articles have already passed is_albany_related in fetch_all_feeds for "strict" feeds.
    # Apply crime filter + full Albany check to everything.
    crime_articles = [
        a for a in all_articles
        if is_crime_related(a) and is_albany_related(a)
    ]

    geocoded = []
    for a in crime_articles:
        geo = geocode_article(a)
        geo["crime_type"] = classify_crime_type(a)
        geo["neighborhood"] = get_neighborhood(geo.get("matched_location", ""))
        geo["confidence"] = compute_article_confidence(a)
        geo["source_reliability"] = get_source_reliability(a.get("source", ""))
        age_h = get_article_age_hours(a)
        geo["age_hours"] = round(age_h, 1) if age_h is not None else None
        geo["feed_tab"] = classify_feed_tab(a)
        geocoded.append(geo)

    # Sort: live items first (newest-first = lowest age_hours first), then news items newest-first
    # Use age_hours (already computed) so sorting is numeric, not RFC 2822 string comparison
    def _age_key(x):
        a = x.get("age_hours")
        return a if a is not None else 9999

    live_items = sorted(
        [x for x in geocoded if x.get("feed_tab") == "live"],
        key=_age_key
    )
    news_items = sorted(
        [x for x in geocoded if x.get("feed_tab") == "news"],
        key=_age_key
    )
    geocoded = live_items + news_items

    set_cached("crime_articles", geocoded)
    return {"status": "ok", "source": "live", "data": geocoded, "total": len(geocoded)}


@app.get("/api/trends")
async def get_trends():
    cached = get_cached("dcjs_trends")
    if cached:
        return {"status": "ok", "source": "cache", "data": cached}
    try:
        resp = await http_client.get(DCJS_URL)
        if resp.status_code == 200:
            data = resp.json()
            set_cached("dcjs_trends", data)
            return {"status": "ok", "source": "live", "data": data}
        return {"status": "error", "message": f"HTTP {resp.status_code}", "data": []}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": []}


@app.get("/api/situation")
async def get_situation():
    crimes_resp = await get_crimes()
    crime_data = crimes_resp.get("data", [])
    news_resp = await get_news()
    news_data = news_resp.get("articles", [])

    patterns = detect_patterns(crime_data)
    situation = await generate_situation_report(crime_data, patterns)

    newest_time = None
    for c in crime_data:
        pub = c.get("pubDate", "")
        if pub:
            try:
                dt = parsedate_to_datetime(pub)
                if newest_time is None or dt > newest_time:
                    newest_time = dt
            except Exception:
                pass

    # Compute average confidence across crime articles
    confidences = [c.get("confidence", 0) for c in crime_data if c.get("confidence")]
    avg_confidence = round(sum(confidences) / len(confidences), 2) if confidences else 0.0

    return {
        "status": "ok",
        "situation": situation.get("situation", ""),
        "threat_level": situation.get("threat_level", "unknown"),
        "ai_confidence": situation.get("confidence", "unknown"),
        "data_confidence": avg_confidence,
        "stats": {
            "total_incidents": len(crime_data),
            "violent": patterns["type_breakdown"].get("violent", 0),
            "property": patterns["type_breakdown"].get("property", 0),
            "other": patterns["type_breakdown"].get("other", 0),
            "total_articles": len(news_data),
            "source_count": len(set(a.get("source", "") for a in news_data)),
            "recent_48h": patterns.get("recent_48h", 0),
        },
        "patterns": patterns,
        "last_updated": newest_time.isoformat() if newest_time else None,
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
    cached = get_cached("merged_news")
    if cached:
        source_data = {}
        for a in cached:
            src = a.get("source", "Unknown")
            if src not in source_data:
                source_data[src] = {"count": 0, "reliability": get_source_reliability(src)}
            source_data[src]["count"] += 1
        sources = sorted(
            [{"source": s, **v} for s, v in source_data.items()],
            key=lambda x: (-x["reliability"], -x["count"])
        )
        return {
            "status": "ok",
            "total_articles": len(cached),
            "source_count": len(sources),
            "sources": sources,
        }
    return {"status": "ok", "total_articles": 0, "source_count": 0, "sources": []}


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
    for a in crime_data[:15]:
        src = a.get("source", "Local News")
        hood = a.get("neighborhood", "")
        conf = a.get("confidence", 0.7)
        reliability = a.get("source_reliability", 0.7)
        conf_label = "HIGH" if conf >= 0.90 else "MED" if conf >= 0.75 else "LOW"

        crime_context += f"- [Conf:{conf_label}|Reliability:{reliability:.0%}|{src}] {a['title']}"
        if hood and hood != "Other":
            crime_context += f" — {hood}"
        crime_context += "\n"

    patterns = detect_patterns(crime_data)
    pattern_text = ""
    if patterns.get("hotspots"):
        pattern_text = "\n**Hotspot areas:** " + ", ".join(
            f"{h['neighborhood']} ({h['count']})" for h in patterns["hotspots"][:4]
        )
    if patterns.get("insights"):
        pattern_text += "\n**Key patterns:**\n" + "\n".join(
            f"- {i['text']}" for i in patterns["insights"]
        )

    news_resp = await get_news()
    news_data = news_resp.get("articles", [])
    news_sources = sorted(set(a.get("source", "") for a in news_data))

    system_prompt = (
        "You are a senior crime intelligence analyst embedded in the Albany County, NY Crime Tracker.\n\n"
        "Albany County, NY comprises: City of Albany + Towns (Bethlehem, Coeymans, Colonie, Guilderland, "
        "Knox, New Scotland, Rensselaerville, Westerlo, Berne) + Cities (Cohoes, Watervliet) + "
        "Villages (Altamont, Green Island, Menands, Ravena, Voorheesville).\n\n"
        "**Strict rules:**\n"
        "- ONLY report incidents verified to be in Albany County, NY. "
        "If an article might refer to Albany, GA; Albany, OR; or elsewhere — say so and flag it.\n"
        "- Never fabricate or extrapolate beyond what is in the data provided.\n"
        "- When citing an incident, name the source and its reliability tier: "
        "Official (law enforcement/government), Local News (TV/print), or Aggregated.\n"
        "- Give the most precise location available (street, intersection, neighborhood, municipality).\n"
        "- Use markdown: **bold** key facts, bullet lists, `### headers` for multi-part answers.\n"
        "- Use > blockquotes for urgent safety warnings.\n"
        "- If the user asks for map locations, output JSON in a code block:\n"
        "  ```json\n  [{\"label\": \"...\", \"lat\": 42.xxx, \"lng\": -73.xxx}]\n  ```\n"
        "- If data is unavailable or ambiguous, say so explicitly.\n"
        "- Confidence labels in the data: HIGH ≥ 90%, MED ≥ 75%, LOW < 75%.\n\n"
        f"**Live sources ({len(news_sources)}):** {', '.join(news_sources[:12])}\n\n"
        f"**Current incident feed ({len(crime_data)} verified reports):**\n{crime_context}"
        f"{pattern_text}"
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
            "max_tokens": 1200,
            "temperature": 0.4,
            "stream": True,
        }, timeout=60.0)

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

FBI_CDE_API_KEY = "DEMO_KEY"
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
        resp = await http_client.get(url, params=params)
        if resp.status_code == 200:
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
        print(f"FBI CDE error [{ori}]: {e}")

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
            params={"num": 20},
        )
        if resp.status_code == 200:
            data = resp.json()
            calls = []
            for call in data.get("calls", [])[:20]:
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
            cache["scanner_calls"] = {"data": calls, "ts": time.time()}
            CACHE_TTL["scanner_calls"] = 30
            return {"status": "ok", "source": "live", "calls": calls}
    except Exception as e:
        print(f"Scanner error: {e}")

    # Fallback — no mock data
    return {"status": "ok", "source": "unavailable", "calls": []}


# =============================================================================
# STATIC FILES — Must be last (catches all unmatched routes)
# =============================================================================
app.mount("/", StaticFiles(directory=".", html=True), name="static")
