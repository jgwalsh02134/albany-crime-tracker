# ACT JSON Schemas — Status & Reconciliation

These schemas are **planning / contract documents**, not currently
enforced at runtime. The runtime incident model lives at
[`app/models/incident.py`](../app/models/incident.py) (`IncidentRecord`)
and the source registry shape lives in
[`source_registry.json`](../source_registry.json) (436 entries).

This file maps planned fields ↔ actual implementation so future code
passes can converge the two without re-deriving the gap each time.

---

## incident.schema.json ↔ `IncidentRecord`

| Planned field | Required | Status | Actual location |
|---|---|---|---|
| `incident_id` | ✓ | rename | `IncidentRecord.id` |
| `external_ids` (object) | | partial | `IncidentRecord.external_ref` (single string) — multi-source ids not yet tracked |
| `created_at` | ✓ | implicit | `IncidentORM.created_at` (DB column, not model) |
| `updated_at` | ✓ | implicit | `IncidentORM.updated_at` (DB column, not model) |
| `incident_datetime` | | rename | `IncidentRecord.occurred_at` |
| `incident_datetime_precision` | | **missing** | — |
| `reported_datetime` | | rename | `IncidentRecord.published_at` |
| `title` | ✓ | ✓ | `IncidentRecord.title` |
| `description` | | ✓ | `IncidentRecord.description` |
| `incident_type` | | ✓ | `IncidentRecord.incident_type` |
| `incident_type_raw` | | **missing** | — |
| `penal_law_charges` (array) | | **missing** | — |
| `severity` | ✓ | ✓ | `IncidentRecord.severity` |
| `severity_rationale` | | **missing** | — |
| `status` | ✓ | ✓ | `IncidentRecord.status` |
| `locality` (object) | ✓ | flat | spread across `municipality` / `latitude` / `longitude` / `address_text` — not nested |
| `responding_agency` | | **missing field**, helper exists | `app.services.agency_registry.resolve_agency_from_call()` returns this; never persisted |
| `additional_agencies` (array) | | **missing** | — |
| `arrests` (array) | | **missing** | — |
| `scanner_data` (object) | | partial | `raw_payload._scanner_call` is loosely-shaped; not validated against the schema's `scanner_data` shape |
| `sources` (array) | ✓ | **major gap** | `IncidentRecord` is single-source (`source_name` + `source_url`). Frontend `_linked_sources` clusters at render time but does not persist |
| `media_coverage` (array) | | partial | only the frontend `_linked_sources` derived at cluster-render time |
| `tags` | | ✓ | `IncidentRecord.tags` |
| `is_give_tracked` | | **missing** | — |
| `is_federal` | | partial | derived heuristically in `app.js` (`isFederal = sourceType==="federal" || /\\busao|us attorney|doj/`); not persisted |
| `meta` (object) | | rename | `IncidentRecord.provenance` |

### Highest-impact gaps to close in future passes
1. **Multi-source `sources` array** — biggest semantic gap. Today, dedupe collapses variant spellings to one row (per `b43e55d`) but only stores the winning source. The schema's intent is to keep all source links + per-source provenance on a single incident.
2. **Nested `locality` object** — current flat fields work but lose shape (e.g. neighborhood / patrol zone vs municipality). Schema separates them.
3. **`responding_agency` persistence** — the resolver exists already; the missing piece is writing `agency_id` to the row at upsert time. Touches `IncidentRecord` and `IncidentORM`, requires a migration.

## source.schema.json ↔ `source_registry.json`

