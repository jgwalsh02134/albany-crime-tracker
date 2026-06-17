"""
Improved Geo Filter for Albany County Crime Tracker

Goals:
- Accept more nearby Capital Region towns (Brunswick, Halfmoon, Clifton Park, Malta, etc.)
- Better NYSP call attribution
- Reduce false rejections while still filtering clearly non-local events
"""

from typing import Dict, Any, Optional
import re

# Expanded list of accepted nearby towns (Capital Region / greater Albany area)
NEARBY_TOWNS = {
    "albany", "colonie", "bethlehem", "guilderland", "coeymans", "new scotland",
    "rensselaerville", "westerlo", "berne", "knox", "voorheesville", "green island",
    "menands", "watervliet", "troy", "schenectady", "saratoga springs",
    # Nearby towns that frequently appear in NYSP calls
    "brunswick", "halfmoon", "clifton park", "malta", "stillwater", "mechanicville",
    "ballston spa", "burnt hills", "scotia", "rotterdam", "niskayuna",
    "east greenbush", "north greenbush", "sand lake", "hoosick falls", "hoosick",
    "pittstown", "schaghticoke", "valley falls", "schodack", "nassau",
}

# Strong Albany County anchors
ALBANY_COUNTY_ANCHORS = {
    "albany county", "albany city", "city of albany", "town of colonie",
    "bethlehem", "guilderland", "coeymans", "new scotland", "rensselaerville",
}

NYSP_KEYWORDS = {"nysp", "new york state police", "state police"}


def has_albany_county_locality(text: str, source: str = "") -> bool:
    text_lower = text.lower()

    # Direct Albany County anchors
    for anchor in ALBANY_COUNTY_ANCHORS:
        if anchor in text_lower:
            return True

    # Check for nearby towns (expanded)
    for town in NEARBY_TOWNS:
        if town in text_lower:
            return True

    # NYSP calls often mention towns without "Albany County" — accept if from known nearby area
    if any(kw in text_lower for kw in NYSP_KEYWORDS):
        # If it mentions a nearby town, accept it
        for town in NEARBY_TOWNS:
            if town in text_lower:
                return True

    return False


def should_accept_incident(incident: Dict[str, Any]) -> tuple[bool, str]:
    """
    Returns (accept, reason)
    """
    text = incident.get("raw_text") or incident.get("description") or incident.get("title", "")
    source = incident.get("source", "")

    if has_albany_county_locality(text, source):
        return True, "accepted"

    # Special case: NYSP calls from Capital Region
    if any(kw in text.lower() for kw in NYSP_KEYWORDS):
        # Accept NYSP calls that mention common nearby towns even without perfect anchor
        for town in ["brunswick", "halfmoon", "clifton park", "malta", "stillwater", "schodack"]:
            if town in text.lower():
                return True, "nysp_nearby_town_accepted"

    return False, "no_albany_county_locality_evidence"
