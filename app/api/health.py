from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter

from app.core.config import get_settings
from app.db.session import database_ready
from app.db.session import database_target_info
from app.db.session import has_database
from app.db.session import last_database_error
from app.services.cache import redis_last_error, redis_ready, redis_target_info
from sources.albany_open_data import socrata_runtime_status

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": get_settings().app_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/ready")
async def readiness() -> dict[str, object]:
    settings = get_settings()
    db_required = has_database()
    db_ok = (await database_ready()) if db_required else False
    db_err = last_database_error() if db_required else ""
    redis_required = bool(settings.redis_url)
    redis_ok = redis_ready(settings.redis_url) if redis_required else False
    redis_err = redis_last_error(settings.redis_url) if redis_required else ""
    soc = socrata_runtime_status()
    soc_datasets = soc.get("datasets") if isinstance(soc, dict) else []
    soc_errors = [
        str(d.get("last_error") or "")
        for d in (soc_datasets or [])
        if isinstance(d, dict) and str(d.get("source_status") or "") not in ("live", "fallback")
    ]
    soc_ok = bool(soc.get("configured")) and isinstance(soc_datasets, list) and all(
        str(d.get("source_status") or "") in ("live", "fallback") for d in soc_datasets if isinstance(d, dict)
    )
    ready = (db_ok if db_required else True) and (redis_ok if redis_required else True)
    return {
        "status": "ready" if ready else "degraded",
        "service": settings.app_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": {
            "database": {"configured": db_required, "ok": db_ok, "error": db_err},
            "redis": {"configured": redis_required, "ok": redis_ok, "error": redis_err},
            "socrata": {"configured": bool(soc.get("configured")), "ok": soc_ok, "error": "; ".join(soc_errors)},
        },
        "targets": {
            "database": database_target_info() if db_required else {"scheme": "", "hostname": "", "port": None, "database": ""},
            "redis": redis_target_info(settings.redis_url) if redis_required else {"scheme": "", "hostname": "", "port": None, "database": ""},
            "socrata": {"domain": "data.albanyny.gov", "datasets": soc_datasets},
        },
    }