| Planned field | Required | Status | Actual key (sample entry) |
|---|---|---|---|
| `source_id` | ✓ | ✓ | `source_id` |
| `canonical_name` | ✓ | rename | `source_name` |
| `short_name` | | **missing** | — (canonical agency registry has it; not on source entries) |
| `aliases` (array) | | **missing** | — (canonical agency registry has it; not on source entries) |
| `source_category` | ✓ | rename | `category` |
| `source_type` | ✓ | partial | `category` overlaps `source_category` |
| `owner_agency_id` | | partial | `organization` (free-text, not an id reference) |
| `jurisdiction_level` | ✓ | **missing** | implied by `category` (e.g. `state` / `municipal`) |
| `municipalities_covered` (array) | | partial | `geography_scope` (single string) |
| `county` | | **missing** | — (always implicit "Albany" for in-scope sources) |
| `state` | | **missing** | — |
| `is_albany_county_primary` | | **missing** | — (canonical agency registry has it; not on source entries) |
| `is_operational_live` | ✓ | partial | `active_status` (boolean) |
| `priority` | ✓ | partial | `trust_tier` |
| `implementation_status` | | rename | `validation_status` |
| `implementation_notes` | | rename | `coverage_notes` |
| `endpoints` (array) | ✓ | flat | `api_url`, `feed_url`, `canonical_url` are 3 separate strings |
| `poll_config` (object) | | **missing** | — (cadence is determined globally by `BACKGROUND_*_INGEST_SECONDS` env vars, not per-source) |
| `data_format` (object) | | **missing** | — |
| `credibility_tier` | | rename | `trust_tier` |
| `content_types` (array) | | partial | `lane` (single tag) |
| `geographic_notes` | | partial | `geography_scope` |
| `dispatch_psap` | | **missing on entry**, present in agency layer | `data/agencies.json` has `dispatch_psap` per agency, not per source |
| `p25_talkgroups` (array) | | **missing on entry**, present in alias layer | `data/scanner_aliases.json` keyed by talkgroup id |
| `broadcastify_feed_ids` (array) | | **missing** | — |
| `nixle_url` | | partial | folded into `social_urls` |
| `social_media` (object) | | partial | `social_urls` (different shape) |
| `contact` (object) | | **missing** | — |
| `last_successful_ingest` | | rename | `last_checked_at` |
| `health_status` | | **missing** | — (the global `_BACKGROUND_INGEST_STATS` tracks per-loop health, not per-source) |
| `notes` | | partial | `coverage_notes` / `legal_notes` |

### Highest-impact gaps to close in future passes
1. **`endpoints` array** — replacing `api_url`/`feed_url`/`canonical_url` with a typed list would let one source declare multiple ingestable URLs (e.g. RSS + JSON + scrape fallback).
2. **`poll_config` per source** — today, cadence is global per loop type. Per-source cadence would let high-frequency operational sources pull faster than monthly Socrata refreshes without separate background loops.
3. **Cross-link to `data/agencies.json`** — `owner_agency_id` should reference an `agency_id` from `data/agencies.json` so source provenance and agency identity converge.

---

## What in the new master reference is already outdated

The reference doc was compiled before some recent passes landed:

- **APD Socrata is now in background ingest** (commit `45e8bee`). The reference describes it as a dev-endpoint-only resource. It is opt-in via `SOCRATA_INGEST_SECONDS` and persists through the standard incident pipeline.
- **Talkgroup → canonical agency mapping exists** (commit `45e8bee`). The reference mentions `data/scanner_aliases.json` as a planning asset. It is loaded by `app/services/agency_registry.py` and joined to `data/agencies.json` (the canonical agency layer also not mentioned in the reference).
- **`false_local_quarantine` tag** is not mentioned in the reference but is the live cleanup mechanism (commits `a418f29`, `77c033a`, `de19e3c`).
- **`_BACKGROUND_INGEST_STATS` + `/api/sources/health`** provide live source-health visibility (commits `7cc6483`, `f8cc8cc`, `45e8bee`). The reference's `health_status` field could be backed by this surface.
- **Canonical source normalization at fingerprint time** (commit `b43e55d`) means "Albany PD" / "Albany Police" / "City of Albany Police Department" already collapse to one incident — the schema's multi-source `sources` array is the next correct step but the dedupe groundwork is in.

---

## Stance on enforcement

These schemas are **not currently used at runtime**. Adding a validation
layer is appropriate only after the field-level gaps above are closed
in `IncidentRecord` and the source registry — otherwise validation would
reject every existing row.

A reasonable migration order, smallest first:
1. Backfill missing-but-trivial fields (`incident_type_raw`,
   `severity_rationale`, `is_federal`, `is_give_tracked`) as optional
   columns on `IncidentORM`. No data loss.
2. Add a JSONB `sources` array column alongside `source_name` /
   `source_url` so multi-source provenance can be persisted. Keep the
   single-source columns for backward compatibility.
3. Persist `responding_agency` as `agency_id` on each row, populated
   from the existing resolver. One column, one migration.
4. Reshape `locality` into a JSONB object after step 3 settles.
5. Source registry shape is bigger; schedule that as its own pass since
   it ripples into `app/services/source_audit.py` and `scripts/build_*`.
