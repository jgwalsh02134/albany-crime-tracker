# Integrate Law Enforcement Directory into Albany County Crime Tracker

**Repo:** https://github.com/jgwalsh02134/albany-crime-tracker
**Local:** /Users/j-gregory-walsh/projects/albany-crime-tracker-main

## Context

A comprehensive law enforcement directory dataset (`le_directory.json`) needs to be integrated into this app. The file goes in the project root alongside `api_server.py`. It contains 56 agencies (federal through local), 18 municipalities with coverage mapping, scanner ecosystem data (feeds + conventional frequencies), 12 media sources, and 7 community alerting platforms — all structured JSON covering every LE agency operating within Albany County, NY.

## Current Architecture

- **Backend:** Python 3.11 / FastAPI (`api_server.py`, ~2220 lines) / uvicorn on port 5000
- **Frontend:** Vanilla JS IIFE (`app.js`, ~1805 lines) + single-page HTML (`index.html`, ~411 lines) + CSS (`style.css`, ~1457 lines)
- **No React, no TypeScript, no npm/node** — pure static frontend served by FastAPI's StaticFiles mount
- **AI:** xAI Grok-3 via `/api/chat` SSE streaming, situation reports, daily/monthly summaries
- **Map:** Leaflet.js + MarkerCluster (CDN-loaded)
- **Charts:** Chart.js (CDN-loaded)
- **Nav system:** `data-view` attributes on nav buttons and desktop tabs. Views are `<section class="view" id="viewXxx">` toggled by `switchView()` in app.js
- **Theme:** CSS custom properties toggled via `[data-theme="dark"]` / `[data-theme="light"]` on `<html>`
- **Existing views:** Feed (Live/News sub-tabs), Map, Scanner, AI Chat, More (Patterns/Trends + FBI NIBRS)

## What to Build

Add a **Directory** view/tab — a searchable, filterable, browsable law enforcement agency directory. It should feel native to the existing app: same dark/light theme, same card-based layouts, same typography (Satoshi body, JetBrains Mono for data), same Material Icons.

---

## STEP 1 — Add `le_directory.json` to Project Root

Place the file at `/Users/j-gregory-walsh/projects/albany-crime-tracker-main/le_directory.json`. This file is provided separately and should be committed to the repo.

## STEP 2 — Backend Endpoints (`api_server.py`)

Add these endpoints **BEFORE** the static files mount (`app.mount("/", StaticFiles(...))`) which must remain the last route:

```python
# =============================================================================
# LAW ENFORCEMENT DIRECTORY
# =============================================================================
import json as _json

_le_dir_cache = None

def _load_le_directory():
    global _le_dir_cache
    if _le_dir_cache is None:
        with open("le_directory.json", "r") as f:
            _le_dir_cache = _json.load(f)
    return _le_dir_cache

@app.get("/api/directory")
async def get_directory():
    """Full directory dataset."""
    data = _load_le_directory()
    return {"status": "ok", "data": data}

@app.get("/api/directory/agencies")
async def get_directory_agencies(tier: str = None, type: str = None, q: str = None):
    """Filtered agency list. Query params: tier, type, q (search)."""
    data = _load_le_directory()
    agencies = data["agencies"]
    if tier:
        agencies = [a for a in agencies if a["tier"] == tier]
    if type:
        agencies = [a for a in agencies if a["type"] == type]
    if q:
        ql = q.lower()
        agencies = [a for a in agencies if
                    ql in a["name"].lower() or
                    ql in (a.get("abbreviation") or "").lower() or
                    ql in a["id"] or
                    ql in a.get("jurisdiction", "").lower()]
    return {"status": "ok", "count": len(agencies), "agencies": agencies}

@app.get("/api/directory/municipalities")
async def get_directory_municipalities():
    """Municipality coverage map."""
    data = _load_le_directory()
    return {"status": "ok", "municipalities": data["municipalities"]}

@app.get("/api/directory/media")
async def get_directory_media():
    """Media sources and blotter publishers."""
    data = _load_le_directory()
    return {"status": "ok", "media": data["mediaSources"]}

@app.get("/api/directory/scanner")
async def get_directory_scanner():
    """Scanner ecosystem — feeds, frequencies, system details."""
    data = _load_le_directory()
    return {"status": "ok", "scanner": data["scannerEcosystem"]}

@app.get("/api/directory/community")
async def get_directory_community():
    """Community alerting platforms."""
    data = _load_le_directory()
    return {"status": "ok", "platforms": data["communityPlatforms"]}
```

