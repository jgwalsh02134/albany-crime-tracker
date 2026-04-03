from __future__ import annotations

from datetime import datetime
from typing import Any
from typing import Optional

from sqlalchemy import DateTime
from sqlalchemy import Float
from sqlalchemy import Index
from sqlalchemy import String
from sqlalchemy import Text
from sqlalchemy import UniqueConstraint
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.orm import Mapped
from sqlalchemy.orm import mapped_column
from sqlalchemy.types import JSON


class Base(DeclarativeBase):
    pass


class IncidentORM(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        UniqueConstraint("source_fingerprint", name="uq_incidents_source_fingerprint"),
        Index("ix_incidents_occurred_at", "occurred_at"),
        Index("ix_incidents_published_at", "published_at"),
        Index("ix_incidents_municipality", "municipality"),
        Index("ix_incidents_incident_type", "incident_type"),
        Index("ix_incidents_status", "status"),
        Index("ix_incidents_source_type", "source_type"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    external_id: Mapped[str] = mapped_column(Text, default="", index=True)
    source_fingerprint: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    incident_type: Mapped[str] = mapped_column(String(120), default="general")
    severity: Mapped[str] = mapped_column(String(32), default="unknown")
    status: Mapped[str] = mapped_column(String(32), default="unknown")
    source_type: Mapped[str] = mapped_column(String(64), default="unknown")
    source_name: Mapped[str] = mapped_column(Text, default="")
    source_url: Mapped[str] = mapped_column(Text, default="")
    occurred_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    municipality: Mapped[str] = mapped_column(Text, default="")
    address_text: Mapped[str] = mapped_column(Text, default="")
    latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    confidence_score: Mapped[float] = mapped_column(Float, default=0.0)
    verification_level: Mapped[str] = mapped_column(String(64), default="unknown")
    tags: Mapped[list[str]] = mapped_column(JSON().with_variant(JSONB, "postgresql"), default=list)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        default=dict,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

