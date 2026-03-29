"""
Albany County, NY — incident-centric public safety intelligence layer.

Maps all ingestion sources into a unified incident model, fuses duplicates,
computes Live eligibility, public-safety scoring, and operational summaries.
"""
from __future__ import annotations

import hashlib
import re
import math
from datetime import datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STOPWORDS = frozenset(
    """
    a an the and or but in on at to for of is was are were be been being
    with as by from that this it its into about after over under up out
    than then so if no not just more most also only very can may will would
    could should police department county city town state ny nys
    """.split()
)

ALBANY_MUNICIPALITIES = frozenset(
    """
    albany colonie bethlehem guilderland cohoes watervliet menands green island
    ravena voorheesville altamont new scotland coeymans westerlo knox berne
    rensselaerville delmar glenmont slingerlands latham loudonville selkirk
    feura bush clarksville westmere roessleville
    """.split()
)

LANE_SCANNER = "scanner"
LANE_OFFICIAL = "official_alerts"
LANE_LOCAL_NEWS = "local_news"
LANE_ENRICHMENT = "enrichment"

VERIFICATION_OFFICIAL = "official"
VERIFICATION_SCANNER = "scanner"
VERIFICATION_MEDIA = "media"
VERIFICATION_MULTI = "multi_source"
VERIFICATION_INFERRED = "inferred"

STATUS_ACTIVE = "active"
STATUS_RECENT = "recent"
STATUS_CLEARED = "cleared"
STATUS_HISTORICAL = "historical"
STATUS_UNKNOWN = "unknown"

LIVE_FRAME_LIVE_NOW = "live_now"
LIVE_FRAME_DEVELOPING = "developing"
LIVE_FRAME_RECENT = "recent"
LIVE_FRAME_STALE = "stale"
LIVE_FRAME_REJECT = "reject"

FUSE_MAX_GAP_SECONDS = 4 * 3600  # 4h between mentions to consider same incident
FUSE_KEYWORD_JACCARD_MIN = 0.22
FUSE_HAVERSINE_MAX_M = 800.0

_URGENCY_TERMS = (
    "shooting", "shots fired", "stabbing", "homicide", "murder", "armed",
    "hostage", "barricade", "standoff", "swat", "pursuit", "amber alert",
    "missing child", "missing person", "silver alert", "structure fire",
    "working fire", "fully engulfed", "hazmat", "explosion", "bomb threat",
    "suspect at large", "manhunt", "mass casualty", "active shooter",
)

_CLOSURE_TERMS = (
    "road closed", "road closure", "lane closed", "lanes closed", "detour",
    "traffic diverted", "avoid the area", "avoid area",
)

_ONGOING_TERMS = (
    "active", "developing", "breaking", "ongoing", "still searching",
    "active search", "shelter in place", "shelter-in-place", "scene",
    "responding", "police activity", "heavy police presence",
)


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _freshness_minutes(pub: Optional[str]) -> Optional[float]:
    dt = _parse_dt(pub)
    if not dt:
        return None
    return (_now_utc() - dt).total_seconds() / 60.0


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s or "")


def _tokenize(text: str) -> set[str]:
    t = re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())
    words = [w for w in t.split() if len(w) > 2 and w not in STOPWORDS]
    return set(words)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def classify_source_lane(raw: dict) -> str:
    if raw.get("_scanner_call"):
        return LANE_SCANNER
    if raw.get("_nixle_item") or raw.get("_official_x_post"):
        return LANE_OFFICIAL
    src = (raw.get("source") or "").lower()
    link = (raw.get("link") or "") + " " + (raw.get("source_url") or "")
    if "blotter" in src or "nixle" in src:
        return LANE_OFFICIAL
    if any(d in link.lower() for d in (
        "wnyt.com", "timesunion.com", "cbs6albany.com", "news10.com",
        "spectrumlocalnews.com", "dailygazette.com", "spotlightnews.com",
        "troopers.ny.gov", "albanyny.gov", "albanycounty.com",
    )):
        return LANE_LOCAL_NEWS
    if raw.get("_scanner_feed_link"):
        return LANE_ENRICHMENT
    return LANE_LOCAL_NEWS


