# Albany Crime Tracker

FastAPI + static frontend app for Albany County public safety intelligence:
- Live feed (Now / Confirmed / Context)
- Scanner activity
- Directory
- Incident map
- AI chat summaries

This repo has been modularized incrementally for production-safe evolution while preserving existing UI and routes.

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
- `DATA_GOV_API_KEY` (FBI CDE API; falls back to demo key if empty)
- `SOCRATA_APP_TOKEN` (Albany open data rate limits)

Prepared placeholders for upcoming integrations:
- `DATABASE_URL`
- `REDIS_URL`
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
python scripts/validate_routes.py
```

## Deployment notes (Railway)

- Keep service start command compatible with current deploys: `python api_server.py`
- Ensure Railway env vars are set from `.env.example`
- Health checks can use:
  - `/health` (liveness)
  - `/ready` (readiness)
- Logging now emits structured JSON, making Railway logs easier to query.

## Current architecture highlights

- Legacy monolith remains in `api_server.py` for compatibility.
- New modular foundation in `app/`:
  - `app/core/` config, logging, error handling
  - `app/api/` health/readiness router
  - `app/models/` normalized incident schema
  - `app/services/` cache abstraction, retrying HTTP client, incident transformers
- Frontend modules added in `frontend/` (api/feed/map/scanner/chat/directory/shared), loaded before `app.js`.

## Next planned integrations

- Postgres + PostGIS persistence for normalized incidents
- Redis cache backend replacing in-memory cache
- Map provider hardening (Mapbox / Google Maps tokenized flows)
- Sentry error tracking and release health
- Product analytics via PostHog
