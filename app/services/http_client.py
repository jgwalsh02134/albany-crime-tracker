from __future__ import annotations

import asyncio
from typing import Any
from typing import Optional

import httpx


RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


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
                await asyncio.sleep(retry_backoff_seconds * (2 ** attempt))
                continue
            return response
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
            if attempt < (attempts - 1):
                await asyncio.sleep(retry_backoff_seconds * (2 ** attempt))
                continue
            return None
    return None