def infer_event_type_and_subtype(blob: str) -> tuple[str, str]:
    b = blob.lower()
    if any(x in b for x in ("structure fire", "working fire", "house fire", "fully engulfed")):
        return "fire", "structure_fire"
    if "hazmat" in b or "chemical" in b:
        return "hazmat", "hazmat"
    if any(x in b for x in _CLOSURE_TERMS):
        return "traffic", "road_closure"
    if any(x in b for x in ("missing person", "missing juvenile", "amber alert", "silver alert")):
        return "missing", "missing_person"
    if any(x in b for x in ("shooting", "shots fired", "shot ", "person shot")):
        return "violent_crime", "shooting"
    if "stabbing" in b or "stabbed" in b:
        return "violent_crime", "stabbing"
    if any(x in b for x in ("robbery", "armed robbery")):
        return "violent_crime", "robbery"
    if any(x in b for x in ("assault", "battery")):
        return "violent_crime", "assault"
    if any(x in b for x in ("burglary", "break-in", "breaking and entering")):
        return "property_crime", "burglary"
    if any(x in b for x in ("crash", "collision", "mva", "mvc", "rollover", "fatal crash")):
        return "traffic", "crash"
    if any(x in b for x in ("overdose", "unconscious", "cardiac", "difficulty breathing")):
        return "ems", "medical"
    if any(x in b for x in ("pursuit", "chase", "foot pursuit")):
        return "police_activity", "pursuit"
    if any(x in b for x in ("investigation", "police investigate", "detectives")):
        return "police_activity", "investigation"
    if any(x in b for x in ("arrest", "arrested", "charged", "in custody")):
        return "law_enforcement", "arrest"
    if "scanner" in b or "dispatch" in b:
        return "police_activity", "dispatch"
    return "general", "public_safety"


def _municipality_from_text(blob: str, matched_loc: Optional[str]) -> str:
    if matched_loc:
        ml = matched_loc.lower().strip()
        for m in sorted(ALBANY_MUNICIPALITIES, key=len, reverse=True):
            if m in ml or m in blob:
                return m.title()
    for m in sorted(ALBANY_MUNICIPALITIES, key=len, reverse=True):
        if re.search(rf"(?<![a-z0-9]){re.escape(m)}(?![a-z0-9])", blob):
            return m.title()
    if "albany county" in blob:
        return "Albany County"
    if re.search(r"\balbany\b", blob) and ("ny" in blob or "new york" in blob or "county" in blob):
        return "Albany"
    return ""


def _street_or_area(blob: str, matched_loc: Optional[str]) -> str:
    if matched_loc and matched_loc.lower() != "albany":
        return matched_loc.replace("_", " ").title()
    m = re.search(
        r"\b(\d{1,5}\s+[a-z][a-z\s]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|drive|dr))\b",
        blob,
        re.I,
    )
    if m:
        return m.group(1).strip().title()
    return matched_loc or ""


def _actionable_summary(title: str, summary: str, event_type: str) -> str:
    s = (summary or "").strip() or (title or "").strip()
    if len(s) > 220:
        s = s[:217] + "..."
    if not s:
        return "Local public safety activity — verify with official sources."
    return s


def normalize_from_enriched(raw: dict) -> dict:
    """
    Single pipeline entry: map one enriched article/geo dict → unified incident dict.
    `raw` must include geocode outputs, crime_type, confidence, ages, source_priority, flags.
    """
    title = (raw.get("title") or "").strip()
    desc = _strip_html(raw.get("description") or "").strip()
    summary = desc if len(desc) >= len(title) * 0.4 else (desc or title)
    blob = f"{title} {desc}".lower()

    lane = classify_source_lane(raw)
    event_type, sub_type = infer_event_type_and_subtype(blob)
    matched = raw.get("matched_location")
    municipality = _municipality_from_text(blob, matched)
    street = _street_or_area(blob, matched)
    neighborhood = raw.get("neighborhood") or ""

    pub = raw.get("pubDate") or ""
    occurred = pub
    first_seen = pub
    last_updated = pub
    fresh_m = _freshness_minutes(pub)

    # Stable id from content + time bucket
    link = raw.get("link") or raw.get("guid") or title
    id_base = f"{link}|{pub}|{title[:80]}"
    iid = hashlib.sha256(id_base.encode("utf-8", errors="ignore")).hexdigest()[:20]

    sp = int(raw.get("source_priority") or 0)
    src_name = raw.get("source") or "Unknown"
    src_url = raw.get("link") or raw.get("x_post_url") or ""

    if raw.get("_official_x_post") or raw.get("_nixle_item"):
        vlevel = VERIFICATION_OFFICIAL
    elif raw.get("_scanner_call"):
        vlevel = VERIFICATION_SCANNER
    else:
        vlevel = VERIFICATION_MEDIA

    lat = raw.get("latitude")
    lng = raw.get("longitude")
    try:
        lat_f = float(lat) if lat is not None else None
        lng_f = float(lng) if lng is not None else None
    except (TypeError, ValueError):
        lat_f = lng_f = None

    local_rel = float(raw.get("confidence") or 0.55)

    incident = {
        "id": iid,
        "title": title,
        "summary": summary[:2000] if summary else title,
        "event_type": event_type,
        "sub_type": sub_type,
        "occurred_at": occurred,
        "first_seen_at": first_seen,
        "last_updated_at": last_updated,
        "freshness_minutes": round(fresh_m, 1) if fresh_m is not None else None,
        "status": STATUS_UNKNOWN,
        "urgency_score": 0.0,
        "confidence_score": float(raw.get("confidence") or 0.55),
        "verification_level": vlevel,
        "municipality": municipality,
        "neighborhood": neighborhood,
        "street_or_area": street,
        "latitude": lat_f,
        "longitude": lng_f,
        "source_type": lane,
        "source_name": src_name,
        "source_url": src_url,
        "source_priority": sp,
        "source_count": 1,
        "source_names": [src_name],
        "local_relevance_score": round(local_rel, 3),
        "public_safety_score": 0.0,
        "is_live_eligible": False,
        "exclusion_reason": "",
        "live_frame": LIVE_FRAME_REJECT,
        "operational_badges": [],
        "why_it_matters": _actionable_summary(title, summary, event_type),
        "_kw_set": _tokenize(f"{title} {desc}"),
        "_sources_raw": [dict(raw)],
        "_primary_raw": dict(raw),
        "_strict_live_ok": bool(raw.get("_strict_live_ok")),
    }
    return incident


