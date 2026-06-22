"""Bluesky (AT Protocol) source adapter — real-time social sourcing.

CUTTING-EDGE RATIONALE
----------------------
Post-Twitter, local journalists and news outlets migrated to Bluesky. Its
AT Protocol exposes a PUBLIC AppView API that requires NO API key for reading
author feeds and discovering accounts:

  • app.bsky.feed.getAuthorFeed   — read a specific account's posts (no auth)
  • app.bsky.actor.searchActors   — discover accounts by name (no auth)

(Note: app.bsky.feed.searchPosts is rate-limit-gated / 403s unauthenticated,
so we deliberately avoid it and instead read curated + discovered author
feeds, which are reliably public.)

This gives the Live feed a genuinely real-time, key-free social layer that
surfaces breaking police/crime/emergency activity the moment a Capital Region
reporter or outlet posts it — often minutes ahead of RSS/Google News indexing.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Any, Optional

import httpx

from app.models.incident import build_provenance

logger = logging.getLogger(__name__)

BLUESKY_APPVIEW = "https://public.api.bsky.app"

# ── Curated, VERIFIED Capital Region NY accounts ──────────────────────────────
# Each handle was confirmed to resolve on the public AppView. Capital Region /
# Albany County only — deliberately EXCLUDES same-name out-of-area accounts
# (e.g. Albany Democrat-Herald = Albany, Oregon).
BLUESKY_SEED_ACCOUNTS: list[dict[str, Any]] = [
    {"handle": "timesunion.com", "label": "Times Union", "reliability": 0.90},
    {"handle": "dgazette.bsky.social", "label": "Daily Gazette", "reliability": 0.88},
    {"handle": "mayorsheehan.bsky.social", "label": "Albany Mayor", "reliability": 0.92},
]

# Discovery search terms — searchActors runs unauthenticated. Discovered
# accounts are keyword/locality-gated downstream, so noise is filtered.
BLUESKY_DISCOVERY_TERMS = ["Albany NY news", "Capital Region NY reporter", "Albany journalist"]

# Out-of-area handles to never include even if discovered (same-name traps).
BLUESKY_BLOCKLIST = frozenset({
    "democratherald.com",      # Albany, Oregon
    "albany-or-nexodus.bsky.social",
    "wdrbnews.bsky.social",    # Louisville, KY
})

# STRONG incident keywords — concrete events. A post must contain at least one
# of these to qualify (prevents policy/opinion/sports posts that merely mention
# "police" from leaking into the feed).
STRONG_ACTIVITY_KEYWORDS = (
    "shooting", "shot dead", "shots fired", "stabbing", "stabbed", "homicide",
    "murder", "arrested", "arrest made", "charged with", "robbery", "burglary",
    "armed", "pursuit", "police chase", "standoff", "barricade", "swat",
    "hostage", "manhunt", "fatal", "killed", "structure fire", "house fire",
    "working fire", "amber alert", "silver alert", "missing person",
    "evacuation", "lockdown", "shelter in place", "bomb threat", "active shooter",
    "officer-involved", "officer involved", "police shooting", "overdose",
    "deadly", "found dead", "body found", "crash", "collision", "rollover",
    "suspect", "in custody", "indicted", "weapons seized", "drug bust",
)

# WEAK keywords — only count when paired with a strong keyword or clear
# incident framing (avoids "police reform", "fire department budget", etc.).
WEAK_ACTIVITY_KEYWORDS = (
    "police", "officer", "trooper", "deputy", "sheriff", "fire", "investigation",
    "emergency", "first responders", "ambulance", "rescue", "scene",
)

# Discussion/opinion/sports markers that disqualify even if keywords match.
_NON_INCIDENT_MARKERS = (
    "touchdown", " td ", "kickoff", "quarterback", "season opener", "playoff",
    "i amuse myself", "ai programs", "sketches", "op-ed", "opinion:",
    "podcast", "newsletter", "subscribe", "commentary", "my column",
    "reform bill", "budget hearing", "town hall", "ribbon cutting",
)

# Albany-County locality anchors — at least one must appear (strict gate).
ALBANY_LOCALITY = (
    "albany", "colonie", "bethlehem", "guilderland", "cohoes", "watervliet",
    "menands", "green island", "coeymans", "new scotland", "berne", "knox",
    "westerlo", "rensselaerville", "ravena", "voorheesville", "altamont",
    "latham", "loudonville", "delmar", "slingerlands", "glenmont", "selkirk",
    "capital region", "troop g",
)

# Out-of-area state markers that disqualify a post even if it says "albany".
_WRONG_ALBANY = ("albany, or", "albany oregon", "albany, ga", "albany georgia", "linn county")

_HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]+\.[a-z]{2,}$", re.I)


def _looks_albany(blob: str) -> bool:
    low = blob.lower()
    if any(w in low for w in _WRONG_ALBANY):
        return False
    return any(loc in low for loc in ALBANY_LOCALITY)


def _has_activity(blob: str) -> bool:
    low = blob.lower()
    if any(m in low for m in _NON_INCIDENT_MARKERS):
        return False
    if any(kw in low for kw in STRONG_ACTIVITY_KEYWORDS):
        return True
    # Weak keywords require at least TWO distinct hits to imply a real event.
    weak_hits = sum(1 for kw in WEAK_ACTIVITY_KEYWORDS if kw in low)
    return weak_hits >= 2


def _severity_for(blob: str) -> str:
    low = blob.lower()
    if any(w in low for w in ("shooting", "shot", "homicide", "murder", "fatal", "stabbing", "hostage", "active shooter")):
        return "high"
    if any(w in low for w in ("robbery", "assault", "pursuit", "standoff", "barricade", "swat", "weapon", "gun")):
        return "high"
    if any(w in low for w in ("arrest", "charged", "burglary", "crash", "fire", "missing", "overdose")):
        return "medium"
    return "low"


def _crime_type_for(blob: str) -> str:
    low = blob.lower()
    if any(w in low for w in ("shooting", "shot", "stabbing", "homicide", "murder", "assault", "robbery", "weapon", "gun", "hostage")):
        return "violent"
    if any(w in low for w in ("burglary", "theft", "larceny", "stolen", "vandal")):
        return "property"
    if any(w in low for w in ("crash", "collision", "dwi", "dui", "accident")):
        return "traffic"
    if any(w in low for w in ("fire", "structure fire", "blaze")):
        return "fire"
    return "other"


def _post_text(post: dict) -> str:
    rec = post.get("record") or {}
    text = rec.get("text") or ""
    # Include embedded external link card title/description for more signal.
    embed = post.get("embed") or rec.get("embed") or {}
    ext = embed.get("external") or {}
    extra = " ".join(filter(None, [ext.get("title"), ext.get("description")]))
    return f"{text} {extra}".strip()


def _post_link(post: dict, handle: str) -> str:
    # Prefer the embedded article URL; fall back to the Bluesky permalink.
    rec = post.get("record") or {}
    embed = post.get("embed") or rec.get("embed") or {}
    ext = embed.get("external") or {}
    if ext.get("uri"):
        return ext["uri"]
    uri = post.get("uri") or ""
    m = re.search(r"app\.bsky\.feed\.post/([a-z0-9]+)$", uri)
    if m:
        return f"https://bsky.app/profile/{handle}/post/{m.group(1)}"
    return f"https://bsky.app/profile/{handle}"


def _to_incident_row(post: dict, account: dict) -> Optional[dict[str, Any]]:
    blob = _post_text(post)
    if len(blob) < 12:
        return None
    if not _has_activity(blob) or not _looks_albany(blob):
        return None

    handle = account["handle"]
    label = account["label"]
    rec = post.get("record") or {}
    created = rec.get("createdAt") or datetime.now(timezone.utc).isoformat()
    try:
        dt = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
        pub = format_datetime(dt)
    except Exception:
        pub = format_datetime(datetime.now(timezone.utc))

    link = _post_link(post, handle)
    title = blob[:160]
    rid = f"bsky:{handle}:{hashlib.sha256((post.get('uri') or blob).encode()).hexdigest()[:16]}"
    severity = _severity_for(blob)
    crime_type = _crime_type_for(blob)

    return {
        "id": rid,
        "guid": rid,
        "title": title,
        "summary": blob[:280],
        "description": blob[:280],
        "link": link,
        "source": f"Bluesky · {label}",
        "source_name": f"Bluesky · {label}",
        "source_url": f"https://bsky.app/profile/{handle}",
        "pubDate": pub,
        "confidence": account.get("reliability", 0.7),
        "event_type": crime_type,
        "municipality": "",  # resolved downstream by locality pipeline
        "incident": {
            "id": rid,
            "event_type": crime_type,
            "status": "recent",
            "severity": severity,
            "source_type": "social",
            "source_name": f"Bluesky · {label}",
            "source_url": link,
            "verification_level": "social",
            "confidence_score": account.get("reliability", 0.7),
            "operational_badges": ["bluesky", "social", "real_time"],
        },
        "raw_payload": {
            "source_class": "social_realtime",
            "platform": "bluesky",
            "handle": handle,
            "ingestion": "bluesky_author_feed",
        },
        "provenance": build_provenance(
            source_class="social_realtime",
            source_id=f"bluesky-{handle}"[:60],
            trust_tier="tier_3",
            lane="social",
            ingestion_method="atproto_getAuthorFeed",
            feed_url=f"https://bsky.app/profile/{handle}",
            captured_at=datetime.now(timezone.utc).isoformat(),
            raw_fields_hash=hashlib.sha256(blob.encode("utf-8", errors="ignore")).hexdigest()[:16],
            content_type="bsky_post",
            capture_method="bluesky_public_appview",
        ),
    }


async def _fetch_author_feed(client: httpx.AsyncClient, account: dict, limit: int) -> list[dict[str, Any]]:
    handle = account["handle"]
    try:
        resp = await client.get(
            f"{BLUESKY_APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed",
            params={"actor": handle, "limit": min(limit, 30), "filter": "posts_no_replies"},
            timeout=10.0,
        )
        if resp.status_code != 200:
            logger.debug("bluesky_author_feed_non200 handle=%s status=%s", handle, resp.status_code)
            return []
        data = resp.json()
    except Exception as exc:
        logger.debug("bluesky_author_feed_error handle=%s error=%s", handle, exc)
        return []

    rows: list[dict[str, Any]] = []
    for item in (data.get("feed") or []):
        post = item.get("post") or {}
        row = _to_incident_row(post, account)
        if row:
            rows.append(row)
    return rows


async def _discover_accounts(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Best-effort: find more Capital Region accounts via searchActors."""
    found: dict[str, dict[str, Any]] = {}
    for term in BLUESKY_DISCOVERY_TERMS:
        try:
            resp = await client.get(
                f"{BLUESKY_APPVIEW}/xrpc/app.bsky.actor.searchActors",
                params={"q": term, "limit": 10},
                timeout=8.0,
            )
            if resp.status_code != 200:
                continue
            for a in (resp.json().get("actors") or []):
                handle = (a.get("handle") or "").lower()
                disp = (a.get("displayName") or "") + " " + (a.get("description") or "")
                if not handle or handle in BLUESKY_BLOCKLIST:
                    continue
                if not _HANDLE_RE.match(handle):
                    continue
                # Only keep accounts whose profile clearly signals Capital Region NY.
                low = disp.lower()
                if any(loc in low for loc in ("albany", "capital region", "schenectady", "troy", "saratoga")) \
                        and not any(w in low for w in ("oregon", ", or", "georgia", ", ga", "louisville")):
                    found[handle] = {"handle": handle, "label": (a.get("displayName") or handle)[:40], "reliability": 0.62}
        except Exception as exc:
            logger.debug("bluesky_discover_error term=%s error=%s", term, exc)
    return list(found.values())


