from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from typing import Optional

from pydantic import BaseModel, Field


IncidentSeverity = Literal["low", "medium", "high", "critical", "unknown"]
IncidentStatus = Literal["active", "recent", "cleared", "historical", "unknown"]
IncidentSourceType = Literal["scanner", "official_alerts", "local_news", "enrichment", "open_data", "unknown"]
IncidentVerification = Literal["official", "multi_source", "media", "scanner", "inferred", "unknown"]


class ProvenanceOrigin(BaseModel):
    source_class: str = ""
    source_id: str = ""
    trust_tier: str = ""
    lane: str = ""
    ingestion_method: str = ""
    feed_url: str = ""


class ProvenanceCapture(BaseModel):
    captured_at: str = ""
    raw_fields_hash: str = ""
    content_type: str = ""
    capture_method: str = ""


class ProvenanceStep(BaseModel):
    step: str = ""
    module: str = ""
    function: str = ""
    timestamp: str = ""


class ProvenanceConfidence(BaseModel):
    score: float = 0.0
    rationale: str = ""
    geocode_quality: str = ""
    verification_level: str = ""
    locality_signal: str = ""


class ProvenanceFusion(BaseModel):
    fused: bool = False
    source_ids: list[str] = Field(default_factory=list)
    source_count: int = 0
    primary_source_id: str = ""
    merge_method: str = ""


class IncidentProvenance(BaseModel):
    origin: ProvenanceOrigin = Field(default_factory=ProvenanceOrigin)
    raw_capture: ProvenanceCapture = Field(default_factory=ProvenanceCapture)
    extraction_chain: list[ProvenanceStep] = Field(default_factory=list)
    confidence: ProvenanceConfidence = Field(default_factory=ProvenanceConfidence)
    fusion: Optional[ProvenanceFusion] = None


def build_provenance(
    *,
    source_class: str = "",
    source_id: str = "",
    trust_tier: str = "",
    lane: str = "",
    ingestion_method: str = "",
    feed_url: str = "",
    captured_at: str = "",
    raw_fields_hash: str = "",
    content_type: str = "",
    capture_method: str = "",
) -> dict[str, Any]:
    """Build a provenance dict at ingestion time. Returns plain dict for JSONB storage."""
    return {
        "origin": {
            "source_class": source_class,
            "source_id": source_id,
            "trust_tier": trust_tier,
            "lane": lane,
            "ingestion_method": ingestion_method,
            "feed_url": feed_url,
        },
        "raw_capture": {
            "captured_at": captured_at,
            "raw_fields_hash": raw_fields_hash,
            "content_type": content_type,
            "capture_method": capture_method,
        },
        "extraction_chain": [],
        "confidence": {
            "score": 0.0,
            "rationale": "",
            "geocode_quality": "",
            "verification_level": "",
            "locality_signal": "",
        },
        "fusion": None,
    }


def append_provenance_step(
    provenance: dict[str, Any],
    *,
    step: str,
    module: str,
    function: str,
    timestamp: str = "",
) -> dict[str, Any]:
    """Append a processing step to a provenance dict. Returns the same dict."""
    chain = provenance.get("extraction_chain")
    if not isinstance(chain, list):
        chain = []
        provenance["extraction_chain"] = chain
    chain.append({
        "step": step,
        "module": module,
        "function": function,
        "timestamp": timestamp or datetime.utcnow().isoformat() + "Z",
    })
    return provenance


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
    provenance: dict[str, Any] = Field(default_factory=dict)

    # Canonical agency identity for the responding agency, when one resolves.
    # Populated by the transformer via app.services.agency_registry.
    # Optional / nullable so unknown sources stay null rather than blocking
    # ingest; the schemas/incident.schema.json `responding_agency` field is
    # this column's downstream consumer.
    responding_agency_id: Optional[str] = None

    # DB-ready metadata hooks (Postgres/PostGIS)
    geom_wkt: Optional[str] = None
    external_ref: Optional[str] = None