def _source_tier(inc: dict) -> int:
    """Higher = stronger for picking display title."""
    vl = inc.get("verification_level")
    if vl == VERIFICATION_OFFICIAL:
        return 4
    if vl == VERIFICATION_MEDIA:
        return 3
    if vl == VERIFICATION_SCANNER:
        return 2
    return 1


def _pick_best_title(cluster: list[dict]) -> str:
    ranked = sorted(cluster, key=lambda x: (_source_tier(x), len(x.get("title") or "")), reverse=True)
    for x in ranked:
        t = (x.get("title") or "").strip()
        if len(t) >= 12:
            return t
    return (ranked[0].get("title") or "Incident") if ranked else "Incident"


def _pick_best_summary(cluster: list[dict], title: str) -> str:
    ranked = sorted(cluster, key=lambda x: (_source_tier(x), len(x.get("summary") or "")), reverse=True)
    for x in ranked:
        s = (x.get("summary") or "").strip()
        if len(s) >= 24 and s.lower() != title.lower():
            return s[:2000]
    return (ranked[0].get("summary") or title)[:2000] if ranked else title


def _pick_best_coords(cluster: list[dict]) -> tuple[Optional[float], Optional[float]]:
    ranked = sorted(cluster, key=_source_tier, reverse=True)
    for x in ranked:
        la, lo = x.get("latitude"), x.get("longitude")
        if la is not None and lo is not None:
            try:
                return float(la), float(lo)
            except (TypeError, ValueError):
                continue
    return None, None


def _merge_verification(cluster: list[dict]) -> str:
    vls = {x.get("verification_level") for x in cluster}
    has_scan = VERIFICATION_SCANNER in vls
    has_off = VERIFICATION_OFFICIAL in vls
    has_media = VERIFICATION_MEDIA in vls
    # Scanner + official/media = cross-source confirmation
    if (has_scan and has_off) or (has_scan and has_media) or (has_off and has_media):
        return VERIFICATION_MULTI
    if VERIFICATION_OFFICIAL in vls:
        return VERIFICATION_OFFICIAL
    if VERIFICATION_MEDIA in vls:
        return VERIFICATION_MEDIA
    if VERIFICATION_SCANNER in vls:
        return VERIFICATION_SCANNER
    return VERIFICATION_INFERRED


def _should_fuse(a: dict, b: dict) -> bool:
    """True if incident a (fresher) belongs with cluster representative b."""
    ta = _parse_dt(a.get("occurred_at"))
    tb = _parse_dt(b.get("occurred_at"))
    if not ta or not tb:
        return False
    if abs((ta - tb).total_seconds()) > FUSE_MAX_GAP_SECONDS:
        return False

    la1, lo1 = a.get("latitude"), a.get("longitude")
    la2, lo2 = b.get("latitude"), b.get("longitude")
    if la1 and lo1 and la2 and lo2:
        try:
            d = _haversine_m(float(la1), float(lo1), float(la2), float(lo2))
            if d <= FUSE_HAVERSINE_MAX_M:
                return True
        except (TypeError, ValueError):
            pass

    sa = (a.get("street_or_area") or "").lower().strip()
    sb = (b.get("street_or_area") or "").lower().strip()
    if sa and sb and sa == sb and len(sa) > 6:
        return True

    ma = (a.get("municipality") or "").lower()
    mb = (b.get("municipality") or "").lower()
    if ma and mb and ma != mb:
        # Different municipalities — only fuse if very strong text match
        ksa, ksb = a.get("_kw_set") or set(), b.get("_kw_set") or set()
        if not ksa or not ksb:
            return False
        inter = len(ksa & ksb)
        union = len(ksa | ksb)
        if union == 0:
            return False
        return inter / union >= 0.5

    ksa, ksb = a.get("_kw_set") or set(), b.get("_kw_set") or set()
    if not ksa or not ksb:
        return False
    j = len(ksa & ksb) / len(ksa | ksb)
    return j >= FUSE_KEYWORD_JACCARD_MIN