## STEP 3 — HTML (`index.html`)

### 3a. Add desktop tab
In `<div class="desktop-tabs" id="desktopTabs">`, add BEFORE the "More" button:
```html
<button class="desktop-tab" data-view="directory">Directory</button>
```

### 3b. Add bottom nav button
In `<nav class="bottom-nav" id="bottomNav">`, add BEFORE the "More" button:
```html
<button class="nav-btn" data-view="directory">
  <span class="material-icons">badge</span>
  <span>Directory</span>
</button>
```

### 3c. Add Directory view section
Inside `<main class="main">`, add this new `<section>` BEFORE `<section class="view" id="viewMore">`:

```html
<!-- === DIRECTORY VIEW === -->
<section class="view" id="viewDirectory">
  <div class="view-scroll">

    <!-- Search + filter bar -->
    <div class="dir-toolbar">
      <div class="dir-search-wrap">
        <span class="material-icons dir-search-icon">search</span>
        <input type="text" id="dirSearch" class="dir-search" placeholder="Search agencies, towns, scanners..." autocomplete="off">
      </div>
      <div class="dir-filters" id="dirFilters">
        <button class="dir-filter-chip active" data-tier="all">All</button>
        <button class="dir-filter-chip" data-tier="federal">Federal</button>
        <button class="dir-filter-chip" data-tier="state">State</button>
        <button class="dir-filter-chip" data-tier="county">County</button>
        <button class="dir-filter-chip" data-tier="municipal">Municipal</button>
        <button class="dir-filter-chip" data-tier="campus">Campus</button>
        <button class="dir-filter-chip" data-tier="specialized">Specialized</button>
      </div>
    </div>

    <!-- Stats banner -->
    <div class="dir-stats" id="dirStats"></div>

    <!-- Agency list -->
    <div class="dir-agency-list" id="dirAgencyList">
      <div class="skeleton-card"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div>
    </div>

    <!-- Sub-sections (rendered after agencies load) -->
    <div class="dir-section" id="dirMuniSection" style="display:none;">
      <h2 class="more-section-title">
        <span class="material-icons" style="font-size:16px;">location_city</span>
        Municipality Coverage
      </h2>
      <div id="dirMuniList"></div>
    </div>

    <div class="dir-section" id="dirScannerSection" style="display:none;">
      <h2 class="more-section-title">
        <span class="material-icons" style="font-size:16px;">sensors</span>
        Scanner Feeds &amp; Frequencies
      </h2>
      <div id="dirScannerList"></div>
    </div>

    <div class="dir-section" id="dirMediaSection" style="display:none;">
      <h2 class="more-section-title">
        <span class="material-icons" style="font-size:16px;">newspaper</span>
        News Sources &amp; Blotters
      </h2>
      <div id="dirMediaList"></div>
    </div>

    <div class="dir-section" id="dirCommunitySection" style="display:none;">
      <h2 class="more-section-title">
        <span class="material-icons" style="font-size:16px;">notifications_active</span>
        Alert Systems &amp; Community Platforms
      </h2>
      <div id="dirCommunityList"></div>
    </div>

  </div>
</section>
```

## STEP 4 — CSS (`style.css`)

Add directory styles. Use the existing CSS custom properties (`var(--bg-card)`, `var(--text-primary)`, `var(--text-secondary)`, `var(--border)`, `var(--accent)`). All styles must work in both `[data-theme="dark"]` and `[data-theme="light"]`.

Key components to style:

- `.dir-toolbar` — sticky at top of directory scroll area, contains search input and filter chips
- `.dir-search-wrap` / `.dir-search` — styled like the existing chat input: dark bg, rounded, icon inside
- `.dir-filters` — horizontal scrolling row of filter chip buttons
- `.dir-filter-chip` — small pill buttons. `.active` state uses `var(--accent)` background
- `.dir-stats` — compact stats bar (e.g. "56 Agencies / 18 Municipalities / 6 Scanner Feeds")
- `.dir-agency-card` — collapsible card. Collapsed: name + tier badge + type + phone. Expanded: full detail panels
- `.dir-card-expanded` — class toggled on click to reveal detail content (use `max-height` transition or `display` toggle)
- `.dir-tier-badge` — colored inline badge per tier:
  - federal: `#8ba7c7` (steel blue — muted, desaturated)
  - state: `#a99dc4` (dusty lavender)
  - county: `#c4b07e` (aged brass)
  - municipal: `#7ab8a4` (sage)
  - campus: `#80b0b2` (stone teal)
  - specialized: `#bfa388` (warm clay)
