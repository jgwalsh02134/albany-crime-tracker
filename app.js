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
  var REFRESH_MS = 45000;
  var SCANNER_REFRESH_MS = 20000;

  // State
  var map, trendsChart;
  var mapReady = false;
  var chatHistory = [];
  var activeView = "feed";
  var activeFeedTab = "verified";       // verified | developing | official
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
  var HOME_WINDOW_HOURS = 48;

  // Law enforcement directory (lazy-loaded from /api/directory/*)
  var leDirectory = null;
  var directoryLoaded = false;
  var directoryLoading = false;
  var dirTierFilter = "all";
  var dirSearchQuery = "";

  // MapLibre style URLs
  var STYLE_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  var STYLE_LIGHT = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
  var mapHeatmapOn = false;

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
    initHomeModeTabs();
    initDirSearch();
    initDirFilters();
    loadScannerAliases();
    initScannerToolbar();
    initFeedTabs();
    initFeedControls();
    initSummaryControls();
    initChat();
    startClock();

    fetchIncidents();
    setTimeout(fetchScannerCalls, 900);
    setTimeout(fetchScannerTalkgroups, 1400);
    setTimeout(fetchSummarySnapshot, 1800);
    setTimeout(fetchSituation, 2500);

    setInterval(function () {
      fetchIncidents();
      fetchSummarySnapshot();
      fetchSituation();
    }, REFRESH_MS);

    setInterval(fetchScannerCalls, SCANNER_REFRESH_MS);

    // Freshness indicator: update "Last updated X min ago" every 15s
    setInterval(updateFreshnessIndicator, 15000);
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

  function refreshHeaderPrimaryCount() {
    var chipLbl = document.querySelector(".stat-chip--live .stat-lbl");
    var sub = document.getElementById("statLiveSub");
    var v = lastCrimeCounts.visible_feed_count;
    var a = lastCrimeCounts.live_now_count;
    var confN = lastFeedTotals.confirmed;
    var tracked = lastCrimeCounts.stats_total_incidents;
    if (activeFeedTab === "verified") {
      if (chipLbl) chipLbl.textContent = "Verified";
      if (typeof v === "number") setNum("statTotal", v);
      if (sub) {
        if (typeof v !== "number" || v === 0) sub.textContent = "";
        else {
          var rsec = Math.max(0, v - (typeof a === "number" ? a : 0));
          sub.textContent =
            (typeof a === "number" ? a : 0) +
            " verified now" +
            (rsec ? " · " + rsec + " additional" : "");
        }
      }
    } else if (activeFeedTab === "developing") {
      if (chipLbl) chipLbl.textContent = "Developing";
      if (typeof confN === "number") setNum("statTotal", confN);
      if (sub) sub.textContent = "Early signals and corroboration";
    } else if (activeFeedTab === "official") {
      if (chipLbl) chipLbl.textContent = "Official";
      if (typeof tracked === "number") setNum("statTotal", tracked);
      if (sub) sub.textContent = "Agency/open-data updates";
    } else {
      if (chipLbl) chipLbl.textContent = "Trends";
      if (typeof tracked === "number") setNum("statTotal", tracked);
      if (sub) sub.textContent = "Map trust + trend snapshot";
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

        if (target === "trendsmap") {
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

    var html = "";
    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Current</div>';
    html += '<div class="feed-summary-v">' + esc(String(Number(currentSummary.total || 0))) + '</div>';
    html += '<div class="feed-summary-sub">Reported in the last 24 hours</div>';
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Developing</div>';
    html += '<div class="feed-summary-v">' + esc(String(_developingCount(currentSummary))) + '</div>';
    html += '<div class="feed-summary-sub">Signals still being confirmed</div>';
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Week overview</div>';
    html += '<div class="feed-summary-v">' + esc(String(Number(weekSummary && weekSummary.total || 0))) + '</div>';
    html += '<div class="feed-summary-list">' + esc(_topText(weekSummary && weekSummary.groups && weekSummary.groups.incident_type)) + "</div>";
    html += "</div>";

    html += '<div class="feed-summary-card">';
    html += '<div class="feed-summary-k">Month overview</div>';
    html += '<div class="feed-summary-v">' + esc(String(Number(monthSummary && monthSummary.total || 0))) + '</div>';
    html += '<div class="feed-summary-list">' + esc(_topText(monthSummary && monthSummary.groups && monthSummary.groups.municipality)) + "</div>";
    html += "</div>";

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
        if (mode === "news" && !_newsLoaded) {
          _newsLoaded = true;
          fetchHomeNews();
        }
      });
    });
  }

  // ── HOME NEWS (major stories, developing, recaps) ─────────────
  function fetchHomeNews() {
    fetch(API + "/api/home/news")
      .then(ok)
      .then(function (data) {
        if (!data || data.status !== "ok") return;
        renderMajorStories(data.major_stories || []);
        renderDevelopingStories(data.developing_stories || []);
        renderRecaps(data.recap_24h, data.recap_7d, data.recap_30d);
      })
      .catch(function () {
        renderMajorStories([]);
        renderDevelopingStories([]);
      });
  }

  function _storyCard(item, cls) {
    var sev = (item.severity || "").toLowerCase();
    var sevCls = sev === "critical" ? " home-story-pill--sev-critical" : sev === "high" ? " home-story-pill--sev-high" : "";
    var link = item.source_url || item.link || "";
    var tag = link ? "a" : "div";
    var linkAttrs = link ? ' href="' + escAttr(link) + '" target="_blank" rel="noopener noreferrer"' : "";
    var html = '<' + tag + ' class="home-story-card ' + cls + '"' + linkAttrs + '>';
    html += '<div class="home-story-body">';
    html += '<div class="home-story-head">';
    html += '<div class="home-story-title">' + esc(item.title || "Untitled") + '</div>';
    if (item.human_time) html += '<span class="home-story-time">' + esc(item.human_time) + '</span>';
    html += '</div>';
    if (item.summary) html += '<div class="home-story-desc">' + esc(item.summary) + '</div>';
    html += '<div class="home-story-meta">';
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
    var btns = document.querySelectorAll(".nav-btn");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        switchView(view);
      });
    });

    var dtabs = document.querySelectorAll(".desktop-tab");
    dtabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var view = tab.getAttribute("data-view");
        switchView(view);
      });
    });

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

    if (viewName === "map" && !mapInitialized) {
      initMap();
      mapInitialized = true;
    } else if (viewName === "map" && map) {
      setTimeout(function () { map.resize(); }, 100);
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
      if (map) map.resize();
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

  // ── MAP (MapLibre GL JS) ──────────────────────────────────────
  var _mapPopup = null;

  function initMap() {
    var el = document.getElementById("map");
    if (!el || map) return;

    try {
      var theme = getTheme();
      map = new maplibregl.Map({
        container: "map",
        style: theme === "dark" ? STYLE_DARK : STYLE_LIGHT,
        center: [-73.75, 42.65],
        zoom: 10.5,
        minZoom: 8,
        maxZoom: 18,
        attributionControl: false
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

      _mapPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "300px" });

      map.on("load", function () {
        mapReady = true;

        // ── GeoJSON source for incidents ──
        map.addSource("incidents", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          cluster: true,
          clusterMaxZoom: 13,
          clusterRadius: 55
        });

        // ── Cluster circles ──
        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "incidents",
          filter: ["has", "point_count"],
          paint: {
            "circle-color": [
              "step", ["get", "point_count"],
              "rgba(108,92,231,0.7)",  // < 5
              5, "rgba(108,92,231,0.8)",  // 5-14
              15, "rgba(108,92,231,0.9)"  // 15+
            ],
            "circle-radius": [
              "step", ["get", "point_count"],
              18, 5, 24, 15, 32
            ],
            "circle-stroke-width": 2,
            "circle-stroke-color": "rgba(255,255,255,0.3)"
          }
        });

        // ── Cluster labels ──
        map.addLayer({
          id: "cluster-count",
          type: "symbol",
          source: "incidents",
          filter: ["has", "point_count"],
          layout: {
            "text-field": "{point_count_abbreviated}",
            "text-font": ["Open Sans Bold"],
            "text-size": 13,
            "text-allow-overlap": true
          },
          paint: {
            "text-color": "#fff"
          }
        });

        // ── Individual incident points ──
        map.addLayer({
          id: "incident-points",
          type: "circle",
          source: "incidents",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": [
              "match", ["get", "severity"],
              "critical", 10,
              "high", 8,
              7
            ],
            "circle-color": [
              "match", ["get", "category"],
              "violent", "#e05252",
              "property", "#d9953a",
              "#4d8fdb"
            ],
            "circle-opacity": [
              "match", ["get", "quality"],
              "exact", 0.9,
              0.5
            ],
            "circle-stroke-width": [
              "match", ["get", "quality"],
              "exact", 2,
              1.5
            ],
            "circle-stroke-color": [
              "match", ["get", "quality"],
              "exact", "#fff",
              ["match", ["get", "category"],
                "violent", "#e05252",
                "property", "#d9953a",
                "#4d8fdb"
              ]
            ]
          }
        });

        // ── Heatmap layer (hidden by default) ──
        map.addLayer({
          id: "incident-heat",
          type: "heatmap",
          source: "incidents",
          filter: ["!", ["has", "point_count"]],
          layout: { visibility: "none" },
          paint: {
            "heatmap-weight": [
              "match", ["get", "category"],
              "violent", 1.0,
              "property", 0.6,
              0.3
            ],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 15, 2],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 15, 15, 25],
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0, "rgba(0,0,0,0)",
              0.15, "rgba(75,0,130,0.3)",
              0.3, "rgba(0,0,255,0.4)",
              0.5, "rgba(0,200,200,0.5)",
              0.7, "rgba(255,200,0,0.65)",
              0.9, "rgba(255,100,0,0.8)",
              1.0, "rgba(255,0,0,0.9)"
            ],
            "heatmap-opacity": 0.7
          }
        });

        // ── Click handlers ──
        map.on("click", "clusters", function (e) {
          var features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
          if (!features.length) return;
          var clusterId = features[0].properties.cluster_id;
          map.getSource("incidents").getClusterExpansionZoom(clusterId, function (err, zoom) {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1 });
          });
        });

        map.on("click", "incident-points", function (e) {
          if (!e.features || !e.features.length) return;
          var f = e.features[0];
          var p = f.properties;
          var coords = f.geometry.coordinates.slice();
          var ta = p.human_time || "";
          var verLabel = String(p.verification || "unknown").replace(/_/g, " ");
          var qualLabel = p.quality === "exact" ? "Exact location" : "Approximate area";

          var html = '<div class="map-popup">';
          html += '<div class="map-popup-title">' + esc(p.title || "Incident") + '</div>';
          html += '<div class="map-popup-meta">' + esc(p.municipality || "Albany County") + (ta ? " · " + esc(ta) : "") + '</div>';
          html += '<div class="map-popup-pills">';
          html += '<span class="map-popup-pill">' + esc(_sourceTypeLabel(p.source_type || "unknown")) + '</span>';
          if (p.source_name) html += '<span class="map-popup-pill map-popup-pill--src">' + esc(p.source_name) + '</span>';
          html += '<span class="map-popup-pill">' + esc(verLabel) + '</span>';
          html += '<span class="map-popup-pill' + (p.quality === "exact" ? '' : ' map-popup-pill--approx') + '">' + esc(qualLabel) + '</span>';
          html += '</div>';
          html += '<div class="map-popup-actions">';
          if (p.source_url) html += '<a href="' + escAttr(p.source_url) + '" target="_blank" rel="noopener">Source</a>';
          html += '<a href="#" onclick="window.ACTFocusIncident && window.ACTFocusIncident(\'' + escAttr(p.id || "") + '\');return false;">View in feed</a>';
          html += '</div></div>';

          _mapPopup.setLngLat(coords).setHTML(html).addTo(map);
        });

        // Cursor styles
        map.on("mouseenter", "clusters", function () { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "clusters", function () { map.getCanvas().style.cursor = ""; });
        map.on("mouseenter", "incident-points", function () { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "incident-points", function () { map.getCanvas().style.cursor = ""; });

        // Load initial data
        if (pendingMarkerData) plotMarkers(pendingMarkerData);
        refreshMapMarkers();
      });

      // Heatmap toggle
      var heatBtn = document.getElementById("mapHeatmapToggle");
      if (heatBtn) {
        heatBtn.addEventListener("click", function () {
          mapHeatmapOn = !mapHeatmapOn;
          heatBtn.classList.toggle("active", mapHeatmapOn);
          if (map.getLayer("incident-heat")) {
            map.setLayoutProperty("incident-heat", "visibility", mapHeatmapOn ? "visible" : "none");
          }
          if (map.getLayer("incident-points")) {
            map.setLayoutProperty("incident-points", "visibility", mapHeatmapOn ? "none" : "visible");
          }
        });
      }

      initMapFilters();
    } catch (err) {
      console.error("Map init error:", err);
      if (el) {
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:13px;">Map unavailable</div>';
      }
    }
  }

  function updateMapTiles(theme) {
    if (!map) return;
    map.setStyle(theme === "dark" ? STYLE_DARK : STYLE_LIGHT);
    // Re-add source and layers after style change
    map.once("style.load", function () {
      _addMapLayers();
      if (pendingMarkerData) plotMarkers(pendingMarkerData);
    });
  }

  function _addMapLayers() {
    if (map.getSource("incidents")) return;
    map.addSource("incidents", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: 13,
      clusterRadius: 55
    });
    map.addLayer({
      id: "clusters", type: "circle", source: "incidents",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": ["step", ["get", "point_count"], "rgba(108,92,231,0.7)", 5, "rgba(108,92,231,0.8)", 15, "rgba(108,92,231,0.9)"],
        "circle-radius": ["step", ["get", "point_count"], 18, 5, 24, 15, 32],
        "circle-stroke-width": 2, "circle-stroke-color": "rgba(255,255,255,0.3)"
      }
    });
    map.addLayer({
      id: "cluster-count", type: "symbol", source: "incidents",
      filter: ["has", "point_count"],
      layout: { "text-field": "{point_count_abbreviated}", "text-font": ["Open Sans Bold"], "text-size": 13, "text-allow-overlap": true },
      paint: { "text-color": "#fff" }
    });
    map.addLayer({
      id: "incident-points", type: "circle", source: "incidents",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["match", ["get", "severity"], "critical", 10, "high", 8, 7],
        "circle-color": ["match", ["get", "category"], "violent", "#e05252", "property", "#d9953a", "#4d8fdb"],
        "circle-opacity": ["match", ["get", "quality"], "exact", 0.9, 0.5],
        "circle-stroke-width": ["match", ["get", "quality"], "exact", 2, 1.5],
        "circle-stroke-color": ["match", ["get", "quality"], "exact", "#fff",
          ["match", ["get", "category"], "violent", "#e05252", "property", "#d9953a", "#4d8fdb"]]
      }
    });
    map.addLayer({
      id: "incident-heat", type: "heatmap", source: "incidents",
      filter: ["!", ["has", "point_count"]],
      layout: { visibility: mapHeatmapOn ? "visible" : "none" },
      paint: {
        "heatmap-weight": ["match", ["get", "category"], "violent", 1.0, "property", 0.6, 0.3],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 15, 2],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 15, 15, 25],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(0,0,0,0)", 0.15, "rgba(75,0,130,0.3)", 0.3, "rgba(0,0,255,0.4)",
          0.5, "rgba(0,200,200,0.5)", 0.7, "rgba(255,200,0,0.65)", 0.9, "rgba(255,100,0,0.8)", 1.0, "rgba(255,0,0,0.9)"],
        "heatmap-opacity": 0.7
      }
    });
    if (map.getLayer("incident-points")) {
      map.setLayoutProperty("incident-points", "visibility", mapHeatmapOn ? "none" : "visible");
    }
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
      start_date: homeWindowStartIso(),
      q: mapSearchQuery,
      verification_level: mapVerification,
      severity: mapSeverity,
      sort_by: "newest"
    };
    var fetcher = apiClient && apiClient.getIncidentMarkers
      ? apiClient.getIncidentMarkers(params)
      : fetch(
          API + "/api/incidents/map?has_coordinates=true&limit=500&sort_by=newest&start_date=" + encodeURIComponent(params.start_date)
        ).then(ok);
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
    if (!map || !map.getSource("incidents")) return;

    var filtered = activeMapFilter === "all"
      ? data
      : data.filter(function (d) { return mapCategory(d) === activeMapFilter; });

    var features = [];
    var exactCount = 0;
    var approxCount = 0;

    filtered.forEach(function (item) {
      var lat = parseFloat(item.latitude);
      var lng = parseFloat(item.longitude);
      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;
      if (lat < 42.3 || lat > 42.9 || lng < -74.2 || lng > -73.4) return;

      var cq = String(item.coordinate_quality || "approximate").toLowerCase();
      if (cq === "missing") return;
      var isExact = cq === "exact";
      if (isExact) exactCount++; else approxCount++;

      var ta = item.human_time || (item.occurred_at ? timeAgo(new Date(item.occurred_at)) : "");

      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          id: item.id || "",
          title: item.title || "Incident",
          municipality: item.municipality || "Albany County",
          category: mapCategory(item),
          severity: item.severity || "low",
          quality: isExact ? "exact" : "approximate",
          verification: item.verification_level || "unknown",
          source_type: item.source_type || "unknown",
          source_name: item.source_name || "",
          source_url: item.source_url || "",
          human_time: ta
        }
      });
    });

    map.getSource("incidents").setData({
      type: "FeatureCollection",
      features: features
    });

    var statusParts = [];
    if (exactCount) statusParts.push(exactCount + " exact");
    if (approxCount) statusParts.push(approxCount + " approximate");
    if (!statusParts.length) {
      setMapStatus("No map-ready incidents in this view.");
    } else {
      setMapStatus(statusParts.join(", ") + " — " + (exactCount + approxCount) + " total");
    }
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
    return document.getElementById("incidentListVerified") || document.getElementById("incidentListNow");
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
    if (st === "open_data") return "verified";
    if (st === "official" || v === "official") return "official";
    if (v === "multi_source") return "verified";
    return "developing";
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
    var params = {
      limit: 180,
      sort_by: "newest",
      start_date: homeWindowStartIso()
    };
    (apiClient && apiClient.getPersistedIncidents
      ? apiClient.getPersistedIncidents(params)
      : fetch(
          API + "/api/incidents?limit=180&sort_by=newest&start_date=" + encodeURIComponent(params.start_date),
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
        lastCrimeCounts.visible_feed_count = data.length;
        lastCrimeCounts.live_now_count = data.filter(function (x) { return x.feed_tab === "verified"; }).length;
        lastCrimeCounts.stats_total_incidents = data.length;
        lastFeedTotals.confirmed = data.filter(function (x) { return x.feed_tab === "developing"; }).length;

        var verifiedItems = data.filter(function (x) { return x.feed_tab === "verified"; });
        var developingItems = data.filter(function (x) { return x.feed_tab === "developing"; });
        var officialItems = data.filter(function (x) { return x.feed_tab === "official"; });
        lastLiveActiveItems = verifiedItems;
        lastLiveRecentItems = [];

        renderLiveFeed(verifiedItems, []);
        renderConfirmedFeed(developingItems);
        renderContextFeed(officialItems);
        autoSelectBestLane(verifiedItems, developingItems, officialItems);
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
            var verifiedItems = data.filter(function (x) { return x.feed_tab === "verified" || x.feed_tab === "live" || x.feed_tab === "now"; });
            var developingItems = data.filter(function (x) { return x.feed_tab === "developing" || x.feed_tab === "confirmed"; });
            var officialItems = data.filter(function (x) { return x.feed_tab === "official"; });
            renderLiveFeed(verifiedItems, []);
            renderConfirmedFeed(developingItems);
            renderContextFeed(officialItems);
            markTopbarLiveIfStillConnecting();
            markFeedFreshNow();
          })
          .catch(function (fallbackErr) {
            console.error("Legacy incidents fallback error:", fallbackErr);
            markTopbarLiveIfStillConnecting();
            var liveL = getLiveFeedListEl();
            var confL = document.getElementById("incidentListDeveloping");
            var ctxL = document.getElementById("incidentListOfficial");
            var errorHtml = '<div class="feed-error-state">' +
              '<span class="material-icons">cloud_off</span>' +
              '<p>Could not load incidents right now.</p>' +
              '<p style="font-size:11px;opacity:0.7">Check your connection or try again shortly.</p>' +
              '<button class="feed-error-retry" onclick="location.reload()">Retry</button>' +
              '</div>';
            [liveL, confL, ctxL].forEach(function (el) {
              if (el && !el.querySelector(".feed-item")) el.innerHTML = errorHtml;
            });
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
        // Hide the regular feed tabs while searching
        var tabs = document.getElementById("feedSubtabs");
        var panels = document.querySelectorAll(".feed-tab-content");
        if (tabs) tabs.style.display = "none";
        panels.forEach(function (p) { p.style.display = "none"; });
      })
      .catch(function () {});
  }
  function hideSearchResults() {
    var container = document.getElementById("feedSearchResults");
    if (container) { container.innerHTML = ""; container.hidden = true; }
    var tabs = document.getElementById("feedSubtabs");
    var panels = document.querySelectorAll(".feed-tab-content");
    if (tabs) tabs.style.display = "";
    panels.forEach(function (p) { p.style.display = ""; });
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
    var type = item.crime_type || "other";
    var sourceType = (item.source_type || "unknown").toLowerCase();
    var sourceName = item.source || item.source_name || "Unknown source";
    var verify = item.verification_level || "unknown";
    var verifyLabel = item.verification_label || String(verify).replace(/_/g, " ");
    var title = item.short_title || item.title || "Untitled";
    var ta = item.human_time || feedAgeCompact(item);
    var link = resolveIncidentCardHref(item);
    var area = item.municipality || item.matched_location || "Albany County";
    var summary = item.summary || item.description || "";
    var sev = (item.severity || "unknown").toLowerCase();

    var cls = "feed-item feed-item--" + type;
    if (sev === "critical") cls += " feed-item--sev-critical";
    else if (sev === "high") cls += " feed-item--sev-high";
    if (sev === "low" && (verify || "").toLowerCase() === "inferred") cls += " feed-item--quiet";

    // Time freshness class
    var ageH = itemAgeHours(item);
    var timeClass = "feed-time";
    if (ageH !== null && ageH <= 1) timeClass += " feed-time--fresh";
    else if (ageH !== null && ageH > 12) timeClass += " feed-time--stale";

    // Severity badge
    var sevBadge = "";
    if (sev === "critical") sevBadge = '<span class="feed-sev feed-sev--critical">Critical</span>';
    else if (sev === "high") sevBadge = '<span class="feed-sev feed-sev--high">High</span>';
    else if (sev === "medium") sevBadge = '<span class="feed-sev feed-sev--medium">Medium</span>';

    var html = '<a class="' + cls + '" href="' + escAttr(link) + '" target="_blank" rel="noopener noreferrer" id="feed-card-' + escAttr(item.id || "") + '">';

    // Left indicator strip
    html += '<div class="feed-indicator"><span class="feed-dot ' + esc(type) + '"></span></div>';

    html += '<div class="feed-body">';
    // Top row: title + time
    html += '<div class="feed-head-row">';
    html += '<div class="feed-title">' + esc(title) + '</div>';
    html += '<span class="' + timeClass + '">' + esc(ta || "") + '</span>';
    html += '</div>';

    // Summary
    if (summary) html += '<div class="feed-summary-line">' + esc(summary) + '</div>';

    // Meta row: area + source + severity + verification
    html += '<div class="feed-meta">';
    html += '<span class="feed-meta-pill feed-meta-pill--area"><span class="material-icons feed-meta-icon">location_on</span>' + esc(area) + '</span>';
    html += '<span class="feed-meta-pill feed-meta-pill--source">' + esc(sourceName) + '</span>';
    html += '<span class="feed-meta-pill feed-meta-pill--verify feed-meta-pill--verify-' + esc(verify) + '">' + esc(verifyLabel) + '</span>';
    if (sevBadge) html += sevBadge;
    html += '</div>';

    html += '</div></a>';
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

  function renderLiveFeed(activeItems, recentItems) {
    var list = getLiveFeedListEl();
    if (!list) return;
    activeItems = applyFeedUiFilters(activeItems || []);
    if (!activeItems.length) {
      list.innerHTML = '<div class="empty-state">No verified incidents in this window. Check other tabs.</div>';
      return;
    }
    var html = "";
    activeItems.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  function renderConfirmedFeed(confirmedItems) {
    var list = document.getElementById("incidentListDeveloping");
    if (!list) return;
    confirmedItems = applyFeedUiFilters(confirmedItems || []);
    if (!confirmedItems || confirmedItems.length === 0) {
      list.innerHTML =
        '<div class="empty-state">No developing incidents right now.</div>';
      return;
    }
    var html = '<div class="feed-live-stale-note" role="note">Developing incidents are still being confirmed. Treat them as early reports, not final records.</div>';
    confirmedItems.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  function renderContextFeed(contextItems) {
    var list = document.getElementById("incidentListOfficial");
    if (!list) return;
    contextItems = applyFeedUiFilters(contextItems || []);

    if (!contextItems || contextItems.length === 0) {
      list.innerHTML = '<div class="empty-state">No official updates in this window.</div>';
      return;
    }
    var html = "";
    contextItems.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  function autoSelectBestLane(verifiedItems, developingItems, officialItems) {
    if (verifiedItems && verifiedItems.length > 0) return;
    var best = "verified";
    if (developingItems && developingItems.length > 0) best = "developing";
    else if (officialItems && officialItems.length > 0) best = "official";
    if (best === "verified") return;
    activeFeedTab = best;
    var tabs = document.querySelectorAll(".feed-subtab");
    tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-feedtab") === best); });
    document.querySelectorAll(".feed-tab-content").forEach(function (panel) {
      panel.classList.toggle("active", panel.id === "feedTab" + capitalize(best));
    });
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
    var liveA = data.filter(function (x) {
      var s = x.live_section || (x.incident && x.incident.live_section);
      return s === "active_now" || x.feed_tab === "now";
    });
    var liveR = data.filter(function (x) {
      var s = x.live_section || (x.incident && x.incident.live_section);
      return s === "recent_local";
    });
    if (!liveA.length && !liveR.length) {
      liveA = data.filter(function (x) { return x.feed_tab === "verified" || x.feed_tab === "live"; });
    }
    renderLiveFeed(liveA, liveR);
    renderConfirmedFeed(data.filter(function (x) { return x.feed_tab === "developing" || x.feed_tab === "confirmed"; }));
    renderContextFeed(data.filter(function (x) { return x.feed_tab === "official"; }));
    renderTrendsMapLane(data);
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

  var _scannerAiCache = {};
  var _scannerAiPending = false;

  function processAndRenderScanner(calls) {
    lastScannerCallsRef = calls.slice();
    var intelFpBefore = getScannerIntelFingerprint();
    extractScannerIntel(calls);
    var intelFpAfter = getScannerIntelFingerprint();
    renderScannerCalls(calls);
    if (allIncidentData.length > 0 && intelFpBefore !== intelFpAfter) {
      renderLiveFeed(lastLiveActiveItems, lastLiveRecentItems);
    }
    requestScannerAiSummaries(calls);
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

    // dedupe: skip same talkgroup within 30s
    var deduped = [];
    var dedupSeen = {};
    filtered.forEach(function (c) {
      var tg = String(c.talkgroup_num || c.talkgroup || "");
      var t = c.time ? new Date(c.time).getTime() : 0;
      var key = tg + "_" + Math.floor(t / 30000);
      if (dedupSeen[key]) return;
      dedupSeen[key] = true;
      deduped.push(c);
    });

    if (deduped.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:24px 16px;">No transmissions match your filters.</div>';
      updateMainPlayer([]);
      return;
    }

    var html = "";
    deduped.slice(0, 30).forEach(function (call, idx) {
      var dept = resolveScannerDept(call);
      var len = call.duration != null ? parseFloat(call.duration) : (call.len ? parseFloat(call.len) : 0);
      var startTime = call.time ? new Date(call.time) : (call.start_time ? new Date(call.start_time) : null);
      var ta = startTime ? timeAgo(startTime) : "";
      var audioUrl = call.url || call.audio_url || "";
      var cat = dept.cat;
      var catLabel = cat === "police" ? "Police" : cat === "fire" ? "Fire" : cat === "ems" ? "EMS" : "Scanner";
      var aiSum = getAiSummaryForCall(call);
      var summary = aiSum && aiSum.summary ? aiSum.summary : scannerSummaryText(call, dept, catLabel);
      var freqHz = call.freq || 0;
      var freqMHz = freqHz ? (freqHz / 1e6).toFixed(4) : "";
      var isSelected = idx === _scannerSelectedIdx;

      html += '<div class="sc-card sc-card--' + esc(cat) + (isSelected ? ' sc-card--active' : '') + '" data-sc-idx="' + idx + '">';

      // Row 1: agency + play + time
      html += '<div class="sc-card-top">';
      html += '<div class="sc-card-agency-col">';
      html += '<span class="sc-card-agency">' + esc(dept.agency || dept.name) + '</span>';
      if (dept.dept && dept.dept !== dept.agency) html += '<span class="sc-card-dept">' + esc(dept.dept) + '</span>';
      html += '</div>';
      if (audioUrl) {
        html += '<button type="button" class="sc-row-play scanner-play-btn" data-audio="' + escAttr(audioUrl) + '" data-sc-idx="' + idx + '" title="Play">';
        html += '<span class="material-icons">play_arrow</span></button>';
      }
      html += '<span class="sc-card-time">' + esc(ta || "\u2014") + '</span>';
      html += '</div>';

      // Row 2: summary
      html += '<div class="sc-card-summary">' + esc(summary) + '</div>';

      // Row 3: meta pills — discipline + municipality + duration (no confidence)
      html += '<div class="sc-card-pills">';
      html += '<span class="sc-pill sc-pill--' + esc(cat) + '">' + esc(catLabel) + '</span>';
      if (dept.location) html += '<span class="sc-pill">' + esc(dept.location) + '</span>';
      if (len > 0) html += '<span class="sc-pill">' + len.toFixed(0) + 's</span>';
      if (aiSum) html += '<span class="sc-pill sc-pill--ai">AI summary</span>';
      html += '</div>';

      // Expandable details
      html += '<details class="sc-card-expand">';
      html += '<summary>Technical details</summary>';
      html += '<div class="sc-card-raw">TG ' + esc(String(call.talkgroup_num || call.talkgroup || "\u2014"));
      if (freqMHz) html += ' · ' + esc(freqMHz) + ' MHz';
      if (dept.channel) html += ' · ' + esc(dept.channel);
      html += '</div>';
      if (call.talkgroup_tag) html += '<div class="sc-card-raw">' + esc(call.talkgroup_tag) + '</div>';
      if (call.talkgroup_description && call.talkgroup_description !== call.talkgroup_tag) {
        html += '<div class="sc-card-raw">' + esc(call.talkgroup_description) + '</div>';
      }
      html += '</details>';
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