def fuse_incident_batch(incidents: list[dict]) -> list[dict]:
    """
    Greedy clustering: each new incident attaches to first compatible cluster (by time order).
    Representative = first (freshest) member.
    """
    if not incidents:
        return []
    sorted_inc = sorted(
        incidents,
        key=lambda x: _parse_dt(x.get("occurred_at")) or _now_utc(),
        reverse=True,
    )
    clusters: list[list[dict]] = []
    for inc in sorted_inc:
        placed = False
        for cluster in clusters:
            rep = cluster[0]
            if _should_fuse(inc, rep):
                cluster.append(inc)
                placed = True
                break
        if not placed:
            clusters.append([inc])
    return [_merge_cluster(c) for c in clusters]


def _merge_cluster(cluster: list[dict]) -> dict:
    cluster = sorted(
        cluster,
        key=lambda x: _parse_dt(x.get("occurred_at")) or _now_utc(),
        reverse=True,
    )
    base = dict(cluster[0])
    title = _pick_best_title(cluster)
    summary = _pick_best_summary(cluster, title)
    lat, lng = _pick_best_coords(cluster)

    names: list[str] = []
    raws: list[dict] = []
    priorities: list[int] = []
    for x in cluster:
        n = x.get("source_name")
        if n and n not in names:
            names.append(n)
        for r in x.get("_sources_raw") or []:
            raws.append(r)
        priorities.append(int(x.get("source_priority") or 0))

    first_ts = min(
        (_parse_dt(x.get("first_seen_at")) for x in cluster if _parse_dt(x.get("first_seen_at"))),
        default=_parse_dt(cluster[-1].get("occurred_at")),
    )
    last_ts = max(
        (_parse_dt(x.get("last_updated_at")) for x in cluster if _parse_dt(x.get("last_updated_at"))),
        default=_parse_dt(cluster[0].get("occurred_at")),
    )

    fid = hashlib.sha256(
        "|".join(sorted({x.get("id", "") for x in cluster})).encode()
    ).hexdigest()[:22]

    merged = {
        **base,
        "id": f"fused_{fid}",
        "title": title,
        "summary": summary,
        "source_count": len(names),
        "source_names": names,
        "source_name": names[0] if names else base.get("source_name"),
        "verification_level": _merge_verification(cluster),
        "source_priority": max(priorities) if priorities else 0,
        "first_seen_at": format_dt_rfc(first_ts) if first_ts else base.get("first_seen_at"),
        "last_updated_at": format_dt_rfc(last_ts) if last_ts else base.get("last_updated_at"),
        "latitude": lat,
        "longitude": lng,
        "confidence_score": max(float(x.get("confidence_score") or 0) for x in cluster),
        "local_relevance_score": max(float(x.get("local_relevance_score") or 0) for x in cluster),
        "_kw_set": set.union(*(x.get("_kw_set") or set() for x in cluster)),
        "_sources_raw": raws,
        "_primary_raw": cluster[0].get("_primary_raw") or {},
        "why_it_matters": _actionable_summary(title, summary, base.get("event_type", "")),
        "_strict_live_ok_any": any(bool(x.get("_strict_live_ok")) for x in cluster),
    }
    # Re-infer event type from merged text
    mblob = f"{title} {summary}".lower()
    et, st = infer_event_type_and_subtype(mblob)
    merged["event_type"] = et
    merged["sub_type"] = st
    return merged


def format_dt_rfc(dt: Optional[datetime]) -> str:
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return format_datetime(dt)


