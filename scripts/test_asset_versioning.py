#!/usr/bin/env python3
"""Regression tests for per-deploy static-asset cache busting.

Production symptom that motivated this: commit 9b92941 deployed but the
clustering / freshness / spacing changes were not visible because the
browser/edge layer was serving cached app.js and style.css. The HTML
referenced the assets at a stable URL, so the cache never invalidated.

Fix: index.html now references app.js?v=__ASSET_VERSION__ and
style.css?v=__ASSET_VERSION__; the FastAPI / route substitutes
__ASSET_VERSION__ with a hash of the asset mtimes at request time, and
sends Cache-Control: no-cache on the HTML response so the substitution
itself reaches the user.

Run: python scripts/test_asset_versioning.py
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server

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


def _read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def main() -> None:
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html_path = os.path.join(repo, "index.html")
    html = _read(html_path)

    # 1. index.html must reference the asset version placeholder for both
    # style.css and app.js so the FastAPI / route substitution kicks in.
    _report("index_html_has_placeholder_for_style",
            "style.css?v=__ASSET_VERSION__" in html)
    _report("index_html_has_placeholder_for_app_js",
            "__ASSET_VERSION__" in html and 'document.write(\'<script src="app.js?v=\'' in html)

    # 2. The placeholder must NOT be a literal hardcoded version (the prior
    # bug was a hardcoded "?v=10" only on localhost).
    _report("index_html_no_hardcoded_v10_in_app_js_loader",
            '"?v=10"' not in html and "'?v=10'" not in html)

    # 3. The FastAPI helper must produce a non-empty token deterministically.
    tok1 = api_server._asset_version_token()
    tok2 = api_server._asset_version_token()
    _report("token_is_non_empty", bool(tok1) and len(tok1) >= 6, f"tok={tok1!r}")
    _report("token_is_deterministic_within_a_run", tok1 == tok2,
            f"tok1={tok1!r} tok2={tok2!r}")
    _report("token_is_lowercase_hex",
            bool(re.match(r"^[0-9a-f]+$", tok1)),
            f"tok={tok1!r}")

    # 4. The token changes when an asset's mtime changes. Touch app.js
    # forward by 5 seconds in the future and assert the token rolls.
    app_js = os.path.join(repo, "app.js")
    orig = os.stat(app_js)
    try:
        future = (orig.st_atime, orig.st_mtime + 5)
        os.utime(app_js, future)
        tok_after = api_server._asset_version_token()
        _report("token_rolls_when_app_js_mtime_changes",
                tok_after != tok1,
                f"before={tok1!r} after={tok_after!r}")
    finally:
        os.utime(app_js, (orig.st_atime, orig.st_mtime))

    # 5. Substitution must remove all __ASSET_VERSION__ occurrences.
    substituted = html.replace("__ASSET_VERSION__", tok1)
    _report("substitution_removes_all_placeholders",
            "__ASSET_VERSION__" not in substituted)
    _report("substitution_emits_versioned_style_css",
            f"style.css?v={tok1}" in substituted)

    # 6. Inline JS fallback branch: if the placeholder is somehow not
    # substituted (e.g. opening index.html directly off disk), the inline
    # script falls back to "dev" rather than emitting a literal underscore-
    # prefixed token that would 404.
    _report("inline_fallback_branch_present",
            'if (v.charAt(0) === "_") v = "dev"' in html)

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
