#!/usr/bin/env python3
"""Regression test for scanner agency resolution + prompt enrichment.

Covers:
- agency_registry.resolve_agency_from_call() across the talkgroup-tag fields
  scanner adapters actually populate
- agency_registry.call_canonical_agency_summary() shape and empty-fallback
- api_server._scanner_transcribe_prompt() enriches Whisper prompt with the
  canonical agency name when resolvable, falls back cleanly otherwise
- api_server._scanner_call_local_reference_context() injects canonical_*
  fields when agency resolves, omits them silently otherwise

Run: python scripts/test_scanner_agency_resolution.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import api_server
from app.services.agency_registry import (
    call_canonical_agency_summary,
    resolve_agency_from_call,
)

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


def test_resolve_from_call() -> None:
    cases = [
        ({"talkgroup_tag": "APD Dispatch"}, "apd"),
        ({"talkgroup_description": "Bethlehem Police Dispatch"}, "bethlehem_pd"),
        ({"talkgroup_tag": "ACSO Patrol"}, "acso"),
        ({"talkgroup_description": "Coeymans Police"}, "coeymans_pd"),
        ({"feed_name": "CSX Police"}, "csx_police"),
        ({"channel": "Colonie Police"}, "colonie_pd"),
        # Falls through fields in declared order — exercises the loop.
        ({"talkgroup_tag": "", "talkgroup_description": "Cohoes Police"}, "cohoes_pd"),
        # Known unknowns return None (do not invent).
        ({}, None),
        ({"talkgroup_tag": "unknown weird"}, None),
        # Defensive: non-dict input must not raise.
        ("not a dict", None),
        (None, None),
    ]
    for call, expected in cases:
        got = resolve_agency_from_call(call)  # type: ignore[arg-type]
        got_id = (got or {}).get("agency_id")
        _report(
            f"resolve_from_call_{str(call)[:50]}",
            got_id == expected,
            f"got={got_id!r} expected={expected!r}",
        )


def test_summary_shape() -> None:
    s = call_canonical_agency_summary({"talkgroup_tag": "APD Dispatch"})
    _report("summary_returns_full_dict_when_resolved",
            s == {"agency_id": "apd", "short_name": "APD",
                  "canonical_name": "Albany City Police Department",
                  "agency_type": "municipal_police"},
            f"got={s}")
    s2 = call_canonical_agency_summary({})
    _report("summary_returns_empty_strings_when_unresolved",
            s2 == {"agency_id": "", "short_name": "", "canonical_name": "", "agency_type": ""},
            f"got={s2}")


def test_transcribe_prompt_enrichment() -> None:
    # Known agency: prompt must include the canonical name AND short name.
    p = api_server._scanner_transcribe_prompt({"talkgroup_tag": "APD Dispatch"})
    _report("prompt_includes_canonical_name_for_apd",
            "Albany City Police Department" in p,
            f"prompt-tail={p[-200:]!r}")
    _report("prompt_includes_short_name_for_apd",
            "(APD)" in p,
            f"prompt-tail={p[-200:]!r}")

    # Discipline-specific base must still be present.
    _report("prompt_keeps_police_discipline_jargon",
            "10-codes" in p or "shots fired" in p)

    # Unknown call: NO Agency: hint appended.
    p_unknown = api_server._scanner_transcribe_prompt({})
    _report("unknown_call_omits_agency_hint",
            " Agency:" not in p_unknown)

    # Fire/EMS calls also pick up the canonical agency name.
    p_fire = api_server._scanner_transcribe_prompt(
        {"talkgroup_description": "Bethlehem Fire Dispatch"}
    )
    # Bethlehem Fire is not in the registry as a separate agency — the
    # discipline classifier returns 'fire' and there's no resolution; the
    # prompt should keep the fire-dispatch hints with no agency hint.
    _report("fire_unresolved_keeps_fire_jargon", "structure fire" in p_fire)


def test_local_reference_context_enrichment() -> None:
    ctx = api_server._scanner_call_local_reference_context({"talkgroup_tag": "APD Dispatch"})
    _report("context_adds_canonical_agency_id",
            "canonical_agency_id=apd" in ctx,
            f"ctx={ctx!r}")
    _report("context_adds_canonical_short_name",
            "canonical_agency_short_name=APD" in ctx,
            f"ctx={ctx!r}")
    _report("context_adds_canonical_name",
            "canonical_agency_name=Albany City Police Department" in ctx,
            f"ctx={ctx!r}")
    _report("context_adds_agency_type",
            "canonical_agency_type=municipal_police" in ctx,
            f"ctx={ctx!r}")

    # Unknown call: canonical_* fields must be absent (not blank-with-equals).
    ctx2 = api_server._scanner_call_local_reference_context({})
    for needle in (
        "canonical_agency_id", "canonical_agency_short_name",
        "canonical_agency_name", "canonical_agency_type",
    ):
        _report(f"unknown_call_omits_{needle}", needle not in ctx2,
                f"ctx={ctx2!r}")
    # Pre-existing jurisdiction line must still be present (no regression).
    _report("context_keeps_jurisdiction",
            "jurisdiction=Albany County, New York" in ctx2)


def test_defensive_against_registry_failure() -> None:
    """If the registry import fails inside the prompt/context helpers, the
    helpers must still return their pre-registry output rather than raising.
    Simulate by monkey-patching the imported symbol in the module."""
    import app.services.agency_registry as reg
    orig = reg.call_canonical_agency_summary
    def _boom(_call):  # noqa: ANN001
        raise RuntimeError("synthetic registry failure")
    reg.call_canonical_agency_summary = _boom  # type: ignore
    try:
        # Both helpers wrap registry calls in try/except; result should be
        # the unenriched base prompt / context.
        p = api_server._scanner_transcribe_prompt({"talkgroup_tag": "APD Dispatch"})
        _report("prompt_falls_back_on_registry_exception",
                " Agency:" not in p)
        ctx = api_server._scanner_call_local_reference_context({"talkgroup_tag": "APD Dispatch"})
        _report("context_falls_back_on_registry_exception",
                "canonical_agency_id" not in ctx)
    finally:
        reg.call_canonical_agency_summary = orig  # type: ignore


def main() -> None:
    test_resolve_from_call()
    test_summary_shape()
    test_transcribe_prompt_enrichment()
    test_local_reference_context_enrichment()
    test_defensive_against_registry_failure()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