def score_public_safety(inc: dict) -> float:
    """0–100 relevance for avoid-area / situational awareness."""
    blob = f"{inc.get('title', '')} {inc.get('summary', '')}".lower()
    score = 15.0
    for t in _URGENCY_TERMS:
        if t in blob:
            score += 14.0
    for t in _CLOSURE_TERMS:
        if t in blob:
            score += 12.0
    if any(t in blob for t in ("missing", "amber", "silver alert")):
        score += 18.0
    if any(t in blob for t in ("fatal", "death", "homicide", "murder")):
        score += 12.0
    vl = inc.get("verification_level")
    if vl == VERIFICATION_OFFICIAL:
        score += 12.0
    elif vl == VERIFICATION_MULTI:
        score += 18.0
    elif vl == VERIFICATION_MEDIA:
        score += 8.0
    elif vl == VERIFICATION_SCANNER:
        score += 4.0

    fm = inc.get("freshness_minutes")
    if fm is not None:
        if fm <= 30:
            score += 20.0
        elif fm <= 120:
            score += 14.0
        elif fm <= 360:
            score += 8.0
        elif fm <= 1440:
            score += 4.0

    if inc.get("_primary_raw", {}).get("_scanner_critical_live"):
        score += 15.0

    return min(100.0, round(score, 1))


def compute_live_eligibility(inc: dict) -> dict:
    """
    Single gate for Live vs history. Sets live_frame, is_live_eligible, exclusion_reason, status.
    Target window 24h preferred; hard cap 48h for Live.
    """
    fm = inc.get("freshness_minutes")
    age_h = fm / 60.0 if fm is not None else None
    raws = inc.get("_sources_raw") or []
    primary = inc.get("_primary_raw") or {}
    if not raws:
        raws = [primary]
    blob = f"{inc.get('title', '')} {inc.get('summary', '')}".lower()
    ongoing = any(t in blob for t in _ONGOING_TERMS)
    closure_missing = any(t in blob for t in _CLOSURE_TERMS + ("missing person", "amber alert", "silver alert"))

    scanner_any = any(r.get("_scanner_call") for r in raws)
    official_any = any(r.get("_nixle_item") or r.get("_official_x_post") for r in raws)
    crit_any = any(r.get("_scanner_critical_live") for r in raws)

    inc["exclusion_reason"] = ""
    inc["is_live_eligible"] = False
    inc["live_frame"] = LIVE_FRAME_REJECT

    if fm is None:
        inc["exclusion_reason"] = "no_timestamp"
        inc["status"] = STATUS_UNKNOWN
        return _apply_strict_live_gate(inc)

    if age_h is not None and age_h > 48.0:
        inc["exclusion_reason"] = "older_than_48h"
        inc["status"] = STATUS_HISTORICAL
        inc["live_frame"] = LIVE_FRAME_REJECT
        return _apply_strict_live_gate(inc)

    if len((inc.get("title") or "").strip()) < 8 and len((inc.get("summary") or "").strip()) < 20:
        inc["exclusion_reason"] = "weak_text"
        inc["live_frame"] = LIVE_FRAME_REJECT
        inc["status"] = STATUS_UNKNOWN
        return _apply_strict_live_gate(inc)

    # --- Scanner-heavy (any dispatch audio row in cluster) ---
    if scanner_any and inc.get("verification_level") != VERIFICATION_MULTI:
        if age_h <= 1.5:
            inc["is_live_eligible"] = True
            inc["live_frame"] = LIVE_FRAME_LIVE_NOW if fm <= 45 else LIVE_FRAME_DEVELOPING
        elif crit_any or ongoing:
            if age_h <= 12.0:
                inc["is_live_eligible"] = True
                inc["live_frame"] = LIVE_FRAME_DEVELOPING
            else:
                inc["exclusion_reason"] = "scanner_stale"
        else:
            inc["exclusion_reason"] = "scanner_age_window"
        if inc["is_live_eligible"]:
            inc["status"] = STATUS_ACTIVE if fm <= 120 or ongoing else STATUS_RECENT
            return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))
        inc["status"] = STATUS_RECENT if age_h and age_h <= 48 else STATUS_HISTORICAL
        if not inc["exclusion_reason"]:
            inc["exclusion_reason"] = "scanner_not_eligible"
        return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))

    # --- Fused scanner + confirmation ---
    if scanner_any and inc.get("verification_level") == VERIFICATION_MULTI and age_h is not None and age_h <= 24.0:
        inc["is_live_eligible"] = True
        inc["live_frame"] = LIVE_FRAME_RECENT
        inc["status"] = STATUS_RECENT
        return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))

    # --- Official / Nixle / verified social ---
    if official_any:
        if age_h <= 12.0 or (closure_missing and (ongoing or age_h <= 24.0)):
            inc["is_live_eligible"] = True
            if fm <= 60:
                inc["live_frame"] = LIVE_FRAME_LIVE_NOW
            elif age_h <= 6:
                inc["live_frame"] = LIVE_FRAME_DEVELOPING
            else:
                inc["live_frame"] = LIVE_FRAME_RECENT
            inc["status"] = STATUS_ACTIVE if ongoing or fm <= 180 else STATUS_RECENT
            return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))
        if age_h <= 24.0 and ongoing:
            inc["is_live_eligible"] = True
            inc["live_frame"] = LIVE_FRAME_RECENT
            inc["status"] = STATUS_RECENT
            return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))
        inc["exclusion_reason"] = "official_stale_for_live"

    # --- Local media / general crime coverage ---
    if age_h is not None and age_h <= 24.0:
        if any(
            k in blob
            for k in (
                "arrest", "crash", "fire", "shooting", "stabbing",
                "investigation", "charged", "robbery", "burglary",
            )
        ):
            inc["is_live_eligible"] = True
            inc["live_frame"] = LIVE_FRAME_DEVELOPING if fm <= 180 else LIVE_FRAME_RECENT
            inc["status"] = STATUS_RECENT
            return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))

    if age_h is not None and age_h <= 48.0 and (ongoing or closure_missing):
        inc["is_live_eligible"] = True
        inc["live_frame"] = LIVE_FRAME_STALE
        inc["status"] = STATUS_RECENT
        return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))

    inc["live_frame"] = LIVE_FRAME_STALE if age_h and age_h <= 72 else LIVE_FRAME_REJECT
    inc["status"] = STATUS_HISTORICAL if age_h and age_h > 48 else STATUS_RECENT
    if not inc["is_live_eligible"] and not inc["exclusion_reason"]:
        inc["exclusion_reason"] = "news_followup_or_low_urgency"
    return _apply_strict_live_gate(_finalize_live_badges(inc, ongoing, closure_missing, age_h))


