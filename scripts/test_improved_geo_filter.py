"""
Test the improved geo filter
"""
from app.services.geo_filter import should_accept_incident

test_cases = [
    ("NYSP: Accident - property damage — Brunswick", True),
    ("NYSP: Vehicle - disabled — Halfmoon", True),
    ("NYSP: Aid - assist citizen — Clifton Park", True),
    ("NYSP: Welfare check — Malta", True),
    ("NYSP: Disturbance — Schodack", True),
    ("NYSP: Accident — Gloversville", False),  # Too far
    ("Albany Police: Domestic — Albany", True),
]

for text, expected in test_cases:
    incident = {"raw_text": text, "source": "nysp"}
    accepted, reason = should_accept_incident(incident)
    status = "PASS" if accepted == expected else "FAIL"
    print(f"{status}: {text} -> {accepted} (expected {expected})")