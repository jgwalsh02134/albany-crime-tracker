/* Albany County Crime Tracker v9 — app.js
   Mobile-first product reset.
   Views: Home, Map, Scanner, AI, Directory, with overflow resources. */

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
  var REFRESH_MS = 30000;
  var SCANNER_REFRESH_MS = 20000;
  var _scannerFailCount = 0;

  // State
  var map, trendsChart;
  var mapReady = false;
  var chatHistory = [];
  var activeView = "feed";
  var activeFeedTab = "all";            // unified chronological feed
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
  // 7-day window. The DB holds ~5 days of incidents; a 48h window was
  // hiding the bulk of them, making the feed look empty even though the
  // content existed. Newest-first sort keeps the top current; older items
  // fill the depth below so the feed never feels starved.
  var HOME_WINDOW_HOURS = 168;

  // Law enforcement directory (lazy-loaded from /api/directory/*)
  var leDirectory = null;
  var directoryLoaded = false;
  var directoryLoading = false;
  var dirTierFilter = "all";
  var dirSearchQuery = "";

  // Google Maps styles
  var _gmapMarkers = [];
  var _gmapClusterer = null;
  var _gmapInfoWindow = null;

  // Safe storage wrapper
  var storage = { _m: {} };
  var _ls = (function () { try { var s = window["local" + "Storage"]; s.setItem("_t", "1"); s.removeItem("_t"); return s; } catch (e) { return null; } })();
  storage.get = function (key) { return _ls ? _ls.getItem(key) : (storage._m[key] || null); };
  storage.set = function (key, val) { if (_ls) _ls.setItem(key, val); else storage._m[key] = val; };

  // marked.js config
  if (typeof marked !== "undefined") {
    marked.setOptions({ breaks: true, gfm: true });
  }

  // ── SCANNER ALIAS REGISTRY (loaded from data/scanner_aliases.json + API merge) ──
  var _SCANNER_ALIASES = {};
  var _SCANNER_ALPHA_PATTERNS = {};
  var _scannerAliasesLoaded = false;

  function loadScannerAliases() {
    if (_scannerAliasesLoaded) return;
    _scannerAliasesLoaded = true;
    fetch(API + "/data/scanner_aliases.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var tgs = d.talkgroups || {};
        for (var k in tgs) {
          if (!Object.prototype.hasOwnProperty.call(tgs, k)) continue;
          _SCANNER_ALIASES[k] = tgs[k];
        }
        var pats = d.alpha_tag_patterns || {};
        for (var p in pats) {
          if (!Object.prototype.hasOwnProperty.call(pats, p)) continue;
          _SCANNER_ALPHA_PATTERNS[p] = pats[p];
        }
      })
      .catch(function () {});
  }

  var TG_MAP = {};

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

  function _lookupAlias(tgStr) {
    if (!tgStr) return null;
    if (_SCANNER_ALIASES[tgStr]) return _SCANNER_ALIASES[tgStr];
    if (TG_MAP[tgStr]) return TG_MAP[tgStr];
    if (/^\d+$/.test(tgStr)) {
      var stripped = tgStr.replace(/^0+/, "") || "0";
      if (_SCANNER_ALIASES[stripped]) return _SCANNER_ALIASES[stripped];
      if (TG_MAP[stripped]) return TG_MAP[stripped];
    }
    return null;
  }

  function _matchAlphaPattern(alpha) {
    if (!alpha) return null;
    for (var pat in _SCANNER_ALPHA_PATTERNS) {
      if (!Object.prototype.hasOwnProperty.call(_SCANNER_ALPHA_PATTERNS, pat)) continue;
      if (alpha.toUpperCase().indexOf(pat.toUpperCase()) >= 0) return _SCANNER_ALPHA_PATTERNS[pat];
    }
    return null;
  }

  function _inferDiscipline(blob) {
    var t = (blob || "").toLowerCase();
    if (/\b(fire|fd|rescue|brush|blaze|smoke|structure fire|alarm)\b/.test(t)) return "fire";
    if (/\b(ems|medic|ambulance|medical|cardiac)\b/.test(t)) return "ems";
    return "police";
  }

  function _inferMunicipality(blob) {
    if (/colonie|latham/i.test(blob)) return "Colonie / Latham";
    if (/bethlehem|delmar|slingerlands|glenmont/i.test(blob)) return "Bethlehem / Delmar";
    if (/guilderland|altamont|westmere/i.test(blob)) return "Guilderland";
    if (/cohoes/i.test(blob)) return "Cohoes";
    if (/watervliet/i.test(blob)) return "Watervliet";
    if (/menands/i.test(blob)) return "Menands";
    if (/green island/i.test(blob)) return "Green Island";
    if (/ravena|coeymans|selkirk/i.test(blob)) return "Coeymans / Ravena";
    if (/voorheesville/i.test(blob)) return "Voorheesville";
    if (/sheriff|\bacso\b|county law|law dispatch|county-wide|countywide/i.test(blob)) return "County-wide";
    if (/albany\s*pd|\bapd\b|city of albany/i.test(blob)) return "Albany";
    if (/state\s*police|nysp|troop\s*[gG]/i.test(blob)) return "Latham / County-wide";
    if (/capitol|plaza|empire state/i.test(blob)) return "Downtown Albany";
    return "";
  }

  function resolveScannerDept(call) {
    var tgRaw = call.talkgroup_num != null ? call.talkgroup_num : call.talkgroup;
    var tgStr = String(tgRaw != null ? tgRaw : "").trim();
    var alpha = (call.talkgroup_tag || call.talkgroupAlpha || call.talkgroup_alpha_tag || "").trim();
    var desc = (call.talkgroup_description || call.talkgroupDescription || "").trim();
    var blob = [alpha, desc, tgStr].join(" ");

    var alias = _lookupAlias(tgStr);
    if (alias) {
      return {
        name: (alias.agency || alias.name || "Scanner") + (alias.dept ? " " + alias.dept : ""),
        agency: alias.agency || alias.name || "Scanner",
        dept: alias.dept || alias.channel || "",
        location: alias.municipality || alias.location || "Albany County",
        cat: alias.discipline || alias.cat || _inferDiscipline(blob),
        priority: alias.priority || "medium",
        channel: alias.channel || "",
        agencyId: alias.agencyId || null
      };
    }

    var alphaPat = _matchAlphaPattern(alpha);
    if (alphaPat) {
      var deptLabel = alpha || desc || "Dispatch";
      return {
        name: (alphaPat.agency || "Scanner") + " " + deptLabel,
        agency: alphaPat.agency || "Scanner",
        dept: deptLabel,
        location: alphaPat.municipality || _inferMunicipality(blob) || "Albany County",
        cat: alphaPat.discipline || _inferDiscipline(blob),
        priority: "medium",
        channel: alpha,
        agencyId: null
      };
    }

    var agencyName = alpha || desc || (tgStr ? "Ch " + tgStr : "Radio traffic");
    var muni = _inferMunicipality(blob) || "Albany County";
    return {
      name: agencyName,
      agency: agencyName,
      dept: "",
      location: muni,
      cat: _inferDiscipline(blob),
      priority: "medium",
      channel: alpha || tgStr,
      agencyId: null
    };
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
    if (el) el.setAttribute("content", theme === "dark" ? "#0A1128" : "#ffffff");
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
    // Header date + live clock with seconds
    (function () {
      var dateEl = document.getElementById("headerDate");
      var timeEl = document.getElementById("headerTime");

      function updateDateTime() {
        var now = new Date();
        if (dateEl) {
          dateEl.textContent = now.toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric"
          });
        }
        if (timeEl) {
          timeEl.textContent = now.toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", second: "2-digit"
          });
        }
      }

      updateDateTime();
      setInterval(updateDateTime, 1000);
    })();

    initTheme();
    initNav();
    initHomeModeTabs();
    initFilterSheet();
    initFilterChips();
    initPullToRefresh();
    initDirSearch();
    initDirFilters();
    loadScannerAliases();
    initScannerToolbar();
    initLiveRadio();
    initFeedTabs();
    initFeedControls();
    initSummaryControls();
    initChat();
    startClock();

    fetchIncidents();
    fetchActivityByArea();
    setTimeout(fetchScannerCalls, 900);
    setTimeout(initScannerChannelChips, 1100);
    setTimeout(initOpenMhzRealtime, 2000);  // Start real-time after initial fetch
    setTimeout(fetchScannerTalkgroups, 1400);
    setTimeout(fetchSummarySnapshot, 1800);
    setTimeout(fetchSituation, 2500);

    setInterval(function () {
      fetchIncidents();
      fetchActivityByArea();
      fetchSocialIntel();
      fetchSummarySnapshot();
      fetchSituation();
    }, REFRESH_MS);

    (function scannerPollLoop() {
      var delay = _scannerFailCount > 3
        ? Math.min(120000, SCANNER_REFRESH_MS * Math.pow(1.5, _scannerFailCount - 3))
        : SCANNER_REFRESH_MS;
      setTimeout(function () {
        fetchScannerCalls();
        scannerPollLoop();
      }, delay);
    })();
    initWhisperFeed();
    setTimeout(fetchWhisperStatus, 700);
    setInterval(fetchWhisperStatus, 30000);
    setTimeout(fetchStreamAlerts, 2500);
    setInterval(fetchStreamAlerts, 15000);

    // Freshness indicator: update "Last updated X min ago" every 15s
    setInterval(updateFreshnessIndicator, 15000);

    // Albany Pulse + SSE real-time connection
    initAlbanyPulse();
    initIncidentSSE();
  });

  var _lastFeedFetchTs = null;
  function markFeedFreshNow() {
    _lastFeedFetchTs = Date.now();
    updateFreshnessIndicator();
  }
  function updateFreshnessIndicator() {
    var el = document.getElementById("feedFreshness");
    if (!el) return;
    if (!_lastFeedFetchTs) {
      el.textContent = "";
      return;
    }
    var ago = Math.round((Date.now() - _lastFeedFetchTs) / 1000);
    var label;
    if (ago < 30) label = "Updated just now";
    else if (ago < 90) label = "Updated ~1 min ago";
    else label = "Updated " + Math.round(ago / 60) + " min ago";
    el.textContent = label;
    el.classList.toggle("feed-freshness--stale", ago > 180);
  }

  // ── ALBANY PULSE — real-time feed health bar ──────────────────────────
  var _pulseData = null;
  function initAlbanyPulse() {
    fetchPulse();
    setInterval(fetchPulse, 20000);
    var dismissBtn = document.getElementById("newActivityDismiss");
    if (dismissBtn) dismissBtn.addEventListener("click", function () {
      var banner = document.getElementById("newActivityBanner");
      if (banner) banner.hidden = true;
    });
  }

  function fetchPulse() {
    fetch(API + "/api/incidents/pulse").then(ok)
      .then(function (d) {
        if (!d || d.status !== "ok") return;
        _pulseData = d;
        renderPulseBar(d);
      })
      .catch(function () {});
  }

  function renderPulseBar(d) {
    var el = document.getElementById("albanyPulse");
    if (!el) return;
    el.hidden = false;
    var dot = document.getElementById("pulseDot");
    var label = document.getElementById("pulseLabel");
    var sources = document.getElementById("pulseSources");
    var age = document.getElementById("pulseAge");

    var state = d.feed_state || "quiet";
    if (dot) {
      dot.className = "albany-pulse-dot albany-pulse-dot--" + state;
    }
    if (label) {
      var stateLabel = state === "live" ? "Live" : state === "aging" ? "Monitoring" : "Quiet";
      label.textContent = stateLabel;
    }
    if (sources) {
      sources.textContent = d.sources_total + " sources" + (d.scanner_pipeline_active ? " + scanner" : "");
    }
    if (age) {
      var sec = d.seconds_since_last_incident || 0;
      if (sec < 60) age.textContent = "< 1m ago";
      else if (sec < 3600) age.textContent = Math.round(sec / 60) + "m ago";
      else age.textContent = Math.round(sec / 3600) + "h ago";
    }
  }

  // ── SSE REAL-TIME CONNECTION ─────────────────────────────────────────────
  var _sseSource = null;
  var _sseLastNewestId = null;

  function initIncidentSSE() {
    if (!window.EventSource) return;
    try {
      _sseSource = new EventSource(API + "/api/incidents/stream");
      _sseSource.addEventListener("new_incidents", function (ev) {
        try {
          var d = JSON.parse(ev.data);
          if (d.newest_id && d.newest_id !== _sseLastNewestId) {
            _sseLastNewestId = d.newest_id;
            showNewActivityBanner(d.newest_title || "New police activity detected");
            fetchIncidents();
          }
        } catch (e) {}
      });
      _sseSource.onerror = function () {
        // Will auto-reconnect per SSE spec
      };
    } catch (e) {}
  }

  function showNewActivityBanner(text) {
    var banner = document.getElementById("newActivityBanner");
    var textEl = document.getElementById("newActivityText");
    if (!banner || !textEl) return;
    textEl.textContent = text;
    banner.hidden = false;
    banner.classList.add("new-activity-banner--show");
    setTimeout(function () {
      banner.classList.remove("new-activity-banner--show");
      banner.hidden = true;
    }, 8000);
  }

  function refreshHeaderPrimaryCount() {
    var chipLbl = document.querySelector(".stat-chip--live .stat-lbl");
    var sub = document.getElementById("statLiveSub");
    var total = lastCrimeCounts.visible_feed_count;
    if (chipLbl) chipLbl.textContent = "Incidents";
    if (typeof total === "number") setNum("statTotal", total);
    if (sub) {
      if (typeof total !== "number" || total === 0) sub.textContent = "";
      else sub.textContent = total + " tracked in this window";
    }
  }

  // ── FEED (unified — no subtabs) ────────────────────────────────
  function initFeedTabs() {
    // Legacy subtabs removed — unified chronological feed.
    // Keep function for backward compat; nothing to bind.
  }

  function initFeedControls() {
    var search = document.getElementById("feedSearchInput");
    if (search) {
      search.addEventListener("input", function () {
        feedSearchQuery = (search.value || "").trim().toLowerCase();
        if (feedControlTimer) clearTimeout(feedControlTimer);
        feedControlTimer = setTimeout(function () {
          fetchIncidents();
          // Backend search for queries 3+ chars
          if (feedSearchQuery.length >= 3) {
            fetchSearchResults(feedSearchQuery);
          } else {
            hideSearchResults();
          }
        }, 320);
      });
    }
    var sort = document.getElementById("feedSortSelect");
    if (sort) {
      sort.value = feedSortMode;
      sort.addEventListener("change", function () {
        feedSortMode = sort.value || "priority";
        syncFeedSortControls();
        fetchIncidents();
      });
    }
    var topBtn = document.getElementById("feedOrderPriority");
    var latestBtn = document.getElementById("feedOrderNewest");
    if (topBtn) {
      topBtn.addEventListener("click", function () {
        if (feedSortMode === "priority") return;
        feedSortMode = "priority";
        syncFeedSortControls();
        fetchIncidents();
      });
    }
    if (latestBtn) {
      latestBtn.addEventListener("click", function () {
        if (feedSortMode === "newest") return;
        feedSortMode = "newest";
        syncFeedSortControls();
        fetchIncidents();
      });
    }
    syncFeedSortControls();
  }

  function syncFeedSortControls() {
    var sort = document.getElementById("feedSortSelect");
    if (sort && sort.value !== feedSortMode) sort.value = feedSortMode;
    var topBtn = document.getElementById("feedOrderPriority");
    var latestBtn = document.getElementById("feedOrderNewest");
    if (topBtn) {
      var topActive = feedSortMode === "priority";
      topBtn.classList.toggle("active", topActive);
      topBtn.setAttribute("aria-pressed", topActive ? "true" : "false");
    }
    if (latestBtn) {
      var latestActive = feedSortMode === "newest";
      latestBtn.classList.toggle("active", latestActive);
      latestBtn.setAttribute("aria-pressed", latestActive ? "true" : "false");
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

  function _developingCount(summary) {
    var rows = summary && summary.groups && summary.groups.verification_level;
    var total = 0;
    if (!Array.isArray(rows)) return total;
    rows.forEach(function (r) {
      var key = String(r.key || "").toLowerCase();
      if (key === "scanner" || key === "inferred" || key === "media") total += Number(r.count || 0);
    });
    return total;
  }

  function renderSummarySnapshot(currentSummary, weekSummary, monthSummary) {
    var el = document.getElementById("feedSummaryGrid");
    if (!el) return;
    if (!currentSummary || currentSummary.status === "error") {
      el.innerHTML = '<div class="feed-summary-empty">Overview is temporarily unavailable.</div>';
      return;
    }

    var total24 = Number(currentSummary.total || 0);
    var total7d = Number(weekSummary && weekSummary.total || 0);

    // Top crime type from 24h data
    var topType = "";
    var typeGroups = currentSummary.groups && currentSummary.groups.incident_type;
    if (typeGroups) {
      var best = "", bestN = 0;
      for (var k in typeGroups) {
        if (Object.prototype.hasOwnProperty.call(typeGroups, k) && Number(typeGroups[k]) > bestN) {
          bestN = Number(typeGroups[k]); best = k;
        }
      }
      if (best) topType = best.charAt(0).toUpperCase() + best.slice(1).replace(/_/g, " ");
    }

    // Top municipality from 24h data
    var topArea = "";
    var areaGroups = currentSummary.groups && currentSummary.groups.municipality;
    if (areaGroups) {
      var bestA = "", bestAN = 0;
      for (var ka in areaGroups) {
        if (Object.prototype.hasOwnProperty.call(areaGroups, ka) && Number(areaGroups[ka]) > bestAN) {
          bestAN = Number(areaGroups[ka]); bestA = ka;
        }
      }
      if (bestA) topArea = bestA;
    }

    var html = "";
    html += '<div class="feed-summary-card feed-summary-card--hero">';
    html += '<div class="feed-summary-v">' + esc(String(total24)) + '</div>';
    html += '<div class="feed-summary-k">incidents today</div>';
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-v">' + esc(String(total7d)) + '</div>';
    html += '<div class="feed-summary-k">this week</div>';
    html += "</div>";

    if (topType) {
      html += '<div class="feed-summary-card">';
      html += '<div class="feed-summary-v feed-summary-v--sm">' + esc(topType) + '</div>';
      html += '<div class="feed-summary-k">top type</div>';
      html += "</div>";
    }

    if (topArea) {
      html += '<div class="feed-summary-card">';
      html += '<div class="feed-summary-v feed-summary-v--sm">' + esc(topArea) + '</div>';
      html += '<div class="feed-summary-k">top area</div>';
      html += "</div>";
    }

    el.innerHTML = html;
  }

  function fetchSummarySnapshot() {
    var req24 = apiClient && apiClient.getIncidentSummary
      ? apiClient.getIncidentSummary({ window: "24h" })
      : fetch(API + "/api/incidents/summary?window=24h").then(ok);
    var req7 = apiClient && apiClient.getIncidentSummary
      ? apiClient.getIncidentSummary({ window: "7d" })
      : fetch(API + "/api/incidents/summary?window=7d").then(ok);
    var req30 = apiClient && apiClient.getIncidentSummary
      ? apiClient.getIncidentSummary({ window: "30d" })
      : fetch(API + "/api/incidents/summary?window=30d").then(ok);
    Promise.all([req24, req7, req30])
      .then(function (res) {
        renderSummarySnapshot(res[0], res[1], res[2]);
      })
      .catch(function () {
        renderSummarySnapshot({ status: "error" }, null, null);
      });
  }

  // ── HOME LIVE / NEWS MODE TABS ────────────────────────────────
  var _homeMode = "live";
  var _newsLoaded = false;

  // ── FILTER SHEET ───────────────────────────────────────────────
  var _filterSheetOpen = false;
  function openFilterSheet() {
    var sheet = document.getElementById("filterSheet");
    var backdrop = document.getElementById("filterSheetBackdrop");
    if (sheet) sheet.classList.add("open");
    if (backdrop) backdrop.classList.add("open");
    _filterSheetOpen = true;
  }
  function closeFilterSheet() {
    var sheet = document.getElementById("filterSheet");
    var backdrop = document.getElementById("filterSheetBackdrop");
    if (sheet) sheet.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
    _filterSheetOpen = false;
  }
  function initFilterSheet() {
    var btn = document.getElementById("filterToggle");
    var backdrop = document.getElementById("filterSheetBackdrop");
    var applyBtn = document.getElementById("filterApply");
    var resetBtn = document.getElementById("filterReset");
    if (btn) btn.addEventListener("click", function () {
      _filterSheetOpen ? closeFilterSheet() : openFilterSheet();
    });
    if (backdrop) backdrop.addEventListener("click", closeFilterSheet);
    if (applyBtn) applyBtn.addEventListener("click", function () {
      closeFilterSheet();
      renderUnifiedFeed(allIncidentData);
    });
    if (resetBtn) resetBtn.addEventListener("click", function () {
      document.querySelectorAll("#filterSheet input[type=checkbox]").forEach(function (cb) { cb.checked = true; });
    });
  }

  // Get active filter state from the sheet
  function getSheetFilters() {
    var sevs = [];
    document.querySelectorAll("#filterSeverityOptions input:checked").forEach(function (cb) {
      sevs.push(cb.value);
    });
    var munis = [];
    document.querySelectorAll("#filterMuniOptions input:checked").forEach(function (cb) {
      munis.push(cb.value.toLowerCase());
    });
    return { severities: sevs, municipalities: munis };
  }

  // ── QUICK FILTER CHIPS (activity-by-area strip) ───────────────
  var _activeChipFilter = "all";
  var _activityAreas = [];

  function _itemAreaSlug(item) {
    if (item && item.area_slug) return item.area_slug;
    if (item && item.incident && item.incident.area_slug) return item.incident.area_slug;
    var muni = ((item && (item.municipality || item.matched_location)) || "").toLowerCase();
    if (muni.indexOf("colonie") !== -1) return "colonie";
    if (muni.indexOf("guilderland") !== -1) return "guilderland";
    if (muni.indexOf("bethlehem") !== -1) return "bethlehem";
    if (muni.indexOf("cohoes") !== -1) return "cohoes";
    if (muni.indexOf("watervliet") !== -1) return "watervliet";
    if (muni.indexOf("albany") !== -1) return "city of albany";
    return "albany county";
  }

  function renderActivityStrip(areas, windowHours) {
    var wrap = document.getElementById("activityByArea");
    var chipsEl = document.getElementById("activityAreaChips");
    var windowEl = document.getElementById("activityByAreaWindow");
    if (!wrap || !chipsEl) return;
    _activityAreas = Array.isArray(areas) ? areas : [];
    if (windowEl) {
      windowEl.textContent = "last " + (windowHours || 24) + "h";
    }
    if (!_activityAreas.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    var html = '<button type="button" class="filter-chip' +
      (_activeChipFilter === "all" ? " active" : "") +
      '" data-filter="all" role="tab" aria-selected="' +
      (_activeChipFilter === "all" ? "true" : "false") + '">All areas</button>';
    _activityAreas.forEach(function (a) {
      var slug = a.slug || "";
      var active = _activeChipFilter === slug;
      html += '<button type="button" class="filter-chip' + (active ? " active" : "") +
        '" data-filter="' + slug + '" role="tab" aria-selected="' + (active ? "true" : "false") +
        '" title="' + (a.newest_title || "").replace(/"/g, "&quot;") + '">' +
        (a.label || slug) +
        '<span class="filter-chip-count">' + (a.count || 0) + "</span></button>";
    });
    chipsEl.innerHTML = html;
    initFilterChips();
  }

  function fetchActivityByArea() {
    fetch(API + "/api/incidents/activity-by-area?window_hours=24")
      .then(ok)
      .then(function (data) {
        if (!data || data.status !== "ok") return;
        renderActivityStrip(data.areas || [], data.window_hours || 24);
      })
      .catch(function (err) {
        console.warn("Activity-by-area fetch failed:", err);
      });
  }

  function initFilterChips() {
    var chips = document.querySelectorAll("#activityAreaChips .filter-chip[data-filter]");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        _activeChipFilter = chip.getAttribute("data-filter") || "all";
        chips.forEach(function (c) {
          var isActive = c === chip;
          c.classList.toggle("active", isActive);
          c.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        renderUnifiedFeed(allIncidentData.filter(function (x) { return x.feed_tab !== "scanner_only"; }));
      });
    });
  }

  // ── PULL-TO-REFRESH ───────────────────────────────────────────
  function initPullToRefresh() {
    var scrollEls = document.querySelectorAll(".home-scroll");
    scrollEls.forEach(function (scrollEl) {
      var startY = 0;
      var pulling = false;
      scrollEl.addEventListener("touchstart", function (e) {
        if (scrollEl.scrollTop === 0) {
          startY = e.touches[0].clientY;
          pulling = true;
        }
      }, { passive: true });
      scrollEl.addEventListener("touchmove", function (e) {
        if (!pulling) return;
        var dy = e.touches[0].clientY - startY;
        if (dy > 80 && scrollEl.scrollTop === 0) {
          pulling = false;
          // Visual feedback
          scrollEl.style.transition = "transform 0.2s";
          scrollEl.style.transform = "translateY(4px)";
          setTimeout(function () {
            scrollEl.style.transform = "";
            scrollEl.style.transition = "";
          }, 300);
          // Refresh data
          fetchIncidents();
          fetchActivityByArea();
        }
      }, { passive: true });
      scrollEl.addEventListener("touchend", function () { pulling = false; }, { passive: true });
    });
  }

  function initHomeModeTabs() {
    var btns = document.querySelectorAll("[data-home-mode]");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.getAttribute("data-home-mode");
        if (mode === _homeMode) return;
        _homeMode = mode;
        btns.forEach(function (b) {
          var isActive = b.getAttribute("data-home-mode") === mode;
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        document.getElementById("homePanelLive").classList.toggle("active", mode === "live");
        document.getElementById("homePanelNews").classList.toggle("active", mode === "news");
        if (mode === "news") {
          fetchHomeNews();
          _newsLoaded = true;
        }
      });
    });
  }

  // ── HOME NEWS (major stories, developing, headlines, recaps) ──
  function fetchHomeNews() {
    fetch(API + "/api/home/news")
      .then(ok)
      .then(function (data) {
        if (!data || data.status !== "ok") return;
        var major = data.major_stories || [];
        var developing = data.developing_stories || [];
        var headlines = data.headlines || [];
        renderMajorStories(major);
        renderDevelopingStories(developing);
        renderHeadlines(headlines);
        renderRecaps(data.recap_24h, data.recap_7d, data.recap_30d);
        renderNewsStats(data);
        renderNewsFreshness(major.concat(developing).concat(headlines));
      })
      .catch(function () {
        renderMajorStories([]);
        renderDevelopingStories([]);
        renderHeadlines([]);
        renderNewsFreshness([]);
      });
  }

  // News freshness header — same trust principle as Live: tell the user how
  // current the news section actually is rather than letting them guess.
  function renderNewsFreshness(stories) {
    var host = document.getElementById("homePanelNews");
    if (!host) return;
    var existing = document.getElementById("newsFreshness");
    if (!existing) {
      existing = document.createElement("div");
      existing.id = "newsFreshness";
      existing.className = "news-freshness";
      var scroll = host.querySelector(".home-scroll");
      if (scroll) scroll.insertBefore(existing, scroll.firstChild);
      else host.insertBefore(existing, host.firstChild);
    }
    if (!stories || !stories.length) { existing.hidden = true; existing.innerHTML = ""; return; }
    var newestMs = 0;
    stories.forEach(function (s) {
      var raw = s && (s.published_at || s.occurred_at || s.pubDate);
      var t = raw ? new Date(raw).getTime() : 0;
      if (t > newestMs) newestMs = t;
    });
    if (!newestMs) { existing.hidden = true; existing.innerHTML = ""; return; }
    var mins = Math.max(0, Math.round((Date.now() - newestMs) / 60000));
    var ageText = mins < 1 ? "just now" :
                  mins === 1 ? "1 min ago" :
                  mins < 60 ? mins + " min ago" :
                  mins < 24 * 60 ? Math.round(mins / 60) + " hr ago" :
                  Math.round(mins / (60 * 24)) + " day" + (Math.round(mins / (60 * 24)) === 1 ? "" : "s") + " ago";
    var tone = mins < 60 ? "fresh" : mins < 6 * 60 ? "aging" : "stale";
    existing.className = "news-freshness news-freshness--" + tone;
    existing.innerHTML =
      '<span class="news-freshness-label">Latest story</span>' +
      '<span class="news-freshness-value">' + ageText + '</span>' +
      '<span class="news-freshness-count">' + stories.length + ' tracked</span>';
    existing.hidden = false;
  }

  // Build a small 2-letter source-brand chip from a source name (e.g.
  // "Times Union" → "TU", "WNYT" → "WN"). We do not have real publisher
  // images in the data model, so this acts as a lightweight, non-invented
  // visual anchor for News cards.
  // Canonical agency_id → compact display name for the Live card meta
  // row's leading agency pill (v7 redesign). Mirrors the short_name field
  // in data/agencies.json for the operational entries the registry tags as
  // is_albany_county_primary plus the most-frequently-resolved state /
  // railroad agencies. Unknown ids fall back to a presentable form of the
  // raw id rather than being suppressed, so a future agency added to
  // data/agencies.json doesn't disappear from the UI just because this
  // map hasn't been refreshed.
  var _AGENCY_DISPLAY_NAMES = {
    apd: "APD",
    acso: "ACSO",
    bethlehem_pd: "Bethlehem PD",
    colonie_pd: "Colonie PD",
    guilderland_pd: "Guilderland PD",
    cohoes_pd: "Cohoes PD",
    watervliet_pd: "Watervliet PD",
    coeymans_pd: "Coeymans PD",
    green_island_pd: "Green Island PD",
    menands_pd: "Menands PD",
    altamont_pd: "Altamont PD",
    nysp_troop_g: "NYSP Troop G",
    nysp_troop_t: "NYSP Troop T",
    nysp_capitol_x: "NYSP Capitol",
    nys_park_police: "NYS Park Police",
    dec_le: "DEC ECO",
    csx_police: "CSX Police",
    fbi_albany: "FBI",
    uapd: "UAPD",
  };

  function _agencyDisplayName(agencyId) {
    if (typeof agencyId !== "string") return "";
    var aid = agencyId.trim().toLowerCase();
    if (!aid) return "";
    if (_AGENCY_DISPLAY_NAMES[aid]) return _AGENCY_DISPLAY_NAMES[aid];
    // Fallback: turn "some_new_pd" into "Some New PD" so unknown
    // canonical ids stay legible until the map is updated.
    return aid.split("_").map(function (w) {
      if (!w) return "";
      if (w === "pd" || w === "po" || w === "le") return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function _sourceInitials(sourceName) {
    var s = String(sourceName || "").trim();
    if (!s) return "·";
    var parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // Map a source name → the publisher's domain so we can show its real logo.
  var _SOURCE_DOMAINS = [
    [/news10|wten/i, "news10.com"],
    [/cbs6|wrgb/i, "cbs6albany.com"],
    [/wnyt|newschannel ?13/i, "wnyt.com"],
    [/wamc/i, "wamc.org"],
    [/times ?union/i, "timesunion.com"],
    [/daily ?gazette|gazette/i, "dailygazette.com"],
    [/spotlight/i, "spotlightnews.com"],
    [/spectrum/i, "spectrumlocalnews.com"],
    [/fox ?23|wxxa/i, "fox23news.com"],
    [/patch/i, "patch.com"],
    [/albany proper/i, "albanyproper.com"],
    [/albany scanner/i, "albanyscanner.com"],
    [/them ?(&|and)? ?us/i, "themandus.substack.com"],
    [/hudson valley|hvnn/i, "hudsonvalleynewsnetwork.com"],
    [/reddit/i, "reddit.com"],
    [/nextdoor/i, "nextdoor.com"],
    [/citizen/i, "citizen.com"],
    [/bluesky/i, "bsky.app"],
    [/nysp|state police|troop/i, "troopers.ny.gov"],
    [/albany.*sheriff|acso/i, "albanycountyny.gov"],
    [/albany.*police|\bapd\b/i, "albanyny.gov"],
    [/city of albany/i, "albanyny.gov"],
    [/nixle/i, "nixle.com"],
    [/facebook/i, "facebook.com"],
  ];

  function _domainFromUrl(u) {
    try {
      var m = /^https?:\/\/([^/?#]+)/i.exec(u || "");
      if (!m) return "";
      var host = m[1].replace(/^www\./, "");
      // Skip Google News redirect domains — they aren't the real publisher.
      if (/google\.com$/i.test(host)) return "";
      return host;
    } catch (e) { return ""; }
  }

  function _sourceDomain(sourceName, sourceUrl) {
    var d = _domainFromUrl(sourceUrl);
    if (d) return d;
    var s = String(sourceName || "");
    for (var i = 0; i < _SOURCE_DOMAINS.length; i++) {
      if (_SOURCE_DOMAINS[i][0].test(s)) return _SOURCE_DOMAINS[i][1];
    }
    return "";
  }

  // Real publisher logo served through our own origin (/api/logo). Going
  // same-origin avoids Safari ITP / privacy blockers that silently drop
  // third-party favicon requests. Falls back to letter-avatar via onerror.
  function _sourceLogoUrl(sourceName, sourceUrl) {
    var d = _sourceDomain(sourceName, sourceUrl);
    if (!d) return "";
    return API + "/api/logo?domain=" + encodeURIComponent(d);
  }

  function _storyCard(item, cls) {
    var sev = (item.severity || "").toLowerCase();
    var sevCls = sev === "critical" ? " home-story-pill--sev-critical" : sev === "high" ? " home-story-pill--sev-high" : "";
    var link = item.source_url || item.link || "";
    var tag = link ? "a" : "div";
    var linkAttrs = link ? ' href="' + escAttr(link) + '" target="_blank" rel="noopener noreferrer"' : "";
    var html = '<' + tag + ' class="home-story-card ' + cls + '"' + linkAttrs + '>';
    var srcName = item.source_name || item.source || "";
    var img = item.image_url || "";
    // Real article thumbnail when the source RSS provided one.
    if (img) {
      html += '<div class="home-story-thumb">'
        + '<img src="' + escAttr(img) + '" alt="" loading="lazy"'
        + ' onerror="this.closest(\'.home-story-card\').classList.add(\'no-thumb\');this.closest(\'.home-story-thumb\').remove();">'
        + '</div>';
    }
    // Publisher logo (reliable favicon) — falls back to letter initials.
    var logo = _sourceLogoUrl(srcName, item.source_url || item.link || "");
    var initials = esc(_sourceInitials(srcName));
    html += '<div class="home-story-avatar' + (logo ? '' : ' is-letter') + '" aria-hidden="true">';
    if (logo) {
      html += '<img class="home-story-logo" src="' + escAttr(logo) + '" alt=""'
        + ' onerror="this.parentNode.classList.add(\'is-letter\');this.remove();">';
    }
    html += '<span class="home-story-initials--fallback">' + initials + '</span>';
    html += '</div>';
    html += '<div class="home-story-body">';
    html += '<div class="home-story-head">';
    html += '<div class="home-story-title">' + esc(item.title || "Untitled") + '</div>';
    if (item.human_time) html += '<span class="home-story-time">' + esc(item.human_time) + '</span>';
    html += '</div>';
    if (item.summary) html += '<div class="home-story-desc">' + esc(item.summary) + '</div>';
    html += '<div class="home-story-meta">';
    if (item.topic) html += '<span class="home-story-pill home-story-pill--topic">' + esc(item.topic) + '</span>';
    if (item.municipality) html += '<span class="home-story-pill"><span class="material-icons" style="font-size:11px;margin-right:2px;">location_on</span>' + esc(item.municipality) + '</span>';
    if (item.source_name) html += '<span class="home-story-pill home-story-pill--source">' + esc(item.source_name) + '</span>';
    if (sev && sev !== "unknown") html += '<span class="home-story-pill' + sevCls + '">' + esc(sev) + '</span>';
    var vl = (item.verification_level || "").replace(/_/g, " ");
    if (vl && vl !== "unknown") html += '<span class="home-story-pill">' + esc(vl) + '</span>';
    html += '</div></div></' + tag + '>';
    return html;
  }

  function renderMajorStories(stories) {
    var el = document.getElementById("homeMajorStories");
    if (!el) return;
    if (!stories.length) {
      el.innerHTML = '<div class="feed-summary-empty">No major stories right now.</div>';
      return;
    }
    var html = "";
    stories.forEach(function (s) { html += _storyCard(s, "home-story-card--major"); });
    el.innerHTML = html;
  }

  function renderDevelopingStories(stories) {
    var el = document.getElementById("homeDevelopingStories");
    if (!el) return;
    if (!stories.length) {
      el.innerHTML = '<div class="feed-summary-empty">Nothing developing right now.</div>';
      return;
    }
    var html = "";
    stories.forEach(function (s) { html += _storyCard(s, "home-story-card--developing"); });
    el.innerHTML = html;
  }

  function renderHeadlines(headlines) {
    var el = document.getElementById("homeHeadlinesList");
    if (!el) return;
    if (!headlines || !headlines.length) {
      el.innerHTML = '<div class="feed-summary-empty">No recent headlines.</div>';
      return;
    }
    var html = "";
    headlines.forEach(function (s) {
      html += _headlineCard(s);
    });
    el.innerHTML = html;
  }

  function _headlineCard(item) {
    var link = item.source_url || "";
    var muni = item.municipality || "";
    if (muni.toLowerCase() === "albany") muni = "City of Albany";
    var time = item.human_time || "";
    var src = item.source_name || "";
    var sev = (item.severity || "").toLowerCase();

    var img = item.image_url || "";
    var hlLogo = _sourceLogoUrl(src, item.source_url || "");
    // Prefer the article thumbnail; otherwise show the publisher logo tile.
    var leadVisual = img || hlLogo;
    var html = '<a class="news-headline' + (leadVisual ? ' news-headline--thumb' : '') + '" href="' + (link ? escAttr(link) : '#') + '"'
      + (link ? ' target="_blank" rel="noopener noreferrer"' : '') + '>';
    if (img) {
      html += '<div class="news-headline-thumb">'
        + '<img src="' + escAttr(img) + '" alt="" loading="lazy"'
        + ' onerror="var c=this.closest(\'.news-headline-thumb\'); if(c){c.classList.add(\'is-logo\'); this.src=\'' + escAttr(hlLogo || "") + '\';}">'
        + '</div>';
    } else if (hlLogo) {
      html += '<div class="news-headline-thumb is-logo">'
        + '<img src="' + escAttr(hlLogo) + '" alt=""'
        + ' onerror="this.closest(\'.news-headline\').classList.remove(\'news-headline--thumb\');this.closest(\'.news-headline-thumb\').remove();">'
        + '</div>';
    }
    html += '<div class="news-headline-body">';
    html += '<div class="news-headline-top">';
    if (sev === "critical" || sev === "high") {
      html += '<span class="news-headline-sev news-headline-sev--' + esc(sev) + '"></span>';
    }
    html += '<span class="news-headline-title">' + esc(item.title || "Untitled") + '</span>';
    html += '</div>';
    var snip = (item.summary || "").trim();
    if (snip && snip.toLowerCase() !== (item.title || "").toLowerCase()) {
      html += '<div class="news-headline-snippet">' + esc(snip) + '</div>';
    }
    html += '<div class="news-headline-meta">';
    if (muni) html += '<span>' + esc(muni) + '</span>';
    if (src) html += '<span>' + esc(src) + '</span>';
    if (time) html += '<span>' + esc(time) + '</span>';
    html += '</div>';
    html += '</div>';
    html += '</a>';
    return html;
  }

  function renderNewsStats(data) {
    var r24 = data.recap_24h || {};
    var r7 = data.recap_7d || {};
    var topCats = data.top_categories || [];
    var topLocs = data.top_locations || [];

    var el24 = document.getElementById("newsStat24h");
    var el7d = document.getElementById("newsStat7d");
    var elType = document.getElementById("newsStatTopType");
    var elArea = document.getElementById("newsStatTopArea");

    if (el24) el24.textContent = String(r24.total || 0);
    if (el7d) el7d.textContent = String(r7.total || 0);
    if (elType && topCats.length) elType.textContent = (topCats[0].key || "—").replace(/_/g, " ");
    if (elArea && topLocs.length) {
      var loc = topLocs[0].key || "—";
      if (loc.toLowerCase() === "albany") loc = "City of Albany";
      elArea.textContent = loc;
    }
  }

  function renderRecaps(r24, r7, r30) {
    var el = document.getElementById("homeRecaps");
    if (!el) return;
    function _topStr(arr) {
      if (!Array.isArray(arr) || !arr.length) return "—";
      return arr.slice(0, 2).map(function (x) { return (x.key || "?") + " (" + (x.count || 0) + ")"; }).join(", ");
    }
    function _card(label, recap) {
      if (!recap) return "";
      var delta = Number(recap.delta_count || 0);
      var deltaText = delta === 0 ? "No change" : (delta > 0 ? "+" : "") + delta + " vs prior";
      var html = '<div class="home-recap-card">';
      html += '<div class="home-recap-label">' + esc(label) + '</div>';
      html += '<div class="home-recap-val">' + esc(String(recap.total || 0)) + '</div>';
      html += '<div class="home-recap-detail">' + esc(deltaText) + '</div>';
      html += '<div class="home-recap-detail">' + esc(_topStr(recap.top_types)) + '</div>';
      html += '<div class="home-recap-detail">' + esc(_topStr(recap.top_locations)) + '</div>';
      html += '</div>';
      return html;
    }
    el.innerHTML = _card("Past 24h", r24) + _card("Past 7 days", r7) + _card("Past 30 days", r30);
  }

  // ── NAVIGATION ────────────────────────────────────────────────
  function initNav() {
    // Logo / header-left → tap returns to Home
    var headerLeft = document.querySelector(".header-left");
    if (headerLeft) {
      headerLeft.style.cursor = "pointer";
      headerLeft.addEventListener("click", function () {
        closeMoreSheet();
        switchView("feed");
      });
    }

    // Tab bar items (mobile)
    var tabItems = document.querySelectorAll(".tab-bar-item[data-view]");
    tabItems.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        closeMoreSheet();
        switchView(view);
      });
    });

    // More tab button — toggles sheet
    var moreBtn = document.getElementById("moreTabBtn");
    var moreSheet = document.getElementById("moreSheet");
    var moreBackdrop = document.getElementById("moreSheetBackdrop");
    if (moreBtn && moreSheet && moreBackdrop) {
      moreBtn.addEventListener("click", function () {
        var isOpen = moreSheet.classList.contains("visible");
        if (isOpen) closeMoreSheet();
        else openMoreSheet();
      });
      moreBackdrop.addEventListener("click", closeMoreSheet);

      // More sheet items — navigate and close sheet
      moreSheet.querySelectorAll(".more-sheet-item[data-view]").forEach(function (item) {
        item.addEventListener("click", function () {
          var view = item.getAttribute("data-view");
          closeMoreSheet();
          switchView(view);
        });
      });
      moreSheet.querySelectorAll(".more-sheet-item[data-overflow-target]").forEach(function (item) {
        item.addEventListener("click", function () {
          var target = item.getAttribute("data-overflow-target");
          closeMoreSheet();
          handleOverflowAction(target);
        });
      });
      var moreThemeBtn = document.getElementById("moreSheetThemeBtn");
      if (moreThemeBtn) {
        moreThemeBtn.addEventListener("click", function () {
          closeMoreSheet();
          var themeBtn = document.getElementById("themeToggle");
          if (themeBtn) themeBtn.click();
        });
      }
    }

    // Legacy nav-btn support (backward compat)
    var legacyBtns = document.querySelectorAll(".nav-btn");
    legacyBtns.forEach(function (btn) {
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

    // Header overflow menu
    var menuToggle = document.getElementById("menuToggle");
    var menu = document.getElementById("overflowMenu");
    if (menuToggle && menu) {
      menuToggle.addEventListener("click", function () {
        var open = !menu.hasAttribute("hidden");
        if (open) menu.setAttribute("hidden", "");
        else menu.removeAttribute("hidden");
        menuToggle.setAttribute("aria-expanded", open ? "false" : "true");
      });
      document.addEventListener("click", function (evt) {
        if (menu.hasAttribute("hidden")) return;
        if (menuToggle.contains(evt.target) || menu.contains(evt.target)) return;
        menu.setAttribute("hidden", "");
        menuToggle.setAttribute("aria-expanded", "false");
      });
      menu.querySelectorAll("[data-overflow-target]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          handleOverflowAction(btn.getAttribute("data-overflow-target"));
          menu.setAttribute("hidden", "");
          menuToggle.setAttribute("aria-expanded", "false");
        });
      });
    }

    document.querySelectorAll("[data-view-target]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.getAttribute("data-view-target");
        if (target) switchView(target);
      });
    });

    switchView("feed");
  }

  function openMoreSheet() {
    var sheet = document.getElementById("moreSheet");
    var backdrop = document.getElementById("moreSheetBackdrop");
    var btn = document.getElementById("moreTabBtn");
    if (!sheet || !backdrop) return;
    sheet.removeAttribute("hidden");
    backdrop.removeAttribute("hidden");
    // Trigger reflow for CSS transition
    void sheet.offsetHeight;
    sheet.classList.add("visible");
    backdrop.classList.add("visible");
    if (btn) btn.classList.add("active");
  }

  function closeMoreSheet() {
    var sheet = document.getElementById("moreSheet");
    var backdrop = document.getElementById("moreSheetBackdrop");
    var btn = document.getElementById("moreTabBtn");
    if (!sheet || !backdrop) return;
    sheet.classList.remove("visible");
    backdrop.classList.remove("visible");
    setTimeout(function () {
      sheet.setAttribute("hidden", "");
      backdrop.setAttribute("hidden", "");
    }, 300);
    // Only remove active if we're not navigating to a "more" sub-view
    if (btn && !["chat", "more"].includes(activeView)) {
      btn.classList.remove("active");
    }
  }

  function handleOverflowAction(target) {
    if (target === "settings") {
      var themeBtn = document.getElementById("themeToggle");
      if (themeBtn) themeBtn.click();
      return;
    }
    switchView("more");
    setTimeout(function () {
      var ids = {
        trends: "patternsContent",
        sources: "methodologyPanel",
        fbi: "nibrsAgencies"
      };
      var el = document.getElementById(ids[target] || "");
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 60);
  }

  function switchView(viewName) {
    activeView = viewName;

    // Update tab bar items (mobile) — 4 primary tabs
    var tabItems = document.querySelectorAll(".tab-bar-item[data-view]");
    tabItems.forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === viewName);
    });
    // If navigating to chat or more (via More sheet), highlight the More tab
    var moreBtn = document.getElementById("moreTabBtn");
    if (moreBtn) {
      var isMoreChild = (viewName === "chat" || viewName === "more");
      moreBtn.classList.toggle("active", isMoreChild);
    }

    // Legacy nav-btn support
    var legacyBtns = document.querySelectorAll(".nav-btn");
    legacyBtns.forEach(function (b) {
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

    if (viewName === "map" && !mapInitialized) {
      initMap();
      mapInitialized = true;
    } else if (viewName === "map" && map) {
      setTimeout(function () { if (window.google) google.maps.event.trigger(map, "resize"); }, 100);
      refreshMapMarkers();
    }

    if (viewName === "more") {
      var list = document.getElementById("nibrsAgencies");
      if (list && list.querySelector(".skeleton")) {
        fetchNibrsAgencies();
      }
      var meth = document.getElementById("methodologyPanel");
      if (meth && meth.querySelector(".skeleton")) {
        fetchMethodologyPanel();
      }
      fetchTrends();
      fetchDailySummary();
      fetchMonthlySummary();
      fetchSocialIntel();
    }

    // Lazy-load law enforcement directory
    if (viewName === "directory" && !directoryLoaded && !directoryLoading) {
      fetchDirectory();
    }
  }

  // Expose globally so inline onclick in scanner-intel cards can call it
  window.switchView = switchView;

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (map && window.google) google.maps.event.trigger(map, "resize");
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

  // ── MAP (Google Maps) ─────────────────────────────────────────

  // Hide POIs and transit to keep focus on crime markers
  var _GMAP_CLEAN_BASE = [
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "poi.park", stylers: [{ visibility: "simplified" }] },
    { featureType: "poi.park", elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "poi.business", stylers: [{ visibility: "off" }] }
  ];
  var _GMAP_LIGHT_STYLE = _GMAP_CLEAN_BASE.concat([]);
  var _GMAP_DARK_STYLE = _GMAP_CLEAN_BASE.concat([
    { elementType: "geometry", stylers: [{ color: "#1d2c4d" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#8ec3b9" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#1a3646" }] },
    { featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#0e1626" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#304a7d" }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#255763" }] }
  ]);

  /** Load the Google Maps JS SDK dynamically from API key served by backend */
  function _loadGoogleMaps(callback) {
    if (window.google && window.google.maps) { callback(); return; }
    fetch(API + "/api/config").then(ok).then(function (cfg) {
      console.log("BROWSER MAP KEY PREFIX:", cfg && cfg.google_maps_api_key ? cfg.google_maps_api_key.slice(0, 12) : "(empty)");
      var key = cfg && cfg.google_maps_api_key;
      if (!key) { console.warn("No Google Maps API key"); return; }
      var s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&libraries=marker,visualization&callback=_gmapReady&v=weekly";
      s.async = true;
      s.defer = true;
      window._gmapReady = function () {
        delete window._gmapReady;
        // Also load MarkerClusterer
        var mc = document.createElement("script");
        mc.src = "https://unpkg.com/@googlemaps/markerclusterer@2.5.3/dist/index.min.js";
        mc.onload = callback;
        mc.onerror = callback; // proceed even without clustering
        document.head.appendChild(mc);
      };
      document.head.appendChild(s);
    }).catch(function () { console.warn("Could not fetch map config"); });
  }

  function _markerColor(cat, sev) {
    // Severity-based color: red for high/critical, blue for medium/low/other
    if (sev === "critical" || sev === "high") return "#EF4444";
    if (cat === "violent") return "#EF4444";
    return "#3B82F6";
  }

  /** Map incident type to a simple SVG icon glyph (Unicode char) */
  function _markerGlyph(item) {
    var t = ((item && (item.incident_type || item.event_type || item.crime_type)) || "").toLowerCase();
    // Simple, universally-rendered glyphs (no web font dependency)
    if (/shoot|shot|gun|firearm/.test(t)) return "\u26A0"; // warning
    if (/assault|victim|attack|stab/.test(t)) return "\u26A0";
    if (/rob|flee|chase|pursuit/.test(t)) return "\u21E8"; // arrow
    if (/burg|break|b&e|break-in/.test(t)) return "\u2302"; // house
    if (/vehicle|car|auto|theft/.test(t)) return "\u2691"; // flag
    if (/vandal|graffiti|damage/.test(t)) return "\u2718"; // x mark
    if (/drug|narcotic|substance/.test(t)) return "\u2620"; // skull
    if (/disorder|noise|disturbance/.test(t)) return "\u266A"; // note
    if (/dui|dwi|accident|crash|collision/.test(t)) return "\u26D4"; // no entry
    if (/fire|arson/.test(t)) return "\u2666"; // diamond
    if (/ems|medical|overdose/.test(t)) return "+";
    if (/arrest|police/.test(t)) return "\u2605"; // star
    return "\u2605"; // default: star
  }

  /** Build circular SVG marker with glyph inside */
  function _makeCircleMarker(color, glyph, hasPulse) {
    var s = 30;
    var cx = s / 2 + 4, cy = s / 2 + 4;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (s + 8) + '" height="' + (s + 8) + '" viewBox="0 0 ' + (s + 8) + ' ' + (s + 8) + '">';
    if (hasPulse) {
      svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (s/2 + 3) + '" fill="' + color + '" fill-opacity="0.2">';
      svg += '<animate attributeName="r" from="' + (s/2) + '" to="' + (s/2 + 8) + '" dur="1.5s" repeatCount="indefinite"/>';
      svg += '<animate attributeName="fill-opacity" from="0.3" to="0" dur="1.5s" repeatCount="indefinite"/>';
      svg += '</circle>';
    }
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (s/2) + '" fill="' + color + '" stroke="white" stroke-width="2"/>';
    svg += '<text x="' + cx + '" y="' + (cy + 1) + '" text-anchor="middle" dominant-baseline="central" fill="white" font-size="13" font-weight="700" font-family="system-ui,sans-serif">' + glyph + '</text>';
    svg += '</svg>';
    return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
  }

  function initMap() {
    var el = document.getElementById("map");
    if (!el || map) return;

    _loadGoogleMaps(function () {
      if (!window.google || !window.google.maps) {
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:14px;">Map could not load — check API key.</div>';
        return;
      }

      try {
        var isDark = getTheme() === "dark";
        map = new google.maps.Map(el, {
          center: { lat: 42.65, lng: -73.75 },
          zoom: 11,
          minZoom: 8,
          maxZoom: 18,
          mapId: "ACT_MAP",
          disableDefaultUI: false,
          zoomControl: true,
          zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_TOP },
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          gestureHandling: "greedy",
          styles: isDark ? _GMAP_DARK_STYLE : _GMAP_LIGHT_STYLE
        });

        _gmapInfoWindow = new google.maps.InfoWindow({ maxWidth: 280 });
        mapReady = true;

        if (pendingMarkerData) plotMarkers(pendingMarkerData);
        refreshMapMarkers();
        initMapFilters();
        initMapTimeScrubber();

        // Heatmap toggle
        var heatBtn = document.getElementById("mapHeatmapToggle");
        if (heatBtn) heatBtn.addEventListener("click", toggleHeatmap);

        // Locate me
        var locBtn = document.getElementById("mapLocateBtn");
        if (locBtn) locBtn.addEventListener("click", function () {
          if (!navigator.geolocation) return;
          locBtn.classList.add("active");
          navigator.geolocation.getCurrentPosition(function (pos) {
            locBtn.classList.remove("active");
            var ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            map.panTo(ll);
            map.setZoom(14);
          }, function () { locBtn.classList.remove("active"); }, { timeout: 8000 });
        });

        // Close map sheet when clicking map background
        google.maps.event.addListener(map, "click", closeMapSheet);
      } catch (err) {
        console.error("Map init error:", err);
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:14px;">Map could not load — try refreshing.</div>';
      }
    });
  }

  function updateMapTiles(theme) {
    if (!map || !window.google) return;
    map.setOptions({ styles: theme === "dark" ? _GMAP_DARK_STYLE : _GMAP_LIGHT_STYLE });
  }

  function initMapFilters() {
    var btns = document.querySelectorAll(".map-chip[data-filter]");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        btns.forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        activeMapFilter = btn.getAttribute("data-filter");
        refreshMapMarkers();
      });
    });
    initMapControls();
    initShareLocation();
  }

  /** Share / show user's location on the map */
  function initShareLocation() {
    var btn = document.getElementById("mapShareBtn");
    if (!btn) return;
    var userMarker = null;

    btn.addEventListener("click", function () {
      if (!navigator.geolocation) {
        setMapStatus("Location not supported");
        return;
      }
      btn.style.opacity = "0.5";
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          btn.style.opacity = "1";
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;

          // Drop a distinct blue pulsing marker for user location
          if (userMarker) userMarker.setMap(null);
          var locSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            '<circle cx="12" cy="12" r="11" fill="#4285F4" fill-opacity="0.2" stroke="#4285F4" stroke-width="2"/>' +
            '<circle cx="12" cy="12" r="5" fill="#4285F4"/></svg>';
          userMarker = new google.maps.Marker({
            position: { lat: lat, lng: lng },
            map: map,
            icon: {
              url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(locSvg),
              scaledSize: new google.maps.Size(24, 24),
              anchor: new google.maps.Point(12, 12)
            },
            title: "Your location",
            zIndex: 9999
          });
          map.panTo({ lat: lat, lng: lng });
          map.setZoom(14);

          // Copy shareable link to clipboard
          var shareUrl = "https://www.google.com/maps?q=" + lat + "," + lng;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl).then(function () {
              setMapStatus("Location link copied!");
              setTimeout(function () { setMapStatus(_gmapMarkers.length + " incidents"); }, 2500);
            });
          } else {
            setMapStatus("Lat: " + lat.toFixed(4) + ", Lng: " + lng.toFixed(4));
          }
        },
        function () {
          btn.style.opacity = "1";
          setMapStatus("Location access denied");
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
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
      mapFetchTimer = setTimeout(refreshMapMarkers, 180);
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
    if (t.indexOf("violent") !== -1 || t.indexOf("homicide") !== -1 || t.indexOf("assault") !== -1 || t.indexOf("shooting") !== -1 || t.indexOf("stabbing") !== -1) return "violent";
    if (t.indexOf("property") !== -1 || t.indexOf("burglary") !== -1 || t.indexOf("theft") !== -1 || t.indexOf("robbery") !== -1) return "property";
    return "other";
  }

  function refreshMapMarkers() {
    setMapStatus("Loading…");
    var fetcher = apiClient && apiClient.getIncidentMarkers
      ? apiClient.getIncidentMarkers({ has_coordinates: "true", limit: 500, start_date: homeWindowStartIso(), q: mapSearchQuery, verification_level: mapVerification, severity: mapSeverity, sort_by: "newest" })
      : fetch(API + "/api/incidents/map?has_coordinates=true&limit=500&sort_by=newest&start_date=" + encodeURIComponent(homeWindowStartIso())).then(ok);
    fetcher
      .then(function (r) {
        var markers = (r && Array.isArray(r.markers)) ? r.markers : [];
        pendingMarkerData = markers;
        if (mapReady) plotMarkers(markers);
      })
      .catch(function () {
        setMapStatus("Could not load map incidents.");
        pendingMarkerData = [];
        if (mapReady) plotMarkers([]);
      });
  }

  function _clearMapMarkers() {
    if (_gmapClusterer) { _gmapClusterer.clearMarkers(); _gmapClusterer = null; }
    _gmapMarkers.forEach(function (m) { m.setMap(null); });
    _gmapMarkers = [];
  }

  // ── Map bottom sheet ───────────────────────────────────────────
  function openMapSheet(d) {
    var sheet = document.getElementById("mapSheet");
    var backdrop = document.getElementById("mapSheetBackdrop");
    var catEl = document.getElementById("mapSheetCat");
    var titleEl = document.getElementById("mapSheetTitle");
    var metaEl = document.getElementById("mapSheetMeta");
    var srcEl = document.getElementById("mapSheetSource");
    var actEl = document.getElementById("mapSheetActions");
    if (!sheet) return;

    var catColor = _markerColor(d.cat, d.sev);
    var catLabel = d.cat === "violent" ? "Violent" : d.cat === "property" ? "Property" : "Other";
    if (catEl) { catEl.textContent = catLabel; catEl.style.background = catColor; }
    if (titleEl) titleEl.textContent = d.title || "Incident";
    if (metaEl) metaEl.textContent = (d.municipality || "Albany County") + (d.time ? " \u00b7 " + d.time : "");
    if (srcEl) srcEl.textContent = d.source_name ? "via " + d.source_name : "";
    if (actEl) {
      var html = '<a href="#" onclick="window.ACTFocusIncident && window.ACTFocusIncident(\'' + escAttr(d.fid) + '\');return false;"><span class="material-icons">article</span>View in feed</a>';
      if (d.source_url) html += '<a href="' + escAttr(d.source_url) + '" target="_blank" rel="noopener"><span class="material-icons">open_in_new</span>Source</a>';
      if (navigator.share) {
        html += '<button onclick="navigator.share({title:\'' + escAttr(d.title) + '\',url:\'' + escAttr(d.source_url || location.href) + '\'}).catch(function(){})"><span class="material-icons">share</span>Share</button>';
      }
      actEl.innerHTML = html;
    }
    sheet.classList.add("open");
    if (backdrop) backdrop.classList.add("open");
  }
  function closeMapSheet() {
    var sheet = document.getElementById("mapSheet");
    var backdrop = document.getElementById("mapSheetBackdrop");
    if (sheet) sheet.classList.remove("open");
    if (backdrop) backdrop.classList.remove("open");
  }
  // Wire backdrop click
  (function () {
    document.addEventListener("click", function (e) {
      if (e.target && e.target.id === "mapSheetBackdrop") closeMapSheet();
    });
  })();

  // ── Time scrubber state ───────────────────────────────────────
  var _mapScrubberHours = 24;
  function initMapTimeScrubber() {
    var range = document.getElementById("mapScrubberRange");
    var label = document.getElementById("mapScrubberLabel");
    if (!range) return;
    range.addEventListener("input", function () {
      _mapScrubberHours = parseInt(range.value, 10) || 24;
      if (label) label.textContent = _mapScrubberHours + "h";
      applyTimeScrubber();
    });
  }
  function applyTimeScrubber() {
    var cutoff = Date.now() - _mapScrubberHours * 3600000;
    _gmapMarkers.forEach(function (m) {
      var ts = m._actData && m._actData.timestamp;
      if (ts) {
        m.setVisible(ts >= cutoff);
      }
    });
  }

  // ── Heatmap layer ─────────────────────────────────────────────
  var _gmapHeatmap = null;
  var _heatmapOn = false;
  function toggleHeatmap() {
    if (!window.google || !google.maps.visualization) return;
    _heatmapOn = !_heatmapOn;
    var btn = document.getElementById("mapHeatmapToggle");
    if (btn) btn.classList.toggle("active", _heatmapOn);

    if (_heatmapOn) {
      var points = _gmapMarkers.map(function (m) {
        return m.getPosition();
      }).filter(Boolean);
      _gmapHeatmap = new google.maps.visualization.HeatmapLayer({
        data: points,
        map: map,
        radius: 30,
        opacity: 0.6
      });
      // Hide individual markers
      _gmapMarkers.forEach(function (m) { m.setVisible(false); });
      if (_gmapClusterer) _gmapClusterer.clearMarkers();
    } else {
      if (_gmapHeatmap) { _gmapHeatmap.setMap(null); _gmapHeatmap = null; }
      // Show markers again
      _gmapMarkers.forEach(function (m) { m.setVisible(true); });
      if (window.markerClusterer && window.markerClusterer.MarkerClusterer) {
        _gmapClusterer = new markerClusterer.MarkerClusterer({
          map: map,
          markers: _gmapMarkers
        });
      }
    }
  }

  function plotMarkers(data) {
    if (!map || !mapReady || !window.google) return;

    _clearMapMarkers();
    closeMapSheet();

    var filtered = activeMapFilter === "all" ? data
      : data.filter(function (d) { return mapCategory(d) === activeMapFilter; });

    var count = 0;

    filtered.forEach(function (item) {
      var lat = parseFloat(item.latitude), lng = parseFloat(item.longitude);
      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;
      if (lat < 42.3 || lat > 42.9 || lng < -74.2 || lng > -73.4) return;

      var cq = String(item.coordinate_quality || "approximate").toLowerCase();
      if (cq === "missing") return;
      count++;

      var cat = mapCategory(item);
      var sev = (item.severity || "low").toLowerCase();
      var color = _markerColor(cat, sev);
      var ta = item.human_time || (item.occurred_at ? timeAgo(new Date(item.occurred_at)) : "");

      // Determine age for pulse effect
      var ageMs = item.occurred_at ? (Date.now() - new Date(item.occurred_at).getTime()) : Infinity;
      var isFreshMarker = ageMs < 3600000; // < 60 minutes

      var markerSize = 38;
      var marker = new google.maps.Marker({
        position: { lat: lat, lng: lng },
        icon: {
          url: _makeCircleMarker(color, _markerGlyph(item), isFreshMarker),
          scaledSize: new google.maps.Size(markerSize, markerSize),
          anchor: new google.maps.Point(markerSize / 2, markerSize / 2)
        },
        title: item.title || "Incident",
        optimized: !isFreshMarker // non-optimized allows animation
      });

      // Store data for bottom sheet + time scrubber
      var ts = item.occurred_at ? new Date(item.occurred_at).getTime() : Date.now();
      marker._actData = {
        fid: item.id || "",
        title: item.title || "Incident",
        municipality: item.municipality || "",
        cat: cat,
        sev: sev,
        source_name: item.source_name || "",
        source_url: item.source_url || "",
        time: ta,
        timestamp: ts
      };

      // Click opens bottom sheet instead of InfoWindow
      marker.addListener("click", function () {
        var d = marker._actData;
        if (/^scanner\s*·/i.test(d.source_name)) d.title = cleanScannerTitle(d.title);
        openMapSheet(d);
      });

      _gmapMarkers.push(marker);
    });

    // Clustering
    if (window.markerClusterer && window.markerClusterer.MarkerClusterer) {
      _gmapClusterer = new markerClusterer.MarkerClusterer({
        map: map,
        markers: _gmapMarkers,
        renderer: {
          render: function (cluster) {
            var cnt = cluster.count;
            var size = cnt < 10 ? 40 : cnt < 30 ? 50 : 58;
            var fs = cnt < 10 ? 14 : cnt < 100 ? 13 : 11;
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
              '<circle cx="' + size/2 + '" cy="' + size/2 + '" r="' + (size/2) + '" fill="#6366f1" fill-opacity="0.15"/>' +
              '<circle cx="' + size/2 + '" cy="' + size/2 + '" r="' + (size/2 - 5) + '" fill="#6366f1" fill-opacity="0.9" stroke="white" stroke-width="2"/>' +
              '<text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" fill="white" font-size="' + fs + '" font-weight="700" font-family="system-ui">' + cnt + '</text></svg>';
            return new google.maps.Marker({
              position: cluster.position,
              icon: {
                url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
                scaledSize: new google.maps.Size(size, size),
                anchor: new google.maps.Point(size/2, size/2)
              },
              label: "",
              zIndex: 1000 + cnt
            });
          }
        }
      });
    } else {
      _gmapMarkers.forEach(function (m) { m.setMap(map); });
    }

    setMapStatus(count ? count + " incident" + (count === 1 ? "" : "s") : "");
  }

  function focusIncidentCard(id) {
    if (!id) return;
    switchView("feed");
    setTimeout(function () {
      var el = document.getElementById("feed-card-" + id);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 120);
  }
  window.ACTFocusIncident = focusIncidentCard;

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
    return document.getElementById("incidentListUnified") || document.getElementById("incidentListVerified") || document.getElementById("incidentListNow");
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
    if (m === "official" || m === "official_alerts") return "Official";
    if (m === "federal") return "Federal";
    if (m === "open_data") return "Official Open Data";
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
    var st = (r.source_type || "").toLowerCase();
    var v = (r.verification_level || "").toLowerCase();
    var sn = (r.source_name || "").toLowerCase();
    var isScanner = (st === "scanner" || v === "scanner" || sn.indexOf("scanner") !== -1);
    // Operational lift (commit landing this pass): scanner rows that the
    // backend marks is_actionable_live=true (shooting / pursuit / structure
    // fire / etc.) belong on Live; only non-actionable scanner chatter stays
    // in scanner_only. Backend sets the flag in
    // app/services/incident_repository._is_actionable_for_live; older API
    // responses missing the field fall through to the prior blanket
    // exclusion so legacy behavior is preserved.
    if (isScanner && r.is_actionable_live !== true) return "scanner_only";
    if (st === "open_data") return "verified";
    if (st === "official" || v === "official") return "official";
    if (v === "multi_source") return "verified";
    return "developing";
  }

  function _toFeedItemFromIncident(r) {
    var pub = r.published_at || r.occurred_at || "";
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
      // Backend-persisted multi-source provenance (commit da1a435). Element
      // shape: {name, url, agency_id?, first_seen_at}. Preferred over the
      // client-side _linked_sources clustering when present so the +N
      // sources pill reflects durable persisted data instead of recomputed
      // render-time grouping. Falls through to null when the row was
      // persisted before the column existed; the renderer falls back to
      // _linked_sources in that case.
      linked_sources: Array.isArray(r.sources) && r.sources.length
        ? r.sources
        : null,
      latitude: r.latitude,
      longitude: r.longitude,
      municipality: r.municipality || "",
      area_slug: r.area_slug || "",
      neighborhood: r.municipality || "",
      matched_location: r.address_text || "",
      confidence: typeof r.confidence_score === "number" ? r.confidence_score : 0,
      verification_level: r.verification_level || "unknown",
      verification_label: _verificationLabel(r.verification_level || ""),
      verification_explanation: r.verification_explanation || "",
      severity: r.severity || "unknown",
      _official_x_post: r._official_x_post === true,
      _x_incident_label: r._x_incident_label || "",
      // Canonical responding agency id, resolved at write time and
      // backfilled across legacy rows in commit f56a205. Used by the
      // v7 redesign to lead the Live card meta row with operational
      // attribution ("APD") rather than just the news outlet.
      responding_agency_id: r.responding_agency_id || null,
      // Operational-actionability flag stamped by the backend at
      // projection time. Tells _feedTabFromRecord whether a scanner row
      // is allowed onto Live or stays in scanner_only.
      is_actionable_live: r.is_actionable_live === true,
      source_type: r.source_type || "",
      source_type_label: _sourceTypeLabel(r.source_type || ""),
      source_type_explanation: r.source_type_explanation || "",
      crime_type: _crimeTypeFromIncidentType(r.incident_type || ""),
      coordinate_quality: r.coordinate_quality || "missing",
      coordinate_explanation: r.coordinate_explanation || "",
      human_time: r.human_time || "",
      priority_score: typeof r.priority_score === "number" ? r.priority_score : 0,
      is_high_priority: r.is_high_priority === true,
      is_trending: r.is_trending === true,
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
        feed_lane: feedTab
      }
    };
  }

  function homeWindowStartIso() {
    return new Date(Date.now() - HOME_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  }

  function fetchIncidents() {
    var myGen = ++_crimesFetchGeneration;
    var ctrl = new AbortController();
    var tid = setTimeout(function () {
      ctrl.abort();
    }, CRIMES_FETCH_MS);
    // Live tab requests sort_by=operational (commit landing this pass) so
    // the backend ranks actionable incidents first and the timeline
    // becomes incident-first instead of strictly chronological.
    var params = {
      limit: 500,
      sort_by: "newest",
      start_date: homeWindowStartIso()
    };
    (apiClient && apiClient.getPersistedIncidents
      ? apiClient.getPersistedIncidents(params)
      : fetch(
          API + "/api/incidents?limit=500&sort_by=newest&start_date=" + encodeURIComponent(params.start_date),
          { signal: ctrl.signal }
        ).then(ok))
      .finally(function () {
        clearTimeout(tid);
      })
      .then(function (r) {
        if (myGen !== _crimesFetchGeneration) return;
        if (!r || r.status !== "ok") throw new Error("incidents_api_invalid");
        var records = Array.isArray(r.incidents) ? r.incidents : [];
        var data = records.map(_toFeedItemFromIncident);
        allIncidentData = data;
        // Exclude scanner-only items from feed — they belong in the Scanner tab
        var feedData = data.filter(function (x) { return x.feed_tab !== "scanner_only"; });
        lastCrimeCounts.visible_feed_count = feedData.length;
        lastCrimeCounts.live_now_count = feedData.length;
        lastCrimeCounts.stats_total_incidents = feedData.length;
        lastLiveActiveItems = feedData;
        lastLiveRecentItems = [];

        renderUnifiedFeed(feedData);
        refreshHeaderPrimaryCount();
        markTopbarLiveIfStillConnecting();
        markFeedFreshNow();
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
            var feedData = data.filter(function (x) { return x.feed_tab !== "scanner_only"; });
            renderUnifiedFeed(feedData);
            markTopbarLiveIfStillConnecting();
            markFeedFreshNow();
          })
          .catch(function (fallbackErr) {
            console.error("Legacy incidents fallback error:", fallbackErr);
            markTopbarLiveIfStillConnecting();
            var liveL = getLiveFeedListEl();
            var errorHtml = '<div class="feed-error-state">' +
              '<span class="material-icons">cloud_off</span>' +
              '<p>Could not load incidents right now.</p>' +
              '<p style="font-size:11px;opacity:0.7">Check your connection or try again shortly.</p>' +
              '<button class="feed-error-retry" onclick="location.reload()">Retry</button>' +
              '</div>';
            if (liveL && !liveL.querySelector(".feed-item")) liveL.innerHTML = errorHtml;
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

  // ── BACKEND SEARCH ──────────────────────────────────────────
  var _searchAbort = null;
  function fetchSearchResults(query) {
    if (_searchAbort) _searchAbort.abort();
    _searchAbort = new AbortController();
    var container = document.getElementById("feedSearchResults");
    if (!container) return;
    fetch(API + "/api/search?q=" + encodeURIComponent(query) + "&limit=20", { signal: _searchAbort.signal })
      .then(ok)
      .then(function (r) {
        if (!r || r.status !== "ok") return;
        var results = r.results || [];
        if (!results.length) {
          container.innerHTML = '<div class="feed-search-count">No results for "' + esc(query) + '"</div>';
          container.hidden = false;
          return;
        }
        var html = '<div class="feed-search-count">' + results.length + ' result' + (results.length === 1 ? '' : 's') + ' for "' + esc(query) + '"</div>';
        results.forEach(function (item) {
          html += buildIncidentCard(item);
        });
        container.innerHTML = html;
        container.hidden = false;
        // Hide the regular feed list while searching
        var feedList = document.getElementById("incidentListUnified");
        if (feedList) feedList.style.display = "none";
      })
      .catch(function () {});
  }
  function hideSearchResults() {
    var container = document.getElementById("feedSearchResults");
    if (container) { container.innerHTML = ""; container.hidden = true; }
    var feedList = document.getElementById("incidentListUnified");
    if (feedList) feedList.style.display = "";
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

  /** Strip raw radio metadata (MHz, PL tone, "conventional frequency listing", etc.) from scanner text */
  function cleanScannerText(text) {
    if (!text) return "";
    // Remove patterns like "155.625 MHz · 118.8 PL · analog · Directory conventional frequency listing."
    var cleaned = text
      .replace(/\d+(\.\d+)?\s*MHz/gi, "")
      .replace(/\d+(\.\d+)?\s*PL\b/gi, "")
      .replace(/\b(analog|digital|P25|DMR|NXDN)\b/gi, "")
      .replace(/\bDirectory\s+(conventional|trunked)\s+frequency\s+listing\.?/gi, "")
      .replace(/\b(conventional|trunked)\s+frequency\s+listing\.?/gi, "")
      .replace(/·\s*·/g, "·")           // collapse double separators
      .replace(/^[\s·\-–—]+|[\s·\-–—]+$/g, "")  // trim leading/trailing separators
      .replace(/\s{2,}/g, " ")
      .trim();
    return cleaned;
  }

  /** Shorten verbose scanner titles: "SCANNER · Name / Long Description — Place: Long Desc (code)" → "Name" */
  function cleanScannerTitle(title) {
    if (!title) return "Scanner Activity";
    // Remove "SCANNER · " prefix
    var t = title.replace(/^SCANNER\s*·\s*/i, "");
    // Take the part before " — " or " / " (whichever is shorter/first)
    var dashIdx = t.indexOf(" \u2014 ");
    var slashIdx = t.indexOf(" / ");
    var cutIdx = -1;
    if (dashIdx > 0 && slashIdx > 0) cutIdx = Math.min(dashIdx, slashIdx);
    else if (dashIdx > 0) cutIdx = dashIdx;
    else if (slashIdx > 0) cutIdx = slashIdx;
    if (cutIdx > 0) t = t.substring(0, cutIdx);
    return t.trim() || "Scanner Activity";
  }

  function buildIncidentCard(item) {
    // Gap-fill / monitoring items render as an honest STATUS STRIP — clearly
    // not an incident — so the feed never looks like it's padding with fake
    // reports during quiet periods.
    if (item._gap_fill) {
      var gfText = item.description || item.summary || item.title || "Monitoring Albany County for new activity.";
      return '<div class="feed-status-strip">' +
        '<span class="feed-status-pulse"></span>' +
        '<span class="feed-status-text">' + esc(gfText) + '</span>' +
        '</div>';
    }

    var type = item.crime_type || "other";
    var sourceName = item.source || item.source_name || "Unknown source";
    var verify = item.verification_level || "unknown";
    var title = item.short_title || item.title || "Untitled";
    var ta = item.pubDate ? feedAgeCompact(item) : (item.human_time || "");
    if (!ta && item.human_time) ta = item.human_time;
    var area = _resolveDisplayMunicipality(item);
    var summary = item.summary || item.description || "";
    var sev = (item.severity || "unknown").toLowerCase();
    var isScanner = isScannerCrimeSource(sourceName);

    if (isScanner) {
      title = cleanScannerTitle(title);
      summary = cleanScannerText(summary);
      sourceName = "Scanner";
      if (!summary) {
        var rawTitle = (item.title || "").toLowerCase();
        if (/\b(dispatch|e911|911)\b/.test(rawTitle)) {
          if (/\bfire\b/i.test(rawTitle)) summary = "Fire dispatch activity";
          else if (/\bems|ambulance|medic/i.test(rawTitle)) summary = "EMS dispatch activity";
          else summary = "Emergency dispatch activity";
        } else if (/\bnysp|state\s*police|troop/i.test(rawTitle)) summary = "NYSP Troop G activity";
        else if (/\bapd|albany\s*p/i.test(rawTitle)) summary = "APD activity";
        else if (/\bsheriff|acso/i.test(rawTitle)) summary = "ACSO activity";
        else if (/\bfire/i.test(rawTitle)) summary = "Fire department activity";
        else summary = "Law enforcement activity";
      }
      if (verify === "scanner") verify = "developing";
    }

    // Determine department/agency
    var agencyDisplay = _agencyDisplayName(item.responding_agency_id);
    var dept = agencyDisplay || _deptFromSource(sourceName, item);

    // Report type label (police tracker style)
    var reportType = _reportTypeLabel(type, sev, item);

    var ageH = itemAgeHours(item);
    var isLive = ageH !== null && ageH <= 2 && (sev === "critical" || sev === "high");
    var isFresh = ageH !== null && ageH <= 1;
    var isGapFill = item._gap_fill;

    var cls = "feed-item feed-item--" + type;
    if (isLive) cls += " feed-item--live";
    if (sev === "critical") cls += " feed-item--sev-critical";
    else if (sev === "high") cls += " feed-item--sev-high";
    if (isGapFill) cls += " feed-item--pulse";
    if (ageH !== null && ageH > 12) cls += " feed-item--aged";

    var cardId = item.id || ("item_" + Math.random().toString(36).slice(2, 8));
    var html = '<div class="' + cls + '" data-incident-id="' + escAttr(cardId) + '" role="button" tabindex="0">';

    // Severity strip (left border set by CSS class)
    html += '<div class="feed-indicator">';
    if (isLive) html += '<span class="feed-live-dot"></span>';
    else html += '<span class="feed-dot ' + esc(type) + '"></span>';
    html += '</div>';

    html += '<div class="feed-body">';

    // Row 1: Report type + LIVE badge + time
    html += '<div class="feed-head-row">';
    html += '<span class="feed-report-type feed-report-type--' + esc(sev) + '">' + esc(reportType) + '</span>';
    if (isLive) html += '<span class="feed-live-badge"><span class="feed-live-dot-sm"></span>ACTIVE</span>';
    html += '<span class="feed-time' + (isFresh ? ' feed-time--fresh' : '') + '">';
    if (isFresh) html += '<span class="feed-time-dot"></span>';
    html += esc(ta || "") + '</span>';
    html += '</div>';

    // Row 2: Title/description
    html += '<div class="feed-title">' + esc(title) + '</div>';

    // Row 3: Structured metadata — Location · Department · Source
    html += '<div class="feed-meta">';
    html += '<span class="feed-meta-pill feed-meta-pill--area"><span class="material-icons feed-meta-icon">place</span>' + esc(area) + '</span>';
    if (dept) {
      html += '<span class="feed-meta-pill feed-meta-pill--agency"><span class="material-icons feed-meta-icon">shield</span>' + esc(dept) + '</span>';
    }
    var srcLogo = isGapFill ? "" : _sourceLogoUrl(sourceName, item.source_url || item.link || "");
    var srcPill = '<span class="feed-meta-pill feed-meta-pill--source">';
    if (srcLogo) {
      srcPill += '<img class="feed-src-logo" src="' + escAttr(srcLogo) + '" alt="" loading="lazy" onerror="this.remove()">';
    }
    srcPill += esc(sourceName) + '</span>';
    html += srcPill;
    var linked = (Array.isArray(item.linked_sources) && item.linked_sources.length)
      ? item.linked_sources
      : (Array.isArray(item._linked_sources) ? item._linked_sources : null);
    if (linked && linked.length > 1) {
      html += '<span class="feed-meta-pill feed-meta-pill--corroborated">+' + (linked.length - 1) + ' sources</span>';
    }
    html += '</div>';

    html += '</div></div>';
    return html;
  }

  function _reportTypeLabel(type, sev, item) {
    if (item && item._x_incident_label) return item._x_incident_label;
    var cat = (item.category || item._nysp_incident_category || "").toLowerCase();
    if (item._gap_fill) return "Monitoring";
    if (sev === "critical") return "CRITICAL INCIDENT";
    if (/\bshoot|shots fired|gunfire/i.test(cat) || /\bshoot|shots fired|gunfire/i.test(item.title || "")) return "Shooting";
    if (/\bstab/i.test(cat) || /\bstab/i.test(item.title || "")) return "Stabbing";
    if (/\bassault/i.test(cat)) return "Assault";
    if (/\brobbery/i.test(cat)) return "Robbery";
    if (/\bburglary/i.test(cat)) return "Burglary";
    if (/\barrest/i.test(cat) || /\barrest/i.test(item.title || "")) return "Arrest";
    if (/\bcrash|mva|accident|collision/i.test(cat) || /\bcrash/i.test(item.title || "")) return "Crash";
    if (/\bfire/i.test(cat) || (/\bfire/i.test(item.title || "") && !/\bfired\b/i.test(item.title || ""))) return "Fire";
    if (/\bmissing/i.test(cat)) return "Missing Person";
    if (/\bpursuit|chase/i.test(cat)) return "Pursuit";
    if (/\bdwi|dui/i.test(cat)) return "DWI Arrest";
    if (type === "violent") return "Violent Crime";
    if (type === "property") return "Property Crime";
    if (type === "traffic") return "Traffic Incident";
    if (sev === "high") return "Major Incident";
    return "Police Activity";
  }

  function _resolveDisplayMunicipality(item) {
    var raw = item.municipality || item.matched_location || "";
    if (!raw) return "Albany County";
    var lower = raw.toLowerCase().trim();
    // "Albany" alone is ambiguous — resolve to "City of Albany"
    if (lower === "albany") return "City of Albany";
    // Already specific
    if (lower === "city of albany") return "City of Albany";
    if (lower === "albany county") return "Albany County";
    // Capitalize properly
    return raw;
  }

  function _deptFromSource(sourceName, item) {
    var s = (sourceName || "").toLowerCase();
    if (/albany\s*police|apd|@albanypolice/i.test(s)) return "Albany PD";
    if (/sheriff|acso/i.test(s)) return "Albany Co. Sheriff";
    if (/colonie/i.test(s)) return "Colonie PD";
    if (/bethlehem/i.test(s)) return "Bethlehem PD";
    if (/guilderland/i.test(s)) return "Guilderland PD";
    if (/nysp|state\s*police|troop/i.test(s)) return "NYSP Troop G";
    if (/watervliet/i.test(s)) return "Watervliet PD";
    if (/cohoes/i.test(s)) return "Cohoes PD";
    if (item._nysp_troop_zone) return "NYSP Troop G";
    if (/nixle/i.test(s)) return "Public Safety Alert";
    return "";
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
    // Text search (legacy — search bar removed but query still used if set programmatically)
    if (feedSearchQuery) {
      var needle = (feedSearchQuery || "").toLowerCase();
      var blob = [
        item && item.title,
        item && item.summary,
        item && item.description,
        item && item.source,
        item && item.municipality,
        item && item.matched_location
      ].join(" ").toLowerCase();
      if (blob.indexOf(needle) === -1) return false;
    }

    // Quick-filter chip (activity-by-area strip)
    if (_activeChipFilter && _activeChipFilter !== "all") {
      if (_activeChipFilter === "high") {
        var sev = ((item && item.severity) || "").toLowerCase();
        if (sev !== "critical" && sev !== "high") return false;
      } else {
        var slug = _itemAreaSlug(item);
        if (slug !== _activeChipFilter) return false;
      }
    }

    // Sheet filters (severity + municipality checkboxes)
    var sf = getSheetFilters();
    if (sf.severities.length < 4) { // not all checked
      var itemSev = ((item && item.severity) || "low").toLowerCase();
      if (sf.severities.indexOf(itemSev) === -1) return false;
    }
    if (sf.municipalities.length > 0 && sf.municipalities.length < 14) { // not all checked
      var itemMuni = ((item && (item.municipality || item.matched_location)) || "albany county").toLowerCase();
      var muniMatch = sf.municipalities.some(function (m) { return itemMuni.indexOf(m) !== -1; });
      if (!muniMatch) return false;
    }

    return true;
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

  function feedSortRankPriority(item) {
    var p = Number(item && item.priority_score);
    if (!isNaN(p)) return p;
    return feedSortRankSeverity(item) * 10 + feedSortRankVerification(item) * 6;
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
    } else if (feedSortMode === "priority") {
      filtered.sort(function (a, b) {
        var dp = feedSortRankPriority(b) - feedSortRankPriority(a);
        if (dp !== 0) return dp;
        var ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        var tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return tb - ta;
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

  // Home live feed must never re-show scanner-tab-only rows. fetchIncidents() filters
  // these out, but filter chips / sheet re-render used allIncidentData (unfiltered),
  // which brought scanner directory / conventional-frequency cards back into the list.
  var _BAD_SOURCES_RE = /\b(kezi|kval|kmtr|walb|wfxl)\b/i;

  function _homeFeedExcludeScannerOnly(items) {
    return (items || []).filter(function (x) {
      if (x.feed_tab === "scanner_only") return false;
      if (x._gap_fill) return true;
      var src = (x.source || x.source_name || "").toLowerCase();
      // Only block confirmed wrong-state TV stations
      if (_BAD_SOURCES_RE.test(src)) return false;
      return true;
    });
  }

  // ── Unified feed renderer ─────────────────────────────────────
  // Single chronological list with time-based section headers.
  // Visual hierarchy is built into each card (severity, source pills, freshness).

  // Stopwords excluded from title-token matching. Short function words
  // shouldn't be what anchors a match; crime nouns (crash, shooting, fire)
  // deliberately stay in the token set since they're the real signal.
  var _LIVE_CLUSTER_STOPWORDS = {
    "the":1,"a":1,"an":1,"and":1,"or":1,"but":1,"of":1,"in":1,"on":1,"at":1,
    "to":1,"for":1,"with":1,"by":1,"from":1,"as":1,"is":1,"are":1,"was":1,
    "were":1,"be":1,"been":1,"has":1,"have":1,"had":1,"it":1,"its":1,
    "this":1,"that":1,"these":1,"those":1,"into":1,"near":1,"over":1,
    "after":1,"before":1,"during":1,"says":1,"say":1,"said":1,"told":1,
    "new":1,"york":1,"ny":1,"county":1,"area":1
  };

  function _liveClusterTokens(title) {
    var raw = String(title || "").toLowerCase();
    // Strip punctuation and decorative dashes so tokens align across sources.
    raw = raw.replace(/[\[\](){}"'`\u2018\u2019\u201c\u201d]/g, " ")
             .replace(/[—\-–:,.!?;]/g, " ")
             .replace(/\s+/g, " ")
             .trim();
    var toks = raw.split(" ");
    var out = {};
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (!t || t.length < 4) continue;
      if (_LIVE_CLUSTER_STOPWORDS[t]) continue;
      out[t] = 1;
    }
    return out;
  }

  function _liveClusterJaccard(a, b) {
    var inter = 0, uni = 0;
    var seen = {};
    for (var k in a) { seen[k] = 1; if (b[k]) inter++; }
    for (var k2 in b) { seen[k2] = 1; }
    for (var k3 in seen) uni++;
    if (!uni) return 0;
    return inter / uni;
  }

  // Overlap coefficient: |A∩B| / min(|A|, |B|). Complements Jaccard —
  // catches short paraphrased headlines that share most of their meaningful
  // tokens but have a few unique words each (e.g. "car crash in Coeymans
  // injures two" vs "Coeymans car crash kills one").
  function _liveClusterOverlap(a, b) {
    var inter = 0, sizeA = 0, sizeB = 0;
    for (var k in a) { sizeA++; if (b[k]) inter++; }
    for (var k2 in b) { sizeB++; }
    var m = sizeA < sizeB ? sizeA : sizeB;
    if (!m) return 0;
    return inter / m;
  }

  // Two items describe the same event when all three agree:
  //   - same municipality (or one side missing — permissive),
  //   - published within 6 hours of each other,
  //   - tokenized-title Jaccard >= 0.55, OR one title fully contains the other
  //     (substring coverage catches "Car crash in Coeymans" vs
  //     "Car crash in Coeymans kills one").
  // Anything weaker stays as its own card. No distinct-incident merging.
  var _LIVE_CLUSTER_JACCARD_MIN = 0.50;
  // Overlap coefficient — only used when municipality already matches (and
  // is non-empty on both sides). Prevents short paraphrases of the same
  // event from slipping past Jaccard when they have similar unique words.
  var _LIVE_CLUSTER_OVERLAP_MIN = 0.66;
  var _LIVE_CLUSTER_OVERLAP_MIN_TOKENS = 2;
  var _LIVE_CLUSTER_MAX_GAP_MS = 6 * 60 * 60 * 1000;

  // Populous Albany County municipalities — strict token similarity required.
  // Smaller munis use a relaxed "same muni + within 4h + share 2 substantive
  // tokens" rule because two distinct newsworthy crime events in the same
  // small town within four hours is rare enough that the precision/recall
  // tradeoff favors merging. Lowercase, no punctuation.
  var _LIVE_CLUSTER_POPULOUS_MUNIS = {
    "albany": 1, "colonie": 1, "bethlehem": 1,
    "guilderland": 1, "cohoes": 1
  };
  var _LIVE_CLUSTER_SMALL_MUNI_GAP_MS = 4 * 60 * 60 * 1000;
  var _LIVE_CLUSTER_SMALL_MUNI_MIN_TOK_LEN = 5;
  var _LIVE_CLUSTER_SMALL_MUNI_MIN_SHARED = 2;

  function _liveClusterSameEvent(a, b) {
    var idA = String(a.id || "");
    var idB = String(b.id || "");
    // Distinct NYSP blotter rows share generic titles ("Property check — Albany")
    // but are separate incidents — never collapse them on the client.
    if (idA.startsWith("nysp_") && idB.startsWith("nysp_") && idA !== idB) return false;

    var muniA = String(a.municipality || a.matched_location || "").toLowerCase().trim();
    var muniB = String(b.municipality || b.matched_location || "").toLowerCase().trim();
    if (muniA && muniB && muniA !== muniB) return false;

    var tA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    var tB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    if (tA && tB && Math.abs(tA - tB) > _LIVE_CLUSTER_MAX_GAP_MS) return false;

    var titleA = String(a.short_title || a.title || "").toLowerCase().trim();
    var titleB = String(b.short_title || b.title || "").toLowerCase().trim();
    if (!titleA || !titleB) return false;

    if (titleA === titleB) return true;
    // Substring coverage: only qualifies when the shorter title is >= 12 chars
    // so generic prefixes don't sweep up unrelated events.
    var shorter = titleA.length <= titleB.length ? titleA : titleB;
    var longer  = titleA.length <= titleB.length ? titleB : titleA;
    if (shorter.length >= 12 && longer.indexOf(shorter) !== -1) return true;

    if (!a._cluster_tokens) a._cluster_tokens = _liveClusterTokens(titleA);
    if (!b._cluster_tokens) b._cluster_tokens = _liveClusterTokens(titleB);
    var jac = _liveClusterJaccard(a._cluster_tokens, b._cluster_tokens);
    if (jac >= _LIVE_CLUSTER_JACCARD_MIN) return true;

    // Overlap-coefficient fallback, gated on non-empty matching municipality
    // and a minimum token count so short generic headlines don't sweep.
    if (muniA && muniB && muniA === muniB) {
      var ov = _liveClusterOverlap(a._cluster_tokens, b._cluster_tokens);
      var minTokens = Math.min(
        Object.keys(a._cluster_tokens).length,
        Object.keys(b._cluster_tokens).length
      );
      if (ov >= _LIVE_CLUSTER_OVERLAP_MIN && minTokens >= _LIVE_CLUSTER_OVERLAP_MIN_TOKENS) {
        return true;
      }

      // Small-municipality relaxed path. The Coeymans case showed three
      // semantically-identical reports with totally different wording —
      // token similarity could not bridge them. In small towns (population
      // ~< 15K), two unrelated newsworthy events in a 4-hour window is
      // genuinely rare, so we accept a weaker title signal: 2+ shared
      // tokens of length >= 5 (which excludes generic 3-4 char fillers).
      if (!_LIVE_CLUSTER_POPULOUS_MUNIS[muniA]
          && tA && tB
          && Math.abs(tA - tB) <= _LIVE_CLUSTER_SMALL_MUNI_GAP_MS) {
        var shared = 0;
        for (var tok in a._cluster_tokens) {
          if (tok.length >= _LIVE_CLUSTER_SMALL_MUNI_MIN_TOK_LEN && b._cluster_tokens[tok]) {
            shared++;
          }
        }
        if (shared >= _LIVE_CLUSTER_SMALL_MUNI_MIN_SHARED) return true;
      }
    }
    return false;
  }

  function _liveClusterPushSource(leader, item) {
    if (!leader._linked_sources) {
      leader._linked_sources = [{
        name: leader.source_name || leader.source || "Unknown",
        url: leader.source_url || leader.link || "",
      }];
    }
    var name = item.source_name || item.source || "Unknown";
    var url = item.source_url || item.link || "";
    // De-dupe by URL (preferred) or name.
    var already = leader._linked_sources.some(function (s) {
      return (url && s.url === url) || (!url && s.name === name);
    });
    if (!already) leader._linked_sources.push({ name: name, url: url });
  }

  // Cluster near-duplicate Live items into a single leader card with an
  // attached _linked_sources list. Replaces the earlier title+bucket equality
  // dedupe that missed paraphrased headlines for the same event.
  function _dedupeLiveItems(items) {
    var clusters = [];
    (items || []).forEach(function (item) {
      if (!item) return;
      var matched = null;
      for (var i = 0; i < clusters.length; i++) {
        if (_liveClusterSameEvent(clusters[i], item)) { matched = clusters[i]; break; }
      }
      if (!matched) {
        clusters.push(item);
        return;
      }
      var leaderT = matched.pubDate ? new Date(matched.pubDate).getTime() : 0;
      var itemT   = item.pubDate    ? new Date(item.pubDate).getTime()    : 0;
      if (itemT > leaderT) {
        // Promote the fresher report to cluster leader but carry forward the
        // source list from the previous leader so we never lose provenance.
        var carry = matched._linked_sources;
        _liveClusterPushSource(item, matched);
        if (carry) {
          carry.forEach(function (s) {
            var exists = item._linked_sources.some(function (x) {
              return (s.url && x.url === s.url) || (!s.url && x.name === s.name);
            });
            if (!exists) item._linked_sources.push(s);
          });
        }
        var idx = clusters.indexOf(matched);
        if (idx >= 0) clusters[idx] = item;
      } else {
        _liveClusterPushSource(matched, item);
      }
    });
    return clusters;
  }

  // Render an honest freshness banner above the feed: "Newest item: 3 min ago".
  // If newest is >30 min old we say so plainly rather than hiding it, because
  // the product is a live tracker — silent lag would undermine trust.
  function renderLiveFreshness(items) {
    var el = document.getElementById("liveFreshness");
    if (!el) return;
    if (!items || !items.length) { el.hidden = true; el.innerHTML = ""; return; }
    var newestMs = 0;
    items.forEach(function (x) {
      var t = x && x.pubDate ? new Date(x.pubDate).getTime() : 0;
      if (t > newestMs) newestMs = t;
    });
    if (!newestMs) { el.hidden = true; el.innerHTML = ""; return; }
    var mins = Math.max(0, Math.round((Date.now() - newestMs) / 60000));
    var tone = "fresh";
    if (mins >= 60) tone = "stale";
    else if (mins >= 15) tone = "aging";
    var ageText = mins < 1 ? "just now" :
                  mins === 1 ? "1 min ago" :
                  mins < 60 ? mins + " min ago" :
                  Math.round(mins / 60) + " hr ago";
    el.innerHTML =
      '<span class="live-freshness-dot live-freshness-dot--' + tone + '"></span>' +
      '<span class="live-freshness-label">Newest incident</span>' +
      '<span class="live-freshness-value">' + ageText + '</span>' +
      '<span class="live-freshness-count">' + items.length + ' tracked</span>';
    el.className = "live-freshness live-freshness--" + tone;
    el.hidden = false;
  }

  function renderUnifiedFeed(allItems) {
    var list = getLiveFeedListEl();
    if (!list) return;
    var items = applyFeedUiFilters(_homeFeedExcludeScannerOnly(allItems));
    items = _dedupeLiveItems(items);
    if (!items.length) {
      list.innerHTML = '<div class="empty-state"><span class="material-icons" style="font-size:32px;opacity:0.4">shield</span><p>No incidents in this window.</p></div>';
      renderLiveFreshness([]);
      return;
    }

    // Sort newest first
    items.sort(function (a, b) {
      var ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      var tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });

    renderLiveFreshness(items);

    var html = "";
    items.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
    _bindIncidentCardClicks(list, items);
  }

  // ── INCIDENT DETAIL SHEET ─────────────────────────────────────────────
  var _incidentDetailItems = [];

  function _bindIncidentCardClicks(container, items) {
    _incidentDetailItems = items;
    container.querySelectorAll(".feed-item[data-incident-id]").forEach(function (card, idx) {
      card.addEventListener("click", function (e) {
        e.preventDefault();
        if (idx < items.length) openIncidentDetail(items[idx]);
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (idx < items.length) openIncidentDetail(items[idx]);
        }
      });
    });
  }

  function openIncidentDetail(item) {
    var sheet = document.getElementById("incidentSheet");
    var backdrop = document.getElementById("incidentSheetBackdrop");
    if (!sheet || !backdrop) return;

    var type = item.crime_type || "other";
    var sev = (item.severity || "medium").toLowerCase();
    var title = item.short_title || item.title || "Incident";
    var area = _resolveDisplayMunicipality(item);
    var sourceName = item.source || item.source_name || "";
    var desc = item.description || item.summary || "";
    var ta = item.pubDate ? feedAgeCompact(item) : (item.human_time || "");
    if (!ta && item.human_time) ta = item.human_time;
    var link = resolveIncidentCardHref(item);
    var reportType = _reportTypeLabel(type, sev, item);
    var dept = _agencyDisplayName(item.responding_agency_id) || _deptFromSource(sourceName, item);

    // Populate header
    var typeEl = document.getElementById("incidentSheetType");
    var sevEl = document.getElementById("incidentSheetSev");
    if (typeEl) typeEl.textContent = reportType;
    if (sevEl) {
      sevEl.textContent = sev.charAt(0).toUpperCase() + sev.slice(1);
      sevEl.className = "incident-sheet-sev incident-sheet-sev--" + sev;
    }

    // Title
    var titleEl = document.getElementById("incidentSheetTitle");
    if (titleEl) titleEl.textContent = title;

    // Structured meta
    var metaEl = document.getElementById("incidentSheetMeta");
    if (metaEl) {
      var metaHtml = '<div class="incident-sheet-meta-row">';
      metaHtml += '<span class="incident-sheet-meta-item"><span class="material-icons">place</span>' + esc(area) + '</span>';
      metaHtml += '<span class="incident-sheet-meta-item"><span class="material-icons">schedule</span>' + esc(ta || "Unknown time") + '</span>';
      if (dept) metaHtml += '<span class="incident-sheet-meta-item"><span class="material-icons">shield</span>' + esc(dept) + '</span>';
      metaHtml += '</div>';
      if (item.pubDate) {
        var dt = new Date(item.pubDate);
        if (!isNaN(dt.getTime())) {
          metaHtml += '<div class="incident-sheet-datetime">' + dt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + '</div>';
        }
      }
      metaEl.innerHTML = metaHtml;
    }

    // Description
    var descEl = document.getElementById("incidentSheetDesc");
    if (descEl) descEl.textContent = desc || "No additional details available.";

    // Sources and links
    var srcEl = document.getElementById("incidentSheetSources");
    if (srcEl) {
      var srcHtml = '<h4 class="incident-sheet-section-label">Sources</h4>';
      if (sourceName) {
        srcHtml += '<div class="incident-sheet-source-item">';
        srcHtml += '<span class="material-icons">article</span>';
        srcHtml += '<span>' + esc(sourceName) + '</span>';
        srcHtml += '</div>';
      }
      var linked = (Array.isArray(item.linked_sources) && item.linked_sources.length)
        ? item.linked_sources : [];
      linked.forEach(function (s) {
        if (!s.name) return;
        srcHtml += '<div class="incident-sheet-source-item">';
        srcHtml += '<span class="material-icons">link</span>';
        srcHtml += '<span>' + esc(s.name) + '</span>';
        srcHtml += '</div>';
      });
      srcEl.innerHTML = srcHtml;
    }

    // Action buttons
    var actEl = document.getElementById("incidentSheetActions");
    if (actEl) {
      var actHtml = '';
      if (link && link !== "#") {
        actHtml += '<a href="' + escAttr(link) + '" target="_blank" rel="noopener noreferrer" class="incident-sheet-btn incident-sheet-btn--primary">';
        actHtml += '<span class="material-icons">open_in_new</span>View source article</a>';
      }
      if (item.lat && item.lon) {
        actHtml += '<button type="button" class="incident-sheet-btn" onclick="switchView(\'map\');closeIncidentSheet();">';
        actHtml += '<span class="material-icons">map</span>Show on map</button>';
      }
      actEl.innerHTML = actHtml;
    }

    // Show
    sheet.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(function () {
      sheet.classList.add("incident-sheet--open");
      backdrop.classList.add("incident-sheet-backdrop--open");
    });
    backdrop.onclick = closeIncidentSheet;
  }

  function closeIncidentSheet() {
    var sheet = document.getElementById("incidentSheet");
    var backdrop = document.getElementById("incidentSheetBackdrop");
    if (sheet) sheet.classList.remove("incident-sheet--open");
    if (backdrop) backdrop.classList.remove("incident-sheet-backdrop--open");
    setTimeout(function () {
      if (sheet) sheet.hidden = true;
      if (backdrop) backdrop.hidden = true;
    }, 250);
  }
  // Expose globally for inline onclick
  window.closeIncidentSheet = closeIncidentSheet;

  // Backward compat wrappers — all feed rendering goes through unified
  function renderLiveFeed(activeItems, recentItems) {
    renderUnifiedFeed((activeItems || []).concat(recentItems || []));
  }

  function renderTrendsMapLane(items) {
    var card = document.getElementById("trendsMapLaneCard");
    var list = document.getElementById("incidentListTrendsmap");
    if (card) {
      card.innerHTML =
        '<div class="nac-body">' +
        '<div class="nac-briefing">Trend lane: use map + summaries for pattern awareness. Coordinate precision is explicit (exact / approximate / missing).</div>' +
        '<div style="margin-top:8px;"><button type="button" class="link-btn" onclick="switchView(\'map\')">Open Map</button></div>' +
        '</div>';
    }
    if (!list) return;
    var sorted = applyFeedUiFilters((items || []).slice(0, 30));
    if (!sorted.length) {
      list.innerHTML = '<div class="empty-state">No trend-support incidents available.</div>';
      return;
    }
    var html = "";
    sorted.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  function renderIncidentList(data) {
    if (!data) return;
    // Exclude scanner-only items from feed — they belong in the Scanner tab
    var feedData = data.filter(function (x) { return x.feed_tab !== "scanner_only"; });
    renderUnifiedFeed(feedData);
    renderTrendsMapLane(feedData);
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
    if (item.url) {
      html += '<a class="social-intel-link" href="' + esc(item.url) + '" target="_blank" rel="noopener">View on X</a>';
    }
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
          bubble.innerHTML = renderMarkdown(fullText) + '<span class="streaming-cursor"></span>';
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

  function fetchMethodologyPanel() {
    var req = apiClient && apiClient.getMethodology
      ? apiClient.getMethodology()
      : fetch(API + "/api/methodology").then(ok);
    req.then(function (r) {
      renderMethodologyPanel(r && r.methodology, r && r.planned_hooks);
    }).catch(function () {
      renderMethodologyPanel(null, null);
    });
  }

  function renderMethodologyPanel(methodology, hooks) {
    var panel = document.getElementById("methodologyPanel");
    if (!panel) return;
    if (!methodology) {
      panel.innerHTML = '<div class="placeholder-text">Methodology details unavailable.</div>';
      return;
    }
    var html = "";
    html += '<div class="pattern-card"><div class="pattern-card-header">Lane model</div><div class="pattern-text">' +
      esc((methodology.lane_model || []).join(" · ")) + "</div></div>";
    html += '<div class="pattern-card"><div class="pattern-card-header">Trust model</div><div class="pattern-text">';
    html += 'Official = highest trust · Scanner = early signal only · Media = corroboration/enrichment · Inferred = preliminary';
    html += "</div></div>";
    html += '<div class="pattern-card"><div class="pattern-card-header">Coordinate precision</div><div class="pattern-text">';
    html += 'Exact / Approximate / Missing are explicitly shown on cards and map popups.';
    html += "</div></div>";
    if (Array.isArray(hooks) && hooks.length) {
      html += '<div class="pattern-card"><div class="pattern-card-header">Planned source hooks</div><div class="pattern-text">';
      html += esc(hooks.slice(0, 12).map(function (h) { return h.label; }).join(" · "));
      html += "</div></div>";
    }
    panel.innerHTML = html;
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
  // ── OpenMHz Socket.IO real-time connection ───────────────────
  var _omhzSocket = null;
  var _omhzConnected = false;
  var _omhzRealtimeCalls = [];  // buffer of calls received via Socket.IO

  function initOpenMhzRealtime() {
    // Load Socket.IO client if not already present
    if (window.io) { _connectOpenMhz(); return; }
    var s = document.createElement("script");
    s.src = "https://cdn.socket.io/4.7.4/socket.io.min.js";
    s.onload = _connectOpenMhz;
    s.onerror = function () { console.warn("Socket.IO CDN failed, using polling only"); };
    document.head.appendChild(s);
  }

  function _connectOpenMhz() {
    if (_omhzSocket || !window.io) return;
    try {
      _omhzSocket = io("https://api.openmhz.com", {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 5000,
        reconnectionAttempts: 10,
        query: { system: "albanycony" }
      });

      _omhzSocket.on("connect", function () {
        _omhzConnected = true;
        console.log("[Scanner] OpenMHz real-time connected");
        // Subscribe to Albany County system
        _omhzSocket.emit("scan", { system: "albanycony" });
      });

      _omhzSocket.on("new call", function (call) {
        if (!call) return;
        // Normalize to our standard format
        var audioUrl = call.url || "";
        var tgNum = String(call.talkgroup || "");
        if (!tgNum) {
          var m = audioUrl.match(/\/(\d{4,6})\//);
          if (m) tgNum = m[1];
        }
        var normalized = {
          id: "omhz_rt_" + (call._id || Date.now()),
          time: call.time || new Date().toISOString(),
          talkgroup_num: tgNum,
          talkgroup_tag: call.talkgroup_tag || call.talkgroupTag || "",
          talkgroup_description: call.talkgroup_description || call.talkgroupDescription || "",
          audio_url: audioUrl,
          duration: call.len || call.duration || 0,
          freq: call.freq || 0,
          source: "openmhz_realtime"
        };

        // Add to buffer and merge with existing calls
        _omhzRealtimeCalls.unshift(normalized);
        if (_omhzRealtimeCalls.length > 20) _omhzRealtimeCalls.length = 20;

        // If we have existing calls, merge the new one in and re-render
        if (lastScannerCallsRef.length) {
          var merged = [normalized].concat(lastScannerCallsRef.filter(function (c) {
            return c.id !== normalized.id;
          }));
          processAndRenderScanner(merged);
        }
      });

      _omhzSocket.on("disconnect", function () {
        _omhzConnected = false;
        console.log("[Scanner] OpenMHz real-time disconnected");
      });

      _omhzSocket.on("connect_error", function (err) {
        console.warn("[Scanner] OpenMHz Socket.IO error:", err.message);
      });
    } catch (e) {
      console.warn("[Scanner] Socket.IO init error:", e);
    }
  }

  // ── SCANNER CHANNEL PRESETS ─────────────────────────────────
  // _activeScannerChannel = null means "all channels" (no filter).
  // When set to a channel_id from /api/scanner/channels, fetchScannerCalls()
  // appends ?channel=<id> so the backend returns only calls whose
  // talkgroup belongs to that channel.
  var _activeScannerChannel = null;
  var _scannerChannelsCache = null;

  function fetchScannerChannels() {
    if (_scannerChannelsCache) return Promise.resolve(_scannerChannelsCache);
    return fetch(API + "/api/scanner/channels").then(ok)
      .then(function (data) {
        if (!data || data.status !== "ok") return null;
        _scannerChannelsCache = data;
        return data;
      })
      .catch(function () { return null; });
  }

  function _scannerChannelLabel(channelId) {
    if (!_scannerChannelsCache) return "";
    var found = (_scannerChannelsCache.channels || []).find(function (c) {
      return c.channel_id === channelId;
    });
    return found ? (found.label || "") : "";
  }

  function initScannerChannelChips() {
    var host = document.getElementById("scannerChannelChips");
    if (!host) return;
    fetchScannerChannels().then(function (data) {
      if (!data || !Array.isArray(data.channels) || !data.channels.length) return;
      // Sort: high priority first, then medium, then low. Within a tier,
      // preserve registry order so channels feel stable across page loads.
      var rank = { high: 0, medium: 1, low: 2 };
      var sorted = data.channels.slice().sort(function (a, b) {
        var ra = rank[a.priority] != null ? rank[a.priority] : 3;
        var rb = rank[b.priority] != null ? rank[b.priority] : 3;
        return ra - rb;
      });
      var html = '<button type="button" class="sc-channel-chip'
               + (_activeScannerChannel == null ? " active" : "")
               + '" data-scanner-channel="" role="tab" aria-selected="'
               + (_activeScannerChannel == null ? "true" : "false")
               + '">All channels</button>';
      sorted.forEach(function (c) {
        var isActive = (_activeScannerChannel === c.channel_id);
        html += '<button type="button" class="sc-channel-chip'
              + (isActive ? " active" : "")
              + '" data-scanner-channel="' + escAttr(c.channel_id)
              + '" data-scanner-channel-priority="' + escAttr(c.priority || "")
              + '" role="tab" aria-selected="' + (isActive ? "true" : "false")
              + '" title="' + escAttr((c.disciplines || []).join(", ") + " · " + (c.region || ""))
              + '">' + esc(c.label) + '</button>';
      });
      host.innerHTML = html;
      // Click handler — single delegated listener so we don't re-bind
      // on every render.
      if (!host._actChannelBound) {
        host.addEventListener("click", function (e) {
          var btn = e.target.closest && e.target.closest("[data-scanner-channel]");
          if (!btn || !host.contains(btn)) return;
          var raw = btn.getAttribute("data-scanner-channel") || "";
          _activeScannerChannel = raw || null;
          // Re-render chip active states.
          host.querySelectorAll("[data-scanner-channel]").forEach(function (b) {
            var active = (b === btn);
            b.classList.toggle("active", active);
            b.setAttribute("aria-selected", active ? "true" : "false");
          });
          fetchScannerCalls();
        });
        host._actChannelBound = true;
      }
    });
  }

  function fetchScannerCalls() {
    var url = API + "/api/scanner/calls"
            + (_activeScannerChannel ? "?channel=" + encodeURIComponent(_activeScannerChannel) : "");
    var req = (_activeScannerChannel || !apiClient)
      ? fetch(url).then(ok)
      : apiClient.getScannerCalls();
    req.then(function (data) {
        var calls = (data && data.calls && data.calls.length > 0) ? data.calls : [];
        var sourcesUsed = data && data.sources_used ? data.sources_used : [];

        // Merge any real-time Socket.IO calls we've received
        if (_omhzRealtimeCalls.length) {
          var existingIds = {};
          calls.forEach(function (c) { existingIds[c.id] = true; });
          _omhzRealtimeCalls.forEach(function (rt) {
            if (!existingIds[rt.id]) calls.unshift(rt);
          });
        }

        if (calls.length > 0) {
          _scannerFailCount = 0;
          var srcEl = document.getElementById("scannerSourceInfo");
          if (srcEl) {
            var srcText = sourcesUsed.length > 1
              ? sourcesUsed.join(" + ")
              : (sourcesUsed[0] || "openmhz");
            if (_omhzConnected) srcText += " + live";
            srcEl.textContent = srcText;
          }
          processAndRenderScanner(calls);
        } else if (_omhzRealtimeCalls.length > 0) {
          // API returned no calls but we have real-time ones from WebSocket
          _scannerFailCount = 0;
          var srcEl2 = document.getElementById("scannerSourceInfo");
          if (srcEl2) srcEl2.textContent = "live (real-time only)";
          processAndRenderScanner(_omhzRealtimeCalls.slice());
        } else {
          _scannerFailCount++;
          return fetchScannerDirect();
        }
      })
      .catch(function () {
        _scannerFailCount++;
        fetchScannerDirect();
      });
  }

  // ── Live Whisper feed (Broadcastify live audio → ffmpeg → Whisper) ──
  // Primary content of the Scanner tab. Alerts carry a transcript, an AI
  // analysis (summary, incident type, municipality), a criticality level
  // and the source feed id. There is no per-call audio file — the play
  // button streams the SOURCE FEED live via the public Broadcastify CDN.
  var _lastStreamAlertTs = 0;
  var _whisperAudio = null;
  var _whisperPlayingFeed = null;  // string feed id currently playing, or null

  var WHISPER_LEVEL_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0, none: 0 };

  function _getWhisperAudio() {
    if (!_whisperAudio) {
      _whisperAudio = new Audio();
      _whisperAudio.preload = "none";
      var clear = function () { _whisperPlayingFeed = null; _syncWhisperPlayButtons(); };
      _whisperAudio.addEventListener("error", clear);
      _whisperAudio.addEventListener("ended", clear);
      _whisperAudio.addEventListener("pause", function () {
        // Reflect external pauses (e.g. another media session) in the UI.
        if (_whisperAudio.ended || _whisperAudio.paused) _syncWhisperPlayButtons();
      });
    }
    return _whisperAudio;
  }

  function toggleWhisperPlay(feedId) {
    feedId = String(feedId || "");
    if (!feedId) return;
    var audio = _getWhisperAudio();
    if (_whisperPlayingFeed === feedId) {
      audio.pause();
      _whisperPlayingFeed = null;
      _syncWhisperPlayButtons();
      return;
    }
    // Public live stream for this feed — open CORS, no API key required.
    audio.src = "https://broadcastify.cdnstream1.com/" + encodeURIComponent(feedId);
    _whisperPlayingFeed = feedId;
    _syncWhisperPlayButtons();  // optimistic; reverted on error
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () { _whisperPlayingFeed = null; _syncWhisperPlayButtons(); });
    }
  }

  function _syncWhisperPlayButtons() {
    var list = document.getElementById("streamAlertsList");
    if (!list) return;
    var btns = list.querySelectorAll(".sc-wc-play");
    for (var i = 0; i < btns.length; i++) {
      var fid = btns[i].getAttribute("data-feed");
      var playing = _whisperPlayingFeed && fid === _whisperPlayingFeed;
      var icon = btns[i].querySelector(".material-icons");
      if (icon) icon.textContent = playing ? "pause" : "play_arrow";
      btns[i].setAttribute("aria-label", playing ? "Pause live feed" : "Play live feed");
      var card = btns[i].closest(".sc-wc");
      if (card) card.classList.toggle("is-playing", !!playing);
    }
  }

  function initWhisperFeed() {
    var list = document.getElementById("streamAlertsList");
    if (!list || list._whisperBound) return;
    list._whisperBound = true;
    // Delegated click — survives the 15s innerHTML re-render.
    list.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".sc-wc-play");
      if (!btn) return;
      e.preventDefault();
      toggleWhisperPlay(btn.getAttribute("data-feed"));
    });
  }

  // Units rarely accompany a stream transcript (no talkgroup), but surface
  // them when the analysis happens to extract any.
  function _whisperUnits(a) {
    var an = a.analysis || {};
    var cand = an.incident_candidate || {};
    var raw = an.raw || {};
    var u = a.units || cand.units || raw.units || raw.unit_ids;
    if (!u) return [];
    if (typeof u === "string") u = [u];
    if (!Array.isArray(u)) return [];
    return u.map(function (x) { return String(x).trim(); }).filter(Boolean).slice(0, 6);
  }

  function _whisperCardHtml(a) {
    var level = String(a.alert_level || "info").toLowerCase();
    if (!(level in WHISPER_LEVEL_ORDER)) level = "info";
    var an = a.analysis || {};
    var cand = an.incident_candidate || {};
    var summary = an.summary || cand.summary || "";
    var text = a.text || "";
    var muni = cand.municipality || (an.raw && an.raw.municipality) || "Albany County";
    if (muni.toLowerCase() === "albany") muni = "City of Albany";
    var itype = cand.incident_type || "";
    var units = _whisperUnits(a);
    var ta = a.timestamp ? timeAgo(new Date(a.timestamp * 1000)) : "";
    var lvlLabel = level.charAt(0).toUpperCase() + level.slice(1);
    var feedId = String(a.feed_id || "");
    var playing = _whisperPlayingFeed && feedId === _whisperPlayingFeed;

    var h = '<article class="sc-wc sc-wc--' + level + (playing ? ' is-playing' : '') + '">';

    h += '<button class="sc-wc-play" type="button" data-feed="' + esc(feedId) + '"'
       + (feedId ? '' : ' disabled') + ' aria-label="' + (playing ? 'Pause' : 'Play') + ' live feed">'
       + '<span class="material-icons">' + (playing ? 'pause' : 'play_arrow') + '</span></button>';

    h += '<div class="sc-wc-body">';
    h += '<div class="sc-wc-head">';
    h += '<span class="sc-wc-level sc-wc-level--' + level + '">' + esc(lvlLabel) + '</span>';
    if (itype) h += '<span class="sc-wc-type">' + esc(itype) + '</span>';
    h += '<span class="sc-wc-time">' + esc(ta) + '</span>';
    h += '</div>';

    if (summary) h += '<div class="sc-wc-summary">' + esc(summary) + '</div>';
    if (text && text !== summary) h += '<div class="sc-wc-transcript">“' + esc(text) + '”</div>';

    h += '<div class="sc-wc-meta">';
    h += '<span class="sc-wc-chip sc-wc-chip--feed"><span class="material-icons">cell_tower</span>' + esc(a.feed_name || "Scanner") + '</span>';
    if (muni) h += '<span class="sc-wc-chip"><span class="material-icons">place</span>' + esc(muni) + '</span>';
    if (units.length) h += '<span class="sc-wc-chip"><span class="material-icons">groups</span>' + esc(units.join(", ")) + '</span>';
    h += '</div>';

    if (a.keywords && a.keywords.length) {
      h += '<div class="sc-wc-kw">';
      a.keywords.slice(0, 6).forEach(function (kw) {
        h += '<span class="sc-wc-kwchip">' + esc(kw) + '</span>';
      });
      h += '</div>';
    }

    h += '</div></article>';
    return h;
  }

  function renderStreamAlerts(alerts) {
    var list = document.getElementById("streamAlertsList");
    if (!list) return;
    if (!alerts.length) {
      list.innerHTML = '<div class="sc-whisper-empty">'
        + '<span class="material-icons">graphic_eq</span>'
        + '<span>Listening for live transmissions…</span></div>';
      return;
    }
    var html = "";
    for (var i = 0; i < alerts.length; i++) html += _whisperCardHtml(alerts[i]);
    list.innerHTML = html;
    _syncWhisperPlayButtons();  // keep the playing card's icon after re-render
  }

  function fetchWhisperStatus() {
    fetch(API + "/api/scanner/stream-status").then(ok)
      .then(function (d) {
        var bar = document.getElementById("streamAlertsStatus");
        var txt = document.getElementById("streamAlertsStatusText");
        if (!bar || !txt) return;
        if (!d || d.status !== "ok") {
          bar.setAttribute("data-state", "offline");
          txt.textContent = "Whisper pipeline unavailable";
          return;
        }
        if (d.monitor_running && d.whisper_configured) {
          bar.setAttribute("data-state", "live");
          var feedCount = d.feeds ? d.feeds.filter(function (f) {
            return f.priority === "high" || f.priority === "medium";
          }).length : 0;
          var modeLabel = d.http_fallback_active ? " (stream capture)" : "";
          txt.textContent = "Live • Monitoring " + feedCount + " feed" + (feedCount !== 1 ? "s" : "") + modeLabel;
        } else if (!d.whisper_configured) {
          bar.setAttribute("data-state", "offline");
          txt.textContent = "Transcription unavailable";
        } else if (d.alert_count > 0) {
          bar.setAttribute("data-state", "idle");
          txt.textContent = d.alert_count + " recent transcription" + (d.alert_count !== 1 ? "s" : "");
        } else {
          bar.setAttribute("data-state", "idle");
          txt.textContent = "Pipeline warming up…";
        }
      })
      .catch(function () {
        var bar = document.getElementById("streamAlertsStatus");
        var txt = document.getElementById("streamAlertsStatusText");
        if (bar) bar.setAttribute("data-state", "offline");
        if (txt) txt.textContent = "Connecting…";
      });
  }

  function fetchStreamAlerts() {
    initWhisperFeed();
    fetch(API + "/api/scanner/stream-alerts?limit=20").then(ok)
      .then(function (data) {
        if (!data || data.status !== "ok") return;
        var alerts = data.alerts || [];
        var countEl = document.getElementById("streamAlertCount");
        if (countEl) countEl.textContent = alerts.length
          ? alerts.length + (alerts.length === 1 ? " call" : " calls")
          : "";
        renderStreamAlerts(alerts);

        // Flash the Scanner nav when a fresh critical/high call arrives.
        if (alerts.length) {
          var top = alerts[0];
          var lvl = String(top.alert_level || "").toLowerCase();
          if ((lvl === "critical" || lvl === "high") && top.timestamp > _lastStreamAlertTs) {
            _flashScannerAlert();
          }
          if (top.timestamp > _lastStreamAlertTs) _lastStreamAlertTs = top.timestamp;
        }
      })
      .catch(function () { /* silent — pipeline may be warming up */ });
  }

  function fetchScannerDirect() {
    fetch("https://api.openmhz.com/albanycony/calls?num=20", {
      mode: "cors",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9"
      }
    })
      .then(function (res) {
        if (!res.ok) return null;
        var ct = res.headers.get("content-type") || "";
        if (ct.indexOf("text/html") >= 0) return null;
        return res.json();
      })
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

  var _scannerAiCache = {};
  var _scannerAiPending = false;

  function processAndRenderScanner(calls) {
    lastScannerCallsRef = calls.slice();
    renderScannerCalls(calls);
    requestScannerAiSummaries(calls);
    requestWhisperTranscription(calls);
  }

  function requestScannerAiSummaries(calls) {
    if (_scannerAiPending) return;
    var candidates = [];
    for (var i = 0; i < Math.min(calls.length, 5); i++) {
      var c = calls[i];
      var id = c.id || c._id || String(c.talkgroup_num || "") + "_" + String(c.time || i);
      if (_scannerAiCache[id]) continue;
      var dept = resolveScannerDept(c);
      if (dept.priority !== "high") continue;
      var dur = c.duration || c.len || 0;
      if (dur < 6) continue;
      candidates.push(c);
    }
    if (!candidates.length) return;
    _scannerAiPending = true;
    fetch(API + "/api/scanner/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls: candidates.slice(0, 3) })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        _scannerAiPending = false;
        if (!data || data.status !== "ok" || !data.summaries) return;
        data.summaries.forEach(function (s, idx) {
          if (idx < candidates.length) {
            var c = candidates[idx];
            var id = c.id || c._id || String(c.talkgroup_num || "") + "_" + String(c.time || idx);
            _scannerAiCache[id] = s;
          }
        });
        if (lastScannerCallsRef.length) renderScannerCalls(lastScannerCallsRef);
      })
      .catch(function () { _scannerAiPending = false; });
  }

  function getAiSummaryForCall(call) {
    var id = call.id || call._id || String(call.talkgroup_num || "") + "_" + String(call.time || "");
    return _scannerAiCache[id] || null;
  }

  // ── WHISPER TRANSCRIPTION ─────────────────────────────────────

  var _whisperCache = {};     // call id -> { text, keywords, alert_level }
  var _whisperPending = false;

  function requestWhisperTranscription(calls) {
    if (_whisperPending) return;
    var candidates = [];
    for (var i = 0; i < Math.min(calls.length, 10); i++) {
      var c = calls[i];
      var audioUrl = c.url || c.audio_url || "";
      if (!audioUrl) continue;
      var id = c.id || c._id || audioUrl;
      if (_whisperCache[id]) continue;

      var dept = resolveScannerDept(c);
      var dur = c.duration || c.len || 0;

      // Auto-transcribe: high-priority police dispatch calls >= 5s
      if (dept.priority === "high" && dept.cat === "police" && dur >= 5) {
        candidates.push(c);
      }
    }
    if (!candidates.length) return;
    _whisperPending = true;

    fetch(API + "/api/scanner/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls: candidates.slice(0, 3) })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        _whisperPending = false;
        if (!data || data.status !== "ok" || !data.transcriptions) return;
        var hasAlerts = false;
        data.transcriptions.forEach(function (t, idx) {
          if (t.status !== "ok") return;
          var c = candidates[idx];
          if (!c) return;
          var id = c.id || c._id || (c.url || c.audio_url || "");
          _whisperCache[id] = {
            text: t.text || "",
            keywords: t.keywords || [],
            alert_level: t.alert_level || "none"
          };
          if (t.alert_level === "critical" || t.alert_level === "high") hasAlerts = true;
        });
        // Re-render scanner cards to show transcriptions
        if (lastScannerCallsRef.length) renderScannerCalls(lastScannerCallsRef);
        // Flash the scanner nav if critical alerts detected
        if (hasAlerts) _flashScannerAlert();
      })
      .catch(function () { _whisperPending = false; });
  }

  function getWhisperForCall(call) {
    var id = call.id || call._id || (call.url || call.audio_url || "");
    return _whisperCache[id] || null;
  }

  function _flashScannerAlert() {
    var navBtn = document.querySelector('.tab-bar-item[data-view="scanner"], .nav-btn[data-view="scanner"]');
    if (!navBtn) {
      // Try desktop tabs
      navBtn = document.querySelector('.desktop-tab[onclick*="scanner"], .desktop-tab[data-view="scanner"]');
    }
    if (!navBtn) return;
    navBtn.classList.add("tab-bar-item--alert");
    navBtn.classList.add("nav-btn--alert");
    setTimeout(function () { navBtn.classList.remove("tab-bar-item--alert"); navBtn.classList.remove("nav-btn--alert"); }, 8000);
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

  var _scannerSelectedIdx = -1;

  function renderScannerCalls(calls) {
    var container = document.getElementById("scannerCallsList");
    if (!container) return;

    var source = (calls && calls.length) ? calls : lastScannerCallsRef;
    if (!source || source.length === 0) { renderScannerFallback(); return; }

    var now = new Date();
    var recentCalls = source.filter(function (c) {
      var t = c.time ? new Date(c.time) : (c.start_time ? new Date(c.start_time) : null);
      return !t || (now - t) < 6 * 60 * 60 * 1000;
    });

    var filtered = recentCalls.filter(function (c) {
      var d = resolveScannerDept(c);
      if (scannerFilterCat !== "all" && d.cat !== scannerFilterCat) return false;
      if (scannerSearchQuery) {
        var blob = (d.name + " " + d.agency + " " + d.location + " " + d.channel + " " +
          String(c.talkgroup_num || c.talkgroup || "") + " " +
          String(c.talkgroup_tag || "") + " " +
          String(c.talkgroup_description || "")).toLowerCase();
        if (blob.indexOf(scannerSearchQuery) < 0) return false;
      }
      return true;
    });

    // dedupe: skip same talkgroup within 3 minutes (180s)
    var deduped = [];
    var dedupSeen = {};
    filtered.forEach(function (c) {
      var tg = String(c.talkgroup_num || c.talkgroup || "");
      var t = c.time ? new Date(c.time).getTime() : 0;
      var key = tg + "_" + Math.floor(t / 180000);
      if (dedupSeen[key]) {
        // Increment count on the existing entry
        dedupSeen[key]._dupeCount = (dedupSeen[key]._dupeCount || 1) + 1;
        return;
      }
      c._dupeCount = 1;
      dedupSeen[key] = c;
      deduped.push(c);
    });

    if (deduped.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:24px 16px;">No transmissions match your filters.</div>';
      updateMainPlayer([]);
      return;
    }

    var html = "";
    deduped.slice(0, 25).forEach(function (call, idx) {
      var dept = resolveScannerDept(call);
      var len = call.duration != null ? parseFloat(call.duration) : (call.len ? parseFloat(call.len) : 0);
      var startTime = call.time ? new Date(call.time) : (call.start_time ? new Date(call.start_time) : null);
      var ta = startTime ? timeAgo(startTime) : "";
      var audioUrl = call.url || call.audio_url || "";
      var cat = dept.cat;
      var catLabel = cat === "police" ? "Police" : cat === "fire" ? "Fire" : cat === "ems" ? "EMS" : "Other";
      var aiSum = getAiSummaryForCall(call);
      var whisper = getWhisperForCall(call);
      var isSelected = idx === _scannerSelectedIdx;
      var dupeCount = call._dupeCount || 1;

      // Source resolution — always show where data came from
      var callSource = call.source || "openmhz";
      var sourceLabel = callSource === "broadcastify" ? "Broadcastify"
        : callSource === "openmhz_realtime" ? "Live"
        : callSource === "radioreference" ? "RadioRef"
        : "OpenMHz";

      // Smart summary — prioritize real content over templates
      var summary = "";
      if (whisper && whisper.text) {
        summary = whisper.text;
      } else if (aiSum && aiSum.summary) {
        summary = aiSum.summary;
      } else {
        var tag = call.talkgroup_tag || call.talkgroup_description || "";
        if (tag && tag.toLowerCase() !== "unknown" && tag.length > 3) {
          summary = tag;
        }
      }

      var alertClass = "";
      if (whisper && whisper.alert_level === "critical") alertClass = " sc-card--alert-critical";
      else if (whisper && whisper.alert_level === "high") alertClass = " sc-card--alert-high";

      html += '<div class="sc-card sc-card--' + esc(cat) + (isSelected ? ' sc-card--active' : '') + alertClass + '" data-sc-idx="' + idx + '">';

      // Alert banner for critical/high
      if (whisper && (whisper.alert_level === "critical" || whisper.alert_level === "high")) {
        html += '<div class="sc-alert-banner sc-alert-banner--' + esc(whisper.alert_level) + '">';
        html += '<span class="material-icons" style="font-size:14px;vertical-align:middle;margin-right:4px;">' +
          (whisper.alert_level === "critical" ? "warning" : "priority_high") + '</span>';
        html += whisper.keywords.slice(0, 3).map(function (kw) {
          return '<span class="sc-alert-keyword">' + esc(kw) + '</span>';
        }).join(" ");
        html += '</div>';
      }

      // Header: Category label + Agency + Time
      html += '<div class="sc-card-top">';
      html += '<span class="sc-card-cat sc-card-cat--' + esc(cat) + '">' + esc(catLabel) + '</span>';
      html += '<span class="sc-card-agency">' + esc(dept.agency || dept.name) + '</span>';
      if (audioUrl) {
        html += '<button type="button" class="sc-row-play scanner-play-btn" data-audio="' + escAttr(audioUrl) + '" data-sc-idx="' + idx + '" title="Play">';
        html += '<span class="material-icons">play_arrow</span></button>';
      }
      html += '<span class="sc-card-time">' + esc(ta || "\u2014") + '</span>';
      html += '</div>';

      // Content: transcription or talkgroup info
      if (summary) {
        var isTranscript = whisper && whisper.text;
        html += '<div class="sc-card-summary' + (isTranscript ? ' sc-card-summary--transcript' : '') + '">';
        if (isTranscript) html += '<span class="material-icons" style="font-size:12px;opacity:0.6;vertical-align:middle;margin-right:3px;">mic</span>';
        html += esc(summary);
        html += '</div>';
      }

      // Meta row: location + source + duration + dupe count
      html += '<div class="sc-card-pills">';
      var scLoc = dept.location || "";
      if (scLoc.toLowerCase() === "albany") scLoc = "City of Albany";
      if (scLoc && scLoc !== "Albany County") {
        html += '<span class="sc-pill"><span class="material-icons" style="font-size:11px;vertical-align:middle;">place</span>' + esc(scLoc) + '</span>';
      }
      html += '<span class="sc-pill sc-pill--source">' + esc(sourceLabel) + '</span>';
      if (len > 0) html += '<span class="sc-pill">' + len.toFixed(0) + 's</span>';
      if (dupeCount > 1) html += '<span class="sc-pill sc-pill--count">' + dupeCount + ' transmissions</span>';
      if (call.is_emergency || call.emergency) html += '<span class="sc-pill sc-pill--emergency">EMERGENCY</span>';
      if (call.channel_label && _activeScannerChannel !== call.channel_id) {
        html += '<span class="sc-pill sc-pill--channel">' + esc(call.channel_label) + '</span>';
      }
      html += '</div>';

      // Responding units
      var units = call.responding_units || call.unit_ids;
      if (units && Array.isArray(units) && units.length) {
        html += '<div class="sc-card-units">';
        html += '<span class="material-icons" style="font-size:11px;color:var(--text-3);vertical-align:middle;">groups</span> ';
        html += units.slice(0, 5).map(function (u) {
          var uid = typeof u === "object" ? (u.src || u.id || "") : String(u);
          return '<span class="sc-unit-badge">' + esc(uid) + '</span>';
        }).join(" ");
        if (units.length > 5) html += ' <span class="sc-unit-badge">+' + (units.length - 5) + '</span>';
        html += '</div>';
      }

      html += '</div>';
    });

    container.innerHTML = html;
    bindScannerRowPlay(container, deduped);
    bindScannerAudio(container);
    if (_scannerSelectedIdx < 0) updateMainPlayer(deduped);

    var tsEl = document.getElementById("scannerTimestamp");
    if (tsEl) tsEl.textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  }

  function bindScannerRowPlay(container, filteredCalls) {
    container.querySelectorAll(".sc-row-play").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-sc-idx"), 10);
        _scannerSelectedIdx = idx;
        selectScannerRow(idx, filteredCalls);
      });
    });
    container.querySelectorAll(".sc-card").forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.closest(".sc-row-play") || e.target.closest("details")) return;
        var idx = parseInt(card.getAttribute("data-sc-idx"), 10);
        _scannerSelectedIdx = idx;
        selectScannerRow(idx, filteredCalls);
      });
    });
  }

  function selectScannerRow(idx, filteredCalls) {
    document.querySelectorAll(".sc-card").forEach(function (c) {
      c.classList.toggle("sc-card--active", parseInt(c.getAttribute("data-sc-idx"), 10) === idx);
    });
    if (idx >= 0 && idx < filteredCalls.length) {
      var call = filteredCalls[idx];
      var dept = resolveScannerDept(call);
      var cat = dept.cat;
      var catLabel = cat === "police" ? "Police" : cat === "fire" ? "Fire" : cat === "ems" ? "EMS" : "Scanner";
      var aiSum = getAiSummaryForCall(call);
      var summary = aiSum && aiSum.summary ? aiSum.summary : scannerSummaryText(call, dept, catLabel);
      var audioUrl = call.url || call.audio_url || "";
      var len = call.duration != null ? parseFloat(call.duration) : (call.len != null ? parseFloat(call.len) : 0);
      var startTime = call.time ? new Date(call.time) : null;
      var ta = startTime ? timeAgo(startTime) : "";
      var agencyEl = document.getElementById("mainPlayerDept");
      var summaryEl = document.getElementById("mainPlayerNowAgency");
      var metaEl = document.getElementById("mainPlayerMeta");
      var btn = document.getElementById("mainPlayerBtn");
      var badge = document.getElementById("mainPlayerBadge");
      if (agencyEl) agencyEl.textContent = dept.agency || dept.name;
      if (summaryEl) summaryEl.textContent = summary;
      if (metaEl) metaEl.textContent = [catLabel, dept.location, len > 0 ? len.toFixed(0) + "s" : "", ta].filter(Boolean).join(" · ");
      if (badge) badge.style.opacity = "1";
      if (btn) {
        btn.disabled = !audioUrl;
        btn.setAttribute("data-audio", audioUrl);
        currentMainPlayerCallIdx = idx;
        btn.onclick = function () { playMainAudio(btn, audioUrl, len, idx); };
      }
      if (audioUrl && btn && !btn.classList.contains("playing")) {
        playMainAudio(btn, audioUrl, len, idx);
      }
    }
  }

  function scannerSummaryText(call, dept, catLabel) {
    var raw = [
      call && call.talkgroup_tag,
      call && call.talkgroup_description,
      dept && dept.name,
      dept && dept.channel,
      dept && dept.location
    ].join(" ").toLowerCase();

    var type = "";
    if (/\b(shots?\s*fired|shoot|gunshot|gun)\b/.test(raw)) type = "Shots-fired report";
    else if (/\b(pursuit|chase|fleeing)\b/.test(raw)) type = "Vehicle pursuit";
    else if (/\b(assault|fight|domestic)\b/.test(raw)) type = "Assault or disturbance";
    else if (/\b(robbery|burglary|larceny|theft)\b/.test(raw)) type = "Property crime report";
    else if (/\b(missing|amber|silver)\b/.test(raw)) type = "Missing person alert";
    else if (/\b(crash|mva|accident|collision)\b/.test(raw)) type = "Motor vehicle crash";
    else if (/\b(structure\s*fire|working\s*fire|blaze)\b/.test(raw)) type = "Structure fire response";
    else if (/\b(brush|wildland)\b/.test(raw)) type = "Brush fire response";
    else if (/\b(alarm)\b/.test(raw)) type = "Fire alarm response";
    else if (/\b(medical|cardiac|overdose|unresponsive)\b/.test(raw)) type = "Medical emergency";
    else if (/\b(ambulance)\b/.test(raw)) type = "EMS response";
    else if (/\b(traffic\s*stop|dwi|dui)\b/.test(raw)) type = "Traffic enforcement";
    else if (/\b(bomb|explosive|hazmat)\b/.test(raw)) type = "Hazmat response";
    else if (/\b(swat|standoff|barricade|hostage)\b/.test(raw)) type = "Tactical situation";
    else if (/\b(dispatch)\b/.test(raw) && dept.cat === "fire") type = "Fire dispatch traffic";
    else if (/\b(dispatch)\b/.test(raw) && dept.cat === "ems") type = "EMS dispatch traffic";
    else if (/\b(dispatch)\b/.test(raw)) type = "Dispatch communication";
    else if (/\b(tac|tactical|ops)\b/.test(raw)) type = "Tactical channel traffic";
    else if (/\b(interop)\b/.test(raw)) type = "Multi-agency coordination";
    else if (dept.cat === "fire") type = "Fire service traffic";
    else if (dept.cat === "ems") type = "EMS traffic";
    else type = "Radio traffic";

    var where = dept.location && dept.location !== "Albany County" ? " in " + dept.location : "";
    return type + where + ".";
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
    var btn = document.getElementById("mainPlayerBtn");
    var agencyEl = document.getElementById("mainPlayerDept");
    var summaryEl = document.getElementById("mainPlayerNowAgency");
    var metaEl = document.getElementById("mainPlayerMeta");
    var badge = document.getElementById("mainPlayerBadge");
    if (!btn) return;

    if (!calls || calls.length === 0) {
      if (agencyEl) agencyEl.textContent = "No transmissions in this filter";
      if (summaryEl) summaryEl.textContent = "";
      if (metaEl) metaEl.textContent = "";
      btn.disabled = true;
      btn.removeAttribute("data-audio");
      if (badge) badge.style.opacity = "0.4";
      return;
    }

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
    var catLabel = dept.cat === "police" ? "Police" : dept.cat === "fire" ? "Fire" : dept.cat === "ems" ? "EMS" : "Scanner";
    var summary = scannerSummaryText(call, dept, catLabel);

    if (agencyEl) agencyEl.textContent = dept.name;
    if (summaryEl) summaryEl.textContent = summary;
    if (metaEl) {
      var parts = [];
      if (catLabel) parts.push(catLabel);
      if (dept.location) parts.push(dept.location);
      if (len > 0) parts.push(len.toFixed(0) + "s");
      if (ta) parts.push(ta);
      metaEl.textContent = parts.join(" · ");
    }
    if (badge) badge.style.opacity = "1";

    btn.disabled = !audioUrl;
    btn.setAttribute("data-audio", audioUrl);
    var idx = currentMainPlayerCallIdx;
    btn.onclick = function () { playMainAudio(btn, audioUrl, len, idx); };
  }

  function playMainAudio(btn, url, len, callIndex) {
    var bar = document.getElementById("mainPlayerBar") || document.querySelector(".sc-player-bar");

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
          var nCatLabel = nd.cat === "police" ? "Police" : nd.cat === "fire" ? "Fire" : nd.cat === "ems" ? "EMS" : "Scanner";
          var nSummary = scannerSummaryText(nc, nd, nCatLabel);
          var agEl = document.getElementById("mainPlayerDept");
          var sumEl = document.getElementById("mainPlayerNowAgency");
          var metaEl2 = document.getElementById("mainPlayerMeta");
          if (agEl) agEl.textContent = nd.name;
          if (sumEl) sumEl.textContent = nSummary;
          if (metaEl2) {
            var st = nc.time ? new Date(nc.time) : null;
            var p2 = [nCatLabel];
            if (nd.location) p2.push(nd.location);
            if (nlen > 0) p2.push(nlen.toFixed(0) + "s");
            if (st) p2.push(timeAgo(st));
            metaEl2.textContent = p2.join(" · ");
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
    if (container.querySelector(".sc-card")) return;

    container.innerHTML =
      '<div class="scanner-fallback">' +
        '<div class="scanner-fallback-header">' +
          '<span class="material-icons" style="font-size:18px;color:var(--warning, #f59e0b);">cell_tower</span>' +
          '<span>Radio calls data source unavailable</span>' +
        '</div>' +
        '<p class="scanner-fallback-text">' +
          'OpenMHz P25 call data is currently unreachable (upstream issue). ' +
          'This does NOT affect the Live Radio player above — you can still listen to live feeds directly.</p>' +
        '<p class="scanner-fallback-text" style="margin-top:6px;">' +
          '<strong>What still works:</strong></p>' +
        '<ul class="scanner-fallback-text" style="margin:4px 0 0 16px;list-style:disc;">' +
          '<li>Live Radio — tap any feed above to listen</li>' +
          '<li>Whisper transcriptions — when audio is captured</li>' +
          '<li>Live feed incidents — separate from scanner</li>' +
        '</ul>' +
        '<div class="scanner-fallback-actions" style="margin-top:10px;">' +
          '<button type="button" class="link-btn sc-retry-btn">Retry calls</button>' +
        '</div>' +
      '</div>';
    var retryBtn = container.querySelector(".sc-retry-btn");
    if (retryBtn) retryBtn.addEventListener("click", function () {
      _scannerFailCount = 0;
      container.innerHTML = '<div class="empty-state">Retrying…</div>';
      fetchScannerCalls();
    });
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

  // ── LIVE RADIO (Broadcastify CDN streams — no API key) ──────────────────
  var _liveRadioAudio = null;
  var _liveRadioFeedId = null;
  var _liveRadioPlaying = false;
  var _liveRadioMuted = false;
  var _liveRadioVizTimer = null;

  var BCFY_FEEDS = [
    { id: "3626",  name: "Albany/Colonie PD",  type: "police" },
    { id: "1440",  name: "Albany Fire",        type: "fire" },
    { id: "37206", name: "County Vol. Fire",   type: "fire" },
    { id: "21216", name: "Thruway",            type: "other" },
  ];

  // Rich Broadcastify feed provenance (who/where/system), fetched from
  // /api/scanner/live-feeds and keyed by feed id.
  var _bcfyFeedMeta = {};

  function _bcfyStreamUrl(feedId) {
    return "https://broadcastify.cdnstream1.com/" + encodeURIComponent(feedId);
  }

  function _fetchLiveFeedMeta() {
    fetch(API + "/api/scanner/live-feeds").then(ok)
      .then(function (d) {
        if (!d || d.status !== "ok" || !Array.isArray(d.feeds)) return;
        d.feeds.forEach(function (f) { _bcfyFeedMeta[f.id] = f; });
        // Render info for the initially-active feed.
        _renderFeedInfo(_liveRadioFeedId || "3626");
      })
      .catch(function () {});
  }

  function _renderFeedInfo(feedId) {
    var m = _bcfyFeedMeta[feedId];
    var cov = document.getElementById("feedInfoCoverage");
    var sys = document.getElementById("feedInfoSystem");
    var src = document.getElementById("feedInfoSource");
    var link = document.getElementById("feedInfoLink");
    if (!m) {
      if (cov) cov.textContent = "—";
      if (sys) sys.textContent = "—";
      if (src) src.textContent = "—";
      return;
    }
    if (cov) cov.textContent = (m.county ? m.county + " · " : "") + (m.coverage || "");
    if (sys) sys.textContent = m.system || "—";
    if (src) src.textContent = "Broadcastify #" + m.id + " · " + (m.genre || "Public Safety");
    if (link && m.page_url) link.setAttribute("href", m.page_url);
  }

  function initLiveRadio() {
    var feedHost = document.getElementById("liveRadioFeeds");
    var playBtn = document.getElementById("liveRadioPlayBtn");
    var muteBtn = document.getElementById("liveRadioMuteBtn");
    var volSlider = document.getElementById("liveRadioVolume");
    if (!feedHost || !playBtn) return;
    _fetchLiveFeedMeta();

    feedHost.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-feed-id]");
      if (!btn || !feedHost.contains(btn)) return;
      var fid = btn.getAttribute("data-feed-id");
      feedHost.querySelectorAll("[data-feed-id]").forEach(function (b) {
        var active = (b === btn);
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      _liveRadioSelectFeed(fid);
      _renderFeedInfo(fid);
    });

    playBtn.addEventListener("click", function () {
      if (_liveRadioPlaying) {
        _liveRadioStop();
      } else {
        var fid = _liveRadioFeedId || "3626";
        _liveRadioStart(fid);
      }
    });

    if (muteBtn) muteBtn.addEventListener("click", function () {
      _liveRadioMuted = !_liveRadioMuted;
      if (_liveRadioAudio) _liveRadioAudio.muted = _liveRadioMuted;
      var icon = document.getElementById("liveRadioMuteIcon");
      if (icon) icon.textContent = _liveRadioMuted ? "volume_off" : "volume_up";
      if (muteBtn) muteBtn.classList.toggle("muted", _liveRadioMuted);
    });

    if (volSlider) volSlider.addEventListener("input", function () {
      var v = parseInt(volSlider.value, 10) / 100;
      if (_liveRadioAudio) _liveRadioAudio.volume = v;
    });
  }

  function _liveRadioSelectFeed(feedId) {
    if (_liveRadioPlaying && _liveRadioFeedId !== feedId) {
      _liveRadioStop();
      _liveRadioStart(feedId);
    } else {
      _liveRadioFeedId = feedId;
      _liveRadioUpdateNowPlaying(feedId, false);
    }
  }

  function _liveRadioStart(feedId) {
    _liveRadioStop();
    _liveRadioFeedId = feedId;
    var url = _bcfyStreamUrl(feedId);
    _liveRadioAudio = new Audio();
    _liveRadioAudio.preload = "none";
    _liveRadioAudio.muted = _liveRadioMuted;
    var volSlider = document.getElementById("liveRadioVolume");
    _liveRadioAudio.volume = volSlider ? parseInt(volSlider.value, 10) / 100 : 0.8;
    _liveRadioAudio.src = url;

    _liveRadioAudio.addEventListener("error", function () {
      _liveRadioSetStatus("Stream unavailable");
      _liveRadioPlaying = false;
      _liveRadioSyncUI();
    });
    _liveRadioAudio.addEventListener("waiting", function () {
      _liveRadioSetStatus("Buffering…");
    });
    _liveRadioAudio.addEventListener("playing", function () {
      _liveRadioSetStatus("Live");
      _liveRadioStartViz();
    });
    _liveRadioAudio.addEventListener("pause", function () {
      _liveRadioSetStatus("Paused");
      _liveRadioStopViz();
    });

    var p = _liveRadioAudio.play();
    if (p && p.catch) p.catch(function () {
      _liveRadioSetStatus("Tap to play");
      _liveRadioPlaying = false;
      _liveRadioSyncUI();
    });

    _liveRadioPlaying = true;
    _liveRadioUpdateNowPlaying(feedId, true);
    _liveRadioSyncUI();
  }

  function _liveRadioStop() {
    if (_liveRadioAudio) {
      _liveRadioAudio.pause();
      _liveRadioAudio.src = "";
      _liveRadioAudio = null;
    }
    _liveRadioPlaying = false;
    _liveRadioStopViz();
    _liveRadioSyncUI();
    _liveRadioSetStatus("Ready");
  }

  function _liveRadioSyncUI() {
    var icon = document.getElementById("liveRadioPlayIcon");
    if (icon) icon.textContent = _liveRadioPlaying ? "stop" : "play_arrow";
    var playBtn = document.getElementById("liveRadioPlayBtn");
    if (playBtn) playBtn.classList.toggle("playing", _liveRadioPlaying);
    var badge = document.getElementById("liveRadioBadge");
    if (badge) badge.classList.toggle("is-live", _liveRadioPlaying);
    var card = document.getElementById("liveRadioCard");
    if (card) card.classList.toggle("is-streaming", _liveRadioPlaying);
  }

  function _liveRadioUpdateNowPlaying(feedId, playing) {
    var el = document.getElementById("liveRadioNowPlaying");
    if (!el) return;
    var feed = BCFY_FEEDS.find(function (f) { return f.id === feedId; });
    if (feed) {
      el.textContent = playing ? "Now streaming: " + feed.name : feed.name;
    } else {
      el.textContent = playing ? "Streaming feed " + feedId : "Feed " + feedId;
    }
  }

  function _liveRadioSetStatus(text) {
    var el = document.getElementById("liveRadioStatus");
    if (el) el.textContent = text;
  }

  function _liveRadioStartViz() {
    var viz = document.getElementById("liveRadioViz");
    if (viz) viz.classList.add("active");
  }

  function _liveRadioStopViz() {
    var viz = document.getElementById("liveRadioViz");
    if (viz) viz.classList.remove("active");
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
