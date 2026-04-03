from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv


API_BASE = "https://api.broadcastify.com"
DEFAULT_SYSTEM_ID = "8553"  # Albany County P25 system used elsewhere in the repo
DEFAULT_LIMIT = 5


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _load_env() -> dict[str, str]:
    load_dotenv(_repo_root() / ".env")
    return {
        "broadcastify_api_key": (os.getenv("BROADCASTIFY_API_KEY") or "").strip(),
        "radioreference_username": (os.getenv("RADIOREFERENCE_USERNAME") or "").strip(),
        "radioreference_password": (os.getenv("RADIOREFERENCE_PASSWORD") or "").strip(),
        "broadcastify_system_id": (os.getenv("BROADCASTIFY_SYSTEM_ID") or DEFAULT_SYSTEM_ID).strip() or DEFAULT_SYSTEM_ID,
        "broadcastify_playlist_uuid": (os.getenv("BROADCASTIFY_PLAYLIST_UUID") or "").strip(),
        "radioreference_api_key": (os.getenv("RADIOREFERENCE_API_KEY") or "").strip(),
    }


def _safe_error_text(response: httpx.Response) -> str:
    text = (response.text or "").strip()
    if not text:
        return "(empty response body)"
    return text[:2000]


def _normalize_audio_url(call: dict[str, Any]) -> str:
    audio = str(
        call.get("audioUrl")
        or call.get("audio_url")
        or call.get("url")
        or call.get("filename")
        or ""
    ).strip()
    if audio and not audio.startswith("http"):
        return f"https://calls.broadcastify.com/{audio.lstrip('/')}"
    return audio


def _extract_calls(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        raw = payload.get("calls")
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
    return []


def _print_calls(calls: list[dict[str, Any]]) -> None:
    print(f"Success: fetched {min(len(calls), DEFAULT_LIMIT)} recent calls")
    for idx, call in enumerate(calls[:DEFAULT_LIMIT], start=1):
        talkgroup = str(call.get("talkgroupID") or call.get("talkgroup") or call.get("tg") or "")
        timestamp = str(call.get("startTime") or call.get("start_time") or call.get("time") or call.get("ts") or "")
        audio_url = _normalize_audio_url(call)
        print(f"{idx}. Talkgroup ID: {talkgroup or '(missing)'}")
        print(f"   Timestamp: {timestamp or '(missing)'}")
        print(f"   MP3 URL: {audio_url or '(missing)'}")


def _request_recent_calls(
    client: httpx.Client,
    *,
    system_id: str,
    api_key: str = "",
    username: str = "",
    password: str = "",
    extra_headers: dict[str, str] | None = None,
) -> httpx.Response:
    params = {"type": "json", "num": str(DEFAULT_LIMIT)}
    if api_key:
        params["apiKey"] = api_key
    auth = httpx.BasicAuth(username, password) if username and password else None
    return client.get(
        f"{API_BASE}/calls/node/{system_id}",
        params=params,
        auth=auth,
        headers=extra_headers or {},
    )


def main() -> int:
    env = _load_env()
    system_id = env["broadcastify_system_id"]
    api_key = env["broadcastify_api_key"] or env["radioreference_api_key"]
    username = env["radioreference_username"]
    password = env["radioreference_password"]

    attempts: list[tuple[str, dict[str, str], dict[str, str], tuple[str, str] | None]] = []
    if api_key:
        attempts.append(
            (
                "apiKey query param",
                {"apiKey": api_key, "type": "json", "num": str(DEFAULT_LIMIT)},
                {},
                None,
            )
        )
    if username and password:
        attempts.append(
            (
                "HTTP Basic Auth",
                {"type": "json", "num": str(DEFAULT_LIMIT)},
                {},
                (username, password),
            )
        )
    if api_key and username and password:
        attempts.append(
            (
                "apiKey + HTTP Basic Auth",
                {"apiKey": api_key, "type": "json", "num": str(DEFAULT_LIMIT)},
                {},
                (username, password),
            )
        )

    if not attempts:
        print(
            "Failure: no Broadcastify/RR credentials found. "
            "Set BROADCASTIFY_API_KEY and/or RADIOREFERENCE_USERNAME/RADIOREFERENCE_PASSWORD in .env."
        )
        return 1

    endpoint = f"{API_BASE}/calls/node/{system_id}"
    print(f"Testing Broadcastify Calls API recent-call metadata at: {endpoint}")

    last_failure_summary = ""
    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        for label, params, headers, basic_auth in attempts:
            print(f"\nAttempting auth mode: {label}")
            try:
                auth = httpx.BasicAuth(*basic_auth) if basic_auth else None
                response = client.get(endpoint, params=params, headers=headers, auth=auth)
            except Exception as exc:
                last_failure_summary = f"{label}: request exception {type(exc).__name__}: {exc}"
                print(f"Failure: {last_failure_summary}")
                continue

            print(f"HTTP status: {response.status_code}")

            try:
                payload = response.json()
            except json.JSONDecodeError:
                payload = None

            calls = _extract_calls(payload)
            if response.status_code == 200 and calls:
                _print_calls(calls)
                return 0

            error_text = _safe_error_text(response)
            last_failure_summary = (
                f"{label}: status={response.status_code} body={error_text}"
            )
            print(f"Failure: {last_failure_summary}")

    print("\nFinal result:")
    print(
        "Broadcastify Calls API request did not return recent call metadata. "
        "If the failure is authentication-related, you may need a dedicated Broadcastify Calls API key."
    )
    if last_failure_summary:
        print(f"Exact error: {last_failure_summary}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
