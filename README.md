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

Prime/persist incidents and query Postgres-backed endpoint:

```bash
curl -s http://127.0.0.1:8000/api/crimes > /dev/null
curl -s "http://127.0.0.1:8000/api/incidents?limit=20"
```

## Deployment notes (Railway)

- Keep service start command compatible with current deploys: `python api_server.py`
- Ensure Railway env vars are set from `.env.example`
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