def _apply_strict_live_gate(inc: dict) -> dict:
    """Require at least one source that passed api_server strict Live quality gate."""
    if inc.get("is_live_eligible") and not inc.get("_strict_live_ok_any", inc.get("_strict_live_ok")):
        inc["is_live_eligible"] = False
        inc["exclusion_reason"] = "strict_quality_gate"
        inc["live_frame"] = LIVE_FRAME_REJECT
    return inc


def _finalize_live_badges(inc: dict, ongoing: bool, closure_missing: bool, age_h: Optional[float]) -> dict:
    badges: list[str] = []
    blob = f"{inc.get('title', '')} {inc.get('summary', '')}".lower()
    vl = inc.get("verification_level")
    if vl == VERIFICATION_MULTI:
        badges.append("MULTI-SOURCE")
    if vl == VERIFICATION_OFFICIAL:
        badges.append("OFFICIAL")
    if inc.get("source_count", 1) > 1:
        badges.append("MULTI-SOURCE")

    if ongoing and inc.get("is_live_eligible"):
        badges.append("ACTIVE")
    elif inc.get("live_frame") == LIVE_FRAME_DEVELOPING:
        badges.append("DEVELOPING")

    if any(x in blob for x in _CLOSURE_TERMS):
        badges.append("ROAD CLOSED")
    if any(x in blob for x in ("missing person", "amber alert", "silver alert")):
        badges.append("MISSING PERSON")
    if any(x in blob for x in ("fire", "smoke", "working fire")):
        badges.append("FIRE")
    if any(x in blob for x in ("crash", "collision", "mva", "mvc")):
        badges.append("TRAFFIC")
    if any(x in blob for x in ("overdose", "unconscious", "ems", "medical")):
        badges.append("EMS")
    if any(x in blob for x in ("police", "investigation", "pursuit", "standoff")):
        badges.append("POLICE ACTIVITY")

    if vl == VERIFICATION_SCANNER and inc.get("source_count", 1) == 1:
        badges.append("UNCONFIRMED")

    out_badges: list[str] = []
    for b in badges:
        if b not in out_badges:
            out_badges.append(b)
    inc["operational_badges"] = out_badges
    return inc


def apply_scores_and_eligibility(fused: list[dict]) -> list[dict]:
    out = []
    for inc in fused:
        inc = dict(inc)
        if "_strict_live_ok_any" not in inc:
            inc["_strict_live_ok_any"] = bool(inc.get("_strict_live_ok"))
        # Refresh freshness on fused last_updated
        inc["freshness_minutes"] = round(_freshness_minutes(inc.get("last_updated_at") or inc.get("occurred_at")) or 0, 1)
        inc["public_safety_score"] = score_public_safety(inc)
        inc["urgency_score"] = inc["public_safety_score"]
        compute_live_eligibility(inc)
        out.append(inc)
    return out


