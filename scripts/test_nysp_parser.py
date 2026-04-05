#!/usr/bin/env python3
"""Validation tests for NYSP Troop G blotter PDF parsing."""
from __future__ import annotations

import io
import os
import re
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


# ---------------------------------------------------------------------------
# Unit tests using synthetic PDF-like text
# ---------------------------------------------------------------------------

from api_server import (
    _clean_nysp_pdf_text,
    _extract_nysp_fields,
    _extract_nysp_municipality,
    _parse_nysp_datetime,
    _build_nysp_title,
    _build_nysp_description,
    _nysp_severity,
    _nysp_crime_type,
    _NYSP_BLOCK_SPLIT_RE,
)


def test_ligature_fix():
    raw = "Informa\x00on Sta\x00on Loca\x00on Domes\x00c ac\x00vity"
    cleaned = _clean_nysp_pdf_text(raw)
    _report("ligature_fix", cleaned == "Information Station Location Domestic activity",
            f"got: {cleaned!r}")


def test_header_stripping():
    raw = (
        "New York State Police Public Information Report Law Title Codes:\n"
        "March 28, 2026 7:01 AM\n"
        "PL- Penal Law\n"
        "TAX - Tax Law\n"
        "Incident Information: Incident Number: NY123 Incident Category: Test\n"
    )
    cleaned = _clean_nysp_pdf_text(raw)
    _report("header_stripped", "Tax Law" not in cleaned and "Penal Law" not in cleaned,
            f"got: {cleaned[:100]!r}")
    _report("incident_preserved", "NY123" in cleaned)


def test_filepath_stripping():
    raw = "some text\nfile:///X:/NicheInterface/PIO/RMSData/TroopG/MediaSun1.htm 2/7\nmore text"
    cleaned = _clean_nysp_pdf_text(raw)
    _report("filepath_stripped", "file:///" not in cleaned, f"got: {cleaned!r}")
    _report("surrounding_text_kept", "some text" in cleaned and "more text" in cleaned)


def test_creation_line_stripped():
    raw = "before\nCreation Date: 3/29/2026 Purge Date: 4/5/2026 Page 1 of 1\nafter"
    cleaned = _clean_nysp_pdf_text(raw)
    _report("creation_line_stripped", "Creation Date" not in cleaned and "Purge Date" not in cleaned)


def test_block_splitting():
    text = (
        "Incident Information: Incident Number: NY0001 Incident Category: Test1\n"
        "Date/Time Reported: March 1, 2026 08:00 AM Station: ALBANY\n"
        "Location Code: CITY - ALBANY - 0101 Incident Status: Closed/cleared\n"
        "Incident Information: Incident Number: NY0002 Incident Category: Test2\n"
        "Date/Time Reported: March 1, 2026 09:00 AM Station: TROY\n"
        "Location Code: CITY - TROY - 4202 Incident Status: Arrest adult\n"
    )
    blocks = _NYSP_BLOCK_SPLIT_RE.split(text)
    non_empty = [b.strip() for b in blocks if b.strip() and "NY000" in b]
    _report("block_split_count", len(non_empty) == 2, f"expected 2, got {len(non_empty)}")


def test_field_extraction():
    block = (
        "Incident Information: Incident Number: NY2600417070 Incident Category: Domestic - dispute\n"
        "Date/Time Reported: March 27, 2026 08:58 PM Station: SCHODACK\n"
        "Location Code: TOWN - NASSAU - 4255 Incident Status: Arrest adult\n"
        "Defendant Information:\n"
        "Defendant (1) Name: JANE DOE Age: 34\n"
        "Defendant Address: NASSAU, New York\n"
        "Date/Time of Arrest: 03/27/2026 09:39 PM Arrestee Status: Central arraignment\n"
    )
    f = _extract_nysp_fields(block)
    _report("field_incident_number", f["incident_number"] == "NY2600417070")
    _report("field_category", f["incident_category"] == "Domestic - dispute",
            f"got: {f['incident_category']!r}")
    _report("field_station", f["station"] == "SCHODACK", f"got: {f['station']!r}")
    _report("field_location", "NASSAU" in f["location_code"])
    _report("field_status", f["incident_status"] == "Arrest adult",
            f"got: {f['incident_status']!r}")
    _report("field_defendant", f["defendant_name"] == "JANE DOE",
            f"got: {f['defendant_name']!r}")
    _report("field_age", f["defendant_age"] == "34")
    _report("field_arrestee_status", "Central arraignment" in f["arrestee_status"],
            f"got: {f['arrestee_status']!r}")


