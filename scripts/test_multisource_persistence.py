#!/usr/bin/env python3
"""Regression test for multi-source `sources` array persistence on incidents.

Closes the largest semantic gap documented in schemas/README.md (item 3 in
the smallest-first migration order): persist the per-incident list of
corroborating sources so the frontend's _linked_sources clustering can
read from the DB instead of recomputing on every render.

Covers:
  - app/db/models.py IncidentORM gains a JSONB `sources` column,
    nullable for backward compat
  - app/db/session.py _INCIDENTS_SCHEMA_HARDENING_SQL adds a conditional
    ALTER TABLE so existing prod tables get the column on next startup
  - app/services/incident_repository._build_source_entry shape matches
    the frontend _liveClusterPushSource entry shape (name + url) plus
    canonical agency_id and first_seen_at
  - _is_same_source_entry dedupe matches the frontend (URL > name)
  - _to_orm() initializes sources with one entry on row creation
  - _apply_updates() appends incoming source on dedupe match
  - _apply_updates() does NOT double-count when the same source URL or
    name reappears
  - _apply_updates() bootstraps from the existing row's source_name /
    source_url when sources column is NULL (legacy pre-migration row)
  - _apply_updates() captures pre-update snapshot so the bootstrap
    preserves the row's ORIGINAL source instead of attributing it to
    the incoming one (regression guard for a bug found during this pass)
  - _merge_source_into_list caps at 20 entries to bound JSONB growth
  - _to_public_dict and the query_incidents DB projection surface the
    new field

Run: python scripts/test_multisource_persistence.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import models as db_models
from app.db import session as db_session
from app.models.incident import IncidentRecord
from app.services.incident_repository import (
    _SOURCES_LIST_CAP,
    _apply_updates,
    _build_source_entry,
    _is_same_source_entry,
    _merge_source_into_list,
    _to_orm,
    _to_public_dict,
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


def _mock_existing(**overrides) -> SimpleNamespace:
    """Build a SimpleNamespace mock of an IncidentORM row with all the
    attributes _apply_updates touches."""
    base = dict(
        title="t", description="", incident_type="", severity="",
        status="", source_type="", source_name="Times Union",
        source_url="https://tu.example/a",
        occurred_at=None, published_at=None,
        municipality="", address_text="",
        latitude=None, longitude=None, confidence_score=0.0,
        verification_level="", responding_agency_id=None,
        tags=[], provenance={}, raw_payload={},
        source_fingerprint="hash",
        sources=[],
        created_at=datetime.now(timezone.utc),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_orm_column_present() -> None:
    cols = db_models.IncidentORM.__table__.columns
    _report("orm_has_sources_column", "sources" in cols)
    if "sources" in cols:
        _report("orm_sources_nullable", cols["sources"].nullable is True)


def test_hardening_sql() -> None:
    sql = db_session._INCIDENTS_SCHEMA_HARDENING_SQL
    _report("hardening_sql_mentions_sources", "sources" in sql)
    _report("hardening_sql_alter_for_sources",
            "ALTER TABLE incidents ADD COLUMN sources JSONB" in sql)
    _report("hardening_sql_default_empty_array",
            "DEFAULT '[]'" in sql)


def test_build_source_entry_shape() -> None:
    rec = IncidentRecord(id="x", title="t", source_name="Bethlehem PD",
                         source_url="https://bpd.example/a",
                         responding_agency_id="bethlehem_pd")
    e = _build_source_entry(rec)
    _report("entry_has_required_keys",
            set(e.keys()) == {"name", "url", "agency_id", "first_seen_at"},
            f"keys={sorted(e.keys())}")
    _report("entry_carries_name", e["name"] == "Bethlehem PD")
    _report("entry_carries_url", e["url"] == "https://bpd.example/a")
    _report("entry_carries_agency_id", e["agency_id"] == "bethlehem_pd")
    _report("entry_carries_first_seen_at_iso",
            isinstance(e["first_seen_at"], str)
            and e["first_seen_at"].startswith("20"))


def test_is_same_source_entry() -> None:
    a = {"name": "WNYT", "url": "https://wnyt.example/x"}
    b = {"name": "WNYT.com", "url": "https://wnyt.example/x"}
    _report("same_url_means_same_source", _is_same_source_entry(a, b))

    c = {"name": "WNYT", "url": ""}
    d = {"name": "wnyt", "url": ""}
    _report("same_name_case_insensitive_when_no_url",
            _is_same_source_entry(c, d))

    e = {"name": "WNYT", "url": "https://x.example/a"}
    f = {"name": "WNYT", "url": "https://x.example/b"}
    _report("different_urls_means_different_sources_even_if_name_matches",
            not _is_same_source_entry(e, f))


def test_to_orm_initializes_with_one_source() -> None:
    rec = IncidentRecord(id="x", title="t", source_name="WRGB",
                         source_url="https://wrgb.example/x",
                         responding_agency_id=None)
    orm = _to_orm(rec, {})
    _report("orm_sources_is_list", isinstance(orm.sources, list))
    _report("orm_sources_has_one_entry_on_create", len(orm.sources) == 1)
    _report("orm_sources_entry_name_correct",
            orm.sources and orm.sources[0].get("name") == "WRGB")
    _report("orm_sources_entry_url_correct",
            orm.sources and orm.sources[0].get("url") == "https://wrgb.example/x")


def test_apply_updates_appends_new_source() -> None:
    existing = _mock_existing(
        source_name="Times Union",
        source_url="https://tu.example/a",
        sources=[{"name": "Times Union", "url": "https://tu.example/a",
                  "agency_id": None, "first_seen_at": "2026-04-14T00:00:00+00:00"}],
    )
    rec = IncidentRecord(id="x", title="t", source_name="WNYT",
                         source_url="https://wnyt.example/b")
    _apply_updates(existing, rec, {})
    _report("appends_new_source_distinct_url", len(existing.sources) == 2)
    names = sorted(s.get("name") for s in existing.sources)
    _report("appends_keeps_both_names",
            names == ["Times Union", "WNYT"], f"names={names}")


def test_apply_updates_does_not_double_count() -> None:
    existing = _mock_existing(
        source_name="Times Union",
        source_url="https://tu.example/a",
        sources=[{"name": "Times Union", "url": "https://tu.example/a",
                  "agency_id": None, "first_seen_at": "2026-04-14T00:00:00+00:00"},
                 {"name": "WNYT", "url": "https://wnyt.example/b",
                  "agency_id": None, "first_seen_at": "2026-04-14T00:01:00+00:00"}],
    )
    # Same URL as the WNYT entry → must not add a duplicate.
    rec = IncidentRecord(id="x", title="t", source_name="WNYT",
                         source_url="https://wnyt.example/b")
    _apply_updates(existing, rec, {})
    _report("duplicate_url_not_appended", len(existing.sources) == 2,
            f"got={len(existing.sources)}")


def test_apply_updates_bootstraps_from_legacy_null() -> None:
    """Legacy row had no sources column. The first update should bootstrap
    the array with the row's ORIGINAL source (preserving its prior
    attribution) and then append the incoming source."""
    legacy = _mock_existing(
        source_name="Spectrum",
        source_url="https://spec.example/x",
        sources=None,  # legacy: column was NULL pre-migration
    )
    rec = IncidentRecord(id="y", title="t", source_name="Times Union",
                         source_url="https://tu.example/new")
    _apply_updates(legacy, rec, {})
    names = sorted(s.get("name") for s in (legacy.sources or []))
    _report("bootstrap_preserves_original_source",
            "Spectrum" in names,
            f"names={names}")
    _report("bootstrap_appends_incoming_source",
            "Times Union" in names,
            f"names={names}")
    _report("bootstrap_yields_two_sources",
            len(legacy.sources or []) == 2,
            f"got={len(legacy.sources or [])}")


def test_apply_updates_snapshot_pre_set() -> None:
    """Regression guard: pre-update snapshot must be captured BEFORE _set
    overwrites existing.source_name. Otherwise the bootstrap would
    attribute the incoming source as the row's original."""
    legacy = _mock_existing(
        source_name="Spectrum",
        source_url="https://spec.example/x",
        sources=None,
    )
    rec = IncidentRecord(id="y", title="t", source_name="Times Union",
                         source_url="https://tu.example/new")
    _apply_updates(legacy, rec, {})
    # If the snapshot were captured AFTER _set, both entries would be
    # "Times Union" because existing.source_name would already be the
    # new value when fallback_existing was built.
    name_set = {s.get("name") for s in (legacy.sources or [])}
    _report("snapshot_captured_pre_set",
            name_set == {"Spectrum", "Times Union"},
            f"got={name_set}")


