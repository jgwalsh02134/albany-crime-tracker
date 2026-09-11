# Security notes — Albany County Crime Tracker

Honest defense-in-depth for a public-safety dashboard. This is **not** a claim that the app is unhackable.

## Threat model

| Asset | Risk if abused |
| --- | --- |
| Superfeedr webhook (feed / share ingest) | Spoofed articles if HMAC is off or leaked |
| Superfeedr subscribe + rich `/ready` | Credential probing, unintended hub.subscribe |
| AI chat (`askCrimeAi`) | Cost abuse against `XAI_API_KEY`, prompt stuffing |
| Scanner STT / Broadcastify jobs | Availability — must keep working |
| Client bundles | Accidental secret exposure via `VITE_*` |

Attackers are assumed to be internet-anonymous (spam bots, scrapers) and opportunistic. We do **not** model nation-state or insider Redis/host compromise as fully mitigated.

## Controls shipped in this hardening

1. **Security headers (Nitro middleware)** — CSP (Map tiles, Google Fonts, Broadcastify media), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, locked-down `Permissions-Policy`, `X-Frame-Options: DENY`, and `Strict-Transport-Security` when the request is HTTPS (`x-forwarded-proto`).
2. **`/ready`** — Public response is `{ ok: true }` only. Rich JSON (STT key presence flags, Superfeedr/scanner stats) requires an admin token with **constant-time** compare. Unauthenticated GET does **not** kick `hub.subscribe`.
3. **Rate limits (IP)** — Superfeedr webhook (share/feed ingest), subscribe, AI chat, and `/ready`. Backend: Upstash Redis REST if configured, else `REDIS_URL` TCP INCR/EXPIRE, else in-memory per process.
4. **Input validation** — Chat fields strip HTML/control chars and enforce max lengths. Webhook rejects oversized bodies (>512 KiB) and unexpected `Content-Type`.
5. **HMAC** — Superfeedr `X-Hub-Signature` still verified when `SUPERFEEDR_SECRET` is set; bad signatures → 403.
6. **Same-origin / Fetch Metadata** — AI chat calls `assertSameSiteRequest` (existing sibling-tenant guard). Webhook and Broadcastify/STT paths are **not** blocked by same-origin checks.
7. **Dotfiles** — Paths with dotfile segments (e.g. `/.env`, `/.git/config`) return 404 from Nitro middleware.
8. **Client secrets** — Only `VITE_*` keys are build-flag carriers (`VITE_AUTH_ENABLED`, optional public hostname). API keys (`XAI_API_KEY`, `OPENAI_API_KEY`, Superfeedr tokens) stay server-side and are never returned on public `/ready`.

## Residual risk

- **In-memory rate limits** reset per instance and do not coordinate across replicas unless Redis/Upstash is configured.
- **CSP** allows `'unsafe-inline'` for scripts/styles (TanStack Start / Vite practicality) — XSS impact is reduced, not eliminated.
- **Webhook without `SUPERFEEDR_SECRET`** accepts unsigned POSTs (local/dev convenience). Production should set the secret.
- **Admin token in query string** (`?token=`) may appear in proxy logs — prefer `Authorization: Bearer`.
- **No secret rotation** in this change set — operators rotate Superfeedr / AI keys out of band.
- **STT / Broadcastify** deliberately lightly touched so caption jobs keep running.

## Operator checklist

- Set `SUPERFEEDR_SECRET` and verify webhook signatures in production.
- Set `SUPERFEEDR_ADMIN_TOKEN` (or `READY_ADMIN_TOKEN`) for rich `/ready` and subscribe.
- Optionally set `REDIS_URL` or Upstash REST env vars for multi-instance rate limiting.
- Confirm the site is served over HTTPS so HSTS applies.
