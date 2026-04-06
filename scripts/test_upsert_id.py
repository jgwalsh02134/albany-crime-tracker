#!/usr/bin/env python3
"""Tests for incident ID generation and upsert safety.

Proves the empty-PK bug is fixed: every IncidentRecord and ORM row gets a
non-empty, unique primary key even when the source article has no 'id' field.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

passed = 0
failed = 0


def _report(name: str, ok: bool, detail: str = ""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


from app.services.incident_transformers import article_to_incident
from app.services.incident_repository import _to_orm, _stable_fingerprint, _candidate_fingerprints


# ---------------------------------------------------------------------------
# article_to_incident: id generation
# ---------------------------------------------------------------------------

def test_id_from_article_id():
    """When article has an explicit 'id', use it."""
    art = {"id": "explicit-id-123", "title": "Test", "source": "UnitTest"}
    rec = article_to_incident(art)
    _report("id_from_article_id", rec.id == "explicit-id-123", f"got: {rec.id!r}")


def test_id_from_guid_fallback():
    """When article has no 'id' or 'external_id', fall back to 'guid'."""
    art = {"title": "Test", "source": "UnitTest", "guid": "nysp-NY001"}
    rec = article_to_incident(art)
    _report("id_from_guid", rec.id == "nysp-NY001", f"got: {rec.id!r}")


def test_id_from_external_id():
    """When article has 'external_id' but no 'id', use it."""
    art = {"title": "Test", "source": "UnitTest", "external_id": "ext-456"}
    rec = article_to_incident(art)
    _report("id_from_external_id", rec.id == "ext-456", f"got: {rec.id!r}")


def test_id_prefers_id_over_guid():
    """'id' field takes precedence over 'guid'."""
    art = {"id": "primary", "guid": "fallback", "title": "Test", "source": "X"}
    rec = article_to_incident(art)
    _report("id_prefers_id", rec.id == "primary", f"got: {rec.id!r}")


def test_external_ref_includes_guid():
    """external_ref should always include guid when present."""
    art = {"title": "Test", "source": "UnitTest", "guid": "g-999"}
    rec = article_to_incident(art)
    _report("external_ref_has_guid", rec.external_ref == "g-999", f"got: {rec.external_ref!r}")


# ---------------------------------------------------------------------------
# _to_orm: safety net for empty IDs
# ---------------------------------------------------------------------------

def test_to_orm_uses_record_id():
    """Normal case: ORM row uses the record's id."""
    art = {"id": "abc", "title": "Test", "source": "X", "guid": "abc"}
    rec = article_to_incident(art)
    orm = _to_orm(rec, art)
    _report("orm_uses_record_id", orm.id == "abc", f"got: {orm.id!r}")


def test_to_orm_fallback_to_external_ref():
    """If record.id is empty, ORM uses external_ref."""
    art = {"title": "Test", "source": "X"}
    rec = article_to_incident(art)
    rec_id_before = rec.id
    # Force empty id to test safety net
    rec = rec.model_copy(update={"id": ""})
    orm = _to_orm(rec, art)
    _report("orm_fallback_external_ref",
            orm.id != "" and len(orm.id) > 0,
            f"record.id was {rec_id_before!r}, orm.id={orm.id!r}")


def test_to_orm_uuid_fallback():
    """If both record.id and external_ref are empty, ORM generates UUID."""
    art = {"title": "Test", "source": "X"}
    rec = article_to_incident(art)
    rec = rec.model_copy(update={"id": "", "external_ref": ""})
    orm = _to_orm(rec, art)
    _report("orm_uuid_fallback",
            orm.id != "" and len(orm.id) >= 32,
            f"got: {orm.id!r}")


# ---------------------------------------------------------------------------
# Batch uniqueness: multiple NYSP-style articles produce unique PKs
# ---------------------------------------------------------------------------

def test_nysp_batch_unique_ids():
    """Multiple NYSP-style articles (no 'id', different 'guid') get distinct PKs."""
    articles = [
        {
            "title": f"NYSP: Incident {i} \u2014 Colonie",
            "source": "NYSP Troop G Blotter",
            "guid": f"nysp-NY260041700{i}",
            "link": "https://publicapps.troopers.ny.gov/media/TroopG/MediaMon1.pdf",
            "municipality": "Colonie",
            "_nysp_pdf_url": "https://publicapps.troopers.ny.gov/media/TroopG/MediaMon1.pdf",
            "_nysp_incident_number": f"NY260041700{i}",
        }
        for i in range(5)
    ]
    records = [article_to_incident(a) for a in articles]
    ids = [r.id for r in records]
    _report("nysp_all_ids_nonempty", all(ids), f"ids: {ids}")
    _report("nysp_all_ids_unique", len(set(ids)) == 5, f"unique: {len(set(ids))}/5")

    orms = [_to_orm(r, a) for r, a in zip(records, articles)]
    orm_ids = [o.id for o in orms]
    _report("nysp_orm_ids_unique", len(set(orm_ids)) == 5, f"unique: {len(set(orm_ids))}/5")


def test_superfeedr_batch_unique_ids():
    """Multiple Superfeedr articles (no 'id', different 'guid') get distinct PKs."""
    articles = [
        {
            "title": f"Article {i}",
            "source": "Superfeedr",
            "guid": f"https://example.com/article/{i}",
            "link": f"https://example.com/article/{i}",
        }
        for i in range(4)
    ]
    records = [article_to_incident(a) for a in articles]
    ids = [r.id for r in records]
    _report("sfdr_all_ids_nonempty", all(ids), f"ids: {ids}")
    _report("sfdr_all_ids_unique", len(set(ids)) == 4, f"unique: {len(set(ids))}/4")


# ---------------------------------------------------------------------------
# Fingerprint uniqueness within a batch
# ---------------------------------------------------------------------------

def test_fingerprints_unique_per_incident():
    """Different NYSP incidents produce different source_fingerprints."""
    articles = [
        {
            "title": f"NYSP: Category{i} \u2014 Muni{i}",
            "source": "NYSP Troop G Blotter",
            "guid": f"nysp-NY000{i}",
            "link": "https://publicapps.troopers.ny.gov/media/TroopG/MediaMon1.pdf",
        }
        for i in range(5)
    ]
    records = [article_to_incident(a) for a in articles]
    fps = [_stable_fingerprint(r, a) for r, a in zip(records, articles)]
    _report("fps_all_unique", len(set(fps)) == 5, f"unique: {len(set(fps))}/5")


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

test_id_from_article_id()
test_id_from_guid_fallback()
test_id_from_external_id()
test_id_prefers_id_over_guid()
test_external_ref_includes_guid()
test_to_orm_uses_record_id()
test_to_orm_fallback_to_external_ref()
test_to_orm_uuid_fallback()
test_nysp_batch_unique_ids()
test_superfeedr_batch_unique_ids()
test_fingerprints_unique_per_incident()

print(f"\n{passed}/{passed + failed} tests passed")
if failed:
    sys.exit(1)