def live_sort_key(inc: dict) -> tuple:
    """Sort Live: public safety impact, recency, confidence, source strength."""
    ps = float(inc.get("public_safety_score") or 0)
    fm = inc.get("freshness_minutes")
    fm = float(fm) if fm is not None else 99999.0
    conf = float(inc.get("confidence_score") or 0)
    sp = float(inc.get("source_priority") or 0)
    frame_rank = {
        LIVE_FRAME_LIVE_NOW: 4,
        LIVE_FRAME_DEVELOPING: 3,
        LIVE_FRAME_RECENT: 2,
        LIVE_FRAME_STALE: 1,
        LIVE_FRAME_REJECT: 0,
    }.get(inc.get("live_frame"), 0)
    return (frame_rank, ps, -fm, conf, sp)


def news_sort_ts(inc: dict) -> float:
    dt = _parse_dt(inc.get("last_updated_at") or inc.get("occurred_at"))
    return dt.timestamp() if dt else 0.0


def map_event_type_to_crime_type(event_type: str, raw_crime: str) -> str:
    if event_type == "violent_crime":
        return "violent"
    if event_type == "property_crime":
        return "property"
    if event_type in ("fire", "hazmat", "missing", "traffic", "ems", "police_activity", "law_enforcement", "general"):
        return "other"
    return raw_crime if raw_crime in ("violent", "property", "other") else "other"


def public_incident_view(inc: dict) -> dict:
    """API-safe subset (no internal fusion keys)."""
    keys = (
        "id",
        "title",
        "summary",
        "event_type",
        "sub_type",
        "occurred_at",
        "first_seen_at",
        "last_updated_at",
        "freshness_minutes",
        "status",
        "urgency_score",
        "confidence_score",
        "verification_level",
        "municipality",
        "neighborhood",
        "street_or_area",
        "latitude",
        "longitude",
        "public_safety_score",
        "live_frame",
        "operational_badges",
        "why_it_matters",
        "source_count",
        "source_names",
        "source_type",
        "is_live_eligible",
        "exclusion_reason",
        "local_relevance_score",
    )
    return {k: inc.get(k) for k in keys}


def incident_to_api_row(inc: dict) -> dict:
    """
    Flatten unified incident for existing clients: feed cards + map + patterns.
    """
    raw = inc.get("_primary_raw") or {}
    pub = inc.get("last_updated_at") or inc.get("occurred_at")
    age_h = (inc.get("freshness_minutes") or 0) / 60.0

    raw_ct = raw.get("crime_type") or "other"
    row = {
        **raw,
        "id": inc.get("id"),
        "title": inc.get("title"),
        "description": inc.get("summary"),
        "summary": inc.get("summary"),
        "pubDate": pub,
        "link": inc.get("source_url") or raw.get("link"),
        "source": inc.get("source_name"),
        "sources": inc.get("source_names", []),
        "latitude": inc.get("latitude"),
        "longitude": inc.get("longitude"),
        "matched_location": inc.get("street_or_area") or raw.get("matched_location"),
        "neighborhood": inc.get("neighborhood") or raw.get("neighborhood"),
        "crime_type": map_event_type_to_crime_type(inc.get("event_type") or "", raw_ct),
        "confidence": inc.get("confidence_score"),
        "source_reliability": raw.get("source_reliability"),
        "source_priority": inc.get("source_priority"),
        "age_hours": round(age_h, 2),
        "age_minutes": inc.get("freshness_minutes"),
        "feed_tab": "live" if inc.get("is_live_eligible") else "news",
        "incident": public_incident_view(inc),
        "event_type": inc.get("event_type"),
        "sub_type": inc.get("sub_type"),
        "incident_status": inc.get("status"),
        "live_frame": inc.get("live_frame"),
        "verification_level": inc.get("verification_level"),
        "public_safety_score": inc.get("public_safety_score"),
        "operational_badges": inc.get("operational_badges", []),
        "why_it_matters": inc.get("why_it_matters"),
        "source_count": inc.get("source_count", 1),
        "municipality": inc.get("municipality"),
        "exclusion_reason": inc.get("exclusion_reason", ""),
        "is_live_eligible": inc.get("is_live_eligible", False),
        "local_relevance_score": inc.get("local_relevance_score"),
        "_stats_eligible": any(
            bool(r.get("_stats_eligible"))
            for r in (inc.get("_sources_raw") or [raw])
        ),
    }
    # Preserve scanner flags from freshest raw in cluster
    for r in inc.get("_sources_raw") or [raw]:
        if r.get("_scanner_call"):
            row["_scanner_call"] = True
            row["_scanner_critical_live"] = r.get("_scanner_critical_live")
            row["_scanner_recent_live"] = r.get("_scanner_recent_live")
            break
    row["is_active_incident"] = bool(
        inc.get("status") == STATUS_ACTIVE or inc.get("live_frame") in (LIVE_FRAME_LIVE_NOW, LIVE_FRAME_DEVELOPING)
    )
    row["live_score"] = float(inc.get("public_safety_score") or 0)
    return row


