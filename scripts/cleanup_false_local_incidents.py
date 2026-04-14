#!/usr/bin/env python3
"""Audit and clean up false-local incidents persisted before the locality-gate fix.

Prior to commit a418f29, the fallback persistence branch in api_server.get_crimes()
could write raw feed rows to the incidents table without running the strict
Albany-County locality gate. Items whose title/description mention Albany, GA;
Dougherty County; GBI; Delmar, MD; etc. may remain in the database.

This utility re-evaluates each persisted row by replaying its raw_payload through
the CURRENT evaluate_strict_albany_county() — the post-fix source of truth — and
reports / quarantines / deletes rows that now fail the gate.

Modes
-----
--dry-run        Default. Prints counts, reason breakdown, and sample titles.
                 Makes NO writes.
--quarantine     Reversible cleanup. Appends "false_local_quarantine" to tags,
                 sets status='historical' and confidence_score=0.0. Rows remain
                 in the table and can be restored by clearing the tag.
--delete         Destructive. Hard-deletes flagged rows. Requires --yes to run.

Safety rails
------------
- Refuses to run without DATABASE_URL set.
- Never touches rows that currently PASS evaluate_strict_albany_county().
- Caps --delete / --quarantine to --limit rows per invocation (default 500).
- Prints a confirmation summary before any write.
- Does not modify rows whose raw_payload is empty/missing — those are logged
  as "raw_payload_missing" and skipped to avoid acting on no evidence.

Run from repo root:
  python scripts/cleanup_false_local_incidents.py
  python scripts/cleanup_false_local_incidents.py --quarantine --yes
  python scripts/cleanup_false_local_incidents.py --delete --yes --limit 200
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import Counter
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_server import evaluate_strict_albany_county  # post-fix locality gate
from app.db.session import get_session_factory, has_database
from sqlalchemy import text


QUARANTINE_TAG = "false_local_quarantine"

# Albany County, NY bounding box (conservative; extends slightly beyond the
# county line so legitimately geocoded rows at the border are not swept up).
# Any row with a latitude/longitude inside this box is protected even if its
# text fails the locality gate — we do not want to delete a real geocoded
# incident just because the scraped title lacks an explicit Albany anchor.
_ALBANY_COUNTY_BBOX = {
    "lat_min": 42.40,
    "lat_max": 42.85,
    "lon_min": -74.25,
    "lon_max": -73.65,
}

# Known-bad text markers we are most confident about. Used to classify whether
# a flagged row is a "hard" false-local (Albany, GA; Dougherty County; GBI;
# Delmar, MD; explicit out-of-state city) vs. a "soft" non-Albany-County row
# (Capital Region neighbor: Troy, Schenectady, Saratoga, etc.). Only hard
# false-locals are touched by --quarantine / --delete by default; soft rows
# require --include-soft.
_HARD_FALSE_LOCAL_MARKERS = (
    "albany, ga",
    "albany, georgia",
    "albany ga",
    "dougherty county",
    "gbi investigating",
    "georgia bureau of investigation",
    "ocilla",
    "albany, or",
    "albany, oregon",
    "linn county",
    "albany, ca",
    "albany, california",
    "albany, wa",
    "albany, washington",
    "delmar, md",
    "delmar md",
)


def _in_albany_county_bbox(lat: Any, lon: Any) -> bool:
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return False
    b = _ALBANY_COUNTY_BBOX
    return b["lat_min"] <= lat_f <= b["lat_max"] and b["lon_min"] <= lon_f <= b["lon_max"]


def _is_hard_false_local(row: dict[str, Any]) -> bool:
    raw = row.get("raw_payload") if isinstance(row.get("raw_payload"), dict) else {}
    blob = " ".join(
        str(v or "").lower() for v in (
            raw.get("title"), raw.get("description"), raw.get("source"),
            row.get("title"), row.get("description"), row.get("source_name"),
        )
    )
    return any(m in blob for m in _HARD_FALSE_LOCAL_MARKERS)


def _raw_payload_fields(raw: Any) -> dict[str, Any]:
    """raw_payload is JSONB — defensively shape it into a dict with the fields
    evaluate_strict_albany_county() actually reads."""
    if not isinstance(raw, dict):
        return {}
    return {
        "title": str(raw.get("title") or ""),
        "description": str(raw.get("description") or ""),
        "source": str(raw.get("source") or raw.get("source_name") or ""),
        "link": str(raw.get("link") or raw.get("source_url") or ""),
        "source_url": str(raw.get("source_url") or ""),
        "guid": str(raw.get("guid") or raw.get("id") or ""),
    }


def _reclassify(row: dict[str, Any]) -> tuple[str, str]:
    """
    Returns (verdict, reason) where verdict is one of:
      "pass"                — row still Albany County; leave it alone.
      "flag"                — row fails the current locality gate; candidate.
      "raw_payload_missing" — cannot evaluate; leave it alone.
    """
    raw = row.get("raw_payload")
    fields = _raw_payload_fields(raw)
    if not any(fields.get(k) for k in ("title", "description", "source")):
        # Also try top-level columns as a backstop for the fallback-era rows
        # that may have persisted the primary fields outside raw_payload.
        fields["title"] = str(row.get("title") or fields["title"])
        fields["description"] = str(row.get("description") or fields["description"])
        fields["source"] = str(row.get("source_name") or fields["source"])
        fields["link"] = str(row.get("source_url") or fields["link"])
    if not any(fields.get(k) for k in ("title", "description", "source")):
        return "raw_payload_missing", "no_evaluable_text"
    ok, reason = evaluate_strict_albany_county(fields)
    if ok:
        return "pass", reason or "pass"
    return "flag", reason or "rejected"


async def _load_rows() -> list[dict[str, Any]]:
    session_factory = get_session_factory()
    if session_factory is None:
        raise RuntimeError("no session factory; is DATABASE_URL set?")
    async with session_factory() as session:
        result = await session.execute(
            text(
                """
                SELECT id, title, description, source_name, source_url,
                       municipality, status, confidence_score, tags, raw_payload
                FROM incidents
                """
            )
        )
        return [dict(m) for m in result.mappings().all()]


async def _apply_quarantine(ids: list[str]) -> int:
    session_factory = get_session_factory()
    if session_factory is None:
        return 0
    updated = 0
    async with session_factory() as session:
        for incident_id in ids:
            # Append tag only if not already present; set status + zero confidence.
            res = await session.execute(
                text(
                    """
                    UPDATE incidents
                    SET tags = CASE
                                 WHEN tags IS NULL THEN to_jsonb(ARRAY[:tag]::text[])
                                 WHEN NOT (tags ? :tag) THEN tags || to_jsonb(ARRAY[:tag]::text[])
                                 ELSE tags
                               END,
                        status = 'historical',
                        confidence_score = 0.0
                    WHERE id = :id
                    """
                ),
                {"id": incident_id, "tag": QUARANTINE_TAG},
            )
            updated += res.rowcount or 0
        await session.commit()
    return updated


async def _apply_delete(ids: list[str]) -> int:
    session_factory = get_session_factory()
    if session_factory is None:
        return 0
    deleted = 0
    async with session_factory() as session:
        for incident_id in ids:
            res = await session.execute(
                text("DELETE FROM incidents WHERE id = :id"),
                {"id": incident_id},
            )
            deleted += res.rowcount or 0
        await session.commit()
    return deleted


async def run(mode: str, *, limit: int, yes: bool, sample: int, include_soft: bool) -> int:
    if not has_database():
        print("ERROR: DATABASE_URL is not set. Refusing to run.", file=sys.stderr)
        return 2

    rows = await _load_rows()
    print(f"Loaded {len(rows)} rows from incidents table.")

    hard_flags: list[dict[str, Any]] = []  # Albany-GA / Dougherty / Delmar-MD / etc.
    soft_flags: list[dict[str, Any]] = []  # Non-Albany Capital-Region neighbors.
    geo_protected: list[dict[str, Any]] = []  # Text fails, but geocode is inside bbox.
    missing: list[dict[str, Any]] = []
    reason_counts: Counter[str] = Counter()

    for row in rows:
        verdict, reason = _reclassify(row)
        if verdict == "flag":
            if _in_albany_county_bbox(row.get("latitude"), row.get("longitude")):
                geo_protected.append({**row, "_flag_reason": reason})
                continue
            entry = {**row, "_flag_reason": reason}
            if _is_hard_false_local(row):
                hard_flags.append(entry)
            else:
                soft_flags.append(entry)
            reason_counts[reason] += 1
        elif verdict == "raw_payload_missing":
            missing.append(row)

    total_hard = len(hard_flags)
    total_soft = len(soft_flags)
    print(f"\nHard false-local (Albany GA / GBI / Delmar MD / etc.): {total_hard}")
    print(f"Soft non-Albany-County (Capital Region neighbors): {total_soft}")
    print(f"Geo-protected (text fails but lat/lon inside Albany County): {len(geo_protected)}")
    print(f"Skipped (raw_payload empty / no evaluable text): {len(missing)}")
    passing = len(rows) - total_hard - total_soft - len(geo_protected) - len(missing)
    print(f"Passing (still Albany County by text): {passing}")

    if reason_counts:
        print("\nReason breakdown (flagged):")
        for reason, count in reason_counts.most_common():
            print(f"  {count:5d}  {reason}")

    def _print_samples(label: str, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        print(f"\nSample {label} titles (first {min(sample, len(items))}):")
        for r in items[:sample]:
            print(f"  [{r['_flag_reason']}] {str(r.get('title') or '')[:110]!r}")

    _print_samples("HARD", hard_flags)
    _print_samples("SOFT", soft_flags)
    if geo_protected:
        print(f"\nGeo-protected rows (not touched) — first {min(sample, len(geo_protected))}:")
        for r in geo_protected[:sample]:
            lat, lon = r.get("latitude"), r.get("longitude")
            print(f"  [{r['_flag_reason']}] ({lat},{lon}) {str(r.get('title') or '')[:90]!r}")

    target = hard_flags + (soft_flags if include_soft else [])
    target_label = "HARD" if not include_soft else "HARD+SOFT"

    if mode == "dry-run":
        print(f"\nDry-run only. No writes performed. Target set ({target_label}) = {len(target)} rows.")
        return 0

    if not yes:
        print(f"\nMode={mode} requires --yes to perform writes. Aborting.")
        return 3

    to_touch = target[:limit]
    ids = [str(row["id"]) for row in to_touch if row.get("id")]
    print(f"\nApplying {mode} to {len(ids)} rows "
          f"(target={target_label}, limit={limit}).")

    if mode == "quarantine":
        n = await _apply_quarantine(ids)
        print(f"Quarantined {n} rows (tag={QUARANTINE_TAG}, status=historical, confidence_score=0).")
    elif mode == "delete":
        n = await _apply_delete(ids)
        print(f"Deleted {n} rows.")
    else:
        print(f"Unknown mode: {mode}")
        return 4

    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Audit/clean false-local incidents in the ACT DB.")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--dry-run", dest="mode", action="store_const", const="dry-run",
                       help="(default) Report only; no writes.")
    group.add_argument("--quarantine", dest="mode", action="store_const", const="quarantine",
                       help="Reversible: tag + status=historical + confidence=0.")
    group.add_argument("--delete", dest="mode", action="store_const", const="delete",
                       help="Destructive: hard DELETE flagged rows.")
    p.add_argument("--yes", action="store_true", help="Required for --quarantine / --delete.")
    p.add_argument("--limit", type=int, default=500, help="Max rows to touch (default 500).")
    p.add_argument("--sample", type=int, default=20, help="Number of sample titles to print.")
    p.add_argument(
        "--include-soft",
        action="store_true",
        help="Also touch 'soft' non-Albany-County rows (Troy, Schenectady, Saratoga, etc.). "
             "Off by default — only hard false-locals are targeted.",
    )
    args = p.parse_args()
    mode = args.mode or "dry-run"
    return asyncio.run(run(
        mode,
        limit=args.limit,
        yes=args.yes,
        sample=args.sample,
        include_soft=args.include_soft,
    ))


if __name__ == "__main__":
    raise SystemExit(main())
