from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import get_settings
from app.db.models import Base

logger = logging.getLogger(__name__)

_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None


def _normalize_database_url(url: str) -> str:
    value = (url or "").strip()
    if value.startswith("postgres://"):
        return "postgresql+asyncpg://" + value[len("postgres://") :]
    if value.startswith("postgresql://"):
        return "postgresql+asyncpg://" + value[len("postgresql://") :]
    return value


def _database_url() -> str:
    return _normalize_database_url(get_settings().database_url)


def has_database() -> bool:
    return bool(_database_url())


def get_engine() -> Optional[AsyncEngine]:
    global _engine, _session_factory
    db_url = _database_url()
    if not db_url:
        return None
    if _engine is None:
        _engine = create_async_engine(
            db_url,
            pool_pre_ping=True,
            pool_recycle=1800,
            future=True,
        )
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)
    return _engine


def get_session_factory() -> Optional[async_sessionmaker[AsyncSession]]:
    if not has_database():
        return None
    if _session_factory is None:
        get_engine()
    return _session_factory


async def init_database() -> bool:
    """
    Safe startup table creation path (replaceable by Alembic migrations later).
    """
    engine = get_engine()
    if engine is None:
        return False
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return True


async def close_database() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None


async def database_ready() -> bool:
    engine = get_engine()
    if engine is None:
        return False
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        logger.warning("database readiness failed: %s", exc)
        return False

