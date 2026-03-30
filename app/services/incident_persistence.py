from __future__ import annotations

import logging
from typing import Any

from app.services.incident_repository import upsert_incidents
from app.services.incident_transformers import article_to_incident

logger = logging.getLogger(__name__)


async def persist_articles_as_incidents(rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    records = []
    payloads = []
    for row in rows:
        try:
            records.append(article_to_incident(row))
            payloads.append(row)
        except Exception as exc:
            logger.warning("incident transform failed: %s", exc)
    if not records:
        return 0
    try:
        return await upsert_incidents(records, payloads)
    except Exception as exc:
        logger.warning("incident persistence failed: %s", exc)
        return 0

