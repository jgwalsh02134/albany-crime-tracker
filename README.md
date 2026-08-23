# Albany County Crime Tracker

Mobile-first public-safety dashboard for Albany County, NY.

Live feed (newsroom wire + county snapshot), map, Broadcastify scanner with captions, directory, trends, and a Grok assistant.

## Run locally

```bash
npm install
npm run dev
```

Optional: set `XAI_API_KEY` for scanner captions and AI chat.

## Railway

The service builds from `Dockerfile` (Node 22, Nitro `node-server`) and listens on `PORT` (8080). Set `XAI_API_KEY` in the Railway service variables so transcription and chat work in production.
