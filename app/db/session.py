from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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
_last_db_error: str = ""


def _normalize_database_url(url: str) -> str:
    value = (url or "").strip()
    if value.startswith("postgres://"):
        value = "postgresql+asyncpg://" + value[len("postgres://") :]
    if value.startswith("postgresql://"):
        value = "postgresql+asyncpg://" + value[len("postgresql://") :]
    if value.startswith("postgresql+asyncpg://"):
        try:
            parsed = urlsplit(value)
            q = dict(parse_qsl(parsed.query, keep_blank_values=True))
            if "sslmode" in q and "ssl" not in q:
                sslmode = (q.pop("sslmode") or "").lower()
                if sslmode in ("require", "verify-full", "verify-ca"):
                    q["ssl"] = "require"
                elif sslmode in ("disable", "allow", "prefer"):
                    q["ssl"] = "disable"
            if q:
                return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(q), parsed.fragment))
        except Exception:
            return value
    return value


def _database_url() -> str:
    return _normalize_database_url(get_settings().database_url)


def has_database() -> bool:
    return bool(_database_url())


def get_engine() -> Optional[AsyncEngine]:
    global _engine, _session_factory, _last_db_error
    db_url = _database_url()
    if not db_url:
        return None
    if _engine is None:
        try:
            _engine = create_async_engine(
                db_url,
                pool_pre_ping=True,
                pool_recycle=1800,
                future=True,
            )
            _session_factory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)
            _last_db_error = ""
        except Exception as exc:
            _last_db_error = f"{type(exc).__name__}: {exc}"
            logger.warning("database engine init failed: %s", exc)
            _engine = None
            _session_factory = None
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
    global _last_db_error
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        _last_db_error = ""
        return True
    except Exception as exc:
        _last_db_error = f"{type(exc).__name__}: {exc}"
        logger.warning("database init failed: %s", exc)
        return False


async def close_database() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None


async def database_ready() -> bool:
    global _last_db_error
    engine = get_engine()
    if engine is None:
        return False
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        _last_db_error = ""
        return True
    except Exception as exc:
        _last_db_error = f"{type(exc).__name__}: {exc}"
        logger.warning("database readiness failed: %s", exc)
        return False


def last_database_error() -> str:
    return _last_db_error

