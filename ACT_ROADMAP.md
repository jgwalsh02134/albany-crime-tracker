# ACT Roadmap — Where You Are and Where to Go

*Generated 2026-03-30. Honest assessment and prioritized plan.*

---

## Current State: Honest Assessment

### What's solid

The **backend architecture** is the strongest part of ACT. You have real, working infrastructure that most projects at this stage don't:

- FastAPI serving 43+ API routes with structured error handling
- Postgres persistence with smart multi-fingerprint deduplication
- Redis caching with TTLs, refresh guards, and graceful in-memory fallback
- 14 RSS feed sources with tiered reliability scoring and Albany geo-filtering
- Socrata open data integration (crimes, arrests, calls-for-service)
- xAI Grok-3 streaming chat with SSE
- Scanner call aggregation with talkgroup alias resolution
- Health/readiness endpoints ready for Railway
- Source registry and audit tooling (411 sources discovered)

This is not throwaway work. The data pipeline, dedup logic, and source model are genuinely well thought out.

### What's not working

**Frontend is the critical gap.** The HTML shell is well-structured (good semantic markup, accessibility attributes, mobile-first meta tags), but the JavaScript is a 3,453-line monolith (`app.js`) that does everything — view switching, feed rendering, scanner playback, map management, chat, directory, trends. The `frontend/` modules exist but are essentially empty stubs.

**Specific problems:**

1. **Home/Live feed** — Works but cards are basic. No detailed incident view, no source attribution visible, no time-relative display ("2 hours ago").
2. **Map** — Leaflet loads and markers render, but geocoding is stubbed out (TODO in `incident_transformers.py`). Most incidents have no coordinates, so the map is mostly empty.
3. **Scanner** — Call list renders and audio player exists, but the UX is rough. Agency resolution works via alias registry, but municipality display is inconsistent.
4. **AI Chat** — Backend SSE streaming works. Frontend has the form but the message rendering and streaming display need work.
5. **Directory** — Backend endpoints exist for agencies, municipalities, media, community. Frontend lazy-loads but rendering is minimal.
6. **News mode** — Recently added (3 days ago) but the sections (Major Stories, Developing, Recaps) need real content rendering logic.

**Architecture debt:**

- `api_server.py` is 5,134 lines — a monolith that should be split into route modules
- `app.js` is 3,453 lines — same problem on the frontend
- No Dockerfile or `railway.toml` for reproducible deploys
- No database migration system (relies on `create_all()` at startup)
- No tests anywhere
- Frontend modules under `frontend/` are dead code — real logic lives in `app.js`

---

## Roadmap: 4 Phases

### Phase 1: Make It Usable (1-2 weeks)
*Goal: A stranger can open the app on their phone and understand what it does.*

| # | Task | Why it matters |
|---|------|----------------|
| 1.1 | **Fix incident card rendering** — time-relative display, source badge, severity indicator, clean typography | Cards are the core product surface. Right now they're walls of text. |
| 1.2 | **Wire up News mode** — connect Major Stories / Developing / Recaps to `/api/home/news` data, render real cards | News mode was just added but renders skeletons. |
| 1.3 | **Fix AI Chat streaming UI** — render streaming tokens as they arrive, handle markdown, show typing indicator | The backend works. The frontend just needs to display it properly. |
| 1.4 | **Polish Scanner view** — better call cards with agency/municipality/discipline badges, working audio player UX | Scanner is a differentiator. It should feel real-time. |
| 1.5 | **Wire up Directory rendering** — render agency cards, municipality list, media sources from the existing API endpoints | Backend serves the data. Frontend just needs to display it. |
| 1.6 | **Mobile layout pass** — test every view at 375px, fix overflow/scroll issues, ensure bottom nav doesn't overlap content | "Mobile-first" is in the README but hasn't been verified. |

### Phase 2: Make It Trustworthy (1-2 weeks)
*Goal: Data feels real, fresh, and attributable.*

