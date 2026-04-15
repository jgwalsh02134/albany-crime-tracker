#!/usr/bin/env python3
"""One-shot backfill: populate incidents.responding_agency_id on rows
persisted before commit fa38b4d (Persist responding_agency_id on incidents).

Background
----------
- Commit fa38b4d added a String(64) `responding_agency_id` column on
  incidents and populated it through article_to_incident() for every
  newly-ingested article.
- Existing rows at deploy time received the column default (NULL) and
  stay NULL until something resolves their agency.
- Production probe (April 2026): 435/436 visible rows have
  responding_agency_id IS NULL.

This script replays the canonical resolver
(app.services.incident_transformers._resolve_responding_agency_id) over
each NULL row's raw_payload (with fallback to its scalar columns when
raw_payload is sparse). Same code path as new ingests = identical
attribution semantics.

Modes
-----
--dry-run    Default. Reports the candidate count, how many would
             resolve, and a top-agencies breakdown without writing.
--apply      Performs row-by-row UPDATEs for resolved rows in a single
             transaction. Unresolved rows stay NULL (the script never
             writes a fabricated value).

Safety rails
------------
- Refuses to run without DATABASE_URL.
- Uses --limit (default 5000) per invocation.
- Never invents an agency: only writes when the resolver returns a
  non-empty agency_id from the canonical registry.
- Leaves rows with a non-NULL responding_agency_id alone — idempotent.
- Single transaction with rollback on error.

Run from repo root:
  python scripts/backfill_responding_agency_id.py
  python scripts/backfill_responding_agency_id.py --apply
  python scripts/backfill_responding_agency_id.py --apply --limit 1000
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import Counter
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from app.db.session import get_session_factory, has_database
from app.services.incident_transformers import _resolve_responding_agency_id


_SELECT_SQL = """
SELECT id, source_name, source_url, raw_payload
FROM incidents
WHERE responding_agency_id IS NULL
ORDER BY created_at DESC NULLS LAST
LIMIT :lim
"""

_UPDATE_SQL = """
UPDATE incidents
SET responding_agency_id = :aid
WHERE id = :id AND responding_agency_id IS NULL
"""


def _row_to_article(row: dict[str, Any]) -> dict[str, Any]:
    """Build the article-shaped dict the canonical resolver consumes.

    Prefers raw_payload (the original ingest article shape) and falls
    back to the persisted scalar columns when raw_payload is sparse.
    Never raises — non-dict raw_payload is treated as missing.
    """
    raw = row.get("raw_payload")
    base: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
    if not base.get("source"):
        base["source"] = str(row.get("source_name") or "")
    if not base.get("source_name"):
        base["source_name"] = str(row.get("source_name") or "")
    if not base.get("link"):
        base["link"] = str(row.get("source_url") or "")
    return base


def _resolve_for_row(row: dict[str, Any]) -> Optional[str]:
    """Apply the canonical resolver to one row. Returns the agency_id or
    None. Defensive — any resolver exception is treated as 'no match'."""
    try:
        return _resolve_responding_agency_id(_row_to_article(row))
    except Exception:
        return None


async def run(*, apply: bool, limit: int, sample: int) -> int:
    if not has_database():
        print("ERROR: DATABASE_URL not set; refusing to run.", file=sys.stderr)
        return 2

    sf = get_session_factory()
    if sf is None:
        print("ERROR: no session factory available; check DB readiness.",
              file=sys.stderr)
        return 2

    async with sf() as session:
        result = await session.execute(text(_SELECT_SQL), {"lim": limit})
        rows = [dict(m) for m in result.mappings().all()]

        print(f"Candidate rows (responding_agency_id IS NULL): {len(rows)}")
        if not rows:
            print("Nothing to backfill.")
            return 0

        # Resolve in Python.
        agency_counts: Counter[str] = Counter()
        unresolved_sources: Counter[str] = Counter()
        resolutions: list[tuple[str, str]] = []
        for row in rows:
            aid = _resolve_for_row(row)
            if aid:
                agency_counts[aid] += 1
                resolutions.append((str(row["id"]), aid))
            else:
                unresolved_sources[str(row.get("source_name") or "<empty>")] += 1

        resolved_count = len(resolutions)
        unresolved_count = len(rows) - resolved_count
        print(f"Would resolve: {resolved_count} row(s)")
        print(f"Would stay NULL (no canonical agency match): {unresolved_count}")

        if agency_counts:
            print("\nTop agency_ids that would be written:")
            for aid, cnt in agency_counts.most_common(10):
                print(f"  {cnt:5d}  {aid}")

        if unresolved_sources:
            print(f"\nTop unresolved source_name (first {sample}):")
            for src, cnt in unresolved_sources.most_common(sample):
                print(f"  {cnt:5d}  {src!r}")

        if not apply:
            print("\nDry-run only. No writes performed. Re-run with --apply.")
            return 0

        if not resolutions:
            print("\nNo resolved rows to write; nothing to apply.")
            return 0

        # Batched per-row UPDATEs in a single transaction. Per-row keeps the
        # idempotency clause (`AND responding_agency_id IS NULL`) tight so a
        # concurrent ingest can't be clobbered.
        try:
            updated = 0
            for incident_id, aid in resolutions:
                r = await session.execute(
                    text(_UPDATE_SQL),
                    {"aid": aid, "id": incident_id},
                )
                updated += r.rowcount or 0
            await session.commit()
        except Exception as exc:
            await session.rollback()
            print(f"ERROR during update; rolled back: {exc}", file=sys.stderr)
            return 3

        print(f"\nUpdated {updated} row(s).")
        # Confirm post-state.
        r = await session.execute(text(
            "SELECT COUNT(*) FROM incidents WHERE responding_agency_id IS NULL"
        ))
        remaining = int(r.scalar() or 0)
        print(f"Remaining NULL responding_agency_id rows: {remaining}")
        if remaining > 0:
            print(f"  ({unresolved_count} of those are unresolvable from "
                  f"current registry; the rest can be retried with --apply.)")
        return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description="Backfill incidents.responding_agency_id for rows "
                    "persisted before fa38b4d, using the canonical resolver."
    )
    g = p.add_mutually_exclusive_group()
    g.add_argument("--dry-run", dest="apply", action="store_false",
                   help="(default) Resolve in-memory; do not write.")
    g.add_argument("--apply", dest="apply", action="store_true",
                   help="Perform UPDATEs for resolved rows.")
    p.set_defaults(apply=False)
    p.add_argument("--limit", type=int, default=5000,
                   help="Max rows to consider per invocation (default 5000).")
    p.add_argument("--sample", type=int, default=15,
                   help="Number of unresolved source_name examples to print "
                        "(default 15).")
    args = p.parse_args()
    return asyncio.run(run(apply=args.apply, limit=args.limit, sample=args.sample))


if __name__ == "__main__":
    raise SystemExit(main())