async def fetch_bluesky_posts(
    limit_per_account: int = 20,
    *,
    discover: bool = False,
) -> list[dict[str, Any]]:
    """Pull recent crime/police/emergency posts from Capital Region Bluesky
    accounts. No API key required. Returns incident-shaped rows ready for the
    standard ingestion/dedupe/persist pipeline."""
    accounts: list[dict[str, Any]] = list(BLUESKY_SEED_ACCOUNTS)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        if discover:
            try:
                discovered = await _discover_accounts(client)
                seen = {a["handle"] for a in accounts}
                for d in discovered:
                    if d["handle"] not in seen:
                        accounts.append(d)
                        seen.add(d["handle"])
            except Exception as exc:
                logger.debug("bluesky_discovery_failed error=%s", exc)

        tasks = [_fetch_author_feed(client, acct, limit_per_account) for acct in accounts]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    rows: list[dict[str, Any]] = []
    for r in results:
        if isinstance(r, Exception):
            continue
        rows.extend(r)

    logger.info("bluesky_fetch accounts=%d incident_rows=%d", len(accounts), len(rows))
    _record_status(len(accounts), len(rows))
    return rows


# Lightweight runtime status for the health/diagnostics endpoints.
_last_status: dict[str, Any] = {"accounts": len(BLUESKY_SEED_ACCOUNTS), "last_rows": 0, "last_run": ""}


def bluesky_runtime_status() -> dict[str, Any]:
    return dict(_last_status)


def _record_status(accounts: int, rows: int) -> None:
    _last_status["accounts"] = accounts
    _last_status["last_rows"] = rows
    _last_status["last_run"] = datetime.now(timezone.utc).isoformat()
