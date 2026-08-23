# Albany County Crime Tracker

Mobile-first public-safety dashboard for Albany County, NY.

Live feed, map, scanner with HLS + transcription, directory, trends, and a Grok assistant. Incidents are sourced from official blotters/CAD, scanner, and newsrooms. A live News10 wire overlays public-safety headlines when the RSS feed is reachable.

## Run

```bash
npm install
npm run dev
```

App listens on `0.0.0.0:8080`.

Optional:

- `XAI_API_KEY` — scanner transcription and AI chat

## Stack

Vite 6, TanStack Start, React 19, Tailwind v4, Leaflet, HLS.js, Zustand.
