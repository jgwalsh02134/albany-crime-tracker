from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote
from urllib.parse import urlsplit
from urllib.parse import urlunsplit

from dotenv import load_dotenv


DEFAULT_STREAM_URL = "https://audio.broadcastify.com/3626.mp3"
DEFAULT_SEGMENT_SECONDS = 30
DEFAULT_RETRY_SECONDS = 5


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_stream_credentials() -> tuple[str, str]:
    load_dotenv(_repo_root() / ".env")
    username = (os.getenv("RADIOREFERENCE_USERNAME") or "").strip()
    password = (os.getenv("RADIOREFERENCE_PASSWORD") or "").strip()
    return username, password


def build_authenticated_url(stream_url: str, username: str, password: str) -> str:
    if not username or not password:
        return stream_url
    parsed = urlsplit(stream_url)
    host = parsed.hostname or ""
    if not host:
        return stream_url
    auth_user = quote(username, safe="")
    auth_pass = quote(password, safe="")
    netloc = f"{auth_user}:{auth_pass}@{host}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


def mask_url(stream_url: str) -> str:
    parsed = urlsplit(stream_url)
    host = parsed.hostname or ""
    if not host:
        return stream_url
    if parsed.username is None:
        return stream_url
    netloc = f"{parsed.username}:****@{host}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


def sanitize_output(text: str, username: str, password: str, authenticated_url: str) -> str:
    cleaned = text or ""
    if authenticated_url:
        cleaned = cleaned.replace(authenticated_url, mask_url(authenticated_url))
    if password:
        cleaned = cleaned.replace(password, "****")
        cleaned = cleaned.replace(quote(password, safe=""), "****")
    if username and password:
        cleaned = cleaned.replace(f"{username}:{password}", f"{username}:****")
        cleaned = cleaned.replace(
            f"{quote(username, safe='')}:{quote(password, safe='')}",
            f"{quote(username, safe='')}:****",
        )
    return cleaned


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Capture a live Broadcastify-style MP3 stream into 30-second local MP3 chunks."
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_STREAM_URL,
        help="Broadcastify MP3 stream URL to capture.",
    )
    parser.add_argument(
        "--out-dir",
        default="temp_audio",
        help="Directory where MP3 chunks will be written.",
    )
    parser.add_argument(
        "--segment-seconds",
        type=int,
        default=DEFAULT_SEGMENT_SECONDS,
        help="Length of each output MP3 chunk in seconds.",
    )
    parser.add_argument(
        "--retry-seconds",
        type=int,
        default=DEFAULT_RETRY_SECONDS,
        help="Delay before reconnecting after a stream failure.",
    )
    return parser


def ensure_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("Failure: ffmpeg is not installed or not on PATH.", file=sys.stderr)
        raise SystemExit(1)
    return ffmpeg


def ensure_output_dir(path_str: str) -> Path:
    out_dir = Path(path_str).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def ffmpeg_command(ffmpeg: str, stream_url: str, out_dir: Path, segment_seconds: int) -> list[str]:
    output_pattern = str(out_dir / "stream_%Y%m%dT%H%M%S.mp3")
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_at_eof",
        "1",
        "-reconnect_delay_max",
        "10",
        "-i",
        stream_url,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "copy",
        "-f",
        "segment",
        "-segment_time",
        str(segment_seconds),
        "-reset_timestamps",
        "1",
        "-strftime",
        "1",
        output_pattern,
    ]


def run_capture_loop(stream_url: str, out_dir: Path, segment_seconds: int, retry_seconds: int) -> int:
    ffmpeg = ensure_ffmpeg()
    username, password = load_stream_credentials()
    authenticated_url = build_authenticated_url(stream_url, username, password)
    display_url = mask_url(authenticated_url)
    attempt = 0
    while True:
        attempt += 1
        cmd = ffmpeg_command(ffmpeg, authenticated_url, out_dir, segment_seconds)
        print(
            f"Starting capture attempt {attempt}: "
            f"url={display_url} segment_seconds={segment_seconds} out_dir={out_dir}"
        )
        proc = subprocess.run(cmd, capture_output=True, text=True)
        stderr = sanitize_output((proc.stderr or "").strip(), username, password, authenticated_url)
        stdout = sanitize_output((proc.stdout or "").strip(), username, password, authenticated_url)

        if proc.returncode == 0:
            print("Capture process exited cleanly; reconnecting to continue live capture.")
        else:
            print(
                f"Capture process disconnected (exit_code={proc.returncode}). "
                f"Reconnecting in {retry_seconds}s."
            )
            if stderr:
                print("ffmpeg stderr:")
                print(stderr[-4000:])
            elif stdout:
                print("ffmpeg stdout:")
                print(stdout[-4000:])

        time.sleep(max(1, retry_seconds))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.segment_seconds <= 0:
        print("Failure: --segment-seconds must be > 0.", file=sys.stderr)
        return 1
    if args.retry_seconds <= 0:
        print("Failure: --retry-seconds must be > 0.", file=sys.stderr)
        return 1

    out_dir = ensure_output_dir(args.out_dir)
    try:
        return run_capture_loop(
            stream_url=args.url,
            out_dir=out_dir,
            segment_seconds=args.segment_seconds,
            retry_seconds=args.retry_seconds,
        )
    except KeyboardInterrupt:
        print("\nCapture stopped by user.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
