from __future__ import annotations

import logging
from typing import Any

from app.services.incident_repository import upsert_incidents
from app.services.incident_transformers import article_to_incident

logger = logging.getLogger(__name__)


async def persist_articles_as_incidents(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {
            "inserted": 0,
            "updated": 0,
            "skipped_as_duplicate": 0,
            "processed": 0,
            "backend": "memory",
        }
    records = []
    payloads = []
    for row in rows:
        try:
            records.append(article_to_incident(row))
            payloads.append(row)
        except Exception as exc:
            logger.warning("incident transform failed: %s", exc)
    if not records:
        return {
            "inserted": 0,
            "updated": 0,
            "skipped_as_duplicate": 0,
            "processed": 0,
            "backend": "memory",
        }
    try:
        stats = await upsert_incidents(records, payloads)
        logger.info(
            "incident_persistence inserted=%s updated=%s skipped_as_duplicate=%s processed=%s backend=%s",
            stats.get("inserted", 0),
            stats.get("updated", 0),
            stats.get("skipped_as_duplicate", 0),
            stats.get("processed", 0),
            stats.get("backend", "memory"),
        )
        return stats
    except Exception as exc:
        logger.warning("incident persistence failed: %s", exc)
        return {
            "inserted": 0,
            "updated": 0,
            "skipped_as_duplicate": 0,
            "processed": len(records),
            "backend": "memory",
        }

