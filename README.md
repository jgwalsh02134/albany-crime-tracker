# Albany County Crime Tracker

Mobile-first public-safety dashboard for Albany County, NY.

Live feed (newsroom wire + county snapshot), map, Broadcastify scanner with captions, directory, trends, and a Grok assistant.

## Public API

See `docs/public-api.md` for the unauthenticated, rate-limited public endpoints (JSON + RSS) intended for newsrooms and bots.

## Run locally

```bash
npm install
npm run dev
```

Optional: set `XAI_API_KEY` for scanner captions and AI chat.

## Railway

The service builds from `Dockerfile` (Node 22, Nitro `node-server`) and listens on `PORT` (8080). Set `XAI_API_KEY` in the Railway service variables so transcription and chat work in production.

Near-me web push needs a VAPID keypair on the Railway service. Do not commit the keys. Generate them out of band (`npx web-push generate-vapid-keys`) and set:

- `VAPID_PUBLIC_KEY` — URL-safe base64 public key
- `VAPID_PRIVATE_KEY` — URL-safe base64 private key
- `VAPID_SUBJECT` — contact URI, usually `mailto:you@example.com`

If any of those are unset, Live shows push as not configured and Enable alerts stays off.
