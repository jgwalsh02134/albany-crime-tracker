# Public Live API (albany.watch)

Albany Watch exposes a small **public, unauthenticated “live incidents” API** intended for newsrooms, bots, and community tooling.

This is **not a CAD feed**. These incidents are fused from multiple public signals (scanner captions, newsroom reporting, civic pages, official posts, etc.). The API includes fields that make uncertainty explicit (verification tier, geo precision, sources, witness flag).

## Endpoints

### `GET /api/public/live`

Returns a stable JSON schema of recent incidents.

- **CORS**: allowed (`Access-Control-Allow-Origin: *`)
- **Auth**: none
- **Rate limit**: IP-based fixed window (currently **120 requests / 60s**)
- **Query params**:
  - `limit` (1–200, default 50)

Response shape:

```json
{
  "ok": true,
  "schema": "albany.watch/public-live/v1",
  "generatedAt": "2026-09-14T18:40:00.000Z",
  "incidents": [
    {
      "id": "evt-abc123",
      "occurredAt": "2026-09-14T18:38:12.000Z",
      "minutesAgo": 2,
      "title": "Report of shots fired",
      "type": "Shots fired",
      "category": "violent",
      "severity": "critical",
      "status": "active",
      "municipality": "Albany",
      "address": "area unknown",
      "lat": 42.65,
      "lng": -73.75,
      "geoPrecision": "town",
      "verificationTier": "developing",
      "verificationWhy": "Scanner only. Radio traffic is early reporting and may be wrong.",
      "sources": [
        {
          "kind": "scanner",
          "tier": "unconfirmed",
          "name": "Broadcastify P25",
          "url": "https://www.broadcastify.com/listen/feed/3626",
          "excerpt": "..."
        }
      ],
      "witness": false
    }
  ]
}
```

Field notes:

- **`verificationTier`**:
  - `confirmed`: at least one official source is present
  - `developing`: multiple early signals, or newsroom-only / mixed signals without official confirmation yet
  - `scanner`: scanner-only
- **`geoPrecision`**: how precise the map point is (`street`, `intersection`, `town`, `county`, etc.). Use it for UI styling and for deciding whether to plot precisely.
- **`sources[]`**: raw provenance of what was fused into the incident. `tier` is one of `official`, `context`, `unconfirmed`.
- **`witness`**: true when a user-submitted witness report is part of the fused incident.

### `GET /api/public/live/rss`

RSS 2.0 feed of recent incidents for legacy tooling.

- **CORS**: allowed (`Access-Control-Allow-Origin: *`)
- **Auth**: none
- **Rate limit**: IP-based fixed window (currently **60 requests / 60s**)
- **Query params**:
  - `limit` (1–200, default 50)

## Abuse controls

- The endpoints are **unauthenticated** by design, but protected with **IP-based rate limiting** (Upstash Redis REST when configured, else Redis TCP, else in-memory per instance).
- Responses intentionally exclude internal diagnostics (pipe health, timeouts, backend flags) that are useful for ops but not needed by consumers.

