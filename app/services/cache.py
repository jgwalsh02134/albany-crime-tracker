from __future__ import annotations

import asyncio
import time
from typing import Any
from typing import Callable
from typing import Optional


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
    "grok_official_x_posts": 90,
    "nitter_official_x": 180,
    "scanner_talkgroups": 3600,
    "scanner_calls": 12,
}


class CacheBackend:
    def get(self, key: str) -> Any:
        raise NotImplementedError

    def set(self, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
        raise NotImplementedError


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


class RefreshGuard:
    """Prevents duplicate simultaneous expensive refreshes."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def run_once(self, key: str, coro_factory: Callable[[], Any]):
        lock = self._lock(key)
        async with lock:
            return await coro_factory()

