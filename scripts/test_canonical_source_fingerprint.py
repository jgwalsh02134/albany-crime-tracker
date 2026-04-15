#!/usr/bin/env python3
"""Regression test for canonical agency normalization at incident dedupe time.

Validates that:
  * canonical_source_for_fingerprint() collapses agency-name variants to a
    single canonical token without affecting unrelated sources,
  * _stable_fingerprint() produces the same primary hash for "Albany PD",
    "Albany Police", "City of Albany Police Department", and "APD" when
    other identity fields agree,
  * different agencies (Albany PD vs Bethlehem PD) still produce different
    fingerprints — no false collisions,
  * distinct source_url values still act as primary identity (existing
    behavior preserved),
  * _all_fingerprint_hashes() emits both canonical and raw-source variants
    so rows persisted before this change still match on lookup,
  * _apply_updates() rotates the stored source_fingerprint forward to the
    canonical hash on touch (no orphaned duplicate-spelling pairs).

Run: python scripts/test_canonical_source_fingerprint.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.models.incident import IncidentRecord
from app.services.incident_repository import (
    _all_fingerprint_hashes,
    _apply_updates,
    _stable_fingerprint,
)
from app.services.agency_registry import canonical_source_for_fingerprint

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


def _mk(src: str, url: str = "") -> IncidentRecord:
    when = datetime(2026, 4, 14, 19, 0, 0, tzinfo=timezone.utc)
    return IncidentRecord(
        id="",
        title="Coeymans woman arrested after alleged shooting",
        source_name=src,
        municipality="Coeymans",
        incident_type="violent",
        source_url=url,
        occurred_at=when,
        published_at=when,
    )


def test_canonical_helper() -> None:
    cases = [
        ("Albany PD", "apd"),
        ("Albany Police", "apd"),
        ("City of Albany Police Department", "apd"),
        ("APD", "apd"),
        ("apd", "apd"),
        ("Bethlehem PD", "bethlehem pd"),
        ("Bethlehem Police", "bethlehem pd"),
        ("Town of Bethlehem Police Department", "bethlehem pd"),
        ("ACSO", "acso"),
        ("Albany County Sheriff", "acso"),
        # Non-agency sources pass through normalized.
        ("Times Union", "times union"),
        ("WNYT.com", "wnyt.com"),
        ("Spectrum News", "spectrum news"),
        # Edge cases.
        ("", ""),
        ("   ", ""),
    ]
    for src, expected in cases:
        got = canonical_source_for_fingerprint(src)
        _report(f"canonical_{src!r}", got == expected, f"got={got!r}")


def test_fingerprint_convergence_no_url() -> None:
    """Without a distinguishing source_url, all APD-variant spellings of the
    same event must produce the same primary fingerprint hash."""
    fp_pd = _stable_fingerprint(_mk("Albany PD"), {})
    fp_pol = _stable_fingerprint(_mk("Albany Police"), {})
    fp_full = _stable_fingerprint(_mk("City of Albany Police Department"), {})
    fp_apd = _stable_fingerprint(_mk("APD"), {})
    _report("apd_variants_collapse_pd_eq_police", fp_pd == fp_pol)
    _report("apd_variants_collapse_pd_eq_full", fp_pd == fp_full)
    _report("apd_variants_collapse_pd_eq_short", fp_pd == fp_apd)

    # Different agencies must NOT collide.
    fp_diff = _stable_fingerprint(_mk("Bethlehem PD"), {})
    _report("apd_does_not_collide_with_bethlehem_pd", fp_pd != fp_diff)

    # Non-agency sources must NOT collide with APD.
    fp_tu = _stable_fingerprint(_mk("Times Union"), {})
    _report("apd_does_not_collide_with_times_union", fp_pd != fp_tu)


def test_distinct_source_url_remains_primary_identity() -> None:
    """When source_url differs across two reports, that URL is the primary
    identity per existing dedupe semantics — they should NOT collapse just
    because the agency canonicalizes."""
    a = _stable_fingerprint(_mk("Albany PD", "https://x.example/a"), {})
    b = _stable_fingerprint(_mk("Albany Police", "https://x.example/b"), {})
    _report("different_urls_still_distinct", a != b)


def test_backward_compat_hash_overlap() -> None:
    """For backward compatibility with rows persisted before this change,
    _all_fingerprint_hashes() must emit both canonical and raw-source
    variants. Two variant spellings should share at least one hash so a
    new write finds an old row stored with the other spelling."""
    hashes_pd = set(_all_fingerprint_hashes(_mk("Albany PD"), {}))
    hashes_pol = set(_all_fingerprint_hashes(_mk("Albany Police"), {}))
    overlap = hashes_pd & hashes_pol
    _report("variant_hash_sets_overlap", bool(overlap),
            f"shared={len(overlap)} pd={len(hashes_pd)} pol={len(hashes_pol)}")
    # Different agencies must have NO overlap.
    hashes_beth = set(_all_fingerprint_hashes(_mk("Bethlehem PD"), {}))
    _report("apd_and_bethlehem_have_no_hash_overlap",
            not (hashes_pd & hashes_beth),
            f"unexpected_overlap={len(hashes_pd & hashes_beth)}")


def test_apply_updates_rotates_fingerprint_forward() -> None:
    """_apply_updates() must migrate an old row's stored source_fingerprint
    to the new canonical hash on touch, so future writes converge."""
    record = _mk("Albany Police")
    canonical_fp = _stable_fingerprint(record, {})

    # Existing row was persisted with a raw-source-name fingerprint (the
    # pre-canonical hash for "Albany PD" spelling).
    pretend_old_fp = "deadbeef" * 8
    existing = SimpleNamespace(
        title="",
        description="",
        incident_type="",
        severity="",
        status="",
        source_type="",
        source_name="Albany PD",  # old row's raw source_name
        source_url="",
        occurred_at=None,
        published_at=None,
        municipality="",
        address_text="",
        latitude=None,
        longitude=None,
        confidence_score=0.0,
        verification_level="",
        tags=[],
        provenance={},
        raw_payload={},
        source_fingerprint=pretend_old_fp,
    )

    changed = _apply_updates(existing, record)
    _report("apply_updates_returns_changed", changed is True)
    _report("apply_updates_rotates_fingerprint_to_canonical",
            existing.source_fingerprint == canonical_fp,
            f"existing.source_fingerprint={existing.source_fingerprint!r}")

    # Idempotency: a second apply with the same record should NOT report a
    # change in source_fingerprint (it's already canonical).
    fp_after = existing.source_fingerprint
    _ = _apply_updates(existing, record)
    _report("apply_updates_idempotent_on_canonical_fp",
            existing.source_fingerprint == fp_after)


def main() -> None:
    test_canonical_helper()
    test_fingerprint_convergence_no_url()
    test_distinct_source_url_remains_primary_identity()
    test_backward_compat_hash_overlap()
    test_apply_updates_rotates_fingerprint_forward()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
