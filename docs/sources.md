# Source matrix — Albany County Crime Tracker

Honest inventory of pipes we poll, subscribe, or have tried. **There is no public CAD / CFS board** for Albany, Colonie, or Bethlehem. Live cards are fused from independent open sources (blotter, scanner, 511, news, civic, social). A lone scanner caption is unconfirmed and cannot outrank a multi-source cluster.

Admin `/ready` (Bearer / `?token=` admin token) returns per-pipe `lastOkAt`, `lastCount`, ok/fail. Live “source map” also shows when radio captions are down (no STT key, rate-limit/backoff, or stream unreachable) so news-only windows aren’t silently treated as “quiet” — radio captions are an early reporting signal, and downtime is a real reporting gap.

## Wired (open)

| Pipe | How | Notes |
| --- | --- | --- |
| NYSP Troop G / T blotter PDFs | Poll | Official overnight dump. Not live dispatch. |
| NYSP newsroom HTML | Poll | Local-only press clips. No public RSS (`troopers.ny.gov/rss.xml` is a stub). |
| Broadcastify scanner | Poll + STT | Albany PD is monitorable; **Colonie PD is encrypted (silent hole)**. Fire/EMS traffic is clear via volunteer fire feeds. Unconfirmed. |
| 511NY accidents | Poll `511ny.org/api/getevents` | Capital District crashes only. Construction dropped. **Stays wired.** |
| NWS alerts | Poll `api.weather.gov` | Severe warnings at Albany point. Advisories skipped. **Stays wired.** |
| News10 / CBS6 / WNYT / WAMC | RSS + Superfeedr | Native feeds. |
| Patch Albany | Google News RSS + Superfeedr | Patch’s legacy `.../new-york/albany/rss` 404s; `albany-ny` coverage comes from `site:patch.com` Google News RSS. |
| Times Union / Spotlight / Gazette / FOX23 | Google News RSS + Superfeedr | Native TU RSS 404s — we do not pretend they work. |
| Spectrum, Troy Record, ACSO, north cities, Guilderland | Google News RSS + Superfeedr | Gap queries (Cohoes / Watervliet / Menands / Green Island; Guilderland / Altamont / Voorheesville). |
| Google News (county-wide) | Google News RSS + Superfeedr | High-signal public-safety query for the last 24h; out-of-area dropped. |
| Corridor + town queries | Google News RSS + Superfeedr | “Central/Western/Wolf” corridor + “Bethlehem/Delmar/Latham” gap queries. |
| CivicPlus: Bethlehem, Guilderland PD, Guilderland town, Albany, Cohoes, Voorheesville, Troy, Schenectady, Schenectady PD | RSS + Superfeedr | Incident-keyword filter. Feeds may be empty and still count as wired. |
| Menands village | `menandsny.gov/feed/` (WordPress) | Sucuri 403 blocks server fetches. We keep the pipe listed and honest in health, but it may be unreachable until the site allows feed traffic. |
| Department Facebook / X (via Google News) | RSS | APD/AFD/NYSP + local PD/FD/EMS pages (Colonie, Colonie EMS, Bethlehem, Cohoes PD/Fire, Watervliet, Guilderland PD, Schenectady PD/Fire, Rensselaer County Sheriff, East Greenbush / Green Island / Menands / Rensselaer City police, volunteer fire) plus X for Troy PD / Schdy Police / Albany+Colonie Police / Thruway TRANSalert / Guilderland+Bethlehem PD. Newsroom social includes CBS6/NEWS10/WNYT/Spectrum/Gazette/WAMC/Times Union/Troy Record. |
| Reddit r/Albany, r/Troy, r/Schenectady | Atom | Citizen, unconfirmed. |
| Nixle (APD, Colonie, Guilderland, Watervliet, Altamont) | HTML parse | Public agency pages. Cached ~1 min daytime (ET), ~4 min overnight; transient errors keep the last-known alert set so advisories don’t “blink” out. |

## Tried and blocked (do not invent)

| Probe | Result | Why we stay honest |
| --- | --- | --- |
| Live CAD / CFS (Albany, Colonie, Bethlehem) | No public board | City open-data host is dead. We never label 511 as CAD. |
| PulsePoint | Albany NY not listed; API 401 | No public path. Later PR only if one appears. |
| OpenMHz `albanycony` | Browser-live, server 403 (Cloudflare) | Not wired. |
| SeeClickFix API v2 | 403 (Cloudflare) from server IP | Cannot rely on a pipe that blocks programmatic fetch. Only wire if a public, stable API path works without bypass. |
| Albany Nixle / NY-Alert | Login wall | APD Alert Center RSS empty until the city posts. |
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
| Patch Albany `/rss` | 404 | Patch moved to `patch.com/new-york/albany-ny` with no public RSS; we use Google News RSS `site:patch.com/new-york/albany-ny` instead. |
| NYSP `rss.xml` | 200 stub, 0 items | HTML newsroom scrape stays. |
| Spectrum `/feed` | 404 | GNews site query instead. |
| UAlbany UPD daily crime log | DevExpress callbacks / stateful export | No clean, stable unauthenticated CSV/RSS endpoint found; revisit if UPD publishes a direct daily-record file or API. |

## Fusion

LiveWire items cluster when **call-type family**, **time window**, and **geo** agree (≈1.6 km or same town). One card lists provenance chips (`Seen on: Blotter · Scanner · 511 · News`). Corroboration scores independent families: official (blotter / 511 / civic / NWS) > context (news) > unconfirmed (scanner / citizen). Lone scanner is capped at 22/100 so it cannot outrank a multi-source card.

## Superfeedr parity (this PR)

All high-value newsroom / Google News RSS queries under `FEEDS` are also included in `SUPERFEEDR_TOPICS` so breaking news can arrive via push when credentials are configured. Anything that must stay poll-only is documented explicitly above (e.g. NYSP newsroom has no working public RSS).

## Later PRs (not this one)

- FOIL cron for delayed CAD / reports
- Court / jail **if** a public machine-readable path exists
- Waze / PulsePoint **only if** a public path appears
- ML place-linking for scanner STT