| # | Task | Why it matters |
|---|------|----------------|
| 2.1 | **Add geocoding** — implement address-to-coordinates in `incident_transformers.py` (Nominatim or Mapbox) | Map is empty without coordinates. This is the #1 map blocker. |
| 2.2 | **Source transparency on cards** — show source name, tier badge, "via Times Union" or "via scanner" on every card | ACT's core promise is source trust. Cards don't show sources. |
| 2.3 | **Feed/map sync** — ensure the same incidents appear in both feed and map, with consistent IDs | Currently these can drift apart. |
| 2.4 | **Freshness indicators** — show "Last updated X min ago" on feeds, pulse dot behavior that reflects actual data age | Users need to trust that data is current. |
| 2.5 | **Error states** — when sources fail, show graceful empty states instead of broken skeletons | Several source failures leave the UI in loading state forever. |
| 2.6 | **Summary strip** — make the top summary grid (incident counts by type) actually useful with real numbers | Currently shows "Loading..." or stale data. |

### Phase 3: Make It Solid (2-3 weeks)
*Goal: Professional deployment, no more "works on my machine."*

| # | Task | Why it matters |
|---|------|----------------|
| 3.1 | **Split `api_server.py`** — extract route groups into `app/api/` modules (incidents, scanner, chat, directory, nibrs) | 5,134-line file is unmaintainable. |
| 3.2 | **Split `app.js`** — move real logic into `frontend/` modules, make `app.js` just the bootstrapper | 3,453-line file is unmaintainable. |
| 3.3 | **Add Dockerfile + `railway.toml`** — reproducible builds, proper health check config | Currently relying on Railway auto-detection. |
| 3.4 | **Add Alembic migrations** — stop using `create_all()`, manage schema changes properly | Any schema change currently requires manual DB work. |
| 3.5 | **Basic test suite** — health check tests, source fetcher tests, dedup logic tests | Zero tests means zero confidence in changes. |
| 3.6 | **Environment validation** — startup check that required env vars are set, clear error messages for missing keys | Missing API keys currently cause cryptic runtime errors. |

### Phase 4: Make It Great (ongoing)
*Goal: The features that make ACT the go-to source.*

| # | Task | Why it matters |
|---|------|----------------|
| 4.1 | **Push notifications** — web push for critical incidents (shootings, major fires, AMBER alerts) | Real-time awareness is the killer feature. |
| 4.2 | **AI-powered situation reports** — auto-generated "What happened today" summaries on Home | Saves users from reading every card. |
| 4.3 | **Incident detail view** — tap a card to see full details, related incidents, source chain, map pin | Currently cards are dead-ends. |
| 4.4 | **Search** — full-text search across incidents, scanner calls, and directory | HTML has search inputs but they're not wired up. |
| 4.5 | **Historical trends** — use the DCJS/FBI data to show "crime is up/down X% vs last year" | The data pipeline exists but the visualization doesn't. |
| 4.6 | **PWA install** — service worker, offline support, app-like experience | Mobile-first means installable. |

---

## Recommended Starting Point

**Phase 1, Task 1.1** — fix incident card rendering. This is the single highest-impact change because cards are what users see first, on every view. A good card has: a clear title, a time-relative timestamp, a source badge, a severity/type indicator, and a one-line summary. Everything else builds on this.

---

## File Map (quick reference)

```
Key backend:
  api_server.py          5,134 lines  — monolith (routes + logic)
  incident_intelligence.py 1,100 lines — constants, keywords, enums
  app/services/incident_repository.py  1,006 lines — persistence/dedup
  app/services/cache.py                  245 lines — Redis + memory cache
  sources/tier1_official.py              — 14 RSS feeds
  sources/albany_open_data.py            — Socrata integration

Key frontend:
  index.html               525 lines  — shell (well-structured)
  app.js                 3,453 lines  — monolith (all view logic)
  style.css              3,057 lines  — styles
  frontend/*/              — stub modules (not yet functional)

Config:
  .env.example             — env template
  requirements.txt         — Python deps (minimal)
  Procfile                 — Railway start command (if exists)
```
