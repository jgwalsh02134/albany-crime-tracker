#!/usr/bin/env python3
"""Regression test: incident_store_backend() must reflect the live connection
state, not a lazy sentinel.

Prior bug: incident_store_backend() returned the global _LAST_QUERY_BACKEND,
which stays at its initial "memory" value until the first successful
query_incidents() postgres path runs. /api/sources/health reported "memory"
on Railway until the first /api/incidents read, despite a healthy Postgres
connection.

Fix: introspect get_session_factory() at call time.

Run: python scripts/test_store_backend_reporter.py
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.services.incident_repository as repo

passed = 0
failed = 0


def _report(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def _with_patched_factory(factory_returns):
    """Return a context manager that swaps repo.get_session_factory for a
    lambda that returns `factory_returns`, then restores the original."""
    class _Ctx:
        def __enter__(self):
            self._orig = repo.get_session_factory
            repo.get_session_factory = lambda: factory_returns
            return self
        def __exit__(self, *a):
            repo.get_session_factory = self._orig
    return _Ctx()


def test_returns_memory_when_no_session_factory() -> None:
    with _with_patched_factory(None):
        result = repo.incident_store_backend()
    _report(
        "memory_when_session_factory_is_none",
        result == "memory",
        f"got {result!r}",
    )


def test_returns_postgres_when_session_factory_present() -> None:
    sentinel_factory = object()
    with _with_patched_factory(sentinel_factory):
        result = repo.incident_store_backend()
    _report(
        "postgres_when_session_factory_present",
        result == "postgres",
        f"got {result!r}",
    )


def test_ignores_stale_lazy_sentinel() -> None:
    # The historical bug: _LAST_QUERY_BACKEND stays "memory" until a
    # successful DB read. Force the sentinel to "memory" and confirm the
    # reporter still returns "postgres" when a session factory exists.
    prev = repo._LAST_QUERY_BACKEND
    repo._LAST_QUERY_BACKEND = "memory"
    try:
        with _with_patched_factory(object()):
            result = repo.incident_store_backend()
        _report(
            "reporter_ignores_stale_memory_sentinel",
            result == "postgres",
            f"got {result!r}",
        )
        # And the inverse: stale "postgres" sentinel but no factory → "memory".
        repo._LAST_QUERY_BACKEND = "postgres"
        with _with_patched_factory(None):
            result2 = repo.incident_store_backend()
        _report(
            "reporter_ignores_stale_postgres_sentinel",
            result2 == "memory",
            f"got {result2!r}",
        )
    finally:
        repo._LAST_QUERY_BACKEND = prev


def test_handles_factory_exception() -> None:
    # If get_session_factory() raises, the reporter must fall back to
    # "memory" rather than propagate.
    def _boom():
        raise RuntimeError("synthetic loop error")
    orig = repo.get_session_factory
    repo.get_session_factory = _boom
    try:
        result = repo.incident_store_backend()
    finally:
        repo.get_session_factory = orig
    _report(
        "handles_factory_exception_gracefully",
        result == "memory",
        f"got {result!r}",
    )


def test_live_env_matches_session_factory_state() -> None:
    # Smoke test against whatever the current shell env provides. Either
    # DATABASE_URL is set (expect postgres) or it isn't (expect memory).
    # Either way, the reporter must agree with the live session factory.
    async def _check():
        sf = repo.get_session_factory()
        return sf, repo.incident_store_backend()
    sf, result = asyncio.run(_check())
    expected = "postgres" if sf is not None else "memory"
    _report(
        "live_env_matches_live_factory_state",
        result == expected,
        f"sf={'set' if sf is not None else 'None'} got={result!r}",
    )


def main() -> None:
    test_returns_memory_when_no_session_factory()
    test_returns_postgres_when_session_factory_present()
    test_ignores_stale_lazy_sentinel()
    test_handles_factory_exception()
    test_live_env_matches_session_factory_state()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
