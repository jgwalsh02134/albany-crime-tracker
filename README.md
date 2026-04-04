# Albany Crime Tracker

FastAPI + static frontend app for Albany County public safety intelligence:

- Live feed (Now / Confirmed / Context)
- Scanner activity
- Directory
- Incident map
- AI chat summaries

This repo now includes production-safe persistence and caching:

- Postgres incident persistence via `DATABASE_URL`
- Redis-backed cache/refresh locking via `REDIS_URL` (with in-memory fallback)

## Local setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Run backend + static app:

```bash
python api_server.py
```

Open: `http://127.0.0.1:8000`

## Environment variables

Required for full functionality:

- `XAI_API_KEY` (AI chat / summaries)
- `FBI_API_KEY` (primary FBI CDE/api.data.gov key)
- `SOCRATA_APP_TOKEN` (Albany open data rate limits)
- `DATABASE_URL` (Postgres persistence for `/api/incidents`)
- `REDIS_URL` (cache + refresh lock; optional but recommended)

Important source-integration credentials already supported:

- `511_NY_API_KEY` (used for 511NY GetEvents + GetCameras fusion)
- `RADIOREFERENCE_API_KEY`, `RADIOREFERENCE_USERNAME`, `RADIOREFERENCE_PASSWORD` (RadioReference SOAP + Albany/Schenectady P25 wiki-seeded talkgroup map; see `scanner_albany_p25_main` in `source_registry.json`)
- `BROADCASTIFY_API_KEY`, `BROADCASTIFY_SYSTEM_ID` (optional; merged scanner call list when Calls API is available)

Prepared placeholders for upcoming integrations:

- `MAPBOX_TOKEN`
- `GOOGLE_MAPS_API_KEY`
- `SENTRY_DSN`
- `POSTHOG_KEY`
- `OPENROUTER_API_KEY`

Runtime and flags:

- `ENVIRONMENT`, `LOG_LEVEL`, `APP_NAME`, `APP_VERSION`
- `EXTERNAL_TIMEOUT_SECONDS`, `EXTERNAL_RETRY_ATTEMPTS`
- `FEATURE_AI_CHAT`, `FEATURE_SCANNER`, `FEATURE_LIVE_FEED`, `FEATURE_DIRECTORY`, `FEATURE_MAP`

## Run commands

Start app:

```bash
python api_server.py
```

Alternative startup entrypoint (new package path):

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Validate critical routes:

```bash
./venv/bin/python scripts/validate_routes.py
```

Manual checks for P25 talkgroup mapping (wiki seed merges even without SOAP credentials; with credentials you should see `rr_row_present` on rows):

```bash
python3 -c "from sources.advanced_adapters import get_talkgroup_mapper, SCANNER_ALBANY_P25_MAIN; m=get_talkgroup_mapper(); d=m.merge_rr_with_wiki({}); print(SCANNER_ALBANY_P25_MAIN['priority_talkgroups']); print({k:d[k].get('wiki_channel_label') for k in sorted(d) if k in m.priority_ids()})"
```

RadioReference SOAP auth (premium) smoke test:

```bash
python3 scripts/test_rr_auth.py
```

Merged scanner API (OpenMHz + optional Broadcastify + RR-enriched talkgroups):

```bash
curl -s http://127.0.0.1:8000/api/scanner/calls | python3 -m json.tool | head -n 80
```

Prime/persist incidents and query Postgres-backed endpoint:

```bash
curl -s http://127.0.0.1:8000/api/crimes > /dev/null
curl -s "http://127.0.0.1:8000/api/incidents?limit=20"
```

## Deployment notes (Railway)

- Keep service start command compatible with current deploys: `python api_server.py`
- Ensure Railway env vars are set from `.env.example`
- For Albany/Schenectady P25 scanner intelligence, set the same RadioReference variables as local (no extra app keys). Without them, the app still applies the hard-seeded wiki talkgroup map for priority TGs; SOAP fills in `rr_row_present` metadata when credentials work.
- Optional: set `511_NY_API_KEY` so priority scanner feed rows can attach a short 511NY snapshot for traffic context in the same refresh cycle.
- Health checks can use:
  - `/health` (liveness)
  - `/ready` (readiness)
- Logging now emits structured JSON, making Railway logs easier to query.
- Startup behavior:
  - if `DATABASE_URL` is set, `incidents` table/indexes are created automatically at boot
  - this is intentionally isolated and replaceable later by Alembic migrations
- Redis behavior:
  - if `REDIS_URL` is set and reachable, cache uses Redis
  - if unavailable, app degrades to in-memory cache automatically

## Current architecture highlights

- Legacy monolith remains in `api_server.py` for compatibility.
- New modular foundation in `app/`:
  - `app/core/` config, logging, error handling
  - `app/api/` health/readiness router
  - `app/db/` SQLAlchemy models/session for Postgres
  - `app/models/` normalized incident schema
  - `app/services/` cache abstraction, retrying HTTP client, incident transformers, persistence repository
- Frontend modules added in `frontend/` (api/feed/map/scanner/chat/directory/shared), loaded before `app.js`.
