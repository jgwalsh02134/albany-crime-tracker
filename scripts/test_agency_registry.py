#!/usr/bin/env python3
"""Regression tests for the canonical agency authority registry.

Validates the structure of data/agencies.json, the loader helpers in
app/services/agency_registry.py, and the smallest-safe wiring into
api_server._directory_locality_signals().

Run: python scripts/test_agency_registry.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.agency_registry import (
    all_agencies,
    agency_by_id,
    agency_alias_anchors,
    albany_county_municipality_set,
    municipality_to_primary_agency,
    operational_live_agency_anchors,
    populous_municipality_set,
    resolve_agency,
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


def test_file_structure() -> None:
    agencies = all_agencies()
    _report("file_loads_at_least_40_agencies", len(agencies) >= 40,
            f"loaded {len(agencies)}")

    required = {
        "agency_id", "canonical_name", "short_name", "aliases",
        "agency_type", "jurisdiction_level", "municipality", "county",
        "is_albany_county_primary", "is_operational_live_relevant",
        "parent_agency", "dispatch_psap", "notes",
    }
    for a in agencies:
        missing = required - set(a.keys())
        _report(
            f"agency_{a.get('agency_id')}_has_all_required_fields",
            not missing,
            f"missing={missing}",
        )

    # agency_id must be unique across the file
    ids = [a.get("agency_id") for a in agencies]
    _report("agency_ids_unique", len(ids) == len(set(ids)),
            f"dupes={[i for i in ids if ids.count(i) > 1]}")

    # Every agency declares county = Albany
    _report("all_agencies_in_albany_county",
            all(a.get("county") == "Albany" for a in agencies))


def test_resolver() -> None:
    cases = [
        ("ACSO", "acso"),
        ("Albany County Sheriff", "acso"),
        ("APD", "apd"),
        ("Albany Police", "apd"),
        ("Bethlehem PD", "bethlehem_pd"),
        ("Town of Bethlehem Police Department", "bethlehem_pd"),
        ("Coeymans PD", "coeymans_pd"),
        ("ECO", "dec_le"),
        ("environmental conservation officers", "dec_le"),
        ("NYSP Troop G", "nysp_troop_g"),
        ("Troop X", "nysp_capitol_x"),
        ("CSX Police", "csx_police"),
        ("Capital Region Hazmat", "capital_region_hazmat_le"),
    ]
    for needle, expected_id in cases:
        a = resolve_agency(needle)
        got = (a or {}).get("agency_id")
        _report(f"resolve_{needle}", got == expected_id, f"got={got}")

    # Unknown text returns None.
    _report("resolve_unknown_returns_none", resolve_agency("Acme Police Dept Inc") is None)
    _report("resolve_empty_returns_none", resolve_agency("") is None)


def test_municipality_helpers() -> None:
    pop = populous_municipality_set()
    for muni in ("albany", "colonie", "bethlehem", "guilderland", "cohoes"):
        _report(f"populous_contains_{muni}", muni in pop)

    # Coeymans is small — must NOT be in populous set.
    _report("coeymans_is_not_populous", "coeymans" not in pop)

    all_muni = albany_county_municipality_set()
    for muni in ("voorheesville", "altamont", "ravena", "selkirk", "delmar"):
        _report(f"all_munis_contains_{muni}", muni in all_muni)

    m2a = municipality_to_primary_agency()
    _report("albany_primary_is_apd", m2a.get("albany") == "apd")
    _report("coeymans_primary_is_coeymans_pd", m2a.get("coeymans") == "coeymans_pd")
    # Munis with no dedicated PD default to ACSO.
    _report("voorheesville_defaults_to_acso", m2a.get("voorheesville") == "acso")
    _report("berne_defaults_to_acso", m2a.get("berne") == "acso")


def test_agency_anchor_sets() -> None:
    all_anchors = agency_alias_anchors()
    primary_only = agency_alias_anchors(only_albany_county_primary=True)
    operational = operational_live_agency_anchors()

    _report("all_anchors_is_largest", len(all_anchors) > len(primary_only))
    _report("operational_subset_of_all", operational.issubset(all_anchors))
    _report("primary_subset_of_all", primary_only.issubset(all_anchors))

    # Operational set must include the day-to-day responders.
    for needle in ("acso", "apd", "bethlehem pd", "colonie pd", "nysp troop g", "csx police"):
        _report(f"operational_contains_{needle}", needle in operational,
                f"present={needle in all_anchors}")

    # Disambiguation-only entries must NOT appear in operational.
    for needle in ("tsa", "irs-ci", "irs-ci albany"):
        _report(f"operational_excludes_{needle}", needle not in operational)


def test_locality_signal_integration() -> None:
    # The /api_server.py side: importing api_server should expose enriched
    # locality signals that include the new agency aliases. We assert the
    # specific agency-derived strings are now present.
    import api_server
    sigs = api_server._directory_locality_signals()
    for needle in (
        "acso", "bethlehem pd", "csx police", "capital region hazmat",
        "voorheesville", "altamont", "eco", "nysp troop g",
    ):
        _report(f"directory_signals_includes_{needle}", needle in sigs,
                f"signals_size={len(sigs)}")


def test_specific_agency_records() -> None:
    apd = agency_by_id("apd")
    _report("apd_record_present", apd is not None)
    _report("apd_is_albany_primary", apd and apd.get("is_albany_county_primary") is True)
    _report("apd_municipality_is_albany", apd and apd.get("municipality") == "Albany")

    csx = agency_by_id("csx_police")
    _report("csx_municipality_is_selkirk", csx and csx.get("municipality") == "Selkirk")
    _report("csx_is_railroad_type", csx and csx.get("agency_type") == "railroad_police")

    # JTTF must be flagged not-live-relevant per authority reference.
    jttf = agency_by_id("albany_jttf")
    _report("jttf_marked_not_live_relevant",
            jttf and jttf.get("is_operational_live_relevant") is False)

    # ACPHS / Albany Law / Siena are non-sworn — must be flagged accordingly.
    for aid in ("acphs_safety", "albany_law_safety", "siena_safety"):
        a = agency_by_id(aid)
        _report(f"{aid}_marked_campus_security",
                a and a.get("agency_type") == "campus_security")
        _report(f"{aid}_not_live_relevant",
                a and a.get("is_operational_live_relevant") is False)


def main() -> None:
    test_file_structure()
    test_resolver()
    test_municipality_helpers()
    test_agency_anchor_sets()
    test_locality_signal_integration()
    test_specific_agency_records()

    print(f"\n{passed}/{passed + failed} tests passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
