#!/usr/bin/env python3
"""Regression test for persisted responding_agency_id on incidents.

Covers the smallest-safe pass that closes the schemas/incident.schema.json
"responding_agency" field gap documented in schemas/README.md:

  - app/models/incident.py IncidentRecord gains an Optional
    responding_agency_id field (additive, default None)
  - app/db/models.py IncidentORM gains a nullable VARCHAR(64)
    responding_agency_id column with an index
  - app/db/session.py _INCIDENTS_SCHEMA_HARDENING_SQL adds a conditional
    ALTER TABLE so existing prod tables get the column on next startup
  - app/services/incident_transformers.article_to_incident() resolves the
    canonical agency_id via two paths (scanner-call attribution then
    source-name attribution)
  - app/services/incident_repository._to_orm threads it onto the ORM row
  - _apply_updates rotates it forward only when the new value is non-empty
  - _to_public_dict and the query_incidents DB projection surface it

Run: python scripts/test_responding_agency_persistence.py
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
    _apply_updates,
    _to_orm,
    _to_public_dict,
)
from app.services.incident_transformers import (
    _resolve_responding_agency_id,
    article_to_incident,
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


def test_model_has_field() -> None:
    rec = IncidentRecord()
    _report("IncidentRecord_has_responding_agency_id_default_none",
            hasattr(rec, "responding_agency_id") and rec.responding_agency_id is None,
            f"got={getattr(rec, 'responding_agency_id', '<missing>')!r}")


def test_orm_has_column() -> None:
    cols = db_models.IncidentORM.__table__.columns
    _report("IncidentORM_has_responding_agency_id_column",
            "responding_agency_id" in cols)
    if "responding_agency_id" in cols:
        col = cols["responding_agency_id"]
        _report("ORM_column_is_nullable", col.nullable is True)
        _report("ORM_column_indexed",
                any("responding_agency_id" in str(idx.columns)
                    for idx in db_models.IncidentORM.__table__.indexes))


def test_hardening_sql_adds_column() -> None:
    sql = db_session._INCIDENTS_SCHEMA_HARDENING_SQL
    _report("hardening_sql_mentions_responding_agency_id",
            "responding_agency_id" in sql)
    _report("hardening_sql_alter_table_for_responding_agency",
            "ALTER TABLE incidents ADD COLUMN responding_agency_id" in sql)
    _report("hardening_sql_creates_index",
            "ix_incidents_responding_agency_id" in sql)


def test_resolver_paths() -> None:
    # Scanner-call path via numeric talkgroup id.
    art = {"id": "s1", "title": "shots fired", "source": "Broadcastify",
           "_scanner_call": True, "talkgroup_num": "13102",
           "pubDate": "Mon, 14 Apr 2026 10:00:00 +0000"}
    _report("scanner_tg_13102_resolves_to_apd",
            _resolve_responding_agency_id(art) == "apd")

    # Source-name path for non-scanner.
    art = {"id": "s2", "title": "arrest", "source": "Bethlehem PD"}
    _report("source_name_bethlehem_pd_resolves",
            _resolve_responding_agency_id(art) == "bethlehem_pd")

    # ACSO short name.
    _report("source_name_ACSO_resolves",
            _resolve_responding_agency_id({"source": "ACSO"}) == "acso")

    # Non-LE source must NOT fabricate. Note: anything containing a real
    # agency alias (e.g. "FBI Tip Line" → fbi_albany) intentionally DOES
    # resolve, because the FBI is a registered agency. Picking strictly
    # editorial / aggregator names here.
    for src in ("Times Union", "WNYT.com", "Spectrum News", "MSN",
                "Daily Gazette", "", None):
        a = _resolve_responding_agency_id({"source": src} if src is not None else {})
        _report(f"non_le_source_{src!r}_returns_none", a is None,
                f"got={a!r}")

    # Defensive: must never raise on weird input.
    for bad in ({}, {"source": 12345}, {"source": []},
                {"talkgroup_num": "not-a-number"}):
        try:
            _resolve_responding_agency_id(bad)
            _report(f"defensive_input_{bad!r}_no_raise", True)
        except Exception as exc:
            _report(f"defensive_input_{bad!r}_no_raise", False,
                    f"raised {exc}")


def test_article_to_incident_populates_field() -> None:
    art = {"id": "a1", "title": "Bethlehem PD reports burglary",
           "source": "Bethlehem PD",
           "pubDate": "Mon, 14 Apr 2026 10:00:00 +0000"}
    rec = article_to_incident(art)
    _report("article_to_incident_populates_responding_agency_id",
            rec.responding_agency_id == "bethlehem_pd",
            f"got={rec.responding_agency_id!r}")


def test_to_orm_carries_field() -> None:
    rec = IncidentRecord(id="x", title="t", source_name="APD",
                         responding_agency_id="apd")
    orm = _to_orm(rec, {})
    _report("_to_orm_carries_responding_agency_id",
            orm.responding_agency_id == "apd",
            f"got={orm.responding_agency_id!r}")

    # Empty/None on the record stays None on the ORM.
    rec2 = IncidentRecord(id="y", title="t", source_name="Times Union")
    orm2 = _to_orm(rec2, {})
    _report("_to_orm_keeps_none_when_unresolved",
            orm2.responding_agency_id is None,
            f"got={orm2.responding_agency_id!r}")


def test_apply_updates_rotates_forward_only_on_resolve() -> None:
    # New record resolves agency → existing row should rotate forward.
    rec = IncidentRecord(id="x", title="t", source_name="APD",
                         responding_agency_id="apd")
    existing = SimpleNamespace(
        title="t", description="", incident_type="", severity="",
        status="", source_type="", source_name="APD", source_url="",
        occurred_at=None, published_at=None,
        municipality="", address_text="",
        latitude=None, longitude=None, confidence_score=0.0,
        verification_level="", responding_agency_id=None,
        tags=[], provenance={}, raw_payload={},
        source_fingerprint="oldhash",
    )
    _apply_updates(existing, rec, {})
    _report("apply_updates_sets_agency_when_new_resolves",
            existing.responding_agency_id == "apd",
            f"got={existing.responding_agency_id!r}")

    # Subsequent record without resolution must NOT blank the existing value.
    rec_no = IncidentRecord(id="x", title="t", source_name="Times Union",
                            responding_agency_id=None)
    existing.source_name = "Times Union"  # so _set doesn't no-op everything
    _apply_updates(existing, rec_no, {})
    _report("apply_updates_does_not_blank_existing_agency",
            existing.responding_agency_id == "apd",
            f"got={existing.responding_agency_id!r}")


def test_public_dict_projection_includes_field() -> None:
    rec = IncidentRecord(id="z", title="t", source_name="Bethlehem PD",
                         responding_agency_id="bethlehem_pd")
    pub = _to_public_dict(rec, {})
    _report("_to_public_dict_includes_responding_agency_id",
            pub.get("responding_agency_id") == "bethlehem_pd",
            f"got={pub.get('responding_agency_id')!r}")


def main() -> None:
    test_model_has_field()
    test_orm_has_column()
    test_hardening_sql_adds_column()
    test_resolver_paths()
    test_article_to_incident_populates_field()
    test_to_orm_carries_field()
    test_apply_updates_rotates_forward_only_on_resolve()
    test_public_dict_projection_includes_field()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
