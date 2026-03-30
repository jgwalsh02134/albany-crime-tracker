from __future__ import annotations

from datetime import datetime
from typing import Literal
from typing import Optional

from pydantic import BaseModel, Field


IncidentSeverity = Literal["low", "medium", "high", "critical", "unknown"]
IncidentStatus = Literal["active", "recent", "cleared", "historical", "unknown"]
IncidentSourceType = Literal["scanner", "official_alerts", "local_news", "enrichment", "open_data", "unknown"]
IncidentVerification = Literal["official", "multi_source", "media", "scanner", "inferred", "unknown"]


class IncidentRecord(BaseModel):
    id: str = ""
    title: str = ""
    description: str = ""
    incident_type: str = "general"
    severity: IncidentSeverity = "unknown"
    status: IncidentStatus = "unknown"
    source_type: IncidentSourceType = "unknown"
    source_name: str = ""
    source_url: str = ""
    occurred_at: Optional[datetime] = None
    published_at: Optional[datetime] = None
    municipality: str = ""
    address_text: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    confidence_score: float = Field(default=0.0, ge=0.0, le=1.0)
    verification_level: IncidentVerification = "unknown"
    tags: list[str] = Field(default_factory=list)

    # DB-ready metadata hooks (Postgres/PostGIS)
    geom_wkt: Optional[str] = None
    external_ref: Optional[str] = None