def build_operational_summary(fused_scored: list[dict]) -> dict:
    live_now = [x for x in fused_scored if x.get("is_live_eligible")]
    active = [x for x in live_now if x.get("live_frame") in (LIVE_FRAME_LIVE_NOW, LIVE_FRAME_DEVELOPING)]
    closures = [
        x for x in live_now
        if any(t in f"{x.get('title','')} {x.get('summary','')}".lower() for t in _CLOSURE_TERMS)
    ]
    municipalities: dict[str, int] = {}
    for x in live_now:
        m = x.get("municipality") or "Unknown"
        municipalities[m] = municipalities.get(m, 0) + 1
    hotspots = sorted(municipalities.items(), key=lambda kv: -kv[1])[:6]

    concerns = sorted(
        [x for x in live_now if (x.get("public_safety_score") or 0) >= 45],
        key=lambda x: -float(x.get("public_safety_score") or 0),
    )[:8]

    conf_levels = [x.get("confidence_score") for x in live_now if x.get("confidence_score")]
    picture_conf = round(sum(conf_levels) / len(conf_levels), 2) if conf_levels else 0.0

    return {
        "top_active": [{"title": x.get("title"), "id": x.get("id"), "score": x.get("public_safety_score")} for x in active[:12]],
        "hotspots": [{"municipality": h[0], "live_count": h[1]} for h in hotspots],
        "closures_disruptions": [{"title": x.get("title"), "id": x.get("id")} for x in closures[:10]],
        "major_safety_concerns": [{"title": x.get("title"), "score": x.get("public_safety_score")} for x in concerns],
        "operational_picture_confidence": picture_conf,
        "live_eligible_count": len(live_now),
        "generated_at": _now_utc().isoformat(),
    }


def build_pipeline_diagnostics(
    raw_enriched: list[dict],
    normalized: list[dict],
    fused: list[dict],
    scored: list[dict],
) -> dict:
    by_lane: dict[str, int] = {}
    for x in normalized:
        by_lane[x.get("source_type", "")] = by_lane.get(x.get("source_type", ""), 0) + 1

    rejected_reasons: dict[str, int] = {}
    non_live = [x for x in scored if not x.get("is_live_eligible")]
    for x in non_live:
        r = x.get("exclusion_reason") or "unspecified"
        rejected_reasons[r] = rejected_reasons.get(r, 0) + 1

    live_eligible = [x for x in scored if x.get("is_live_eligible")]
    stale_frame = [x for x in scored if x.get("live_frame") == LIVE_FRAME_STALE]

    def _is_local(x: dict) -> bool:
        return float(x.get("local_relevance_score") or 0) >= 0.5

    multi = [x for x in scored if x.get("verification_level") == VERIFICATION_MULTI]
    scanner_only = [x for x in scored if x.get("verification_level") == VERIFICATION_SCANNER and x.get("source_count", 1) == 1]
    official_only = [
        x for x in scored
        if x.get("verification_level") == VERIFICATION_OFFICIAL and x.get("source_count", 1) == 1
    ]

    return {
        "raw_items_count": len(raw_enriched),
        "normalized_count": len(normalized),
        "fused_incident_count": len(fused),
        "live_eligible_count": len(live_eligible),
        "rejected_count": len(non_live),
        "rejected_by_reason": rejected_reasons,
        "stale_frame_count": len(stale_frame),
        "non_local_low_relevance_count": sum(1 for x in scored if not _is_local(x)),
        "scanner_only_count": len(scanner_only),
        "official_only_count": len(official_only),
        "multi_source_count": len(multi),
        "raw_items_by_lane": by_lane,
    }


def debug_top_lists(scored: list[dict], limit: int = 50) -> dict:
    rejected = [x for x in scored if not x.get("is_live_eligible")]
    rejected.sort(key=lambda x: news_sort_ts(x), reverse=True)
    live = [x for x in scored if x.get("is_live_eligible")]
    live.sort(key=live_sort_key, reverse=True)

    def pack(x: dict) -> dict:
        return {
            "id": x.get("id"),
            "title": x.get("title"),
            "exclusion_reason": x.get("exclusion_reason"),
            "live_frame": x.get("live_frame"),
            "public_safety_score": x.get("public_safety_score"),
            "confidence_score": x.get("confidence_score"),
            "verification_level": x.get("verification_level"),
            "source_names": x.get("source_names"),
            "source_count": x.get("source_count"),
            "freshness_minutes": x.get("freshness_minutes"),
            "badges": x.get("operational_badges"),
        }

    return {
        "rejected_top": [pack(x) for x in rejected[:limit]],
        "live_top": [pack(x) for x in live[:limit]],
    }
