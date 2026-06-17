from fastapi import APIRouter, Query
from app.services.scanner_v4 import AdvancedScanner

router = APIRouter(prefix="/scanner/v4", tags=["Scanner v4 - Advanced"])

@router.get("/critical")
async def get_critical_feed(limit: int = Query(50, ge=1, le=200)):
    scanner = AdvancedScanner()
    return await scanner.get_critical_feed(limit=limit)

@router.get("/all")
async def get_all_feed(limit: int = Query(100, ge=1, le=500)):
    scanner = AdvancedScanner()
    all_calls = await scanner.ingest_from_all_sources()
    processed = []
    for c in all_calls:
        try:
            processed.append(await scanner.process_call(c.__dict__ if hasattr(c, "__dict__") else c))
        except Exception:
            continue
    return [scanner._to_card(c) for c in sorted(processed, key=lambda x: x.timestamp, reverse=True)[:limit]]

@router.get("/municipalities")
async def get_municipalities():
    from app.services.agency_registry import albany_county_municipality_set
    return sorted(albany_county_municipality_set())
