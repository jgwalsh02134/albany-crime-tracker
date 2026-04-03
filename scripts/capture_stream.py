from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_STREAM_URL = "https://audio.broadcastify.com/3626.mp3"
DEFAULT_SEGMENT_SECONDS = 30
DEFAULT_RETRY_SECONDS = 5


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
    attempt = 0
    while True:
        attempt += 1
        cmd = ffmpeg_command(ffmpeg, stream_url, out_dir, segment_seconds)
        print(
            f"Starting capture attempt {attempt}: "
            f"url={stream_url} segment_seconds={segment_seconds} out_dir={out_dir}"
        )
        proc = subprocess.run(cmd, capture_output=True, text=True)
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()

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
