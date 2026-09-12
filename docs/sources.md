# Source matrix — Albany County Crime Tracker

Honest inventory of pipes we poll, subscribe, or have tried. **There is no public CAD / CFS board** for Albany, Colonie, or Bethlehem. Live cards are fused from independent open sources (blotter, scanner, 511, news, civic, social). A lone scanner caption is unconfirmed and cannot outrank a multi-source cluster.

Admin `/ready` (Bearer / `?token=` admin token) returns per-pipe `lastOkAt`, `lastCount`, ok/fail.

## Wired (open)

| Pipe | How | Notes |
| --- | --- | --- |
| NYSP Troop G / T blotter PDFs | Poll | Official overnight dump. Not live dispatch. |
| NYSP newsroom HTML | Poll | Local-only press clips. No public RSS (`troopers.ny.gov/rss.xml` is a stub). |
| Broadcastify scanner | Poll + STT | Albany/Colonie PD, Bethlehem, Albany Fire, volunteer fire, Thruway. Unconfirmed. |
| 511NY accidents | Poll `511ny.org/api/getevents` | Capital District crashes only. Construction dropped. **Stays wired.** |
| NWS alerts | Poll `api.weather.gov` | Severe warnings at Albany point. Advisories skipped. **Stays wired.** |
| News10 / CBS6 / WNYT / WAMC / Patch Albany | RSS + Superfeedr | Native feeds. |
| Times Union / Spotlight / Gazette / FOX23 | Google News RSS + Superfeedr | Native TU RSS 404s — we do not pretend they work. |
| Spectrum, Troy Record, ACSO, north cities, Guilderland | Google News RSS + Superfeedr | Gap queries (Cohoes / Watervliet / Menands / Green Island; Guilderland / Altamont / Voorheesville). |
| CivicPlus: Bethlehem, Guilderland PD, Guilderland town, Albany, Cohoes, Voorheesville | RSS + Superfeedr | Incident-keyword filter. Feeds may be empty and still count as wired. |
| Menands village | `menandsny.gov/feed/` (WordPress) | Public civic RSS. Usually board/newsletter; crime items pass the filter if posted. |
| Department Facebook / X (via Google News) | RSS | APD, Colonie, Bethlehem, Cohoes, Watervliet, Guilderland, NYSP, Albany Fire, newsroom X. |
| Reddit r/Albany, r/Troy, r/Schenectady | Atom | Citizen, unconfirmed. |

## Tried and blocked (do not invent)

| Probe | Result | Why we stay honest |
| --- | --- | --- |
| Live CAD / CFS (Albany, Colonie, Bethlehem) | No public board | City open-data host is dead. We never label 511 as CAD. |
| PulsePoint | Albany NY not listed; API 401 | No public path. Later PR only if one appears. |
| OpenMHz `albanycony` | Browser-live, server 403 (Cloudflare) | Not wired. |
| Nixle / NY-Alert | Login wall | APD Alert Center RSS empty until the city posts. |
| SpotCrime / CrimeMapping / RAIDS | No public JSON; SpotCrime 403 | Not wired. |
| Citizen App, Ring, Nextdoor, Waze | No public feed | Later PR only if a public path appears. |
| Meta Graph / Instagram | App-review token | We index public Facebook posts via Google News instead. |
| APD / Colonie X | Stale / Facebook-only | Documented; Facebook GNews stays. |
| Jail bookings / FOIL CAD | Not a live stream | Later PR: FOIL cron; court/jail **if public**. |
| Colonie civic RSS | 404 on `townofcolonie.gov` | No CivicPlus All-news. |
| Watervliet civic RSS | 404 | No CivicPlus All-news. |
| Albany County / ACSO CivicPlus RSS | HTML homepage, not RSS | Sheriff coverage via Google News query. |
| Menands CivicPlus / old village domain | SSL / Sucuri / 404 | WordPress feed is the public path. |
| Green Island civic RSS | 403 / NXDOMAIN | Not wired. |
| Times Union native `/news/feed/` and `/local/feed/` | 404 | Superfeedr now uses the working GNews TU query. |
| Patch Colonie / Latham / Bethlehem / Guilderland `/rss` | 404 | GNews `site:patch.com` queries instead. |
| NYSP `rss.xml` | 200 stub, 0 items | HTML newsroom scrape stays. |
| Spectrum `/feed` | 404 | GNews site query instead. |

## Fusion (this PR)

LiveWire items cluster when **call-type family**, **time window**, and **geo** agree (≈1.6 km or same town). One card lists provenance chips (`Seen on: Blotter · Scanner · 511 · News`). Corroboration scores independent families: official (blotter / 511 / civic / NWS) > context (news) > unconfirmed (scanner / citizen). Lone scanner is capped at 22/100 so it cannot outrank a multi-source card.

## Later PRs (not this one)

- FOIL cron for delayed CAD / reports
- Court / jail **if** a public machine-readable path exists
- Waze / PulsePoint **only if** a public path appears
- ML place-linking for scanner STT
