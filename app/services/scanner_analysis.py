from __future__ import annotations

import json
import logging
from typing import Any
from typing import Literal
from typing import Optional

from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import ValidationError

from app.core.config import get_settings

logger = logging.getLogger(__name__)

PROMPT_ID = "pmpt_69cff9fb80d481969d7d80f50b5e983f096668912811ec3b"
PROMPT_VERSION = "1"

_client: Optional[AsyncOpenAI] = None


class ScannerIncidentCandidate(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str = ""
    summary: str = ""
    incident_type: str = ""
    severity: str = ""
    municipality: str = ""
    location_hint: str = ""
    tags: list[str] = Field(default_factory=list)


class ScannerUiSurface(BaseModel):
    model_config = ConfigDict(extra="allow")

    headline: str = ""
    badge: str = ""
    priority: str = ""


class ScannerTranscriptAnalysis(BaseModel):
    model_config = ConfigDict(extra="allow")

    summary: str = ""
    alert_level: Literal["none", "medium", "high", "critical"] = "none"
    keywords: list[str] = Field(default_factory=list)
    incident_candidate: Optional[ScannerIncidentCandidate] = None
    ui: Optional[ScannerUiSurface] = None
    raw: dict[str, Any] = Field(default_factory=dict)
    prompt_id: str = PROMPT_ID
    prompt_version: str = PROMPT_VERSION


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        settings = get_settings()
        _client = AsyncOpenAI(
            api_key=settings.openai_api_key,
            timeout=settings.external_timeout_seconds,
            max_retries=settings.external_retry_attempts,
        )
    return _client


def _first_str(payload: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if isinstance(item, str):
                item_s = item.strip()
                if item_s and item_s not in out:
                    out.append(item_s)
            elif isinstance(item, dict):
                text = _first_str(item, ["keyword", "value", "name", "label"])
                if text and text not in out:
                    out.append(text)
        return out
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _normalize_alert_level(raw_level: Any) -> str:
    value = str(raw_level or "").strip().lower()
    if value in {"none", "medium", "high", "critical"}:
        return value
    if value in {"low", "normal", "minor"}:
        return "medium"
    if value in {"urgent", "severe"}:
        return "high"
    return "none"


def _extract_output_text(response: Any) -> str:
    direct = getattr(response, "output_text", None)
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    try:
        payload = response.model_dump()
    except Exception:
        payload = {}
    output = payload.get("output") if isinstance(payload, dict) else None
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            if content.get("type") == "output_text":
                text = str(content.get("text") or "").strip()
                if text:
                    parts.append(text)
    return "\n".join(parts).strip()


def _strip_json_fences(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    return cleaned


def _normalize_analysis_payload(raw: dict[str, Any]) -> ScannerTranscriptAnalysis:
    incident_candidate_raw = raw.get("incident_candidate")
    if not isinstance(incident_candidate_raw, dict):
        maybe_candidate = {
            "title": _first_str(raw, ["incident_title", "title", "headline"]),
            "summary": _first_str(raw, ["incident_summary", "summary"]),
            "incident_type": _first_str(raw, ["incident_type", "call_type", "event_type"]),
            "severity": _first_str(raw, ["severity"]),
            "municipality": _first_str(raw, ["municipality", "municipality_hint"]),
            "location_hint": _first_str(raw, ["location_hint", "location", "address_hint"]),
            "tags": _string_list(raw.get("tags")),
        }
        incident_candidate_raw = {k: v for k, v in maybe_candidate.items() if v}

    ui_raw = raw.get("ui")
    if not isinstance(ui_raw, dict):
        maybe_ui = {
            "headline": _first_str(raw, ["ui_headline", "headline", "title"]),
            "badge": _first_str(raw, ["ui_badge", "badge"]),
            "priority": _first_str(raw, ["ui_priority", "priority"]),
        }
        ui_raw = {k: v for k, v in maybe_ui.items() if v}

    alert_raw = raw.get("alert_level")
    if not alert_raw and isinstance(raw.get("alert"), dict):
        alert_raw = raw.get("alert", {}).get("level")
    if not alert_raw:
        alert_raw = raw.get("priority")

    normalized = {
        "summary": _first_str(raw, ["summary", "incident_summary", "headline", "title"]),
        "alert_level": _normalize_alert_level(alert_raw),
        "keywords": _string_list(raw.get("keywords") or raw.get("tags") or raw.get("signals")),
        "incident_candidate": incident_candidate_raw or None,
        "ui": ui_raw or None,
        "raw": raw,
    }
    return ScannerTranscriptAnalysis.model_validate(normalized)


async def analyze_scanner_transcript(
    *,
    transcript: str,
    channel_name: str,
    source_name: str,
    timestamp: str,
    municipality_hint: str,
    local_reference_context: str,
) -> Optional[dict[str, Any]]:
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    if not (transcript or "").strip():
        return None

    try:
        response = await _get_client().responses.create(
            prompt={
                "id": PROMPT_ID,
                "version": PROMPT_VERSION,
                "variables": {
                    "transcript": transcript,
                    "channel_name": channel_name,
                    "source_name": source_name,
                    "timestamp": timestamp,
                    "municipality_hint": municipality_hint,
                    "local_reference_context": local_reference_context,
                },
            }
        )
    except Exception as exc:
        logger.warning(
            "scanner_prompt_request_failed source_name=%s channel_name=%s error=%s type=%s",
            source_name[:120],
            channel_name[:120],
            str(exc)[:500],
            type(exc).__name__,
        )
        return None

    output_text = _strip_json_fences(_extract_output_text(response))
    if not output_text:
        logger.warning(
            "scanner_prompt_invalid_output source_name=%s channel_name=%s reason=empty_output_text",
            source_name[:120],
            channel_name[:120],
        )
        return None

    try:
        raw = json.loads(output_text)
    except json.JSONDecodeError as exc:
        logger.warning(
            "scanner_prompt_invalid_output source_name=%s channel_name=%s reason=json_decode_error error=%s snippet=%s",
            source_name[:120],
            channel_name[:120],
            str(exc)[:240],
            output_text[:500],
        )
        return None

    if not isinstance(raw, dict):
        logger.warning(
            "scanner_prompt_invalid_output source_name=%s channel_name=%s reason=non_object_json type=%s",
            source_name[:120],
            channel_name[:120],
            type(raw).__name__,
        )
        return None

    try:
        normalized = _normalize_analysis_payload(raw)
    except ValidationError as exc:
        logger.warning(
            "scanner_prompt_invalid_output source_name=%s channel_name=%s reason=validation_error error=%s snippet=%s",
            source_name[:120],
            channel_name[:120],
            str(exc)[:500],
            output_text[:500],
        )
        return None

    return normalized.model_dump()
