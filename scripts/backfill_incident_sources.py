#!/usr/bin/env python3
"""One-shot backfill: populate the incidents.sources JSONB array on rows
persisted before commit da1a435 (Persist multi-source sources array on
incidents).

Background
----------
- Commit da1a435 added a JSONB `sources` column on incidents and wrote
  per-row entries through _to_orm() and _apply_updates().
- Existing rows at deploy time received the column default ('[]') from
  the schema-hardening ALTER TABLE.
- _apply_updates() bootstraps the array from the row's source_name /
  source_url on the next dedupe-matched touch — but rows that never
  receive another matching ingest stay at sources=[].
- Result on the live DB: 435/436 rows still have empty sources; only
  freshly-inserted rows carry data.

This script writes the bootstrap entry directly. The entry shape matches
_build_source_entry() exactly: {name, url, agency_id, first_seen_at}.

Modes
-----
--dry-run    Default. Reports the candidate count without writing.
--apply      Performs the UPDATE. Idempotent: only touches rows where
             sources IS NULL OR jsonb_array_length(sources) = 0.

Safety rails
------------
- Refuses to run without DATABASE_URL.
- Hard-cap on rows updated per invocation via --limit (default 5000).
- Single transaction; rollback on any error.
- Never modifies rows that already have a non-empty sources array.

Run from repo root:
  python scripts/backfill_incident_sources.py
  python scripts/backfill_incident_sources.py --apply
  python scripts/backfill_incident_sources.py --apply --limit 1000
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from app.db.session import get_session_factory, has_database


_COUNT_SQL = """
SELECT COUNT(*)
FROM incidents
WHERE sources IS NULL OR jsonb_array_length(sources) = 0
"""

# Build one-element JSONB array from existing scalar columns. Column shape
# must match app/services/incident_repository.py:_build_source_entry().
# COALESCE keeps the entry valid even when source_url or
# responding_agency_id is null.
_BACKFILL_SQL = """
WITH candidates AS (
    SELECT id
    FROM incidents
    WHERE sources IS NULL OR jsonb_array_length(sources) = 0
    LIMIT :lim
)
UPDATE incidents AS i
SET sources = jsonb_build_array(
    jsonb_build_object(
        'name', COALESCE(i.source_name, ''),
        'url', COALESCE(i.source_url, ''),
        'agency_id', i.responding_agency_id,
        'first_seen_at', COALESCE(
            to_char(i.created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            ''
        )
    )
)
FROM candidates
WHERE i.id = candidates.id
RETURNING i.id
"""


async def run(*, apply: bool, limit: int) -> int:
    if not has_database():
        print("ERROR: DATABASE_URL not set; refusing to run.", file=sys.stderr)
        return 2

    sf = get_session_factory()
    if sf is None:
        print("ERROR: no session factory available; check DB readiness.",
              file=sys.stderr)
        return 2

    async with sf() as session:
        r = await session.execute(text(_COUNT_SQL))
        candidate_count = int(r.scalar() or 0)

        print(f"Empty-sources rows: {candidate_count}")
        if candidate_count == 0:
            print("Nothing to backfill.")
            return 0

        print(f"Limit per run: {limit}")
        will_touch = min(candidate_count, limit)
        print(f"Would update: {will_touch} row(s)")

        if not apply:
            print("\nDry-run only. No writes performed. Re-run with --apply.")
            return 0

        # Single transaction.
        try:
            r = await session.execute(text(_BACKFILL_SQL), {"lim": limit})
            updated_ids = [row[0] for row in r.fetchall()]
            await session.commit()
        except Exception as exc:
            await session.rollback()
            print(f"ERROR during update; rolled back: {exc}", file=sys.stderr)
            return 3

        print(f"\nUpdated {len(updated_ids)} row(s).")
        # Confirm post-state.
        r = await session.execute(text(_COUNT_SQL))
        remaining = int(r.scalar() or 0)
        print(f"Remaining empty-sources rows after this run: {remaining}")
        if remaining > 0:
            print(f"Re-run with --apply to continue (cap is {limit}/run).")
        return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description="Backfill incidents.sources for rows persisted before "
                    "the multi-source persistence pass."
    )
    g = p.add_mutually_exclusive_group()
    g.add_argument("--dry-run", dest="apply", action="store_false",
                   help="(default) Count candidates; do not write.")
    g.add_argument("--apply", dest="apply", action="store_true",
                   help="Perform the UPDATE.")
    p.set_defaults(apply=False)
    p.add_argument("--limit", type=int, default=5000,
                   help="Max rows to update per invocation (default 5000).")
    args = p.parse_args()
    return asyncio.run(run(apply=args.apply, limit=args.limit))


if __name__ == "__main__":
    raise SystemExit(main())
