#!/usr/bin/env python3
"""
Provenance tracking unit tests.

Validates the full provenance lifecycle:
  build → normalize → fuse → transform → serialize

Run:  python scripts/test_provenance.py
"""
from __future__ import annotations

import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.models.incident import (
    IncidentRecord,
    IncidentProvenance,
    build_provenance,
    append_provenance_step,
)


def test_build_provenance_shape():
    p = build_provenance(
        source_class="rss_local_news",
        source_id="wnyt-crime",
        trust_tier="tier_3",
        lane="developing_incidents",
        ingestion_method="rss_poll",
        feed_url="https://wnyt.com/rss/crime",
        captured_at="2026-04-05T12:00:00Z",
        content_type="rss_item",
        capture_method="rss_poll",
    )
    assert isinstance(p, dict)
    assert p["origin"]["source_class"] == "rss_local_news"
    assert p["origin"]["trust_tier"] == "tier_3"
    assert p["raw_capture"]["content_type"] == "rss_item"
    assert p["raw_capture"]["captured_at"] == "2026-04-05T12:00:00Z"
    assert p["extraction_chain"] == []
    assert p["confidence"]["score"] == 0.0
    assert p["fusion"] is None


def test_append_step():
    p = build_provenance(source_class="test")
    append_provenance_step(p, step="normalize", module="m", function="f")
    append_provenance_step(p, step="fuse", module="m2", function="f2")
    assert len(p["extraction_chain"]) == 2
    assert p["extraction_chain"][0]["step"] == "normalize"
    assert p["extraction_chain"][1]["step"] == "fuse"
    for entry in p["extraction_chain"]:
        assert entry["timestamp"], "timestamp should be auto-populated"


def test_provenance_on_incident_record():
    p = build_provenance(source_class="scanner_priority_p25", trust_tier="tier_3")
    rec = IncidentRecord(id="inc-1", title="Test", provenance=p)
    assert rec.provenance["origin"]["source_class"] == "scanner_priority_p25"


def test_backward_compat_empty_provenance():
    rec = IncidentRecord(id="old-inc")
    assert rec.provenance == {}


def test_provenance_model_round_trip():
    p = build_provenance(
        source_class="official_structured_open_data",
        source_id="albany-socrata-crime",
        trust_tier="tier_1",
        captured_at="2026-04-05T12:00:00Z",
        content_type="json_api_row",
    )
    append_provenance_step(p, step="normalize", module="ii", function="nfe")
    p["confidence"] = {
        "score": 0.98,
        "rationale": "official source",
        "geocode_quality": "exact",
        "verification_level": "official",
        "locality_signal": "strict_albany",
    }
    p["fusion"] = {
        "fused": False,
        "source_ids": ["abc"],
        "source_count": 1,
        "primary_source_id": "abc",
        "merge_method": "",
    }
    model = IncidentProvenance(**p)
    assert model.origin.source_class == "official_structured_open_data"
    assert model.confidence.score == 0.98
    assert model.fusion is not None
    assert model.fusion.fused is False


def test_json_serializable():
    p = build_provenance(source_class="test", captured_at="2026-01-01T00:00:00Z")
    append_provenance_step(p, step="x", module="m", function="f")
    p["fusion"] = {"fused": True, "source_ids": ["a", "b"], "source_count": 2, "primary_source_id": "a", "merge_method": "haversine"}
    s = json.dumps(p, default=str)
    parsed = json.loads(s)
    assert parsed["origin"]["source_class"] == "test"
    assert parsed["fusion"]["fused"] is True


def test_all_source_classes():
    classes = [
        "official_structured_open_data",
        "official_structured_or_press",
        "official_cap_feed",
        "scanner_priority_p25",
        "scanner_directory",
        "rss_local_news",
        "rss_gnews",
    ]
    for sc in classes:
        p = build_provenance(source_class=sc)
        assert p["origin"]["source_class"] == sc


def main():
    tests = [
        test_build_provenance_shape,
        test_append_step,
        test_provenance_on_incident_record,
        test_backward_compat_empty_provenance,
        test_provenance_model_round_trip,
        test_json_serializable,
        test_all_source_classes,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed}/{passed + failed} tests passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