- `.dir-detail-section` — labeled subsections within expanded card (Contact, Social, Alerts, Records, Press, Dispatch, Units)
- `.dir-social-pill` — small inline pills for social accounts (platform label + handle, linked)
- `.dir-muni-card` — municipality card showing own PD status and coverage agencies
- `.dir-scanner-card` — scanner feed card with provider badge, live/archive indicators, link
- `.dir-freq-row` — conventional frequency table row (frequency, tone, use, mode — in JetBrains Mono)
- `.dir-media-card` — news source card with reliability badge (high=green, moderate=yellow, low=red), paywall indicator, blotter coverage area
- `.dir-community-card` — platform card with type badge, description, link/phone

Cards: subtle 1px borders (`var(--border)`), not heavy shadows. Mobile full-width. Smooth transitions on expand/collapse.

## STEP 5 — JavaScript (`app.js`)

All new code goes inside the existing `(function() { ... })();` IIFE.

### 5a. State variables
Add near the top with the other state vars:
```javascript
var directoryData = null;
var dirActiveTier = "all";
var dirSearchTimeout = null;
```

### 5b. Lazy-load in switchView
In the existing `switchView()` function (find where views are activated), add:
```javascript
if (view === "directory" && !directoryData) {
  fetchDirectory();
}
```

### 5c. fetchDirectory
```javascript
function fetchDirectory() {
  fetch(API + "/api/directory")
    .then(ok)
    .then(function(data) {
      directoryData = data.data;
      renderDirStats();
      renderDirAgencies();
      renderDirMunis();
      renderDirScannerFeeds();
      renderDirMedia();
      renderDirCommunity();
      initDirSearch();
      initDirFilters();
    })
    .catch(function() {
      var el = document.getElementById("dirAgencyList");
      if (el) el.innerHTML = '<p class="placeholder-text">Failed to load directory.</p>';
    });
}
```

### 5d. Stats rendering
```javascript
function renderDirStats() {
  var el = document.getElementById("dirStats");
  if (!el || !directoryData) return;
  var a = directoryData.agencies.length;
  var m = directoryData.municipalities.length;
  var s = directoryData.scannerEcosystem.feeds.length;
  var socials = 0;
  directoryData.agencies.forEach(function(ag) { socials += ag.socialAccounts.length; });
  el.innerHTML =
    '<span class="dir-stat-item">' + a + ' Agencies</span>' +
    '<span class="dir-stat-sep">/</span>' +
    '<span class="dir-stat-item">' + m + ' Municipalities</span>' +
    '<span class="dir-stat-sep">/</span>' +
    '<span class="dir-stat-item">' + socials + ' Social Accounts</span>' +
    '<span class="dir-stat-sep">/</span>' +
    '<span class="dir-stat-item">' + s + ' Scanner Feeds</span>';
}
```

### 5e. Agency rendering (core)
Each agency card: collapsed shows name, abbreviation, tier badge, jurisdiction one-liner, primary phone. Click to expand showing full contact, social accounts (as linked pills), alert channels with enrollment instructions, FOIL/FOIA portal links, news/press surfaces, dispatch info, special units, and notes.

Tier badge helper:
```javascript
var TIER_COLORS = {
  federal: "#8ba7c7", state: "#a99dc4", county: "#c4b07e",
  municipal: "#7ab8a4", campus: "#80b0b2", specialized: "#bfa388"
};
function dirTierBadge(tier) {
  var c = TIER_COLORS[tier] || "#7a7a78";
  return '<span class="dir-tier-badge" style="background:' + c + '22;color:' + c + ';border:1px solid ' + c + '44;">' + esc(tier) + '</span>';
}
```

Social platform labels (Material Icons lacks brand icons, use text pills):
```javascript
var PLATFORM_LABELS = {
  facebook: "FB", twitter: "X", instagram: "IG",
  youtube: "YT", linkedin: "LI", nextdoor: "ND", tiktok: "TT"
};
```

Rendering function filters by `dirActiveTier` and search query from `#dirSearch`.

