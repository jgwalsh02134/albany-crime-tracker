from __future__ import annotations

import asyncio
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

_engines_by_loop: dict[int, AsyncEngine] = {}
_session_factories_by_loop: dict[int, async_sessionmaker[AsyncSession]] = {}
_last_db_error: str = ""
_INCIDENTS_SCHEMA_HARDENING_SQL = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'incidents'
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'id'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN id TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'external_id'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN external_id TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'title'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN title TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'description'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN description TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'source_name'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN source_name TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'source_url'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN source_url TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'municipality'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN municipality TYPE TEXT;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'address_text'
              AND data_type <> 'text'
        ) THEN
            ALTER TABLE incidents ALTER COLUMN address_text TYPE TEXT;
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'incidents'
              AND column_name = 'provenance'
        ) THEN
            ALTER TABLE incidents ADD COLUMN provenance JSONB DEFAULT '{}';
        END IF;
    END IF;
END $$;
"""


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


def database_target_info() -> dict[str, object]:
    db_url = _database_url()
    if not db_url:
        return {
            "scheme": "",
            "hostname": "",
            "port": None,
            "database": "",
        }
    try:
        parsed = urlsplit(db_url)
        db_name = (parsed.path or "").lstrip("/")
        return {
            "scheme": parsed.scheme or "",
            "hostname": parsed.hostname or "",
            "port": parsed.port,
            "database": db_name,
        }
    except Exception:
        return {
            "scheme": "",
            "hostname": "",
            "port": None,
            "database": "",
        }


def has_database() -> bool:
    return bool(_database_url())


def _active_loop_id() -> Optional[int]:
    try:
        return id(asyncio.get_running_loop())
    except RuntimeError:
        return None


def get_engine() -> Optional[AsyncEngine]:
    global _last_db_error
    db_url = _database_url()
    if not db_url:
        return None
    loop_id = _active_loop_id()
    if loop_id is None:
        _last_db_error = "RuntimeError: no running event loop for async database engine"
        return None
    engine = _engines_by_loop.get(loop_id)
    if engine is None:
        try:
            engine = create_async_engine(
                db_url,
                pool_pre_ping=True,
                pool_recycle=1800,
                future=True,
            )
            _engines_by_loop[loop_id] = engine
            _session_factories_by_loop[loop_id] = async_sessionmaker(
                engine, expire_on_commit=False, class_=AsyncSession
            )
            _last_db_error = ""
        except Exception as exc:
            _last_db_error = f"{type(exc).__name__}: {exc}"
            logger.warning("database engine init failed: %s", exc)
            _engines_by_loop.pop(loop_id, None)
            _session_factories_by_loop.pop(loop_id, None)
            return None
    return engine


def get_session_factory() -> Optional[async_sessionmaker[AsyncSession]]:
    if not has_database():
        return None
    loop_id = _active_loop_id()
    if loop_id is None:
        return None
    session_factory = _session_factories_by_loop.get(loop_id)
    if session_factory is None:
        engine = get_engine()
        if engine is None:
            return None
        session_factory = _session_factories_by_loop.get(loop_id)
    return session_factory


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
            await conn.execute(text(_INCIDENTS_SCHEMA_HARDENING_SQL))
        _last_db_error = ""
        return True
    except Exception as exc:
        _last_db_error = f"{type(exc).__name__}: {exc}"
        logger.warning("database init failed: %s", exc)
        return False


async def close_database() -> None:
    engines = list(_engines_by_loop.values())
    _engines_by_loop.clear()
    _session_factories_by_loop.clear()
    for engine in engines:
        try:
            await engine.dispose()
        except Exception as exc:
            logger.warning("database dispose failed: %s", exc)


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

