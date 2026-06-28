# Albany Crime Tracker — Next.js 15 Frontend

This directory contains the Next.js 15 App Router frontend for the Albany County Crime Tracker. It replaces the vanilla JavaScript/HTML frontend with full Server-Side Rendering (SSR), React Server Components, and Suspense streaming.

## Architecture

```
nextjs/
├── app/
│   ├── layout.tsx              # Root layout (fonts, metadata, theme)
│   ├── page.tsx                # Home/Live page (SSR)
│   ├── globals.css             # Global styles + ACT design tokens
│   ├── types.ts                # Shared TypeScript types
│   ├── lib/
│   │   ├── api.ts              # Server-side API helpers (fetch from FastAPI)
│   │   └── utils.ts            # Shared utilities (timeAgo, etc.)
│   ├── components/
│   │   ├── Header.tsx          # App header (client — theme toggle)
│   │   ├── BottomNav.tsx       # Mobile tab bar (client — active state)
│   │   ├── HomeShell.tsx       # Home page shell (client — filter state)
│   │   ├── LiveFeed.tsx        # Live incident feed (client — polling + dedup)
│   │   ├── IncidentCard.tsx    # Single incident card (client)
│   │   └── CriticalFilter.tsx  # Filter bottom sheet (client)
│   ├── scanner/
│   │   ├── page.tsx            # Scanner page (SSR)
│   │   ├── ScannerShell.tsx    # Scanner page shell (client)
│   │   └── ScannerCards.tsx    # Scanner call cards (client — polling)
│   └── api/
│       ├── incidents/route.ts  # Proxy → FastAPI /api/incidents
│       └── scanner/route.ts    # Proxy → FastAPI /api/scanner/calls
├── package.json
├── next.config.js              # Next.js config (rewrites, env)
├── tsconfig.json
├── tailwind.config.ts
└── .env.local.example          # Environment variable template
```

## SSR Data Flow

1. **Request arrives** at Next.js server
2. **Server Component** (`page.tsx`) fetches data from FastAPI using `FASTAPI_URL` (internal Railway URL)
3. **Pre-rendered HTML** is sent to the browser with real incident data — no loading flash
4. **Client components** hydrate and begin polling for real-time updates every 45s (incidents) / 20s (scanner)

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in:

| Variable | Description |
|---|---|
| `FASTAPI_URL` | Internal URL of the FastAPI backend (e.g. `http://albany-crime-tracker.railway.internal:8080`) |
| `NEXT_PUBLIC_API_URL` | Public API URL for client-side fetches (usually empty — uses Next.js rewrites) |

## Railway Deployment

Set the following in Railway for the Next.js service:

- **Build command**: `cd nextjs && npm install && npm run build`
- **Start command**: `cd nextjs && npm start`
- **Environment**: `FASTAPI_URL=http://<fastapi-service>.railway.internal:8080`

## Features Preserved

- ✅ Critical incident filter (severity + municipality bottom sheet)
- ✅ Multi-source incident display ("+N sources" corroboration pill)
- ✅ Expandable/linked news articles (click-through to source)
- ✅ Scanner live feed with real-time polling
- ✅ Dark/light theme toggle (persisted to localStorage)
- ✅ Responsive mobile-first design
- ✅ Freshness banner (honest "newest incident X min ago")
- ✅ Incident dedup clustering (same-event grouping across sources)
- ✅ Agency attribution pill (APD, ACSO, etc.)
- ✅ Severity color coding (critical = red border, high = orange)

## New Capabilities (vs vanilla JS)

- 🚀 **SSR**: Pages pre-rendered with real data — no blank loading state on first visit
- 🚀 **React Server Components**: Data fetching happens on the server, reducing client JS
- 🚀 **Streaming**: Suspense boundaries allow progressive rendering
- 🚀 **TypeScript**: Full type safety across all components
- 🚀 **Next.js rewrites**: All `/api/*` calls proxy to FastAPI transparently