Card expand/collapse: click handler toggles `.dir-card-expanded` class on the card element.

### 5f. Search and filter initialization
```javascript
function initDirSearch() {
  var input = document.getElementById("dirSearch");
  if (!input) return;
  input.addEventListener("input", function() {
    clearTimeout(dirSearchTimeout);
    dirSearchTimeout = setTimeout(renderDirAgencies, 300);
  });
}

function initDirFilters() {
  var chips = document.querySelectorAll(".dir-filter-chip");
  chips.forEach(function(chip) {
    chip.addEventListener("click", function() {
      chips.forEach(function(c) { c.classList.remove("active"); });
      chip.classList.add("active");
      dirActiveTier = chip.getAttribute("data-tier");
      renderDirAgencies();
    });
  });
}
```

### 5g. Municipality rendering
Show each municipality as a card. Highlight whether it has its own PD. List covering agencies by resolving `primaryCoverageIds` against `directoryData.agencies`.

### 5h. Scanner feeds rendering
Render each feed from `directoryData.scannerEcosystem.feeds` as a card with provider badge, live/archive status, and direct link. Also render conventional frequencies as a compact table with JetBrains Mono styling.

### 5i. Media sources rendering
Render each source from `directoryData.mediaSources` as a card with reliability tier color badge, paywall indicator, blotter coverage text, and crime section URL link.

### 5j. Community platforms rendering
Render each platform from `directoryData.communityPlatforms` as a card with type badge, description, and action link/phone.

## STEP 6 — Cross-Feature Enhancements (Optional, Lower Priority)

### 6a. Enrich scanner TG_MAP
The directory's `scannerEcosystem.conventionalFrequencies` has agency IDs. When rendering scanner calls in the Scanner view, cross-reference talkgroup names with directory agency data to enable linking from scanner items to the agency's directory card.

### 6b. Enrich source reliability display
The directory's `mediaSources` array has `reliabilityTier` and `hasPaywall`. Use this to add reliability badges and paywall warnings to articles in the Feed view.

### 6c. Link Nixle enrollment from Feed
When articles come from agencies that have Nixle alert channels in the directory, show a small "Get alerts" link that displays the enrollment instructions.

## Design Rules (Non-Negotiable)

1. No emojis anywhere in the UI
2. Dark theme is default — all colors must work on both dark (#0c0f14 bg) and light (#ffffff bg)
3. Cards: subtle 1px borders (var(--border)), not heavy box-shadows
4. Typography: Satoshi for UI, JetBrains Mono for frequencies/codes/data
5. Expandable cards use smooth CSS transitions, not jarring show/hide
6. Mobile-first: cards full-width, filter chips horizontally scroll, bottom nav shows Directory icon
7. All external links: target="_blank" rel="noopener noreferrer"
8. Phone numbers: `<a href="tel:...">`
9. Emails: `<a href="mailto:...">`
10. The directory is a quick-reference tool, not a data dump — prioritize scannable card layouts over walls of text

## Data Schema Quick Reference

```
agencies[].id                    — stable kebab-case key
agencies[].tier                  — "federal"|"state"|"county"|"municipal"|"campus"|"specialized"
agencies[].type                  — "municipal_pd"|"investigative"|"state_police"|etc.
agencies[].contact               — {nonEmergencyPhone, emergencyPhone, tipLine, address, ...}
agencies[].socialAccounts[]      — {platform, handle, url, verified}
agencies[].alertChannels[]       — {system, keyword, shortCode, enrollmentMethod}
agencies[].recordsAccess[]       — {system, url, notes}
agencies[].newsPressSurfaces[]   — {type, label, url, hasRss, hasArchive}
agencies[].dispatch              — {dispatchedBy, systemType, systemName}
agencies[].specialUnits[]        — string array
agencies[].headOfficial          — name string
agencies[].headOfficialTitle     — title string
municipalities[].hasOwnPolice    — boolean
municipalities[].primaryCoverageIds[] — agency ID references
scannerEcosystem.feeds[]         — {provider, label, url, isLive, hasArchive, isPremiumArchive}
scannerEcosystem.conventionalFrequencies[] — {agency, frequency, tone, use, mode}
mediaSources[]                   — {name, mediaType, reliabilityTier, publishesBlotters, blotterCoverage}
communityPlatforms[]             — {name, type, url, phone, appName, description}
```
