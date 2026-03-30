from __future__ import annotations

import asyncio
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from typing import Any
from typing import Optional

import httpx


RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def _retry_after_seconds(response: httpx.Response) -> Optional[float]:
    value = response.headers.get("Retry-After")
    if not value:
        return None
    raw = value.strip()
    try:
        sec = float(raw)
        return max(0.0, sec)
    except Exception:
        pass
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return max(0.0, (dt - now).total_seconds())
    except Exception:
        return None


async def fetch_with_retry(
    client: httpx.AsyncClient,
    url: str,
    *,
    method: str = "GET",
    retries: int = 3,
    timeout: float = 20.0,
    retry_backoff_seconds: float = 0.4,
    **kwargs: Any,
) -> Optional[httpx.Response]:
    attempts = max(1, retries)
    for attempt in range(attempts):
        try:
            response = await client.request(method, url, timeout=timeout, **kwargs)
            if response.status_code in RETRYABLE_STATUS_CODES and attempt < (attempts - 1):
                retry_after = _retry_after_seconds(response)
                sleep_for = retry_after if retry_after is not None else (retry_backoff_seconds * (2 ** attempt))
                await asyncio.sleep(max(0.05, sleep_for))
                continue
            return response
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
            if attempt < (attempts - 1):
                await asyncio.sleep(retry_backoff_seconds * (2 ** attempt))
                continue
            return None
    return None

