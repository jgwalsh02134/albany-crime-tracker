from __future__ import annotations

import asyncio
import time
from typing import Any
from typing import Callable
from typing import Optional
from urllib.parse import parse_qs, urlsplit, urlunsplit
from uuid import uuid4

try:
    import redis
except Exception:  # pragma: no cover
    redis = None


DEFAULT_TTLS: dict[str, int] = {
    "merged_news": 60,
    "crime_articles": 30,
    "crime_articles_v3": 60,
    "dcjs_trends": 3600,
    "ai_summaries": 600,
    "patterns": 60,
    "monthly_summary": 1800,
    "daily_summary": 600,
    "social_intel": 900,
    "social_intel_v2": 900,
    "grok_official_x_posts_v2": 90,
    "nitter_official_x_v2": 180,
    "official_x_combined_v2": 120,
    "scanner_talkgroups": 3600,
    "scanner_calls": 12,
    "incidents_query": 45,
}


class CacheBackend:
    def get(self, key: str) -> Any:
        raise NotImplementedError

    def set(self, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
        raise NotImplementedError

    def is_ready(self) -> bool:
        return True


class InMemoryTTLCache(CacheBackend):
    def __init__(self, default_ttls: Optional[dict[str, int]] = None) -> None:
        self._store: dict[str, dict[str, Any]] = {}
        self._ttls = default_ttls or {}

    def get(self, key: str) -> Any:
        entry = self._store.get(key)
        if not entry:
            return None
        ttl_seconds = entry.get("ttl_seconds")
        if ttl_seconds is None:
            return entry.get("value")
        if time.time() - float(entry.get("ts", 0)) < ttl_seconds:
            return entry.get("value")
        self._store.pop(key, None)
        return None

    def set(self, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
        ttl = ttl_seconds if ttl_seconds is not None else self._ttls.get(key, 300)
        self._store[key] = {"value": value, "ts": time.time(), "ttl_seconds": ttl}


class RedisCache(CacheBackend):
    def __init__(self, redis_url: str, default_ttls: Optional[dict[str, int]] = None) -> None:
        if redis is None:
            raise RuntimeError("redis package is unavailable")
        normalized_url = normalize_redis_url(redis_url)
        self._client = redis.Redis.from_url(normalized_url, **_redis_client_kwargs())
        self._ttls = default_ttls or {}

    def get(self, key: str) -> Any:
        try:
            raw = self._client.get(key)
            if raw is None:
                return None
            import json

            return json.loads(raw)
        except Exception:
            return None

    def set(self, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
        import json

        ttl = ttl_seconds if ttl_seconds is not None else self._ttls.get(key, 300)
        try:
            self._client.setex(key, ttl, json.dumps(value, default=str))
        except Exception:
            # Graceful failure; caller should continue.
            return

    def is_ready(self) -> bool:
        try:
            return bool(self._client.ping())
        except Exception:
            return False

    def acquire_lock(self, key: str, lock_ttl_seconds: int = 90) -> Optional[str]:
        token = uuid4().hex
        lock_key = f"lock:{key}"
        try:
            ok = self._client.set(lock_key, token, nx=True, ex=lock_ttl_seconds)
            return token if ok else None
        except Exception:
            return None

    def release_lock(self, key: str, token: str) -> None:
        lock_key = f"lock:{key}"
        try:
            cur = self._client.get(lock_key)
            if cur == token:
                self._client.delete(lock_key)
        except Exception:
            return


class RefreshGuard:
    """Prevents duplicate simultaneous expensive refreshes (local + optional Redis lock)."""

    def __init__(self, redis_cache: Optional[RedisCache] = None) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._redis_cache = redis_cache

    def _lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def run_once(self, key: str, coro_factory: Callable[[], Any]):
        lock = self._lock(key)
        redis_token: Optional[str] = None
        if self._redis_cache is not None:
            redis_token = self._redis_cache.acquire_lock(key)
            if redis_token is None:
                # Another worker is refreshing; allow caller to proceed without duplicate refresh work.
                await asyncio.sleep(0.15)
                return await coro_factory()
        try:
            async with lock:
                return await coro_factory()
        finally:
            if self._redis_cache is not None and redis_token:
                self._redis_cache.release_lock(key, redis_token)


def create_cache_backend(redis_url: str, default_ttls: Optional[dict[str, int]] = None) -> CacheBackend:
    if redis_url:
        try:
            rc = RedisCache(normalize_redis_url(redis_url), default_ttls=default_ttls)
            if rc.is_ready():
                return rc
        except Exception:
            pass
    return InMemoryTTLCache(default_ttls)


def create_refresh_guard(redis_url: str) -> RefreshGuard:
    if redis_url:
        try:
            rc = RedisCache(normalize_redis_url(redis_url))
            if rc.is_ready():
                return RefreshGuard(redis_cache=rc)
        except Exception:
            pass
    return RefreshGuard()


def redis_ready(redis_url: str) -> bool:
    if not redis_url or redis is None:
        return False
    try:
        normalized = normalize_redis_url(redis_url)
        return bool(redis.Redis.from_url(normalized, **_redis_client_kwargs()).ping())
    except Exception:
        return False


def redis_last_error(redis_url: str) -> str:
    if not redis_url:
        return ""
    if redis is None:
        return "redis package unavailable"
    try:
        normalized = normalize_redis_url(redis_url)
        client = redis.Redis.from_url(normalized, **_redis_client_kwargs())
        client.ping()
        return ""
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def normalize_redis_url(redis_url: str) -> str:
    value = (redis_url or "").strip()
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        scheme = (parsed.scheme or "").lower()
        host = (parsed.hostname or "").lower()
        q = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
        wants_tls = q.get("ssl", [""])[0].lower() in ("1", "true", "yes", "required")
        if scheme == "redis" and (host.endswith("upstash.io") or wants_tls):
            return urlunsplit(("rediss", parsed.netloc, parsed.path, parsed.query, parsed.fragment))
        return value
    except Exception:
        return value


def _redis_client_kwargs() -> dict[str, Any]:
    return {"decode_responses": True}


def redis_target_info(redis_url: str) -> dict[str, object]:
    normalized = normalize_redis_url(redis_url)
    if not normalized:
        return {
            "scheme": "",
            "hostname": "",
            "port": None,
            "database": "",
        }
    try:
        parsed = urlsplit(normalized)
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

