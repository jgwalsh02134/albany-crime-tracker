from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": get_settings().app_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/ready")
async def readiness() -> dict[str, str]:
    # TODO: include DB/Redis downstream checks once those integrations land.
    return {
        "status": "ready",
        "service": get_settings().app_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

