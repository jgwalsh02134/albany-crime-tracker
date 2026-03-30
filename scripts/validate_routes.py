#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_server import app


CRITICAL_ROUTES = [
    "/health",
    "/ready",
    "/api/situation",
    "/api/sources",
]


async def main() -> int:
    failures = 0
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=20.0) as client:
        for route in CRITICAL_ROUTES:
            try:
                resp = await client.get(route)
                ok = resp.status_code == 200
                print(f"{route}: {resp.status_code}")
                if not ok:
                    failures += 1
            except Exception as exc:
                print(f"{route}: ERROR {exc}")
                failures += 1
    if failures:
        print(f"\nValidation failed: {failures} route(s) did not pass.")
        return 1
    print("\nValidation passed for all critical routes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

