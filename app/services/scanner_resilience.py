"""
Scanner Source Resilience Layer

Handles cases when OpenMHz returns 403 or other sources fail.
"""

import asyncio
from typing import List, Dict, Any

async def safe_scanner_ingest(primary_fetcher, fallback_fetchers: List, max_retries: int = 2):
    """
    Try primary source (OpenMHz), fall back to others if it fails.
    """
    for attempt in range(max_retries):
        try:
            result = await primary_fetcher()
            if result:
                return result
        except Exception as e:
            print(f"Primary scanner source failed (attempt {attempt+1}): {e}")

    # Fallbacks
    for fetcher in fallback_fetchers:
        try:
            result = await fetcher()
            if result:
                return result
        except Exception as e:
            print(f"Fallback scanner source failed: {e}")

    return []  # All sources failed