def test_merge_caps_at_20() -> None:
    big = [
        {"name": f"src-{i}", "url": f"https://x/{i}",
         "agency_id": None, "first_seen_at": ""}
        for i in range(_SOURCES_LIST_CAP + 5)
    ]
    out = _merge_source_into_list(
        big, {},
        {"name": "newest", "url": "https://newest.example", "agency_id": None,
         "first_seen_at": ""},
    )
    _report("merge_caps_at_20", len(out) == _SOURCES_LIST_CAP,
            f"got={len(out)}")
    _report("merge_keeps_newest", any(e.get("name") == "newest" for e in out))


def test_merge_does_not_mutate_input() -> None:
    """The merge helper must return a NEW list rather than mutate the input
    (so SQLAlchemy's JSONB change tracking always sees a new value)."""
    original = [{"name": "TU", "url": "https://tu/a",
                 "agency_id": None, "first_seen_at": ""}]
    out = _merge_source_into_list(
        original, {},
        {"name": "WNYT", "url": "https://wnyt/b", "agency_id": None,
         "first_seen_at": ""},
    )
    _report("merge_returns_new_list", out is not original)
    _report("merge_input_unchanged", len(original) == 1)


def test_to_public_dict_includes_sources() -> None:
    rec = IncidentRecord(id="z", title="t", source_name="Bethlehem PD",
                         source_url="https://bpd.example/x",
                         responding_agency_id="bethlehem_pd")
    pub = _to_public_dict(rec, {})
    _report("public_dict_has_sources",
            isinstance(pub.get("sources"), list)
            and len(pub["sources"]) == 1
            and pub["sources"][0].get("name") == "Bethlehem PD")


def main() -> None:
    test_orm_column_present()
    test_hardening_sql()
    test_build_source_entry_shape()
    test_is_same_source_entry()
    test_to_orm_initializes_with_one_source()
    test_apply_updates_appends_new_source()
    test_apply_updates_does_not_double_count()
    test_apply_updates_bootstraps_from_legacy_null()
    test_apply_updates_snapshot_pre_set()
    test_merge_caps_at_20()
    test_merge_does_not_mutate_input()
    test_to_public_dict_includes_sources()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
