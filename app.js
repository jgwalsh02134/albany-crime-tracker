/* Albany County Crime Tracker v8 — app.js
   Mobile-first, feed-first, card-based, touch-optimized.
   Views: Feed (Now / Confirmed / Context lanes), Map, Scanner, AI Chat, More */

(function () {
  "use strict";

  var API = "";
  if (API.indexOf("__") === 0) API = "http://" + location.hostname + ":8000";
  if (!API) {
    if (location.protocol === "file:") {
      API = "http://127.0.0.1:8000";
    } else if (
      location.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(location.hostname)
    ) {
      var _p = location.port || "80";
      if (_p !== "8000") {
        var _h = location.hostname;
        var _apiHost = /^::1$/i.test(_h) ? "[::1]" : _h;
        API = "http://" + _apiHost + ":8000";
      }
    }
  }
  var apiClient = window.ACTApiClient ? window.ACTApiClient.createApiClient(API) : null;
  var REFRESH_MS = 45000;
  var SCANNER_REFRESH_MS = 20000;

  // State
  var map, markerGroup, trendsChart, tileLayer;
  var mapReady = false;
  var chatHistory = [];
  var activeView = "feed";
  var activeFeedTab = "live";       // "live" | "confirmed" | "context"
  var lastLiveActiveItems = [];
  var lastLiveRecentItems = [];
  var lastCrimeCounts = {};
  var lastFeedTotals = { confirmed: 0 };
  var scannerAudio = null;
  var mainAudio    = null;
  var mainProgressTimer = null;
  var scannerIntelItems = [];
  var mapInitialized = false;
  var pendingMarkerData = null;
  var activeMapFilter = "all";
  var allIncidentData = [];          // holds all crime articles for tab filtering
  var feedSearchQuery = "";
  var feedSortMode = "newest";
  var mapSearchQuery = "";
  var mapVerification = "";
  var mapSeverity = "";
  var mapFetchTimer = null;
  var feedControlTimer = null;
  var summaryWindow = "7d";

  // Law enforcement directory (lazy-loaded from /api/directory/*)
  var leDirectory = null;
  var directoryLoaded = false;
  var directoryLoading = false;
  var dirTierFilter = "all";
  var dirSearchQuery = "";

  // Tile URLs
  var TILES_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  var TILES_LIGHT = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

  // Safe storage wrapper
  var storage = { _m: {} };
  var _ls = (function () { try { var s = window["local" + "Storage"]; s.setItem("_t", "1"); s.removeItem("_t"); return s; } catch (e) { return null; } })();
  storage.get = function (key) { return _ls ? _ls.getItem(key) : (storage._m[key] || null); };
  storage.set = function (key, val) { if (_ls) _ls.setItem(key, val); else storage._m[key] = val; };

  // marked.js config
  if (typeof marked !== "undefined") {
    marked.setOptions({ breaks: true, gfm: true });
  }

  // ── ALBANY COUNTY SCANNER TALKGROUP MAP ────────────────────────
  var TG_MAP = {
    // ── Primary 5-digit OpenMHz / Albany County P25 IDs ──────────────────────
    "15202": { name: "Albany County Law Dispatch", cat: "police", priority: "high",   location: "County-wide" },
    "10702": { name: "Albany County Fire Dispatch", cat: "fire",   priority: "high",   location: "County-wide" },
    "11702": { name: "County Fire Tac",            cat: "fire",   priority: "medium", location: "County-wide" },
    "10003": { name: "Albany County Sheriff",      cat: "police", priority: "high",   location: "County-wide" },
    "13102": { name: "Albany PD Dispatch",         cat: "police", priority: "high",   location: "City of Albany" },
    "13202": { name: "Albany PD Ops",              cat: "police", priority: "high",   location: "City of Albany" },
    "11003": { name: "Albany County EMS",          cat: "ems",    priority: "high",   location: "County-wide" },
    "10921": { name: "Albany County Interop",      cat: "police", priority: "medium", location: "County-wide" },
    "10922": { name: "Multi-Agency Tac",           cat: "police", priority: "medium", location: "County-wide" },
    "10923": { name: "Emergency Ops",              cat: "police", priority: "high",   location: "County-wide" },
    "10925": { name: "Albany County OEM",          cat: "police", priority: "medium", location: "County-wide" },
    "18301": { name: "Albany County Law Ops",      cat: "police", priority: "high",   location: "County-wide" },
    "18884": { name: "Capitol / State Police Tac", cat: "police", priority: "high",   location: "Downtown Albany / Plaza" },
    "10354": { name: "Metro Law Tac",              cat: "police", priority: "medium", location: "Capital Region" },
    "10401": { name: "Colonie PD Dispatch",        cat: "police", priority: "high",   location: "Colonie / Latham" },
    "10402": { name: "Colonie PD Tac",             cat: "police", priority: "medium", location: "Colonie" },
    "10501": { name: "Guilderland PD",             cat: "police", priority: "medium", location: "Guilderland" },
    "10502": { name: "Bethlehem PD",               cat: "police", priority: "medium", location: "Bethlehem / Delmar" },
    "10601": { name: "Cohoes PD",                  cat: "police", priority: "medium", location: "Cohoes" },
    "10602": { name: "Watervliet PD",              cat: "police", priority: "medium", location: "Watervliet" },
    // ── Legacy 4-digit IDs (still seen in some OpenMHz paths) ───────────────
    "8211":  { name: "Colonie PD Dispatch",        cat: "police", priority: "high",   location: "Colonie / Latham" },
    "8212":  { name: "Colonie PD Tac",             cat: "police", priority: "medium", location: "Colonie" },
    "8215":  { name: "Bethlehem PD",               cat: "police", priority: "medium", location: "Bethlehem / Delmar" },
    "8216":  { name: "Guilderland PD",             cat: "police", priority: "medium", location: "Guilderland" },
    "8206":  { name: "Albany County Sheriff",      cat: "police", priority: "high",   location: "County-wide" },
    "8239":  { name: "Albany Fire Dispatch",       cat: "fire",   priority: "high",   location: "City of Albany" },
    "8243":  { name: "Colonie Fire Dispatch",      cat: "fire",   priority: "high",   location: "Colonie" },
    "8259":  { name: "Albany County EMS",          cat: "ems",    priority: "high",   location: "County-wide" },
    "8260":  { name: "Albany EMS Dispatch",        cat: "ems",    priority: "high",   location: "City of Albany" }
  };

  var scannerFilterCat = "all";
  var scannerSearchQuery = "";
  var lastScannerCallsRef = [];
  var currentMainPlayerCallIdx = -1;
  var scannerMuted = false;

  function mergeScannerTalkgroupsFromApi(payload) {
    var tgs = payload.talkgroups || {};
    for (var tid in tgs) {
      if (!Object.prototype.hasOwnProperty.call(tgs, tid)) continue;
      var row = tgs[tid];
      TG_MAP[tid] = {
        name: row.department || row.name,
        location: row.location || "Albany County, NY",
        cat: row.category || "police",
        priority: row.priority || "medium",
        agencyId: row.agency_id || null
      };
    }
    if (payload.system && payload.system.name) {
      var sub = document.getElementById("mainPlayerSub");
      if (sub) {
        var line = payload.system.name;
        if (payload.dispatch_center) line += " · " + payload.dispatch_center;
        sub.textContent = line;
      }
    }
  }

  function fetchScannerTalkgroups() {
    (apiClient ? apiClient.getScannerTalkgroups() : fetch(API + "/api/scanner/talkgroups").then(ok))
      .then(function (r) {
        if (r && r.status === "ok" && r.talkgroups) mergeScannerTalkgroupsFromApi(r);
      })
      .catch(function () {});
  }

  function openDirectoryToAgency(agencyId) {
    if (!agencyId) {
      switchView("directory");
      return;
    }
    switchView("directory");
    function tryScroll() {
      var el = document.getElementById("dir-agency-" + agencyId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("dir-agency-highlight");
        setTimeout(function () { el.classList.remove("dir-agency-highlight"); }, 2200);
        return true;
      }
      return false;
    }
    if (!tryScroll()) {
      setTimeout(function () {
        if (!tryScroll()) setTimeout(tryScroll, 500);
      }, 350);
    }
  }

  function initScannerToolbar() {
    var chips = document.querySelectorAll("[data-scanner-filter]");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        scannerFilterCat = chip.getAttribute("data-scanner-filter") || "all";
        chips.forEach(function (c) { c.classList.toggle("active", c === chip); });
        if (lastScannerCallsRef.length) renderScannerCalls(lastScannerCallsRef);
      });
    });
    var inp = document.getElementById("scannerSearchInput");
    if (inp) {
      var tmr;
      inp.addEventListener("input", function () {
        clearTimeout(tmr);
        tmr = setTimeout(function () {
          scannerSearchQuery = (inp.value || "").trim().toLowerCase();
          if (lastScannerCallsRef.length) renderScannerCalls(lastScannerCallsRef);
        }, 100);
      });
    }
    var vol = document.getElementById("mainPlayerVolume");
    if (vol) {
      var savedV = storage.get("act-scanner-vol");
      if (savedV != null) vol.value = savedV;
      vol.addEventListener("input", function () {
        storage.set("act-scanner-vol", vol.value);
        if (mainAudio) mainAudio.volume = (parseInt(vol.value, 10) || 0) / 100;
      });
    }
    var muteBtn = document.getElementById("mainPlayerMute");
    if (muteBtn) {
      muteBtn.addEventListener("click", function () {
        scannerMuted = !scannerMuted;
        if (mainAudio) mainAudio.muted = scannerMuted;
        muteBtn.classList.toggle("muted", scannerMuted);
        var ic = document.getElementById("mainPlayerMuteIcon");
        if (ic) ic.textContent = scannerMuted ? "volume_off" : "volume_up";
      });
    }
  }

  function lookupTgMap(tgRaw) {
    var s = String(tgRaw == null ? "" : tgRaw).trim();
    if (!s) return null;
    if (TG_MAP[s]) return TG_MAP[s];
    if (/^\d+$/.test(s)) {
      var stripped = s.replace(/^0+/, "") || "0";
      if (TG_MAP[stripped]) return TG_MAP[stripped];
    }
    return null;
  }

  function inferScannerCat(name, desc, audioUrl) {
    var t = ((name || "") + " " + (desc || "") + " " + (audioUrl || "")).toLowerCase();
    if (/\b(fire|fd|rescue|brush|blaze|smoke|structure fire)\b/.test(t)) return "fire";
    if (/\b(ems|medic|ambulance|medical)\b/.test(t)) return "ems";
    return "police";
  }

  function resolveScannerDept(call) {
    var tgRaw = call.talkgroup_num != null ? call.talkgroup_num : call.talkgroup;
    var tgStr = String(tgRaw != null ? tgRaw : "").trim();
    var info = lookupTgMap(tgStr);
    var alpha = (call.talkgroup_tag || call.talkgroupAlpha || call.talkgroup_alpha_tag || "").trim();
    var desc = (call.talkgroup_description || call.talkgroupDescription || "").trim();
    var audioUrl = call.url || call.audio_url || "";

    var name;
    var location;
    var cat;
    var priority;
    var agencyId = null;

    if (info) {
      name = info.name;
      location = info.location || "Albany County, NY";
      cat = info.cat;
      priority = info.priority || "medium";
      agencyId = info.agencyId != null ? info.agencyId : null;
    } else {
      var blob = (alpha + " " + desc).trim();
      if (blob) {
        name = alpha || (desc.length > 80 ? desc.slice(0, 77) + "..." : desc);
        location = "";
        if (/colonie/i.test(blob)) location = "Colonie / Latham";
        else if (/bethlehem|delmar/i.test(blob)) location = "Bethlehem / Delmar";
        else if (/guilderland/i.test(blob)) location = "Guilderland";
        else if (/cohoes/i.test(blob)) location = "Cohoes";
        else if (/watervliet/i.test(blob)) location = "Watervliet";
        else if (/ravena|coeymans|selkirk/i.test(blob)) location = "Ravena / Coeymans";
        else if (/menands|green island|voorheesville|altamont/i.test(blob)) location = "Albany County";
        else if (/sheriff|\bacso\b|county law|law dispatch/i.test(blob)) location = "County-wide";
        else if (/albany\s*pd|\bapd\b|city of albany/i.test(blob)) location = "City of Albany";
        else if (/state\s*police|nysp|troop\s*[fg]/i.test(blob)) location = "Capital Region";
        else if (/fire|rescue|\bfd\b/i.test(blob)) location = "County-wide";
        else if (/ems|medic/i.test(blob)) location = "County-wide";
        else location = "Albany County, NY";
      } else if (tgStr) {
        name = "Talkgroup " + tgStr;
        location = "Albany County, NY";
      } else {
        name = "Radio traffic";
        location = "Albany County, NY";
      }
      cat = inferScannerCat(name, desc, audioUrl);
      priority = "medium";
    }
    if (!location) location = "Albany County, NY";
    return { name: name, location: location, cat: cat, priority: priority, agencyId: agencyId };
  }

  // ── THEME ─────────────────────────────────────────────────────
  function getTheme() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    storage.set("act-theme", theme);
    updateThemeToggleIcon(theme);
    updateThemeMeta(theme);
    updateMapTiles(theme);
    updateChartTheme();
  }

  function updateThemeMeta(theme) {
    var el = document.querySelector('meta[name="theme-color"]');
    if (el) el.setAttribute("content", theme === "dark" ? "#0c0f14" : "#ffffff");
  }

  function updateThemeToggleIcon(theme) {
    var btn = document.getElementById("themeToggle");
    if (!btn) return;
    var icon = btn.querySelector(".material-icons");
    if (icon) {
      icon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
    }
  }

  function initTheme() {
    var saved = storage.get("act-theme");
    var theme = saved || "dark";
    document.documentElement.setAttribute("data-theme", theme);
    updateThemeToggleIcon(theme);
    updateThemeMeta(theme);

    var btn = document.getElementById("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        var current = getTheme();
        setTheme(current === "dark" ? "light" : "dark");
      });
    }
  }

  // ── INIT ──────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    // Set today's date in the header
    (function () {
      var el = document.getElementById("headerDate");
      if (el) {
        el.textContent = new Date().toLocaleDateString("en-US", {
          weekday: "short", month: "short", day: "numeric", year: "numeric"
        });
      }
    })();

    initTheme();
    initNav();
    initDirSearch();
    initDirFilters();
    initScannerToolbar();
    initFeedTabs();
    initFeedControls();
    initSummaryControls();
    initChat();
    startClock();

    // First paint: load core incident feed first, defer heavier noncritical calls.
    fetchIncidents();
    setTimeout(fetchSituation, 700);
    setTimeout(fetchScannerCalls, 1200);
    setTimeout(fetchScannerTalkgroups, 1800);
    setTimeout(fetchTrends, 2400);
    setTimeout(fetchSummarySnapshot, 2600);
    setTimeout(fetchDailySummary, 3000);
    setTimeout(fetchMonthlySummary, 3600);
    setTimeout(fetchSocialIntel, 4200);

    setInterval(function () {
      fetchIncidents();
      fetchSituation();
      fetchSummarySnapshot();
    }, REFRESH_MS);

    setInterval(fetchScannerCalls, SCANNER_REFRESH_MS);
    setInterval(fetchSocialIntel, 900000);   // social intel every 15 min
  });

  function refreshHeaderPrimaryCount() {
    var chipLbl = document.querySelector(".stat-chip--live .stat-lbl");
    var sub = document.getElementById("statLiveSub");
    var v = lastCrimeCounts.visible_feed_count;
    var a = lastCrimeCounts.live_now_count;
    var confN = lastFeedTotals.confirmed;
    var tracked = lastCrimeCounts.stats_total_incidents;
    if (activeFeedTab === "live") {
      if (chipLbl) chipLbl.textContent = "Live feed";
      if (typeof v === "number") setNum("statTotal", v);
      if (sub) {
        if (typeof v !== "number" || v === 0) sub.textContent = "";
        else {
          var rsec = Math.max(0, v - (typeof a === "number" ? a : 0));
          sub.textContent =
            (typeof a === "number" ? a : 0) +
            " active now" +
            (rsec ? " · " + rsec + " recent" : "");
        }
      }
    } else if (activeFeedTab === "confirmed") {
      if (chipLbl) chipLbl.textContent = "Confirmed (48h)";
      if (typeof confN === "number") setNum("statTotal", confN);
      if (sub) sub.textContent = "This tab · fused + official + media";
    } else {
      if (chipLbl) chipLbl.textContent = "Tracked";
      if (typeof tracked === "number") setNum("statTotal", tracked);
      if (sub) sub.textContent = "Stats-eligible (all lanes)";
    }
  }

  // ── FEED SUB-TABS (Live / Confirmed / Context) ────────────────
  function initFeedTabs() {
    var tabs = document.querySelectorAll(".feed-subtab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var target = tab.getAttribute("data-feedtab");
        if (target === activeFeedTab) return;
        activeFeedTab = target;

        tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-feedtab") === target); });
        document.querySelectorAll(".feed-tab-content").forEach(function (panel) {
          panel.classList.toggle("active", panel.id === "feedTab" + capitalize(target));
        });

        refreshHeaderPrimaryCount();

        if (target === "context") {
          var card = document.getElementById("monthlySummaryCard");
          if (card && card.querySelector(".skeleton-card")) {
            fetchMonthlySummary();
          }
        }
      });
    });
  }

  function initFeedControls() {
    var search = document.getElementById("feedSearchInput");
    if (search) {
      search.addEventListener("input", function () {
        feedSearchQuery = (search.value || "").trim().toLowerCase();
        if (feedControlTimer) clearTimeout(feedControlTimer);
        feedControlTimer = setTimeout(fetchIncidents, 220);
      });
    }
    var sort = document.getElementById("feedSortSelect");
    if (sort) {
      sort.addEventListener("change", function () {
        feedSortMode = sort.value || "newest";
        fetchIncidents();
      });
    }
  }

  function initSummaryControls() {
    var sel = document.getElementById("summaryWindowSelect");
    if (!sel) return;
    sel.value = summaryWindow;
    sel.addEventListener("change", function () {
      summaryWindow = sel.value || "7d";
      fetchSummarySnapshot();
    });
  }

  function _topText(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return "No data";
    return rows
      .slice(0, 2)
      .map(function (r) {
        return (r.key || "unknown") + " (" + (r.count || 0) + ")";
      })
      .join(" · ");
  }

  function renderSummarySnapshot(summary, trends) {
    var el = document.getElementById("feedSummaryGrid");
    if (!el) return;
    if (!summary || summary.status === "error") {
      el.innerHTML = '<div class="feed-summary-empty">Summary is temporarily unavailable.</div>';
      return;
    }

    var total = Number(summary.total || 0);
    var delta = Number(summary.delta_count || 0);
    var pct = Number(summary.delta_percent || 0);
    var trendText =
      (delta > 0 ? "+" : "") + delta + " vs prev window" + " (" + (isFinite(pct) ? pct : 0) + "%)";

    var topTypes = _topText(summary.groups && summary.groups.incident_type);
    var topMunis = _topText(summary.groups && summary.groups.municipality);
    var sourceMix = _topText(summary.groups && summary.groups.source_type);
    var verifyMix = _topText(summary.groups && summary.groups.verification_level);

    var daily = trends && trends.series && Array.isArray(trends.series.daily_counts)
      ? trends.series.daily_counts
      : [];
    var recentDaily = daily.slice(-7).map(function (p) { return p.count || 0; });
    var spike = recentDaily.length ? Math.max.apply(Math, recentDaily) : 0;

    var html = "";
    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Total incidents</div>';
    html += '<div class="feed-summary-v">' + esc(String(total)) + '</div>';
    html += '<div class="feed-summary-sub">' + esc(trendText) + "</div>";
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Trend snapshot</div>';
    html += '<div class="feed-summary-v">' + esc(String(spike)) + '</div>';
    html += '<div class="feed-summary-sub">Highest daily count in recent trend</div>';
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Top categories</div>';
    html += '<div class="feed-summary-list">' + esc(topTypes) + "</div>";
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Top municipalities</div>';
    html += '<div class="feed-summary-list">' + esc(topMunis) + "</div>";
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Source mix</div>';
    html += '<div class="feed-summary-list">' + esc(sourceMix) + "</div>";
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Verification mix</div>';
    html += '<div class="feed-summary-list">' + esc(verifyMix) + "</div>";
    html += "</div>";

    el.innerHTML = html;
  }

  function fetchSummarySnapshot() {
    var summaryReq = apiClient && apiClient.getIncidentSummary
      ? apiClient.getIncidentSummary({ window: summaryWindow })
      : fetch(API + "/api/incidents/summary?window=" + encodeURIComponent(summaryWindow)).then(ok);
    var trendsReq = apiClient && apiClient.getIncidentTrends
      ? apiClient.getIncidentTrends({ window: summaryWindow === "24h" ? "7d" : summaryWindow })
      : fetch(API + "/api/incidents/trends?window=" + encodeURIComponent(summaryWindow === "24h" ? "7d" : summaryWindow)).then(ok);
    Promise.all([summaryReq, trendsReq])
      .then(function (res) {
        renderSummarySnapshot(res[0], res[1]);
      })
      .catch(function () {
        renderSummarySnapshot({ status: "error" }, null);
      });
  }

  // ── NAVIGATION ────────────────────────────────────────────────
  function initNav() {
    // Mobile bottom nav
    var btns = document.querySelectorAll(".nav-btn");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        switchView(view);
      });
    });

    // Desktop tabs
    var dtabs = document.querySelectorAll(".desktop-tab");
    dtabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var view = tab.getAttribute("data-view");
        switchView(view);
      });
    });

    // Set feed as default active view
    switchView("feed");
  }

  function switchView(viewName) {
    activeView = viewName;

    // Update nav buttons (mobile)
    var btns = document.querySelectorAll(".nav-btn");
    btns.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === viewName);
    });

    // Update desktop tabs
    var dtabs = document.querySelectorAll(".desktop-tab");
    dtabs.forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === viewName);
    });

    // Update views
    var views = document.querySelectorAll(".view");
    views.forEach(function (v) { v.classList.remove("active"); });

    var target = document.getElementById("view" + capitalize(viewName));
    if (target) target.classList.add("active");

    // Lazy init map when first shown
    if (viewName === "map" && !mapInitialized) {
      initMap();
      mapInitialized = true;
    } else if (viewName === "map" && map) {
      setTimeout(function () { map.invalidateSize(); }, 100);
      refreshMapMarkers();
    }

    // On tablet+, map is always visible — also init it on first load
    if (isTablet() && !mapInitialized) {
      initMap();
      mapInitialized = true;
    }

    // Lazy-load NIBRS
    if (viewName === "more") {
      var list = document.getElementById("nibrsAgencies");
      if (list && list.querySelector(".skeleton")) {
        fetchNibrsAgencies();
      }
    }

    // Lazy-load law enforcement directory
    if (viewName === "directory" && !directoryLoaded && !directoryLoading) {
      fetchDirectory();
    }
  }

  // Expose globally so inline onclick in scanner-intel cards can call it
  window.switchView = switchView;

  function isTablet() {
    return window.innerWidth >= 768;
  }

  // On resize, ensure map is initialized for tablet+
  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (isTablet() && !mapInitialized) {
        initMap();
        mapInitialized = true;
      }
      if (map) map.invalidateSize();
    }, 200);
  });

  // ── CLOCK ─────────────────────────────────────────────────────
  function startClock() {
    function tick() {
      var el = document.getElementById("topbarTime");
      if (el) {
        var now = new Date();
        el.textContent = now.toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        });
      }
    }
    tick();
    setInterval(tick, 1000);
  }

  // ── MAP ───────────────────────────────────────────────────────
  function initMap() {
    var el = document.getElementById("map");
    if (!el || map) return;

    try {
      map = L.map("map", {
        center: [42.65, -73.75],
        zoom: 11,
        zoomControl: false,
        attributionControl: false,
        tap: true,
        tapTolerance: 15,
        touchZoom: true,
        dragging: true,
        bounceAtZoomLimits: true,
        inertia: true,
        inertiaDeceleration: 3000,
        zoomAnimation: true,
        scrollWheelZoom: true
      });

      L.control.zoom({ position: "topright" }).addTo(map);

      var theme = getTheme();
      var tileUrl = theme === "dark" ? TILES_DARK : TILES_LIGHT;
      tileLayer = L.tileLayer(tileUrl, {
        maxZoom: 19,
        subdomains: "abcd"
      }).addTo(map);

      if (typeof L.markerClusterGroup === "function") {
        markerGroup = L.markerClusterGroup({
          maxClusterRadius: 60,
          disableClusteringAtZoom: 14,
          spiderfyOnMaxZoom: false,
          showCoverageOnHover: false,
          zoomToBoundsOnClick: true,
          chunkedLoading: true,
          iconCreateFunction: function (cluster) {
            var count = cluster.getChildCount();
            var size = count < 5 ? "small" : count < 15 ? "medium" : "large";
            return L.divIcon({
              html: '<div class="cluster-inner">' + count + '</div>',
              className: "marker-cluster marker-cluster-" + size,
              iconSize: L.point(40, 40)
            });
          }
        });
      } else {
        markerGroup = L.layerGroup();
      }
      map.addLayer(markerGroup);
      mapReady = true;

      // Bottom-left legend control
      var legend = L.control({ position: "bottomleft" });
      legend.onAdd = function () {
        var div = L.DomUtil.create("div", "map-legend-ctrl");
        div.innerHTML =
          '<span class="legend-item"><span class="legend-dot violent"></span>Violent</span>' +
          '<span class="legend-item"><span class="legend-dot property"></span>Property</span>' +
          '<span class="legend-item"><span class="legend-dot other"></span>Other</span>';
        return div;
      };
      legend.addTo(map);

      initMapFilters();

      if (pendingMarkerData) plotMarkers(pendingMarkerData);
      refreshMapMarkers();

      setTimeout(function () { map.invalidateSize(); }, 300);
      el.style.touchAction = "none";
    } catch (err) {
      console.error("Map init error:", err);
      // Degrade gracefully — show a message in the map container
      if (window.ACTMap && window.ACTMap.mountMapUnavailableMessage) {
        window.ACTMap.mountMapUnavailableMessage(el, "Map unavailable right now");
      } else if (el) {
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:13px;">Map unavailable</div>';
      }
    }
  }

  function updateMapTiles(theme) {
    if (!map || !tileLayer) return;
    var newUrl = theme === "dark" ? TILES_DARK : TILES_LIGHT;
    tileLayer.setUrl(newUrl);
  }

  function initMapFilters() {
    var btns = document.querySelectorAll(".map-filter-btn");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        btns.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeMapFilter = btn.getAttribute("data-filter");
        refreshMapMarkers();
      });
    });
    initMapControls();
  }

  function initMapControls() {
    var search = document.getElementById("mapSearchInput");
    var verification = document.getElementById("mapVerificationSelect");
    var severity = document.getElementById("mapSeveritySelect");
    function trigger() {
      if (search) mapSearchQuery = (search.value || "").trim();
      if (verification) mapVerification = verification.value || "";
      if (severity) mapSeverity = severity.value || "";
      if (mapFetchTimer) clearTimeout(mapFetchTimer);
      mapFetchTimer = setTimeout(function () {
        refreshMapMarkers();
      }, 180);
    }
    if (search) search.addEventListener("input", trigger);
    if (verification) verification.addEventListener("change", trigger);
    if (severity) severity.addEventListener("change", trigger);
  }

  function setMapStatus(text) {
    var el = document.getElementById("mapStatus");
    if (el) el.textContent = text || "";
  }

  function mapCategory(item) {
    var t = (item && item.incident_type || item && item.event_type || "").toLowerCase();
    if (t.indexOf("violent") !== -1 || t.indexOf("homicide") !== -1 || t.indexOf("assault") !== -1 || t.indexOf("shooting") !== -1 || t.indexOf("stabbing") !== -1) {
      return "violent";
    }
    if (t.indexOf("property") !== -1 || t.indexOf("burglary") !== -1 || t.indexOf("theft") !== -1 || t.indexOf("robbery") !== -1) {
      return "property";
    }
    return "other";
  }

  function refreshMapMarkers() {
    setMapStatus("Loading map incidents...");
    var params = {
      has_coordinates: "true",
      limit: 500,
      q: mapSearchQuery,
      verification_level: mapVerification,
      severity: mapSeverity,
      sort_by: "newest"
    };
    var fetcher = apiClient && apiClient.getIncidentMarkers
      ? apiClient.getIncidentMarkers(params)
      : fetch(API + "/api/incidents/map?has_coordinates=true&limit=500").then(ok);
    fetcher
      .then(function (r) {
        var markers = (r && Array.isArray(r.markers)) ? r.markers : [];
        pendingMarkerData = markers;
        if (mapReady) plotMarkers(markers);
      })
      .catch(function () {
        setMapStatus("Could not load map incidents right now.");
        pendingMarkerData = [];
        if (mapReady) plotMarkers([]);
      });
  }

  function plotMarkers(data) {
    if (!markerGroup) return;
    markerGroup.clearLayers();

    var filtered = activeMapFilter === "all"
      ? data
      : data.filter(function (d) { return mapCategory(d) === activeMapFilter; });

    filtered.forEach(function (item) {
      var lat = parseFloat(item.latitude);
      var lng = parseFloat(item.longitude);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

      var type = mapCategory(item);
      var color = type === "violent" ? "#e05252" :
                  type === "property" ? "#d9953a" : "#4d8fdb";

      var inc = item.incident || {};
      var ps = typeof item.public_safety_score === "number" ? item.public_safety_score : 0;
      var vf = item.verification_level || inc.verification_level || "";
      var lf = inc.live_frame || "";
      var radius = lf === "live_now" ? 12 : lf === "developing" ? 10 : ps >= 55 ? 9 : 7;
      var fillOp = vf === "multi_source" || vf === "official" ? 0.92 : vf === "scanner" ? 0.72 : 0.85;
      if (item._scanner_call && vf !== "multi_source" && vf !== "official") fillOp = 0.68;

      var circle = L.circleMarker([lat, lng], {
        radius: radius,
        fillColor: color,
        color: "#fff",
        weight: lf === "live_now" ? 2.2 : 1.5,
        opacity: 1,
        fillOpacity: fillOp
      });

      var ta = item.human_time || (item.pubDate ? timeAgo(new Date(item.pubDate)) : "");
      var loc = item.matched_location
        ? esc(item.matched_location.replace(/\b\w/g, function(c){ return c.toUpperCase(); }))
        : "";

      var popup = '<div style="font-family:Satoshi,system-ui,sans-serif;max-width:260px;">';
      popup += '<div style="font-size:12px;font-weight:600;line-height:1.4;margin-bottom:6px;">' + esc(item.title || "Incident") + '</div>';
      if (inc.why_it_matters && inc.why_it_matters !== item.title) {
        popup += '<div style="font-size:11px;color:#aaa;line-height:1.35;margin-bottom:6px;">' + esc(inc.why_it_matters.slice(0, 200)) + '</div>';
      }
      if (inc.source_count > 1) {
        popup += '<div style="font-size:10px;color:#7cb87c;margin-bottom:4px;">' + esc(String(inc.source_count)) + ' sources</div>';
      }
      if (loc) {
        popup += '<div style="font-size:11px;color:#4d8fdb;margin-bottom:3px;font-weight:500;">📍 ' + loc + '</div>';
      }
      var typeBadge = type === "violent"
        ? '<span style="background:#e05252;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;text-transform:uppercase;font-weight:700;">Violent</span>'
        : type === "property"
        ? '<span style="background:#d9953a;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;text-transform:uppercase;font-weight:700;">Property</span>'
        : '<span style="background:#4d8fdb;color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;text-transform:uppercase;font-weight:700;">Other</span>';
      popup += '<div style="margin-bottom:6px;">' + typeBadge + '</div>';
      if (item.source || ta) {
        popup += '<div style="font-size:10px;color:#888;">';
        if (item.source) popup += esc(item.source);
        if (item.source && ta) popup += ' · ';
        if (ta) popup += esc(ta);
        popup += '</div>';
      }
      if (item.link) {
        popup += '<div style="margin-top:6px;"><a href="' + escAttr(item.link) + '" target="_blank" rel="noopener" style="font-size:11px;color:#4d8fdb;text-decoration:none;font-weight:500;">Read article →</a></div>';
      }
      if (item.coordinate_quality && item.coordinate_quality !== "exact") {
        popup += '<div style="margin-top:6px;font-size:10px;color:#c9b37f;">Coordinate: ' + esc(item.coordinate_quality) + '</div>';
      }
      popup += '</div>';

      circle.bindPopup(popup, { closeButton: true, autoPan: true, autoPanPaddingTopLeft: [10, 60], maxWidth: 260 });
      markerGroup.addLayer(circle);
    });
    setMapStatus(filtered.length ? (filtered.length + " markers") : "No incidents match the current map filters.");
  }

  // ── SITUATION EXPAND ──────────────────────────────────────────
  (function initSituationExpand() {
    var btn = document.getElementById("situationExpandBtn");
    var full = document.getElementById("situationTextFull");
    if (!btn || !full) return;
    btn.addEventListener("click", function () {
      var expanded = btn.classList.toggle("expanded");
      if (expanded) {
        full.removeAttribute("hidden");
        btn.querySelector(".material-icons").textContent = "expand_less";
      } else {
        full.setAttribute("hidden", "");
        btn.querySelector(".material-icons").textContent = "expand_more";
      }
    });
  })();

  // Top bar shows "Connecting" until /api/situation returns — that route can be very slow on a cold cache.
  // Once the incident feed has loaded, show Live so the app does not look stuck.
  function markTopbarLiveIfStillConnecting() {
    var status = document.getElementById("topbarStatus");
    if (status && status.textContent === "Connecting") {
      status.textContent = "Live";
      var dot = document.getElementById("liveDot");
      if (dot) dot.classList.add("active");
    }
  }

  // ── SITUATION BAR ─────────────────────────────────────────────
  var SITUATION_FETCH_MS = 60000;

  function fetchSituation() {
    var ctrl = new AbortController();
    var tid = setTimeout(function () {
      ctrl.abort();
    }, SITUATION_FETCH_MS);
    fetch(API + "/api/situation", { signal: ctrl.signal })
      .finally(function () {
        clearTimeout(tid);
      })
      .then(ok)
      .then(function (r) {
        var situation = r.situation || "Analyzing...";
        // Split into short preview (first sentence) and full text
        var sentences = situation.match(/[^.!?]+[.!?]+/g) || [situation];
        var preview = sentences[0].trim();
        var hasMore = sentences.length > 1;

        var textEl = document.getElementById("situationText");
        if (textEl) textEl.textContent = preview;

        var fullEl = document.getElementById("situationTextFull");
        var btnEl = document.getElementById("situationExpandBtn");
        if (fullEl && btnEl) {
          if (hasMore) {
            fullEl.textContent = sentences.slice(1).join(" ").trim();
            btnEl.style.display = "";
          } else {
            btnEl.style.display = "none";
          }
        }

        var badgeEl = document.getElementById("threatBadge");
        var level = (r.threat_level || "unknown").toLowerCase();
        if (badgeEl) {
          badgeEl.textContent = level;
          badgeEl.className = "threat-badge " + level;
        }

        var stats = r.stats || {};
        var cc = r.crime_counts || {};
        if (cc && Object.keys(cc).length) {
          Object.assign(lastCrimeCounts, cc);
        }
        setNum("statViolent", stats.violent || 0);
        setNum("statProperty", stats.property || 0);
        if (typeof cc.recent_48h_count === "number") {
          setNum("statRecent", cc.recent_48h_count);
        } else {
          setNum("statRecent", stats.recent_48h || 0);
        }
        refreshHeaderPrimaryCount();

        if (r.patterns) renderPatterns(r.patterns);

        var dot = document.getElementById("liveDot");
        var status = document.getElementById("topbarStatus");
        if (dot) dot.classList.add("active");
        if (status) status.textContent = "Live";

        var footer = document.getElementById("footerSources");
        if (footer) {
          var sc = stats.source_count || 0;
          var ac = stats.total_articles || 0;
          footer.textContent = ac + " articles from " + sc + " sources · auto-refreshing";
        }
      })
      .catch(function (err) {
        console.error("Situation fetch error:", err);
        var status = document.getElementById("topbarStatus");
        if (err && err.name === "AbortError") {
          var textEl = document.getElementById("situationText");
          if (textEl && /^Analyzing/i.test(textEl.textContent || "")) {
            textEl.textContent =
              "Briefing is taking longer than usual (first load can take a minute). The feed below updates separately.";
          }
          markTopbarLiveIfStillConnecting();
          return;
        }
        if (status) status.textContent = "Reconnecting";
      });
  }

  // ── INCIDENTS ─────────────────────────────────────────────────
  var CRIMES_FETCH_MS = 120000;
  var _crimesFetchGeneration = 0;

  /** Live feed container (supports older HTML that used incidentListNow). */
  function getLiveFeedListEl() {
    return document.getElementById("incidentListLive") || document.getElementById("incidentListNow");
  }

  function _verificationLabel(v) {
    var m = (v || "").toLowerCase();
    if (m === "official") return "Official";
    if (m === "multi_source") return "Multi-source";
    if (m === "media") return "Media";
    if (m === "scanner") return "Scanner";
    if (m === "inferred") return "Inferred";
    return "Unknown";
  }

  function _sourceTypeLabel(v) {
    var m = (v || "").toLowerCase();
    if (m === "official") return "Official";
    if (m === "scanner") return "Scanner";
    if (m === "media") return "Media";
    if (m === "fused" || m === "inferred") return "Inferred/Fused";
    return "Unknown";
  }

  function _crimeTypeFromIncidentType(t) {
    var v = (t || "").toLowerCase();
    if (v.indexOf("violent") !== -1 || v.indexOf("shooting") !== -1 || v.indexOf("stabbing") !== -1 || v.indexOf("homicide") !== -1) return "violent";
    if (v.indexOf("property") !== -1 || v.indexOf("burglary") !== -1 || v.indexOf("theft") !== -1 || v.indexOf("robbery") !== -1) return "property";
    return "other";
  }

  function _feedTabFromRecord(r) {
    var s = (r.status || "").toLowerCase();
    var v = (r.verification_level || "").toLowerCase();
    if (s === "active" || s === "recent") return "live";
    if (v === "official" || v === "multi_source" || v === "media") return "confirmed";
    return "news_context";
  }

  function _toFeedItemFromIncident(r) {
    var pub = r.occurred_at || r.published_at || "";
    var tags = Array.isArray(r.badges) && r.badges.length ? r.badges : (r.tags || []);
    var feedTab = _feedTabFromRecord(r);
    return {
      id: r.id,
      title: r.short_title || r.title || "Untitled",
      short_title: r.short_title || r.title || "Untitled",
      summary: r.description || "",
      description: r.description || "",
      pubDate: pub,
      link: r.source_url || "",
      source: r.source_name || "",
      sources: r.source_name ? [r.source_name] : [],
      latitude: r.latitude,
      longitude: r.longitude,
      municipality: r.municipality || "",
      neighborhood: r.municipality || "",
      matched_location: r.address_text || "",
      confidence: typeof r.confidence_score === "number" ? r.confidence_score : 0,
      verification_level: r.verification_level || "unknown",
      verification_label: _verificationLabel(r.verification_level || ""),
      verification_explanation: r.verification_explanation || "",
      severity: r.severity || "unknown",
      source_type: r.source_type || "",
      source_type_label: _sourceTypeLabel(r.source_type || ""),
      crime_type: _crimeTypeFromIncidentType(r.incident_type || ""),
      coordinate_quality: r.coordinate_quality || "missing",
      coordinate_explanation: r.coordinate_explanation || "",
      human_time: r.human_time || "",
      feed_tab: feedTab,
      is_active_incident: (r.status || "").toLowerCase() === "active" || (r.status || "").toLowerCase() === "recent",
      badges: tags,
      incident: {
        id: r.id,
        event_type: r.incident_type || "general",
        sub_type: "",
        status: r.status || "unknown",
        verification_level: r.verification_level || "unknown",
        operational_badges: tags,
        why_it_matters: r.description || "",
        feed_lane: feedTab === "news_context" ? "news_context" : feedTab
      }
    };
  }

  function fetchIncidents() {
    var myGen = ++_crimesFetchGeneration;
    var ctrl = new AbortController();
    var tid = setTimeout(function () {
      ctrl.abort();
    }, CRIMES_FETCH_MS);
    var params = {
      limit: 300,
      q: feedSearchQuery || "",
      sort_by: feedSortMode || "newest"
    };
    (apiClient && apiClient.getPersistedIncidents
      ? apiClient.getPersistedIncidents(params)
      : fetch(API + "/api/incidents?limit=300", { signal: ctrl.signal }).then(ok))
      .finally(function () {
        clearTimeout(tid);
      })
      .then(function (r) {
        if (myGen !== _crimesFetchGeneration) return;
        if (!r || r.status !== "ok") throw new Error("incidents_api_invalid");
        var records = Array.isArray(r.incidents) ? r.incidents : [];
        var data = records.map(_toFeedItemFromIncident);
        allIncidentData = data;
        lastCrimeCounts.visible_feed_count = data.length;
        lastCrimeCounts.live_now_count = data.filter(function (x) { return x.feed_tab === "live"; }).length;
        lastCrimeCounts.stats_total_incidents = data.length;
        lastFeedTotals.confirmed = data.filter(function (x) { return x.feed_tab === "confirmed"; }).length;

        var activeItems = data.filter(function (x) { return x.feed_tab === "live"; });
        var recentItems = [];
        lastLiveActiveItems = activeItems;
        lastLiveRecentItems = recentItems;

        var confItems = data.filter(function (x) { return x.feed_tab === "confirmed"; });
        var ctxItems = data.filter(function (x) { return x.feed_tab === "news_context" || x.feed_tab === "news"; });
        renderLiveFeed(activeItems, recentItems);
        renderConfirmedFeed(confItems);
        renderContextFeed(ctxItems);
        refreshHeaderPrimaryCount();
        markTopbarLiveIfStillConnecting();
      })
      .catch(function (err) {
        console.error("Incidents fetch error (/api/incidents):", err);
        if (myGen !== _crimesFetchGeneration) return;
        // Backward-compatible fallback to legacy /api/crimes payload.
        (apiClient ? apiClient.getIncidents() : fetch(API + "/api/crimes", { signal: ctrl.signal }).then(ok))
          .then(function (legacy) {
            if (!legacy || legacy.status !== "ok") throw new Error("legacy_incidents_invalid");
            var data = Array.isArray(legacy.data) ? legacy.data : [];
            allIncidentData = data;
            var activeItems = data.filter(function (x) { return x.feed_tab === "live" || x.feed_tab === "now" || x.is_live_eligible === true; });
            var confItems = data.filter(function (x) { return x.feed_tab === "confirmed"; });
            var ctxItems = data.filter(function (x) { return x.feed_tab === "news_context" || x.feed_tab === "news"; });
            renderLiveFeed(activeItems, []);
            renderConfirmedFeed(confItems);
            renderContextFeed(ctxItems);
            markTopbarLiveIfStillConnecting();
          })
          .catch(function (fallbackErr) {
            console.error("Legacy incidents fallback error:", fallbackErr);
            markTopbarLiveIfStillConnecting();
            var msgText = "Could not load feed incidents right now. Please try again.";
            var liveL = getLiveFeedListEl();
            var confL = document.getElementById("incidentListConfirmed");
            var ctxL = document.getElementById("incidentListContext");
            if (window.ACTFeed && window.ACTFeed.renderErrorState) {
              if (liveL && !liveL.querySelector(".feed-item")) window.ACTFeed.renderErrorState(liveL, msgText);
              if (confL && !confL.querySelector(".feed-item")) window.ACTFeed.renderErrorState(confL, msgText);
              if (ctxL && !ctxL.querySelector(".feed-item")) window.ACTFeed.renderErrorState(ctxL, msgText);
            }
          });
      });
  }

  var OFFICIAL_SOURCES = new Set([
    "official @albanypolice", "official @acsotweet", "official @colonie_police",
    "official @pdbethlehem", "official @nyspolice",
    "nysp blotter", "nixle alert", "daily gazette blotter",
  ]);

  function isOfficialSource(src) {
    var s = (src || "").toLowerCase();
    if (OFFICIAL_SOURCES.has(s)) return true;
    if (s.indexOf("official @") === 0) return true;
    if (s.indexOf("official ·") === 0) return true;
    if (s === "official x") return true;
    if (s.indexOf("nixle") !== -1) return true;
    return false;
  }

  function isScannerCrimeSource(src) {
    return (src || "").toLowerCase().indexOf("scanner ·") !== -1;
  }

  function officialHandleFromSource(src) {
    var s = (src || "").trim();
    var m = /^official @(.+)$/i.exec(s);
    if (m) return m[1].trim();
    var m2 = /^official ·\s*@?([a-z0-9_]{2,20})$/i.exec(s);
    if (m2) return m2[1].trim();
    return "";
  }

  /** Visible freshness: Xm ago / Xh ago (uses API age_minutes when present). */
  function feedAgeCompact(item) {
    var m = item && typeof item.age_minutes === "number" && !isNaN(item.age_minutes)
      ? item.age_minutes
      : null;
    if (m === null && item && item.pubDate) {
      var ms = new Date(item.pubDate).getTime();
      if (!isNaN(ms)) m = (Date.now() - ms) / 60000;
    }
    if (m === null || isNaN(m)) return "";
    if (m < 1) return "just now";
    if (m < 60) return Math.round(m) + "m ago";
    var h = m / 60;
    if (h < 24) {
      var hf = Math.floor(h);
      if (hf < 1) hf = 1;
      return hf + "h ago";
    }
    var d = Math.floor(h / 24);
    return d + "d ago";
  }

  function isLikelyValidXStatusUrl(url) {
    var u = url || "";
    var m = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i.exec(u);
    if (!m) return false;
    var id = m[1];
    return id.length >= 18 && /^\d+$/.test(id);
  }

  /** Prefer real X status URL (x_post_url or link with snowflake); profile only if no valid post URL. */
  function resolveIncidentCardHref(item) {
    var xu = (item && (item.x_post_url || item._x_post_url)) || "";
    if (xu && isLikelyValidXStatusUrl(xu)) return xu;
    var link = (item && item.link) || "#";
    var src = (item && item.source) || "";
    if (!isOfficialSource(src)) return link;
    var h = officialHandleFromSource(src);
    if (!h) return link;
    var profile = "https://x.com/" + encodeURIComponent(h);
    if (isLikelyValidXStatusUrl(link)) return link;
    if (item && item._official_x_post) {
      if (!link || link === "#") return profile;
      if (/\/status\/\d+/i.test(link) && !isLikelyValidXStatusUrl(link)) return profile;
      return link;
    }
    if (/\/status\/\d+/i.test(link) && /(?:x\.com|twitter\.com)/i.test(link) && !isLikelyValidXStatusUrl(link))
      return profile;
    return link;
  }

  function renderOperationalBadges(inc) {
    if (!inc || !inc.operational_badges || !inc.operational_badges.length) return "";
    var html = '<div class="feed-op-badges">';
    inc.operational_badges.slice(0, 8).forEach(function (b) {
      html += '<span class="op-badge">' + esc(b) + "</span>";
    });
    html += "</div>";
    return html;
  }

  function buildIncidentCard(item) {
    var inc = item.incident || {};
    var type = item.crime_type || "other";
    var hood = item.municipality || item.neighborhood || item.matched_location || "";
    var primarySrc = item.source || "";
    var srcs = (Array.isArray(item.sources) && item.sources.length)
      ? item.sources : (primarySrc ? [primarySrc] : []);
    var ta = item.human_time || feedAgeCompact(item);
    var link = resolveIncidentCardHref(item);
    var official = isOfficialSource(primarySrc);
    var scannerCrime = isScannerCrimeSource(primarySrc);
    var scannerCritical = !!item._scanner_critical_live;
    var multiSource = srcs.length > 1;

    var cls = "feed-item";
    if (official) cls += " feed-item-official feed-item-official-prominent";
    if (scannerCrime) cls += " feed-item-scanner-crime";
    if (scannerCritical) cls += " feed-item-scanner-critical";
    var ageHForStale =
      item && typeof item.age_hours === "number" && !isNaN(item.age_hours)
        ? item.age_hours
        : null;
    if (ageHForStale === null && item && item.pubDate) {
      var _ms = new Date(item.pubDate).getTime();
      if (!isNaN(_ms)) ageHForStale = (Date.now() - _ms) / 3600000;
    }
    if (activeFeedTab === "live" && ageHForStale !== null && ageHForStale > 1.5) {
      cls += " feed-item--stale";
    }
    var html = '<a class="' + cls + '" href="' + escAttr(link) + '" target="_blank" rel="noopener noreferrer">';
    html += '<span class="feed-dot ' + esc(type) + '"></span>';
    html += '<div class="feed-body">';
    html += '<div class="feed-title">' + esc(item.short_title || item.title || "Untitled") + '</div>';
    if (item.subtitle) {
      html += '<div class="feed-op-line"><span class="feed-op-k">Source</span>' + esc(item.subtitle) + "</div>";
    }
    var areaDisp = hood || item.matched_location || item.neighborhood || "Albany County, NY";
    var typeStr =
      inc.event_type && inc.sub_type
        ? inc.event_type.replace(/_/g, " ") + " · " + inc.sub_type.replace(/_/g, " ")
        : String(item.crime_type || "public safety").replace(/_/g, " ");
    var sourceTypeLabel = item.source_type_label || "Unknown";
    var verificationExplain = item.verification_explanation || "Verification confidence metadata unavailable.";
    var coordinateExplain = item.coordinate_explanation || "Coordinate quality metadata unavailable.";
    var verStr =
      item.verification_label || String(inc.verification_level || "").replace(/_/g, " ") || "—";
    if (typeof item.confidence === "number" && !isNaN(item.confidence)) {
      var pctL = item.confidence <= 1 ? Math.round(item.confidence * 100) : Math.round(item.confidence);
      verStr = verStr + " · locality " + pctL + "%";
    }
    var srcSummary = multiSource ? srcs.slice(0, 4).join(" + ") : primarySrc || "—";
    html += '<div class="feed-op-line"><span class="feed-op-k">Area</span>' + esc(capitalize(areaDisp)) + "</div>";
    html += '<div class="feed-op-line"><span class="feed-op-k">Fresh</span>' + esc(ta || "—") + "</div>";
    html += '<div class="feed-op-line"><span class="feed-op-k">Type</span>' + esc(typeStr) + "</div>";
    html += '<div class="feed-op-line" title="' + escAttr(verificationExplain) + '"><span class="feed-op-k">Verification</span>' + esc(verStr) + "</div>";
    html += '<div class="feed-op-line"><span class="feed-op-k">Source class</span>' + esc(sourceTypeLabel) + "</div>";
    html += '<div class="feed-op-line"><span class="feed-op-k">Sources</span>' + esc(srcSummary) + "</div>";
    html += renderOperationalBadges(inc);
    if (item.coordinate_quality) {
      html += '<div class="feed-op-line" title="' + escAttr(coordinateExplain) + '"><span class="feed-op-k">Location</span>' + esc(item.coordinate_quality) + "</div>";
    }
    if (inc.why_it_matters != null && String(inc.why_it_matters).trim() !== "") {
      html +=
        '<div class="feed-why"><span class="feed-op-k">Why it matters</span> ' +
        esc(String(inc.why_it_matters).slice(0, 240)) +
        "</div>";
    }
    if (inc.feed_lane === "now" && inc.now_channel) {
      var ch = String(inc.now_channel).replace(/_/g, " ");
      html +=
        '<div class="feed-now-channel"><span class="now-channel-pill">' +
        esc(ch) +
        "</span>";
      if (typeof inc.score_source_confidence === "number") {
        html +=
          ' <span class="now-score-hint">rank · locality ' +
          (inc.score_locality != null ? Math.round(inc.score_locality) : "—") +
          " · impact " +
          (inc.score_impact != null ? Math.round(inc.score_impact) : "—") +
          "</span>";
      }
      html += "</div>";
    }
    html += '<div class="feed-meta">';
    if (hood) html += '<span class="feed-hood">' + esc(capitalize(hood)) + '</span>';
    if (official) {
      html += '<span class="official-badge official-badge--lg">OFFICIAL</span>';
      if (isLikelyValidXStatusUrl(link)) {
        html += '<span class="feed-x-cta">View post on X</span>';
      }
    } else if (scannerCritical) {
      html += '<span class="scanner-feed-badge scanner-feed-badge--critical scanner-feed-badge--lg scanner-badge-police">SCANNER · CRITICAL</span>';
    } else if (scannerCrime) {
      html += '<span class="scanner-feed-badge scanner-feed-badge--lg scanner-badge-police">SCANNER</span>';
    } else if (item.is_active_incident) {
      html += '<span class="scanner-feed-badge scanner-feed-badge--lg scanner-badge-police">ACTIVE</span>';
    }
    if (item.verification_level) {
      html += '<span class="scanner-feed-badge scanner-feed-badge--lg">' + esc(String(item.verification_level).replace(/_/g, " ").toUpperCase()) + '</span>';
    }
    if (Array.isArray(item.badges)) {
      item.badges.slice(0, 3).forEach(function (b) {
        html += '<span class="scanner-feed-badge scanner-feed-badge--lg">' + esc(String(b)) + '</span>';
      });
    }
    if (multiSource) {
      html += '<span class="multi-source">' + srcs.map(esc).join('<span class="src-sep"> + </span>') + '</span>';
    } else if (srcs.length === 1) {
      html += '<span>' + esc(srcs[0]) + '</span>';
    }
    if (ta) {
      var mFresh = item && typeof item.age_minutes === "number" && !isNaN(item.age_minutes) ? item.age_minutes : null;
      var ageCls = "feed-age";
      if (mFresh !== null && mFresh <= 30) ageCls += " feed-age--fresh";
      if (activeFeedTab === "live" && ageHForStale !== null && ageHForStale > 1.5) ageCls += " feed-age--stale";
      html += '<span class="' + ageCls + '">' + esc(ta) + "</span>";
    }
    html += '</div></div></a>';
    return html;
  }

  function itemAgeHours(item) {
    if (item && typeof item.age_hours === "number" && !isNaN(item.age_hours)) return item.age_hours;
    if (item && item.pubDate) {
      var ms = new Date(item.pubDate).getTime();
      if (!isNaN(ms)) return (Date.now() - ms) / 3600000;
    }
    return null;
  }

  function liveActiveSectionHasFreshItems(activeItems, maxHours) {
    maxHours = maxHours == null ? 1.5 : maxHours;
    if (!activeItems || !activeItems.length) return false;
    return activeItems.some(function (x) {
      var h = itemAgeHours(x);
      return h !== null && h <= maxHours;
    });
  }

  function feedItemMatches(item) {
    if (!feedSearchQuery) return true;
    var needle = (feedSearchQuery || "").toLowerCase();
    var blob = [
      item && item.title,
      item && item.summary,
      item && item.description,
      item && item.source,
      item && item.municipality,
      item && item.matched_location
    ].join(" ").toLowerCase();
    return blob.indexOf(needle) !== -1;
  }

  function feedSortRankSeverity(item) {
    var sev = (item && (item.severity || (item.incident && item.incident.severity)) || "").toLowerCase();
    if (sev === "critical") return 4;
    if (sev === "high") return 3;
    if (sev === "medium") return 2;
    if (sev === "low") return 1;
    return 0;
  }

  function feedSortRankVerification(item) {
    var v = (item && (item.verification_level || (item.incident && item.incident.verification_level)) || "").toLowerCase();
    if (v === "official") return 5;
    if (v === "multi_source") return 4;
    if (v === "media") return 3;
    if (v === "scanner") return 2;
    if (v === "inferred") return 1;
    return 0;
  }

  function applyFeedUiFilters(items) {
    var filtered = (items || []).filter(feedItemMatches);
    if (feedSortMode === "severity") {
      filtered.sort(function (a, b) {
        return feedSortRankSeverity(b) - feedSortRankSeverity(a);
      });
    } else if (feedSortMode === "verification") {
      filtered.sort(function (a, b) {
        return feedSortRankVerification(b) - feedSortRankVerification(a);
      });
    } else {
      filtered.sort(function (a, b) {
        var ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        var tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return tb - ta;
      });
    }
    return filtered;
  }

  function renderLiveFeed(activeItems, recentItems) {
    var list = getLiveFeedListEl();
    if (!list) return;
    activeItems = applyFeedUiFilters(activeItems || []);
    recentItems = applyFeedUiFilters(recentItems || []);

    var html = "";
    var hasActive = activeItems && activeItems.length;
    var hasRecent = recentItems && recentItems.length;
    var anyIncidentCards = hasActive || hasRecent;

    if (scannerIntelItems.length > 0 && !anyIncidentCards) {
      scannerIntelItems.forEach(function (intel) {
        var catLabel = intel.cat === "fire" ? "Fire" : intel.cat === "ems" ? "EMS" : "Police";
        var catIcon  = intel.cat === "fire" ? "local_fire_department"
                     : intel.cat === "ems"  ? "emergency"
                     :                        "local_police";
        var borderCls = " scanner-intel-" + (intel.cat || "police");
        var detailParts = [];
        if (intel.freqMHz) detailParts.push(intel.freqMHz + " MHz");
        if (intel.len > 0) detailParts.push(intel.len.toFixed(0) + "s");
        var durText = detailParts.length ? detailParts.join(" \u00b7 ") : "active";
        html += '<div class="feed-item scanner-intel' + borderCls + ' scanner-intel-clickable" role="button" tabindex="0" title="View in Scanner tab" onclick="switchView(\'scanner\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')switchView(\'scanner\')">';
        html += '<span class="feed-dot scanner-dot scanner-dot-' + esc(intel.cat || "police") + '"></span>';
        html += '<div class="feed-body">';
        html += '<div class="feed-title">';
        html += '<span class="material-icons" style="font-size:13px;vertical-align:-2px;margin-right:3px;">' + catIcon + '</span>';
        html += '<strong>' + esc(intel.tgName) + '</strong>';
        if (intel.location) html += '<span class="scanner-call-loc"> \u2014 ' + esc(intel.location) + '</span>';
        html += '<span class="scanner-intel-arrow material-icons" style="font-size:12px;opacity:0.4;margin-left:4px;vertical-align:-1px;">chevron_right</span>';
        html += '</div>';
        html += '<div class="scanner-call-detail">' + esc(durText) + '</div>';
        html += '<div class="feed-meta">';
        html += '<span class="scanner-feed-badge scanner-feed-badge--lg scanner-badge-' + esc(intel.cat || "police") + '">SCANNER · ' + esc(catLabel) + '</span>';
        html += '<span>' + esc(intel.time) + '</span>';
        html += '<span class="scanner-intel-tap-hint">Tap for scanner</span>';
        html += '</div></div></div>';
      });
    }

    if (!hasActive && hasRecent) {
      html +=
        '<div class="feed-section-note" role="status">' +
        "<strong>Active now</strong> is empty. Showing <strong>Recent local activity</strong> (Albany County, up to 48h) so the feed stays useful." +
        "</div>";
    } else if (
      !liveActiveSectionHasFreshItems(activeItems, 1.5) &&
      !hasRecent &&
      !anyIncidentCards &&
      scannerIntelItems.length === 0
    ) {
      html +=
        '<div class="feed-live-stale-note" role="status">' +
        "No active or recent incidents in the Live feed yet. Sources refresh on a short interval." +
        "</div>";
    }

    if (hasActive) {
      html += '<div class="feed-section-title">Active now</div>';
      if (!liveActiveSectionHasFreshItems(activeItems, 1.5)) {
        html +=
          '<div class="feed-section-note">Nothing fresher than ~90m in this block; cards here are older operational mentions kept for context.</div>';
      }
      activeItems.forEach(function (item) { html += buildIncidentCard(item); });
    }

    if (hasRecent) {
      html += '<div class="feed-section-title">Recent local activity</div>';
      html +=
        '<div class="feed-section-note">Up to 48 hours · may not be an ongoing scene · same strict Albany County filter as the rest of the app.</div>';
      recentItems.forEach(function (item) { html += buildIncidentCard(item); });
    }

    if (!anyIncidentCards && scannerIntelItems.length === 0) {
      html +=
        '<div class="empty-state">No Albany County incidents on the Live feed right now. Try the Scanner tab or wait for the next refresh.</div>';
    }

    list.innerHTML = html;
  }

  function renderConfirmedFeed(confirmedItems) {
    var list = document.getElementById("incidentListConfirmed");
    if (!list) return;
    confirmedItems = applyFeedUiFilters(confirmedItems || []);
    if (!confirmedItems || confirmedItems.length === 0) {
      list.innerHTML =
        '<div class="empty-state">No confirmed incidents in the last 48 hours (fused scanner + official + substantive local media).</div>';
      return;
    }
    var html = "";
    confirmedItems.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  function renderContextFeed(contextItems) {
    var list = document.getElementById("incidentListContext");
    if (!list) return;
    contextItems = applyFeedUiFilters(contextItems || []);

    if (!contextItems || contextItems.length === 0) {
      list.innerHTML = '<div class="empty-state">No follow-ups or older reports in the 48h–7d window.</div>';
      return;
    }

    var sorted = contextItems.slice().sort(function (a, b) {
      var ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      var tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });
    var html = "";
    sorted.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  function renderIncidentList(data) {
    if (!data) return;
    var liveA = data.filter(function (x) {
      var s = x.live_section || (x.incident && x.incident.live_section);
      return s === "active_now" || x.feed_tab === "now";
    });
    var liveR = data.filter(function (x) {
      var s = x.live_section || (x.incident && x.incident.live_section);
      return s === "recent_local";
    });
    if (!liveA.length && !liveR.length) {
      liveA = data.filter(function (x) { return x.feed_tab === "now" || x.feed_tab === "live"; });
    }
    renderLiveFeed(liveA, liveR);
    renderConfirmedFeed(data.filter(function (x) { return x.feed_tab === "confirmed"; }));
    renderContextFeed(data.filter(function (x) { return x.feed_tab === "news_context" || x.feed_tab === "news"; }));
  }

  // ── DAILY BRIEFING ────────────────────────────────────────────
  function fetchDailySummary() {
    fetch(API + "/api/daily_summary")
      .then(ok)
      .then(renderDailySummary)
      .catch(function () {
        var card = document.getElementById("dailySummaryCard");
        if (card) card.innerHTML = "";
      });
  }

  function renderDailySummary(r) {
    var card = document.getElementById("dailySummaryCard");
    if (!card) return;
    if (!r || r.status === "error") { card.innerHTML = ""; return; }

    var level = (r.threat_level || "low").toLowerCase();
    var levelLabel = { high: "HIGH", elevated: "ELEVATED", moderate: "MODERATE", low: "LOW" }[level] || level.toUpperCase();
    var date = r.date || "";
    var briefing = r.briefing || "";
    var incidents = r.top_incidents || [];
    var patterns = r.patterns || [];

    var html = '<div class="nac-header">';
    html += '<span class="nac-label"><span class="nac-label-icon">📋</span>Daily Briefing · ' + esc(date) + ' · ' + (r.incident_count || 0) + ' incidents</span>';
    html += '<span class="nac-badge level-' + esc(level) + '">' + esc(levelLabel) + '</span>';
    html += '</div>';
    html += '<div class="nac-body">';
    if (briefing) html += '<div class="nac-briefing">' + esc(briefing) + '</div>';

    if (incidents.length) {
      html += '<div class="nac-incidents">';
      incidents.forEach(function (inc) {
        var t = (inc.type || "other").toLowerCase();
        html += '<div class="nac-incident ' + esc(t) + '">';
        html += '<div>';
        html += '<div class="nac-incident-title">' + esc(inc.title || "") + '</div>';
        html += '<div class="nac-incident-meta">';
        if (inc.location) html += esc(inc.location);
        if (inc.significance) html += (inc.location ? ' · ' : '') + esc(inc.significance);
        html += '</div>';
        html += '</div></div>';
      });
      html += '</div>';
    }

    if (patterns.length) {
      html += '<div class="nac-patterns" style="margin-top:var(--sp-3)">';
      patterns.forEach(function (p) {
        html += '<div class="nac-pattern">' + esc(p) + '</div>';
      });
      html += '</div>';
    }

    html += '</div>';
    card.innerHTML = html;
  }

  // ── MONTHLY OVERVIEW + PROJECTION ────────────────────────────
  function fetchMonthlySummary() {
    fetch(API + "/api/monthly_summary")
      .then(ok)
      .then(renderMonthlySummary)
      .catch(function () {
        var c1 = document.getElementById("monthlySummaryCard");
        var c2 = document.getElementById("monthlyProjectionCard");
        if (c1) c1.innerHTML = "";
        if (c2) c2.innerHTML = "";
      });
  }

  function renderMonthlySummary(r) {
    var overviewCard = document.getElementById("monthlySummaryCard");
    var projCard = document.getElementById("monthlyProjectionCard");
    if (!overviewCard) return;
    if (!r || r.status === "error") {
      overviewCard.innerHTML = "";
      if (projCard) projCard.innerHTML = "";
      return;
    }

    var trend = (r.trend || "stable").toLowerCase();
    var trendLabel = trend === "up" ? "▲ Trending Up" : trend === "down" ? "▼ Trending Down" : "— Stable";
    var month = r.month || "";
    var summary = r.summary || "";
    var highlights = r.highlights || [];
    var count = r.crime_count || 0;

    // ── Overview card ──────────────────────────────────────────
    var html = '<div class="nac-header">';
    html += '<span class="nac-label"><span class="nac-label-icon">📅</span>' + esc(month) + ' Overview · ' + count + ' reports</span>';
    html += '<span class="nac-badge trend-' + esc(trend) + '">' + esc(trendLabel) + '</span>';
    html += '</div>';
    html += '<div class="nac-body">';
    if (summary) html += '<div class="nac-briefing">' + esc(summary) + '</div>';
    if (highlights.length) {
      html += '<div class="nac-highlights">';
      highlights.forEach(function (h) {
        html += '<div class="nac-highlight">' + esc(h) + '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
    overviewCard.innerHTML = html;

    // ── Projection card ────────────────────────────────────────
    if (!projCard) return;
    var projection = r.projection || "";
    var watchAreas = r.watch_areas || [];

    if (!projection && !watchAreas.length) { projCard.innerHTML = ""; return; }

    var phtml = '<div class="nac-header">';
    phtml += '<span class="nac-label"><span class="nac-label-icon">🔭</span>30-Day Projection</span>';
    phtml += '</div>';
    phtml += '<div class="nac-body">';
    if (projection) phtml += '<div class="nac-projection">' + esc(projection) + '</div>';
    if (watchAreas.length) {
      phtml += '<div class="nac-watch-label">Areas to Watch</div>';
      phtml += '<div class="nac-watch-chips">';
      watchAreas.forEach(function (area) {
        phtml += '<span class="nac-watch-chip">' + esc(area) + '</span>';
      });
      phtml += '</div>';
    }
    phtml += '</div>';
    projCard.innerHTML = phtml;
  }

  // ── SOCIAL INTEL (X/Twitter via xAI live search) ──────────────
  function fetchSocialIntel() {
    fetch(API + "/api/social_intel")
      .then(ok)
      .then(function (r) {
        if (r.status === "ok" && r.items && r.items.length > 0) {
          renderSocialIntel(r.items);
        }
      })
      .catch(function () {});  // silent fail — social intel is best-effort
  }

  var SOCIAL_CRITICAL_KWS = [
    "shooting", "shot", "stabbing", "stabbed", "homicide", "murder",
    "pursuit", "chase", "standoff", "barricade", "swat", "hostage",
    "explosion", "bomb", "fire", "crash", "armed", "lockdown",
    "amber alert", "missing", "overdose"
  ];

  function _socialTypeColor(type) {
    if (type === "fire")  return "var(--amber)";
    if (type === "ems")   return "var(--green)";
    if (type === "crime") return "var(--violent)";
    return "var(--accent-gold)";
  }

  function _socialCardHTML(item) {
    var col = _socialTypeColor(item.type);
    var icon = item.type === "fire" ? "local_fire_department" :
               item.type === "ems"  ? "emergency" : "campaign";
    var html = '<div class="social-intel-card">';
    html += '<div class="social-intel-body">';
    html += '<div class="social-intel-source" style="color:' + col + ';">';
    html += '<span class="material-icons" style="font-size:11px;vertical-align:-1px;margin-right:3px;">' + icon + '</span>';
    html += esc(item.source || item.handle || "Law Enforcement") + '</div>';
    html += '<div class="social-intel-text">' + esc(item.text || "") + '</div>';
    if (item.time) html += '<div class="social-intel-time">' + esc(item.time) + '</div>';
    html += '</div></div>';
    return html;
  }

  function _isCriticalSocialPost(item) {
    var t = ((item.text || "") + " " + (item.source || "")).toLowerCase();
    return SOCIAL_CRITICAL_KWS.some(function (kw) { return t.indexOf(kw) !== -1; });
  }

  function renderSocialIntel(items) {
    if (!items || items.length === 0) return;

    // ── News tab: full list ─────────────────────────────────────
    var newsContainer = document.getElementById("socialIntelList");
    if (newsContainer) {
      var newsHtml = "";
      items.slice(0, 8).forEach(function (item) {
        newsHtml += _socialCardHTML(item);
      });
      newsContainer.innerHTML = newsHtml || '<div class="empty-state">No recent social posts.</div>';
    }

    // ── Live tab: critical posts only (promoted) ─────────────────
    var liveContainer = document.getElementById("promotedSocialPosts");
    if (liveContainer) {
      var critical = items.filter(_isCriticalSocialPost).slice(0, 3);
      if (critical.length > 0) {
        var liveHtml = '<div class="promoted-social-header">';
        liveHtml += '<span class="material-icons" style="font-size:13px;vertical-align:-2px;margin-right:5px;color:var(--accent-gold);">campaign</span>';
        liveHtml += 'Police Social Media</div>';
        critical.forEach(function (item) {
          liveHtml += _socialCardHTML(item);
        });
        liveContainer.innerHTML = liveHtml;
      } else {
        liveContainer.innerHTML = "";
      }
    }
  }

  // ── PATTERNS ──────────────────────────────────────────────────
  function renderPatterns(patterns) {
    var container = document.getElementById("patternsContent");
    if (!container) return;

    var html = "";

    if (patterns.insights && patterns.insights.length) {
      patterns.insights.forEach(function (insight) {
        var sev = insight.severity || "low";
        var iconSvg = getInsightIcon(insight.icon, sev);
        html += '<div class="pattern-card">';
        html += '<div class="pattern-card-header">' + iconSvg + '<span>' + esc(insight.type || "Insight") + '</span></div>';
        html += '<div class="pattern-text">' + esc(insight.text) + '</div>';
        html += '</div>';
      });
    }

    if (patterns.hotspots && patterns.hotspots.length) {
      html += '<div class="pattern-card">';
      html += '<div class="pattern-card-header"><svg class="pattern-icon high" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg><span>Active Areas</span></div>';

      var maxCount = patterns.hotspots[0].count || 1;
      patterns.hotspots.forEach(function (h) {
        var pct = Math.round((h.count / maxCount) * 100);
        var barType = h.dominant_type || "mixed";
        html += '<div class="hotspot-bar">';
        html += '<span class="hotspot-name">' + esc(h.neighborhood) + '</span>';
        html += '<div class="hotspot-track"><div class="hotspot-fill ' + barType + '" style="width:' + pct + '%"></div></div>';
        html += '<span class="hotspot-count">' + h.count + '</span>';
        html += '</div>';
      });

      html += '</div>';
    }

    if (!html) {
      html = '<div class="empty-state">No patterns detected yet.</div>';
    }

    container.innerHTML = html;
  }

  function getInsightIcon(type, severity) {
    var cls = "pattern-icon " + severity;
    switch (type) {
      case "alert":
        return '<svg class="' + cls + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      case "property":
        return '<svg class="' + cls + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
      case "location":
        return '<svg class="' + cls + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>';
      case "clock":
        return '<svg class="' + cls + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
      default:
        return '<svg class="' + cls + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }
  }

  // ── TRENDS CHART ──────────────────────────────────────────────
  function fetchTrends() {
    fetch(API + "/api/trends")
      .then(ok)
      .then(function (r) {
        if (r.status !== "ok" || !r.data || !r.data.length) return;
        var sorted = r.data.slice().sort(function (a, b) {
          return parseInt(a.year) - parseInt(b.year);
        });
        renderTrendsChart(sorted);
        var meta = document.getElementById("trendsMeta");
        if (meta) meta.textContent = "via NY DCJS · " + sorted.length + " years";
      })
      .catch(function () {
        var meta = document.getElementById("trendsMeta");
        if (meta) meta.textContent = "Data unavailable";
      });
  }

  function getChartColors() {
    var theme = getTheme();
    return {
      gridColor: theme === "dark" ? "rgba(37, 42, 53, 0.5)" : "rgba(0,0,0,0.07)",
      tickColor: theme === "dark" ? "#5f6570" : "#8c919b",
      legendColor: theme === "dark" ? "#5f6570" : "#6c717b",
      tooltipBg: theme === "dark" ? "#181c24" : "#ffffff",
      tooltipTitle: theme === "dark" ? "#d4d7dd" : "#1c1f26",
      tooltipBody: theme === "dark" ? "#9399a4" : "#5f6570",
      tooltipBorder: theme === "dark" ? "#252a35" : "#e0e2e6",
    };
  }

  function renderTrendsChart(data) {
    var ctx = document.getElementById("trendsChart");
    if (!ctx) return;
    if (trendsChart) trendsChart.destroy();

    var labels = data.map(function (d) { return d.year; });
    var totalArr = data.map(function (d) { return parseInt(d.total_index_crimes || d.index_total || 0); });
    var violentArr = data.map(function (d) { return parseInt(d.violent || d.violent_total || 0); });
    var propertyArr = data.map(function (d) { return parseInt(d.property || d.property_total || 0); });

    var cc = getChartColors();

    trendsChart = new Chart(ctx.getContext("2d"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Total",
            data: totalArr,
            borderColor: "#4d8fdb",
            backgroundColor: "rgba(77, 143, 219, 0.06)",
            borderWidth: 1.5,
            tension: 0.35,
            fill: true,
            pointRadius: 3,
            pointBackgroundColor: "#4d8fdb"
          },
          {
            label: "Violent",
            data: violentArr,
            borderColor: "#e05252",
            borderWidth: 1.5,
            tension: 0.35,
            fill: false,
            pointRadius: 3,
            pointBackgroundColor: "#e05252"
          },
          {
            label: "Property",
            data: propertyArr,
            borderColor: "#d9953a",
            borderWidth: 1.5,
            tension: 0.35,
            fill: false,
            pointRadius: 3,
            pointBackgroundColor: "#d9953a"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: cc.legendColor,
              font: { family: "'Satoshi', sans-serif", size: 11 },
              boxWidth: 8,
              usePointStyle: true,
              pointStyle: "circle",
              padding: 12
            }
          },
          tooltip: {
            backgroundColor: cc.tooltipBg,
            titleColor: cc.tooltipTitle,
            bodyColor: cc.tooltipBody,
            borderColor: cc.tooltipBorder,
            borderWidth: 1,
            padding: 10,
            cornerRadius: 6,
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 }
          }
        },
        scales: {
          x: {
            ticks: { color: cc.tickColor, font: { family: "'JetBrains Mono', monospace", size: 10 } },
            grid: { color: cc.gridColor }
          },
          y: {
            ticks: { color: cc.tickColor, font: { family: "'JetBrains Mono', monospace", size: 10 } },
            grid: { color: cc.gridColor }
          }
        }
      }
    });
  }

  function updateChartTheme() {
    if (!trendsChart) return;
    var cc = getChartColors();
    trendsChart.options.plugins.legend.labels.color = cc.legendColor;
    trendsChart.options.plugins.tooltip.backgroundColor = cc.tooltipBg;
    trendsChart.options.plugins.tooltip.titleColor = cc.tooltipTitle;
    trendsChart.options.plugins.tooltip.bodyColor = cc.tooltipBody;
    trendsChart.options.plugins.tooltip.borderColor = cc.tooltipBorder;
    trendsChart.options.scales.x.ticks.color = cc.tickColor;
    trendsChart.options.scales.x.grid.color = cc.gridColor;
    trendsChart.options.scales.y.ticks.color = cc.tickColor;
    trendsChart.options.scales.y.grid.color = cc.gridColor;
    trendsChart.update("none");
  }

  // ── AI CHAT ───────────────────────────────────────────────────
  function initChat() {
    var form = document.getElementById("chatForm");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = document.getElementById("chatInput");
        if (input) sendChat(input.value.trim(), input);
      });
    }

    document.querySelectorAll(".suggest-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var prompt = chip.getAttribute("data-prompt");
        if (prompt) {
          var input = document.getElementById("chatInput");
          if (input) input.value = prompt;
          sendChat(prompt, input);
        }
      });
    });
  }

  // AI chat uses POST /api/chat; model is xAI Grok 3 full (api_server.py XAI_MODEL).
  function sendChat(message, inputEl) {
    if (!message) return;
    if (inputEl) inputEl.value = "";

    var container = document.getElementById("chatMessages");
    if (!container) return;

    var suggestions = document.getElementById("chatSuggestions");
    if (suggestions) suggestions.style.display = "none";

    var userHtml = '<div class="chat-msg chat-user"><div class="chat-bubble">' + esc(message) + '</div></div>';
    container.insertAdjacentHTML("beforeend", userHtml);

    var aiId = "ai-" + Date.now();
    var aiHtml = '<div class="chat-msg chat-ai">' +
      '<div class="chat-bubble md-rendered" id="' + aiId + '">' +
      '<div class="typing-indicator"><span></span><span></span><span></span></div>' +
      '</div></div>';
    container.insertAdjacentHTML("beforeend", aiHtml);
    container.scrollTop = container.scrollHeight;

    chatHistory.push({ role: "user", content: message });

    var chatReq = apiClient
      ? apiClient.streamChat({ message: message, history: chatHistory.slice(-10) })
      : fetch(API + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message, history: chatHistory.slice(-10) })
        });
    chatReq.then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (!res.body) throw new Error("Streaming not supported");

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var bubble = document.getElementById(aiId);
      var fullText = "";
      var buffer = "";
      var renderTimer = null;
      var streamDone = false;

      function doRender() {
        if (bubble && fullText) {
          bubble.classList.add("is-streaming");
          bubble.textContent = fullText;
          container.scrollTop = container.scrollHeight;
        }
        renderTimer = null;
      }

      function scheduleRender() {
        if (!renderTimer) renderTimer = setTimeout(doRender, 50);
      }

      function handleDataLine(rawLine) {
        var trimmedLine = (rawLine || "").trim();
        if (!trimmedLine || streamDone) return;
        if (!trimmedLine.startsWith("data:")) return;
        var data = trimmedLine.slice(5).trim();
        if (!data) return;
        if (data === "[DONE]") {
          streamDone = true;
          return;
        }
        try {
          var parsed = JSON.parse(data);
          if (!parsed || parsed.content == null) return;
          var piece =
            typeof parsed.content === "string"
              ? parsed.content
              : String(parsed.content);
          if (piece) {
            fullText += piece;
            scheduleRender();
          }
        } catch (e) {}
      }

      function processBuffer(flushAll) {
        var normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        var lines = normalized.split("\n");
        if (flushAll) {
          buffer = "";
          lines.forEach(function (line) {
            handleDataLine(line);
          });
        } else {
          buffer = lines.pop() || "";
          lines.forEach(function (line) {
            handleDataLine(line);
          });
        }
      }

      function read() {
        reader.read().then(function (result) {
          if (result.done) {
            if (renderTimer) clearTimeout(renderTimer);
            buffer += decoder.decode();
            processBuffer(true);
            if (bubble && fullText) {
              bubble.classList.remove("is-streaming");
              bubble.innerHTML = renderMarkdown(fullText);
              addChatActions(bubble, fullText);
            } else if (bubble) {
              bubble.innerHTML = '<p>No response received.</p>';
            }
            if (fullText) chatHistory.push({ role: "assistant", content: fullText });
            container.scrollTop = container.scrollHeight;
            return;
          }

          buffer += decoder.decode(result.value, { stream: true });
          processBuffer(false);

          read();
        }).catch(function () {
          if (bubble && !fullText) {
            bubble.innerHTML = '<p style="color:var(--red);">Connection error. Please try again.</p>';
          }
        });
      }

      read();
    }).catch(function () {
      var bubble = document.getElementById(aiId);
      if (window.ACTChat && window.ACTChat.renderUnavailable) {
        window.ACTChat.renderUnavailable(bubble, "Failed to connect. Check your connection.");
      } else if (bubble) {
        bubble.innerHTML = '<p style="color:var(--red);">Failed to connect. Check your connection.</p>';
      }
    });
  }

  function addChatActions(bubbleEl, text) {
    var actions = document.createElement("div");
    actions.className = "chat-actions";
    actions.innerHTML = '<button class="chat-action-btn copy-btn" title="Copy response">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
      '</button>';

    var copyBtn = actions.querySelector(".copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            copyBtn.classList.add("copied");
            copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(function () {
              copyBtn.classList.remove("copied");
              copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
            }, 2000);
          });
        }
      });
    }

    bubbleEl.parentNode.appendChild(actions);
  }

  function renderMarkdown(text) {
    if (typeof marked !== "undefined" && text) {
      try { return marked.parse(text); }
      catch (e) { return '<p>' + esc(text) + '</p>'; }
    }
    return '<p>' + esc(text || "") + '</p>';
  }

  // ── FBI NIBRS ─────────────────────────────────────────────────
  function fetchNibrsAgencies() {
    fetch(API + "/api/nibrs/agencies")
      .then(ok)
      .then(function (r) {
        if (r.status !== "ok" || !r.agencies) return;
        renderNibrsAgencies(r.agencies);
      })
      .catch(function () {
        var list = document.getElementById("nibrsAgencies");
        if (list) list.innerHTML = '<p class="placeholder-text">Failed to load agencies.</p>';
      });
  }

  function renderNibrsAgencies(agencies) {
    var list = document.getElementById("nibrsAgencies");
    if (!list) return;

    var html = "";
    agencies.forEach(function (a) {
      var nibrsTag = a.nibrs ?
        '<span class="nibrs-tag nibrs-active">NIBRS</span>' :
        '<span class="nibrs-tag nibrs-inactive">UCR</span>';
      var pop = a.population ? a.population.toLocaleString() : "—";
      var clickable = a.nibrs ? ' data-ori="' + escAttr(a.ori) + '"' : '';
      var cls = "nibrs-agency-item" + (a.nibrs ? " nibrs-clickable" : "");

      html += '<div class="' + cls + '"' + clickable + '>';
      html += '<div class="nibrs-agency-info">';
      html += '<span class="nibrs-agency-name">' + esc(a.name) + '</span>';
      html += '<span class="nibrs-agency-meta">' + esc(a.type) + ' · Pop: ' + pop + ' · ' + esc(a.ori) + '</span>';
      html += '</div>';
      html += nibrsTag;
      html += '</div>';
    });

    list.innerHTML = html;

    list.querySelectorAll("[data-ori]").forEach(function (item) {
      item.addEventListener("click", function () {
        var ori = item.getAttribute("data-ori");
        var name = item.querySelector(".nibrs-agency-name");
        fetchNibrsAgencyDetail(ori, name ? name.textContent : ori);

        list.querySelectorAll(".nibrs-agency-item").forEach(function (el) { el.classList.remove("selected"); });
        item.classList.add("selected");
      });
    });
  }

  function fetchNibrsAgencyDetail(ori, agencyName) {
    var breakdown = document.getElementById("nibrsBreakdown");
    var nameEl = document.getElementById("nibrsAgencyName");

    if (nameEl) nameEl.textContent = agencyName;
    if (breakdown) breakdown.innerHTML = '<div class="nibrs-loading"><div class="typing-indicator"><span></span><span></span><span></span></div></div>';

    fetch(API + "/api/nibrs/agency/" + encodeURIComponent(ori))
      .then(ok)
      .then(function (r) {
        if (r.status === "ok" && r.data) {
          renderNibrsBreakdown(r.data, agencyName);
        } else if (r.status === "partial") {
          if (breakdown) {
            breakdown.innerHTML =
              '<p class="nibrs-note">' + esc(r.message || "Data unavailable.") + '</p>' +
              '<a href="' + escAttr(r.cde_url || "https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend") + '" target="_blank" class="resource-card">' +
              '<span class="resource-title">View on FBI Crime Data Explorer</span>' +
              '<span class="resource-desc">Search ' + esc(agencyName) + ' directly</span>' +
              '</a>';
          }
        } else {
          if (breakdown) breakdown.innerHTML = '<p class="nibrs-note">Failed to load data for this agency.</p>';
        }
      })
      .catch(function () {
        if (breakdown) breakdown.innerHTML = '<p class="nibrs-note">Connection error. Try again.</p>';
      });
  }

  function renderNibrsBreakdown(data, agencyName) {
    var container = document.getElementById("nibrsBreakdown");
    if (!container) return;

    var html = '<div class="nibrs-offense-list">';

    if (typeof data === "object" && !Array.isArray(data)) {
      var entries = Object.entries(data);
      if (entries.length === 0) {
        html += '<p class="nibrs-note">No offense data available for this agency.</p>';
      } else {
        entries.forEach(function (entry) {
          var offenseType = entry[0];
          var yearData = entry[1];

          var latest = null;
          if (Array.isArray(yearData)) {
            yearData.forEach(function (d) {
              if (d && typeof d === "object") {
                if (!latest || (d.data_year || d.year || 0) > (latest.data_year || latest.year || 0)) {
                  latest = d;
                }
              }
            });
          }

          var count = 0;
          if (latest) {
            count = latest.value || latest.actual || latest.cleared || 0;
          }

          var formattedType = offenseType.replace(/_/g, " ").replace(/\b\w/g, function (l) { return l.toUpperCase(); });

          html += '<div class="nibrs-offense-row">';
          html += '<span class="nibrs-offense-name">' + esc(formattedType) + '</span>';
          html += '<span class="nibrs-offense-count">' + (typeof count === "number" ? count.toLocaleString() : count) + '</span>';
          html += '</div>';
        });
      }
    } else if (Array.isArray(data)) {
      if (data.length === 0) {
        html += '<p class="nibrs-note">No offense data available.</p>';
      } else {
        data.forEach(function (item) {
          var label = item.offense || item.offense_name || item.key || "Unknown";
          var val = item.value || item.actual || item.count || 0;
          html += '<div class="nibrs-offense-row">';
          html += '<span class="nibrs-offense-name">' + esc(label) + '</span>';
          html += '<span class="nibrs-offense-count">' + (typeof val === "number" ? val.toLocaleString() : val) + '</span>';
          html += '</div>';
        });
      }
    } else {
      html += '<p class="nibrs-note">Unexpected data format.</p>';
    }

    html += '</div>';

    html += '<a href="https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend" target="_blank" class="resource-card" style="margin-top:12px;">';
    html += '<span class="resource-title">Explore Full Data</span>';
    html += '<span class="resource-desc">View detailed stats for ' + esc(agencyName) + ' on FBI CDE</span>';
    html += '</a>';

    container.innerHTML = html;
  }

  // ── SCANNER ───────────────────────────────────────────────────
  function fetchScannerCalls() {
    (apiClient ? apiClient.getScannerCalls() : fetch(API + "/api/scanner/calls").then(ok))
      .then(function (data) {
        if (data.calls && data.calls.length > 0) {
          processAndRenderScanner(data.calls);
        } else {
          return fetchScannerDirect();
        }
      })
      .catch(function () {
        if (window.ACTScanner && window.ACTScanner.renderUnavailable) {
          window.ACTScanner.renderUnavailable("scannerCallsList", "Scanner API unavailable, trying direct feed.");
        }
        fetchScannerDirect();
      });
  }

  function fetchScannerDirect() {
    fetch("https://api.openmhz.com/albanycony/calls?num=20", {
      mode: "cors",
      headers: { "Accept": "application/json" }
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data) {
          var calls = data.calls || data;
          if (Array.isArray(calls) && calls.length > 0) {
            processAndRenderScanner(calls);
            return;
          }
        }
        renderScannerFallback();
      })
      .catch(function () {
        renderScannerFallback();
      });
  }

  function getScannerIntelFingerprint() {
    if (!scannerIntelItems || !scannerIntelItems.length) return "";
    return scannerIntelItems
      .map(function (i) {
        return (i.tgName || "") + ":" + (i.rawTime || 0) + ":" + (i.cat || "");
      })
      .join("|");
  }

  function processAndRenderScanner(calls) {
    lastScannerCallsRef = calls.slice();
    var intelFpBefore = getScannerIntelFingerprint();
    extractScannerIntel(calls);
    var intelFpAfter = getScannerIntelFingerprint();
    renderScannerCalls(calls);
    // Live feed: only re-render when scanner intel actually changed (avoids 45s full list flicker)
    if (allIncidentData.length > 0 && intelFpBefore !== intelFpAfter) {
      renderLiveFeed(lastLiveActiveItems, lastLiveRecentItems);
    }
  }

  // Keywords that make ANY scanner call worthy of the Live feed regardless of TG priority
  var CRITICAL_SCANNER_KEYWORDS = [
    "shoot", "shot", "stab", "pursuit", "chase", "standoff", "barricade",
    "officer", "ois", "assault", "weapon", "gun", "armed", "hostage",
    "missing", "abduct", "bomb", "explos", "swat", "k9", "k-9"
  ];

  function extractScannerIntel(calls) {
    var significant = [];
    var seen = {};
    var now = new Date();

    calls.forEach(function (call) {
      var tg = String(call.talkgroup_num || call.talkgroupNum || call.talkgroup || "");
      var dept = resolveScannerDept(call);
      var len = call.duration || call.len || 0;
      var callTime = call.time ? new Date(call.time) : null;
      var freqHz = call.freq || 0;
      var freqMHz = freqHz ? (freqHz / 1e6).toFixed(4) : "";

      // Drop anything older than 2 hours
      if (callTime && (now - callTime) > 2 * 60 * 60 * 1000) return;

      var searchText = (
        dept.name + " " +
        (call.talkgroup_tag || "") + " " +
        (call.talkgroup_description || "")
      ).toLowerCase();

      var hasKeyword = CRITICAL_SCANNER_KEYWORDS.some(function (kw) {
        return searchText.indexOf(kw) !== -1;
      });

      var isHighPolice = dept.priority === "high" && dept.cat === "police" && len >= 10;
      var isCritical = hasKeyword && len >= 5;

      if (!isHighPolice && !isCritical) return;

      var dedupKey = tg || dept.name;
      if (seen[dedupKey]) return;
      seen[dedupKey] = true;

      significant.push({
        tgName: dept.name,
        location: dept.location,
        cat: dept.cat,
        priority: dept.priority,
        len: len,
        freqMHz: freqMHz,
        time: callTime ? timeAgo(callTime) : "",
        rawTime: callTime ? callTime.getTime() : 0
      });
    });

    significant.sort(function (a, b) { return b.rawTime - a.rawTime; });
    scannerIntelItems = significant.slice(0, 3); // cap at 3 so they don't dominate the feed
  }

  function renderScannerCalls(calls) {
    var container = document.getElementById("scannerCallsList");
    if (!container) return;

    var source = (calls && calls.length) ? calls : lastScannerCallsRef;
    if (!source || source.length === 0) {
      renderScannerFallback();
      return;
    }

    var now = new Date();
    var recentCalls = source.filter(function (c) {
      var t = c.time ? new Date(c.time) : (c.start_time ? new Date(c.start_time) : null);
      return !t || (now - t) < 6 * 60 * 60 * 1000;
    });

    var filtered = recentCalls.filter(function (c) {
      var d = resolveScannerDept(c);
      if (scannerFilterCat !== "all" && d.cat !== scannerFilterCat) return false;
      if (scannerSearchQuery) {
        var blob = (
          d.name + " " + d.location + " " +
          String(c.talkgroup_num || c.talkgroup || "") + " " +
          String(c.talkgroup_tag || "") + " " +
          String(c.talkgroup_description || "")
        ).toLowerCase();
        if (blob.indexOf(scannerSearchQuery) < 0) return false;
      }
      return true;
    });

    var html = "";

    html += '<div class="scanner-status-ok">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-5"/></svg>';
    html += '<span class="scanner-status-text">Receiving radio traffic</span>';
    html += '<span class="scanner-status-meta">' + source.length + " calls · " + filtered.length + " shown</span>";
    html += '</div>';

    var liveInd = document.getElementById("scannerLiveIndicator");
    if (liveInd) {
      liveInd.style.display = filtered.length ? "inline" : "none";
      liveInd.textContent = "● Receiving";
    }

    if (filtered.length === 0) {
      html += '<div class="scanner-no-traffic">';
      html += '<span class="material-icons" style="font-size:28px;opacity:0.25;display:block;margin-bottom:6px;">filter_alt_off</span>';
      html += '<span>No transmissions match your filters</span>';
      html += '</div>';
      container.innerHTML = html;
      var tsEl2 = document.getElementById("scannerTimestamp");
      if (tsEl2) tsEl2.textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
      return;
    }

    filtered.slice(0, 25).forEach(function (call) {
      var dept = resolveScannerDept(call);
      var freqHz = call.freq || 0;
      var freqMHz = freqHz ? (freqHz / 1e6).toFixed(4) : "";
      var len = call.duration != null ? parseFloat(call.duration) : (call.len ? parseFloat(call.len) : 0);
      var startTime = call.time ? new Date(call.time) : (call.start_time ? new Date(call.start_time) : null);
      var ta = startTime ? timeAgo(startTime) : "";
      var audioUrl = call.url || call.audio_url || "";

      var cat = dept.cat;
      var catLabel = cat === "police" ? "Police" : cat === "fire" ? "Fire" : cat === "ems" ? "EMS" : "";
      var catClass = cat !== "other" ? " scanner-cat-" + cat : "";

      var isHigh = dept.priority === "high";
      var dotCls = "scanner-priority-dot scanner-dot-" + cat;
      if (isHigh) dotCls += " scanner-priority-dot--high";
      var priorityDot = '<span class="' + dotCls + '" title="High-priority talkgroup"></span>';

      var freqPart = freqMHz ? freqMHz + " MHz" : "";
      var durPart = len > 0 ? len.toFixed(0) + "s" : "";
      var detailLine = [freqPart, durPart, ta ? ta + " ago" : ""].filter(Boolean).join(" · ");

      var agencyId = dept.agencyId || "";
      var clickableCls = " scanner-call-item--clickable";

      html += '<div class="scanner-call-item' + catClass + clickableCls + '" tabindex="0" role="button"';
      if (agencyId) html += ' data-agency-id="' + escAttr(agencyId) + '"';
      html += ' title="Open agency in Directory">';

      html += '<div class="scanner-call-top">';
      html += '<span class="scanner-call-tg">' + priorityDot;
      html += '<span class="scanner-call-dept">' + esc(dept.name) + '</span>';
      html += '<span class="scanner-call-loc"> \u2014 ' + esc(dept.location) + '</span>';
      html += '</span>';
      html += '<span class="scanner-call-time">' + esc(ta || "\u2014") + '</span>';
      html += '</div>';

      if (detailLine) {
        html += '<div class="scanner-call-detail scanner-call-detail--prominent">' + esc(detailLine) + '</div>';
      }

      html += '<div class="scanner-call-bottom">';
      if (catLabel) {
        html += '<span class="scanner-call-cat scanner-cat-tag-' + esc(cat) + '">' + esc(catLabel) + '</span>';
      }
      if (audioUrl) {
        html += '<button type="button" class="scanner-play-btn" data-audio="' + escAttr(audioUrl) + '" title="Play transmission">';
        html += '<span class="material-icons" style="font-size:14px;">play_arrow</span>';
        html += '</button>';
      }
      html += '</div>';

      if (agencyId) {
        html += '<div class="scanner-call-item-hint"><span class="material-icons">open_in_new</span> Directory</div>';
      }

      html += '</div>';
    });

    container.innerHTML = html;
    bindScannerAudio(container);
    bindScannerCallCards(container, recentCalls);
    updateMainPlayer(recentCalls);

    var tsEl = document.getElementById("scannerTimestamp");
    if (tsEl) tsEl.textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  }

  function bindScannerCallCards(container) {
    container.querySelectorAll(".scanner-call-item--clickable").forEach(function (row) {
      function go() {
        var aid = row.getAttribute("data-agency-id");
        openDirectoryToAgency(aid || null);
      }
      row.addEventListener("click", function (e) {
        if (e.target.closest(".scanner-play-btn")) return;
        go();
      });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    });
  }

  // ── Main (top) scanner player — uses clean OpenMHz MP3, no commercials ──
  function updateMainPlayer(calls) {
    var btn    = document.getElementById("mainPlayerBtn");
    var deptEl = document.getElementById("mainPlayerDept");
    var metaEl = document.getElementById("mainPlayerMeta");
    var badge  = document.getElementById("mainPlayerBadge");
    if (!btn || !calls || calls.length === 0) return;

    var call = null;
    currentMainPlayerCallIdx = -1;
    for (var i = 0; i < calls.length; i++) {
      if (calls[i].url || calls[i].audio_url) {
        call = calls[i];
        currentMainPlayerCallIdx = i;
        break;
      }
    }
    if (!call) return;

    var dept = resolveScannerDept(call);
    var len = call.duration != null ? parseFloat(call.duration) : (call.len != null ? parseFloat(call.len) : 0);
    var startTime = call.time ? new Date(call.time) : (call.start_time ? new Date(call.start_time) : null);
    var ta = startTime ? timeAgo(startTime) : "";
    var audioUrl = call.url || call.audio_url || "";
    var freqHz = call.freq || 0;
    var freqMHz = freqHz ? (freqHz / 1e6).toFixed(4) : "";

    var catLabels = { police: "Police", fire: "Fire", ems: "EMS" };
    var line = dept.name + " \u2014 " + dept.location;

    if (deptEl) deptEl.textContent = line;
    var nowAg = document.getElementById("mainPlayerNowAgency");
    if (nowAg) nowAg.textContent = line;
    if (metaEl) {
      var parts = [];
      if (freqMHz) parts.push(freqMHz + " MHz");
      if (len > 0) parts.push(len.toFixed(0) + "s");
      if (catLabels[dept.cat]) parts.push(catLabels[dept.cat]);
      if (ta) parts.push(ta + " ago");
      metaEl.textContent = parts.join(" \u00b7 ");
    }
    if (badge) badge.style.opacity = "1";

    btn.disabled = !audioUrl;
    btn.setAttribute("data-audio", audioUrl);
    var idx = currentMainPlayerCallIdx;
    btn.onclick = function () { playMainAudio(btn, audioUrl, len, idx); };
  }

  function playMainAudio(btn, url, len, callIndex) {
    var bar = document.getElementById("mainPlayerBar");

    if (btn.classList.contains("playing")) {
      btn.classList.remove("playing");
      btn.innerHTML = '<span class="material-icons">play_arrow</span>';
      if (bar) bar.style.width = "0%";
      if (mainAudio) {
        mainAudio.pause();
        mainAudio = null;
      }
      if (mainProgressTimer) {
        clearInterval(mainProgressTimer);
        mainProgressTimer = null;
      }
      return;
    }

    if (mainAudio) {
      mainAudio.pause();
      mainAudio = null;
    }
    if (mainProgressTimer) {
      clearInterval(mainProgressTimer);
      mainProgressTimer = null;
    }
    if (bar) bar.style.width = "0%";

    var audio = new Audio(url);
    mainAudio = audio;
    var volSlider = document.getElementById("mainPlayerVolume");
    audio.volume = volSlider ? (parseInt(volSlider.value, 10) || 100) / 100 : 1;
    audio.muted = scannerMuted;

    btn.classList.add("playing");
    btn.innerHTML = '<span class="material-icons">stop</span>';

    function syncBar() {
      if (!bar) return;
      var dur = audio.duration;
      if (dur && !isNaN(dur) && isFinite(dur) && dur > 0) {
        bar.style.width = (audio.currentTime / dur) * 100 + "%";
      } else if (len > 0) {
        bar.style.width = Math.min(100, (audio.currentTime / len) * 100) + "%";
      }
    }
    audio.addEventListener("timeupdate", syncBar);

    audio.play().catch(function () {
      btn.classList.remove("playing");
      btn.innerHTML = '<span class="material-icons">play_arrow</span>';
      if (bar) bar.style.width = "0%";
      audio.removeEventListener("timeupdate", syncBar);
    });

    audio.addEventListener("ended", function () {
      audio.removeEventListener("timeupdate", syncBar);
      btn.classList.remove("playing");
      btn.innerHTML = '<span class="material-icons">play_arrow</span>';
      if (bar) bar.style.width = "0%";
      if (mainAudio === audio) mainAudio = null;

      var ap = document.getElementById("mainPlayerAutoplay");
      if (ap && ap.checked && callIndex != null && callIndex >= 0 && lastScannerCallsRef.length) {
        var ref = lastScannerCallsRef;
        for (var j = callIndex + 1; j < ref.length; j++) {
          var nurl = ref[j].url || ref[j].audio_url;
          if (!nurl) continue;
          currentMainPlayerCallIdx = j;
          var nc = ref[j];
          var nlen = nc.duration != null ? parseFloat(nc.duration) : (nc.len != null ? parseFloat(nc.len) : 0);
          var nd = resolveScannerDept(nc);
          var deptEl = document.getElementById("mainPlayerDept");
          var nowA = document.getElementById("mainPlayerNowAgency");
          var meta = document.getElementById("mainPlayerMeta");
          var line2 = nd.name + " \u2014 " + nd.location;
          if (deptEl) deptEl.textContent = line2;
          if (nowA) nowA.textContent = line2;
          if (meta) {
            var fh = nc.freq || 0;
            var fm = fh ? (fh / 1e6).toFixed(4) : "";
            var st = nc.time ? new Date(nc.time) : null;
            var parts2 = [];
            if (fm) parts2.push(fm + " MHz");
            if (nlen > 0) parts2.push(nlen.toFixed(0) + "s");
            if (st) parts2.push(timeAgo(st) + " ago");
            meta.textContent = parts2.join(" \u00b7 ");
          }
          setTimeout(function () {
            playMainAudio(btn, nurl, nlen, j);
          }, 80);
          return;
        }
      }
    });
  }

  function renderScannerFallback() {
    var container = document.getElementById("scannerCallsList");
    if (!container) return;
    if (container.querySelector(".scanner-call-item")) return;

    container.innerHTML =
      '<div class="scanner-fallback">' +
        '<div class="scanner-fallback-header">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>' +
          '<span>Call log temporarily unavailable</span>' +
        '</div>' +
        '<p class="scanner-fallback-text">Call log from OpenMHz may be intermittently unavailable due to API limits. Check scanner links below.</p>' +
      '</div>';
  }

  function bindScannerAudio(container) {
    container.querySelectorAll(".scanner-play-btn").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var url = btn.getAttribute("data-audio");
        if (!url) return;

        if (scannerAudio) {
          scannerAudio.pause();
          scannerAudio.remove();
          scannerAudio = null;
        }

        container.querySelectorAll(".scanner-play-btn.playing").forEach(function (b) {
          b.classList.remove("playing");
          b.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        });

        if (btn.classList.contains("was-playing")) {
          btn.classList.remove("was-playing");
          return;
        }

        var audio = document.createElement("audio");
        audio.src = url;
        audio.style.display = "none";
        document.body.appendChild(audio);
        scannerAudio = audio;

        btn.classList.add("playing");
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

        audio.play().catch(function () {
          btn.classList.remove("playing");
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        });

        audio.addEventListener("ended", function () {
          btn.classList.remove("playing");
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
          if (scannerAudio === audio) scannerAudio = null;
          audio.remove();
        });

        btn.addEventListener("click", function stop(ev) {
          ev.stopPropagation();
          if (audio && !audio.paused) {
            audio.pause();
            audio.remove();
            if (scannerAudio === audio) scannerAudio = null;
            btn.classList.remove("playing");
            btn.classList.add("was-playing");
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
            setTimeout(function () { btn.classList.remove("was-playing"); }, 100);
          }
          btn.removeEventListener("click", stop);
        });
      });
    });
  }

  // ── LAW ENFORCEMENT DIRECTORY ─────────────────────────────────
  function initDirSearch() {
    var input = document.getElementById("dirSearchInput");
    if (!input) return;
    var t;
    input.addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        dirSearchQuery = (input.value || "").trim().toLowerCase();
        if (directoryLoaded) renderDirAgencies();
      }, 120);
    });
  }

  function initDirFilters() {
    var wrap = document.getElementById("dirFilterPills");
    if (!wrap) return;
    wrap.querySelectorAll(".dir-filter-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tier = btn.getAttribute("data-tier") || "all";
        dirTierFilter = tier;
        wrap.querySelectorAll(".dir-filter-btn").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-tier") === tier);
        });
        if (directoryLoaded) renderDirAgencies();
      });
    });
  }

  function fetchDirectory() {
    if (directoryLoading) return;
    directoryLoading = true;
    var list = document.getElementById("dirAgenciesList");
    if (list) list.innerHTML = '<div class="empty-state">Loading directory…</div>';

    var base = API || "";
    var paths = [
      "/api/directory/metadata",
      "/api/directory/agencies",
      "/api/directory/municipalities",
      "/api/directory/scanner",
      "/api/directory/media",
      "/api/directory/community"
    ];
    Promise.all(paths.map(function (p) {
      return apiClient ? apiClient.getDirectoryPart(p) : fetch(base + p).then(ok);
    })).then(function (results) {
      directoryLoading = false;
      if (!results || results.length < 6 || results.some(function (x) { return !x || x.status !== "ok"; })) {
        if (window.ACTDirectory && window.ACTDirectory.renderUnavailable) {
          window.ACTDirectory.renderUnavailable(list, "Could not load directory. Try again later.");
        } else if (list) {
          list.innerHTML = '<div class="empty-state">Could not load directory. Try again later.</div>';
        }
        return;
      }
      leDirectory = {
        metadata: results[0].metadata,
        agencies: results[1].agencies || [],
        municipalities: results[2].municipalities || [],
        scannerEcosystem: results[3].scannerEcosystem,
        mediaSources: results[4].mediaSources || [],
        communityPlatforms: results[5].communityPlatforms || []
      };
      directoryLoaded = true;
      var meta = leDirectory.metadata || {};
      var line = document.getElementById("dirMetaLine");
      if (line) {
        var parts = ["Agencies, coverage, scanner feeds, media & community resources"];
        if (meta.lastUpdated) parts.push("Updated " + meta.lastUpdated);
        if (meta.version) parts.push("v" + meta.version);
        line.textContent = parts.join(" · ");
      }
      renderDirStats();
      renderDirAgencies();
      renderDirMunicipalities();
      renderDirScanner();
      renderDirMedia();
      renderDirCommunity();
    }).catch(function () {
      directoryLoading = false;
      if (window.ACTDirectory && window.ACTDirectory.renderUnavailable) {
        window.ACTDirectory.renderUnavailable(list, "Could not load directory. Check your connection.");
      } else if (list) {
        list.innerHTML = '<div class="empty-state">Could not load directory. Check your connection.</div>';
      }
    });
  }

  function renderDirStats() {
    if (!leDirectory) return;
    var ag = (leDirectory.agencies || []).filter(function (a) { return a.active !== false; });
    function setDirNum(id, n) {
      var el = document.getElementById(id);
      if (el) el.textContent = String(n);
    }
    setDirNum("dirStatAgencies", ag.length);
    setDirNum("dirStatMunis", (leDirectory.municipalities || []).length);
    setDirNum("dirStatMedia", (leDirectory.mediaSources || []).length);
    setDirNum("dirStatCommunity", (leDirectory.communityPlatforms || []).length);
  }

  function renderDirAgencies() {
    var list = document.getElementById("dirAgenciesList");
    if (!list || !leDirectory) return;
    var agencies = leDirectory.agencies || [];
    var filtered = agencies.filter(function (a) {
      if (a.active === false) return false;
      if (dirTierFilter !== "all" && (a.tier || "") !== dirTierFilter) return false;
      if (!dirSearchQuery) return true;
      var blob = [
        a.name, a.abbreviation, a.id, a.type, a.jurisdiction, a.notes || ""
      ].join(" ").toLowerCase();
      return blob.indexOf(dirSearchQuery) >= 0;
    });
    if (!filtered.length) {
      list.innerHTML = '<div class="empty-state">No agencies match your filters.</div>';
      return;
    }
    filtered.sort(function (x, y) { return (x.name || "").localeCompare(y.name || ""); });
    var html = filtered.map(function (a) {
      var tier = a.tier || "";
      var name = esc(a.name || "");
      var typeLabel = a.type || "";
      var jur = a.jurisdiction || "";
      var metaLine = "";
      if (typeLabel || jur) {
        metaLine = '<p class="dir-card-meta">' +
          (typeLabel ? "<strong>" + esc(typeLabel) + "</strong>" : "") +
          (typeLabel && jur ? " · " : "") +
          esc(jur) + "</p>";
      }
      var notesLine = a.notes ? '<p class="dir-card-meta">' + esc(a.notes) + "</p>" : "";
      var links = [];
      if (a.website) {
        links.push(
          '<a class="dir-link" href="' + escAttr(a.website) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="material-icons">language</span> Website</a>'
        );
      }
      var c = a.contact || {};
      var phone = c.nonEmergencyPhone || c.tipLine;
      if (phone) {
        var tel = String(phone).replace(/[^\d+]/g, "");
        links.push(
          '<a class="dir-link" href="tel:' + escAttr(tel) + '"><span class="material-icons">call</span> ' + esc(phone) + "</a>"
        );
      }
      (a.socialAccounts || []).slice(0, 5).forEach(function (s) {
        if (!s.url) return;
        links.push(
          '<a class="dir-link" href="' + escAttr(s.url) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="material-icons">link</span> ' + esc(s.platform || "social") + "</a>"
        );
      });
      var aid = a.id || "";
      return (
        '<article class="dir-card dir-agency-card"' + (aid ? ' id="dir-agency-' + escAttr(aid) + '"' : "") + ">" +
          '<div class="dir-card-head">' +
          '<div class="dir-card-name">' + name + "</div>" +
          '<span class="dir-tier-pill" data-tier="' + escAttr(tier) + '">' + esc(String(tier).toUpperCase()) + "</span>" +
          "</div>" +
          metaLine + notesLine +
          (links.length ? '<div class="dir-card-links">' + links.join("") + "</div>" : "") +
        "</article>"
      );
    }).join("");
    list.innerHTML = html;
  }

  function renderDirMunicipalities() {
    var el = document.getElementById("dirMuniList");
    if (!el || !leDirectory) return;
    var idToName = {};
    (leDirectory.agencies || []).forEach(function (a) {
      if (a.id) idToName[a.id] = a.name || a.id;
    });
    var munis = (leDirectory.municipalities || []).slice();
    munis.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
    el.innerHTML = munis.map(function (m) {
      var cov = (m.primaryCoverageIds || []).map(function (id) { return esc(idToName[id] || id); }).join(", ");
      var pdBadge = m.hasOwnPolice ? "Own PD" : "Shared coverage";
      return (
        '<div class="dir-card">' +
          '<div class="dir-muni-row">' +
          '<div style="flex:1;min-width:0;">' +
          '<div class="dir-muni-name">' + esc(m.name || "") + "</div>" +
          '<div class="dir-muni-coverage">' +
          (cov ? "Primary: " + cov : "") +
          (m.notes ? (cov ? " · " : "") + esc(m.notes) : "") +
          "</div></div>" +
          '<span class="dir-muni-type">' + esc(m.type || "") + "</span>" +
          '<span class="dir-muni-type">' + esc(pdBadge) + "</span>" +
          "</div></div>"
      );
    }).join("");
  }

  function renderDirScanner() {
    var el = document.getElementById("dirScannerBlock");
    if (!el || !leDirectory) return;
    var se = leDirectory.scannerEcosystem;
    if (!se || !se.system) {
      el.innerHTML = '<div class="empty-state">No scanner ecosystem data.</div>';
      return;
    }
    var idToAbbr = {};
    (leDirectory.agencies || []).forEach(function (a) {
      if (a.id) idToAbbr[a.id] = a.abbreviation || a.name || a.id;
    });
    var sys = se.system;
    var dispatched = (sys.agenciesDispatched || []).map(function (id) { return esc(idToAbbr[id] || id); }).join(", ");
    var sysHtml =
      '<div class="dir-scanner-sys"><strong>' + esc(sys.name || "") + "</strong><br>" +
      esc(sys.type || "") +
      (sys.radioReferenceUrl
        ? ' · <a class="dir-link" href="' + escAttr(sys.radioReferenceUrl) + '" target="_blank" rel="noopener noreferrer">RadioReference</a>'
        : "") +
      "<br>" + esc(sys.notes || "") +
      (dispatched ? '<br><span style="color:var(--text-3);">Dispatched:</span> ' + dispatched : "") +
      "</div>";
    var feeds = (se.feeds || []).map(function (f) {
      return (
        '<div class="dir-feed-item">' +
          "<div>" +
          '<div class="dir-feed-label">' + esc(f.label || "") + "</div>" +
          '<div class="dir-feed-meta">' +
          esc(f.provider || "") +
          (f.coverageDescription ? " · " + esc(f.coverageDescription) : "") +
          (f.isLive ? " · Live" : "") +
          "</div></div>" +
          (f.url
            ? '<a class="dir-link" href="' + escAttr(f.url) + '" target="_blank" rel="noopener noreferrer">' +
              '<span class="material-icons">open_in_new</span></a>'
            : "") +
        "</div>"
      );
    }).join("");
    var freqs = se.conventionalFrequencies || [];
    var freqRows = freqs.map(function (r) {
      return (
        "<tr><td>" + esc(idToAbbr[r.agency] || r.agency) + "</td>" +
        "<td>" + esc(r.frequency || "") + (r.tone ? " <span style=\"color:var(--text-3);\">" + esc(r.tone) + "</span>" : "") + "</td>" +
        "<td>" + esc(r.use || "") + "</td>" +
        "<td>" + esc(r.mode || "") + "</td></tr>"
      );
    }).join("");
    var freqTable = freqs.length
      ? '<table class="dir-freq-table"><thead><tr><th>Agency</th><th>Frequency</th><th>Use</th><th>Mode</th></tr></thead><tbody>' +
        freqRows + "</tbody></table>"
      : "";
    el.innerHTML = sysHtml + '<div class="dir-feed-list">' + feeds + "</div>" + freqTable;
  }

  function renderDirMedia() {
    var el = document.getElementById("dirMediaList");
    if (!el || !leDirectory) return;
    var items = leDirectory.mediaSources || [];
    el.innerHTML = items.map(function (m) {
      var links = [];
      if (m.website) {
        links.push('<a class="dir-link" href="' + escAttr(m.website) + '" target="_blank" rel="noopener noreferrer">Website</a>');
      }
      if (m.crimeCourtsSectionUrl) {
        links.push(
          '<a class="dir-link" href="' + escAttr(m.crimeCourtsSectionUrl) + '" target="_blank" rel="noopener noreferrer">Crime / courts</a>'
        );
      }
      (m.socialAccounts || []).forEach(function (s) {
        if (!s.url) return;
        links.push(
          '<a class="dir-link" href="' + escAttr(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.platform || "link") + "</a>"
        );
      });
      var extra = "";
      if (m.publishesBlotters) extra += '<p class="dir-card-meta">Publishes blotters' + (m.blotterCoverage ? ": " + esc(m.blotterCoverage) : "") + "</p>";
      if (m.reliabilityTier) extra += '<p class="dir-card-meta">Reliability: ' + esc(m.reliabilityTier) + "</p>";
      return (
        '<article class="dir-card">' +
        '<div class="dir-media-type">' + esc(m.mediaType || "media") + "</div>" +
        '<div class="dir-card-head" style="margin-bottom:4px;"><div class="dir-card-name">' + esc(m.name || "") + "</div></div>" +
        (m.owner ? '<p class="dir-card-meta">' + esc(m.owner) + "</p>" : "") +
        (m.coverageFocus ? '<p class="dir-media-desc">' + esc(m.coverageFocus) + "</p>" : "") +
        extra +
        (links.length ? '<div class="dir-card-links">' + links.join("") + "</div>" : "") +
        "</article>"
      );
    }).join("");
  }

  function renderDirCommunity() {
    var el = document.getElementById("dirCommunityList");
    if (!el || !leDirectory) return;
    var items = leDirectory.communityPlatforms || [];
    el.innerHTML = items.map(function (c) {
      var links = [];
      if (c.url) {
        links.push('<a class="dir-link" href="' + escAttr(c.url) + '" target="_blank" rel="noopener noreferrer">Open</a>');
      }
      if (c.phone) {
        var tel = String(c.phone).replace(/[^\d+]/g, "");
        links.push('<a class="dir-link" href="tel:' + escAttr(tel) + '">' + esc(c.phone) + "</a>");
      }
      return (
        '<article class="dir-card">' +
        '<div class="dir-community-type">' + esc(c.type || "resource") + "</div>" +
        '<div class="dir-card-head" style="margin-bottom:4px;"><div class="dir-card-name">' + esc(c.name || "") + "</div></div>" +
        (c.appName ? '<p class="dir-card-meta">App: ' + esc(c.appName) + "</p>" : "") +
        (c.coverageArea ? '<p class="dir-card-meta">' + esc(c.coverageArea) + "</p>" : "") +
        (c.description ? '<p class="dir-community-desc">' + esc(c.description) + "</p>" : "") +
        (c.notes ? '<p class="dir-card-meta">' + esc(c.notes) + "</p>" : "") +
        (c.reward ? '<p class="dir-card-meta">Reward: ' + esc(c.reward) + "</p>" : "") +
        (links.length ? '<div class="dir-card-links">' + links.join("") + "</div>" : "") +
        "</article>"
      );
    }).join("");
  }

  // ── HELPERS ───────────────────────────────────────────────────
  function ok(res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  function setNum(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    var current = parseInt(el.textContent) || 0;
    var target = parseInt(val) || 0;
    if (current === target) { el.textContent = target; return; }
    var steps = 20, inc = (target - current) / steps, step = 0;
    function tick() {
      step++;
      if (step >= steps) { el.textContent = target; return; }
      el.textContent = Math.round(current + inc * step);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function timeAgo(date) {
    var s = Math.floor((new Date() - date) / 1000);
    if (s < 0) return "just now";
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    return d + "d ago";
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function esc(str) {
    if (!str) return "";
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function escAttr(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

})();