def test_field_extraction_accident():
    block = (
        "Incident Information: Incident Number: NY2600418617 Incident Category: Accident - personal injury\n"
        "Date/Time Reported: March 28, 2026 10:35 AM Station: NEW SCOTLAND\n"
        "Location Code: TOWN - NEW SCOTLAND - 0157 Incident Status: Closed/cleared\n"
        "Driver Information:\n"
        "Driver (1): A PERSON DELANSON, NY Age: 21\n"
        "Number of Vehicles: 3 Number Killed: 0 Number Injured: 1\n"
        "Road/Highway: STATE FARM RD\n"
        "Intersection:\n"
        "Location: TOWN - NEW SCOTLAND - 0157\n"
    )
    f = _extract_nysp_fields(block)
    _report("accident_num_vehicles", f["num_vehicles"] == "3")
    _report("accident_num_injured", f["num_injured"] == "1")
    _report("accident_road", f["road"] == "STATE FARM RD", f"got: {f['road']!r}")


def test_municipality_extraction():
    _report("muni_town", _extract_nysp_municipality("TOWN - NASSAU - 4255") == "Nassau")
    _report("muni_city", _extract_nysp_municipality("CITY - ALBANY - 0101") == "Albany")
    _report("muni_village", _extract_nysp_municipality("VILLAGE - CASTLETON-ON-HUDSON - 4224") == "Castleton-On-Hudson")
    _report("muni_empty", _extract_nysp_municipality("") == "Albany County")


def test_datetime_parsing():
    dt1 = _parse_nysp_datetime("March 27, 2026 08:58 PM")
    _report("datetime_long_format", dt1 is not None and dt1.hour == 20 and dt1.minute == 58)
    dt2 = _parse_nysp_datetime("03/28/2026 01:43 PM")
    _report("datetime_short_format", dt2 is not None and dt2.day == 28)
    _report("datetime_empty", _parse_nysp_datetime("") is None)


def test_title_building():
    t1 = _build_nysp_title("Domestic - dispute", "Arrest adult", "Nassau", {})
    _report("title_arrest", t1 == "NYSP Arrest: Domestic - dispute — Nassau", f"got: {t1!r}")

    t2 = _build_nysp_title("Vehicle - DWI", "Investigation pending", "Berne",
                           {"arrestee_status": "Appearance ticket"})
    _report("title_dwi_arrest", t2 == "NYSP DWI Arrest — Berne", f"got: {t2!r}")

    t3 = _build_nysp_title("Welfare check", "Closed/cleared", "Brunswick", {})
    _report("title_routine", t3 == "NYSP: Welfare check — Brunswick", f"got: {t3!r}")


def test_severity_mapping():
    _report("sev_arrest", _nysp_severity("Domestic", "Arrest adult", {}) == "medium")
    _report("sev_dwi_arrest", _nysp_severity("Vehicle - DWI", "Arrest adult", {}) == "medium")
    _report("sev_closed_assault",
            _nysp_severity("Assault - simple", "Closed/cleared", {}) == "medium")
    _report("sev_active_assault",
            _nysp_severity("Assault", "Investigation pending", {}) == "high")
    _report("sev_fatal", _nysp_severity("Accident", "Closed", {"num_killed": "1"}) == "critical")
    _report("sev_closed_routine", _nysp_severity("Welfare check", "Closed/cleared", {}) == "low")
    _report("sev_felony_charge",
            _nysp_severity("Larceny", "Closed", {"charges": ["Grand Larceny (Felony)"]}) == "high")


def test_crime_type_mapping():
    _report("ctype_violent", _nysp_crime_type("Assault - simple") == "violent")
    _report("ctype_property", _nysp_crime_type("Larceny") == "property")
    _report("ctype_traffic", _nysp_crime_type("Vehicle - DWI") == "traffic")
    _report("ctype_drugs", _nysp_crime_type("Drug possession") == "drugs")
    _report("ctype_other", _nysp_crime_type("Welfare check") == "other")


def test_description_building():
    fields = {
        "incident_category": "Vehicle - DWI",
        "incident_status": "Arrest adult",
        "station": "BRUNSWICK",
        "defendant_name": "JOHN DOE",
        "defendant_age": "28",
        "arrestee_status": "Release to 3rd party",
        "charges": ["Driving While Intoxicated (Misdemeanor)"],
    }
    desc = _build_nysp_description(fields)
    _report("desc_has_category", "Vehicle - DWI" in desc)
    _report("desc_has_defendant", "JOHN DOE" in desc and "age 28" in desc)
    _report("desc_has_charges", "Driving While Intoxicated" in desc)
    _report("desc_no_noise", "file:///" not in desc and "Tax Law" not in desc)


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------

test_ligature_fix()
test_header_stripping()
test_filepath_stripping()
test_creation_line_stripped()
test_block_splitting()
test_field_extraction()
test_field_extraction_accident()
test_municipality_extraction()
test_datetime_parsing()
test_title_building()
test_severity_mapping()
test_crime_type_mapping()
test_description_building()

print(f"\n{passed}/{passed + failed} tests passed")
if failed:
    sys.exit(1)
