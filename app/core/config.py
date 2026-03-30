from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional
from dotenv import load_dotenv

load_dotenv()


def _extract_url_like(value: str, prefixes: tuple[str, ...]) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    low = raw.lower()
    for prefix in prefixes:
        idx = low.find(prefix)
        if idx >= 0:
            return raw[idx:].strip()
    return raw


def _as_bool(value: Optional[str], *, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _as_float(value: Optional[str], *, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    # Runtime
    environment: str
    log_level: str
    app_name: str
    app_version: str

    # External keys / integrations
    xai_api_key: str
    fbi_api_key: str
    socrata_app_token: str
    database_url: str
    redis_url: str
    mapbox_token: str
    google_maps_api_key: str
    sentry_dsn: str
    posthog_key: str
    openrouter_api_key: str
    openai_api_key: str
    ny_511_api_key: str

    # HTTP controls
    external_timeout_seconds: float
    external_retry_attempts: int

    # Feature flags
    enable_ai_chat: bool
    enable_scanner: bool
    enable_live_feed: bool
    enable_directory: bool
    enable_map: bool


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        environment=os.getenv("ENVIRONMENT", "development"),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        app_name=os.getenv("APP_NAME", "Albany Crime Tracker"),
        app_version=os.getenv("APP_VERSION", "1.0.0"),
        xai_api_key=(os.getenv("XAI_API_KEY") or "").strip(),
        fbi_api_key=(os.getenv("FBI_API_KEY") or "").strip(),
        socrata_app_token=(os.getenv("SOCRATA_APP_TOKEN") or "").strip(),
        database_url=_extract_url_like(
            os.getenv("DATABASE_URL") or "",
            ("postgres://", "postgresql://"),
        ),
        redis_url=_extract_url_like(
            os.getenv("REDIS_URL") or "",
            ("rediss://", "redis://"),
        ),
        mapbox_token=(os.getenv("MAPBOX_TOKEN") or "").strip(),
        google_maps_api_key=(os.getenv("GOOGLE_MAPS_API_KEY") or "").strip(),
        sentry_dsn=(os.getenv("SENTRY_DSN") or "").strip(),
        posthog_key=(os.getenv("POSTHOG_KEY") or "").strip(),
        openrouter_api_key=(os.getenv("OPENROUTER_API_KEY") or "").strip(),
        openai_api_key=(os.getenv("OPENAI_API_KEY") or "").strip(),
        ny_511_api_key=(os.getenv("511_NY_API_KEY") or "").strip(),
        external_timeout_seconds=_as_float(os.getenv("EXTERNAL_TIMEOUT_SECONDS"), default=20.0),
        external_retry_attempts=max(1, int(os.getenv("EXTERNAL_RETRY_ATTEMPTS", "3"))),
        enable_ai_chat=_as_bool(os.getenv("FEATURE_AI_CHAT"), default=True),
        enable_scanner=_as_bool(os.getenv("FEATURE_SCANNER"), default=True),
        enable_live_feed=_as_bool(os.getenv("FEATURE_LIVE_FEED"), default=True),
        enable_directory=_as_bool(os.getenv("FEATURE_DIRECTORY"), default=True),
        enable_map=_as_bool(os.getenv("FEATURE_MAP"), default=True),
    )

