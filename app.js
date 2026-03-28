/* Albany County Crime Tracker v7 — app.js
   Mobile-first, feed-first, card-based, touch-optimized.
   Views: Feed (Live/News tabs), Map, Scanner, AI Chat, More */

(function () {
  "use strict";

  var API = "";
  if (API.indexOf("__") === 0) API = "http://" + location.hostname + ":8000";
  var REFRESH_MS = 180000;
  var SCANNER_REFRESH_MS = 45000;

  // State
  var map, markerGroup, trendsChart, tileLayer;
  var mapReady = false;
  var chatHistory = [];
  var activeView = "feed";
  var activeFeedTab = "live";       // "live" or "news"
  var scannerAudio = null;
  var mainAudio    = null;
  var mainProgressTimer = null;
  var scannerIntelItems = [];
  var mapInitialized = false;
  var pendingMarkerData = null;
  var activeMapFilter = "all";
  var allIncidentData = [];          // holds all crime articles for tab filtering

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
    // ── Primary 5-digit OpenMHz IDs ─────────────────────────────────────────
    "15202": { name: "Albany County Law Dispatch", cat: "police", priority: "high",   location: "County-wide" },
    "10702": { name: "Albany County Fire Dispatch",cat: "fire",   priority: "high",   location: "County-wide" },
    "11702": { name: "County Fire Tac",            cat: "fire",   priority: "medium", location: "County-wide" },
    "10003": { name: "Albany County Sheriff",      cat: "police", priority: "high",   location: "County-wide" },
    "13102": { name: "Albany PD Dispatch",         cat: "police", priority: "high",   location: "City of Albany" },
    "11003": { name: "Albany County EMS",          cat: "ems",    priority: "high",   location: "County-wide" },
    "10921": { name: "Albany County Interop",      cat: "police", priority: "medium", location: "County-wide" },
    "10922": { name: "Multi-Agency Tac",           cat: "police", priority: "medium", location: "County-wide" },
    "10923": { name: "Emergency Ops",              cat: "police", priority: "high",   location: "County-wide" },
    "10925": { name: "Albany County OEM",          cat: "police", priority: "medium", location: "County-wide" },
    "18301": { name: "Albany County Law Ops",      cat: "police", priority: "high",   location: "County-wide" },
    "13202": { name: "Albany PD Ops",              cat: "police", priority: "high",   location: "City of Albany" },
    "15202": { name: "Albany County Law Dispatch", cat: "police", priority: "high",   location: "County-wide" },
    // ── Legacy 4-digit IDs ───────────────────────────────────────────────────
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
    initFeedTabs();
    initChat();
    startClock();
    fetchSituation();
    fetchIncidents();
    fetchTrends();
    fetchScannerCalls();
    fetchDailySummary();
    fetchMonthlySummary();
    fetchSocialIntel();

    setInterval(function () {
      fetchSituation();
      fetchIncidents();
    }, REFRESH_MS);

    setInterval(fetchScannerCalls, SCANNER_REFRESH_MS);
    setInterval(fetchSocialIntel, 900000);   // social intel every 15 min
  });

  // ── FEED SUB-TABS (Live / News) ────────────────────────────────
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

        // Lazy-load monthly summary when News tab first opened
        if (target === "news") {
          var card = document.getElementById("monthlySummaryCard");
          if (card && card.querySelector(".skeleton-card")) {
            fetchMonthlySummary();
          }
        }
      });
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

      setTimeout(function () { map.invalidateSize(); }, 300);
      el.style.touchAction = "none";
    } catch (err) {
      console.error("Map init error:", err);
      // Degrade gracefully — show a message in the map container
      if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:13px;">Map unavailable</div>';
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
        if (pendingMarkerData) plotMarkers(pendingMarkerData);
      });
    });
  }

  function plotMarkers(data) {
    if (!markerGroup) return;
    markerGroup.clearLayers();

    var filtered = activeMapFilter === "all"
      ? data
      : data.filter(function (d) { return (d.crime_type || "other") === activeMapFilter; });

    filtered.forEach(function (item) {
      var lat = parseFloat(item.latitude);
      var lng = parseFloat(item.longitude);
      if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;

      var type = item.crime_type || "other";
      var color = type === "violent" ? "#e05252" :
                  type === "property" ? "#d9953a" : "#4d8fdb";

      var circle = L.circleMarker([lat, lng], {
        radius: 7,
        fillColor: color,
        color: "#fff",
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.85
      });

      var ta = item.pubDate ? timeAgo(new Date(item.pubDate)) : "";
      var loc = item.matched_location
        ? esc(item.matched_location.replace(/\b\w/g, function(c){ return c.toUpperCase(); }))
        : "";

      var popup = '<div style="font-family:Satoshi,system-ui,sans-serif;max-width:240px;">';
      popup += '<div style="font-size:12px;font-weight:600;line-height:1.4;margin-bottom:6px;">' + esc(item.title || "Incident") + '</div>';
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
      popup += '</div>';

      circle.bindPopup(popup, { closeButton: true, autoPan: true, autoPanPaddingTopLeft: [10, 60], maxWidth: 260 });
      markerGroup.addLayer(circle);
    });
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

  // ── SITUATION BAR ─────────────────────────────────────────────
  function fetchSituation() {
    fetch(API + "/api/situation")
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
        setNum("statTotal", stats.total_incidents || 0);
        setNum("statViolent", stats.violent || 0);
        setNum("statProperty", stats.property || 0);
        setNum("statRecent", stats.recent_48h || 0);

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
        if (status) status.textContent = "Reconnecting";
      });
  }

  // ── INCIDENTS ─────────────────────────────────────────────────
  function fetchIncidents() {
    fetch(API + "/api/crimes")
      .then(ok)
      .then(function (r) {
        if (r.status !== "ok" || !r.data) return;
        allIncidentData = r.data;
        pendingMarkerData = r.data;
        if (mapReady) plotMarkers(r.data);
        renderLiveFeed(r.data.filter(function (x) { return x.feed_tab === "live"; }));
        renderNewsFeed(r.data.filter(function (x) { return x.feed_tab === "news"; }));
      })
      .catch(function (err) {
        console.error("Incidents fetch error:", err);
      });
  }

  var OFFICIAL_SOURCES = new Set([
    "official @albanypolice", "official @acsotweet", "official @colonie_police",
    "official @pdbethlehem", "official @nyspolice",
    "nysp blotter", "nixle alert", "daily gazette blotter",
  ]);

  function isOfficialSource(src) {
    return OFFICIAL_SOURCES.has((src || "").toLowerCase());
  }

  function buildIncidentCard(item) {
    var type = item.crime_type || "other";
    var hood = item.neighborhood || item.matched_location || "";
    var primarySrc = item.source || "";
    var srcs = (Array.isArray(item.sources) && item.sources.length)
      ? item.sources : (primarySrc ? [primarySrc] : []);
    var ta = item.pubDate ? timeAgo(new Date(item.pubDate)) : "";
    var link = item.link || "#";
    var official = isOfficialSource(primarySrc);
    var multiSource = srcs.length > 1;

    var cls = "feed-item" + (official ? " feed-item-official" : "");
    var html = '<a class="' + cls + '" href="' + escAttr(link) + '" target="_blank" rel="noopener">';
    html += '<span class="feed-dot ' + esc(type) + '"></span>';
    html += '<div class="feed-body">';
    html += '<div class="feed-title">' + esc(item.title || "Untitled") + '</div>';
    html += '<div class="feed-meta">';
    if (hood) html += '<span class="feed-hood">' + esc(capitalize(hood)) + '</span>';
    if (official) {
      html += '<span class="official-badge">Official</span>';
    }
    if (multiSource) {
      html += '<span class="multi-source">' + srcs.map(esc).join('<span class="src-sep"> + </span>') + '</span>';
    } else if (srcs.length === 1) {
      html += '<span>' + esc(srcs[0]) + '</span>';
    }
    if (ta) html += '<span>' + esc(ta) + '</span>';
    html += '</div></div></a>';
    return html;
  }

  function renderLiveFeed(liveItems) {
    var list = document.getElementById("incidentListLive");
    if (!list) return;

    var html = "";

    // Scanner intel alerts at very top — only critical events, clickable to Scanner tab
    if (scannerIntelItems.length > 0) {
      scannerIntelItems.forEach(function (intel) {
        var catLabel = intel.cat === "fire" ? "Fire" : intel.cat === "ems" ? "EMS" : "Police";
        var catIcon  = intel.cat === "fire" ? "local_fire_department"
                     : intel.cat === "ems"  ? "emergency"
                     :                        "local_police";
        var borderCls = " scanner-intel-" + (intel.cat || "police");
        var durText = intel.len > 0 ? intel.len.toFixed(0) + "s transmission" : "active";
        // Clickable card — switches to Scanner tab
        html += '<div class="feed-item scanner-intel' + borderCls + ' scanner-intel-clickable" role="button" tabindex="0" title="View in Scanner tab" onclick="switchView(\'scanner\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')switchView(\'scanner\')">';
        html += '<span class="feed-dot scanner-dot scanner-dot-' + esc(intel.cat || "police") + '"></span>';
        html += '<div class="feed-body">';
        // Title: "icon Dept Name — Location ›"
        html += '<div class="feed-title">';
        html += '<span class="material-icons" style="font-size:13px;vertical-align:-2px;margin-right:3px;">' + catIcon + '</span>';
        html += '<strong>' + esc(intel.tgName) + '</strong>';
        if (intel.location) html += '<span class="scanner-call-loc"> \u2014 ' + esc(intel.location) + '</span>';
        html += '<span class="scanner-intel-arrow material-icons" style="font-size:12px;opacity:0.4;margin-left:4px;vertical-align:-1px;">chevron_right</span>';
        html += '</div>';
        // Sub-line: duration
        if (intel.len > 0) {
          html += '<div class="scanner-call-detail">' + esc(durText) + '</div>';
        }
        html += '<div class="feed-meta">';
        html += '<span class="scanner-feed-badge scanner-badge-' + esc(intel.cat || "police") + '">SCANNER · ' + esc(catLabel) + '</span>';
        html += '<span>' + esc(intel.time) + '</span>';
        html += '<span class="scanner-intel-tap-hint">Tap for scanner</span>';
        html += '</div></div></div>';
      });
    }

    if (!liveItems || liveItems.length === 0) {
      if (scannerIntelItems.length === 0) {
        html += '<div class="empty-state">No breaking incidents in the last 72 hours.<br>Check the News tab for recent reports.</div>';
      }
    } else {
      // Strict newest-first: sort by pubDate descending before rendering
      var sorted = liveItems.slice().sort(function (a, b) {
        var ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        var tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return tb - ta;
      });
      sorted.forEach(function (item) { html += buildIncidentCard(item); });
    }

    list.innerHTML = html;
  }

  function renderNewsFeed(newsItems) {
    var list = document.getElementById("incidentListNews");
    if (!list) return;

    if (!newsItems || newsItems.length === 0) {
      list.innerHTML = '<div class="empty-state">No news reports in the last 5 days.</div>';
      return;
    }

    // Newest-first within the News tab too
    var sorted = newsItems.slice().sort(function (a, b) {
      var ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      var tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });
    var html = "";
    sorted.forEach(function (item) { html += buildIncidentCard(item); });
    list.innerHTML = html;
  }

  // Legacy fallback — kept for compatibility with any other callers
  function renderIncidentList(data) {
    if (!data) return;
    renderLiveFeed(data.filter(function (x) { return x.feed_tab === "live"; }));
    renderNewsFeed(data.filter(function (x) { return x.feed_tab === "news"; }));
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

    fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, history: chatHistory.slice(-10) })
    }).then(function (res) {
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

      function handleDataLine(trimmedLine) {
        if (!trimmedLine || streamDone) return;
        if (!trimmedLine.startsWith("data:")) return;
        var data = trimmedLine.substring(5).replace(/^\s/, "").trim();
        if (!data) return;
        if (data === "[DONE]") {
          streamDone = true;
          return;
        }
        try {
          var parsed = JSON.parse(data);
          if (typeof parsed.content === "string") {
            fullText += parsed.content;
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
            handleDataLine(line.replace(/\s+$/, ""));
          });
        } else {
          buffer = lines.pop() || "";
          lines.forEach(function (line) {
            handleDataLine(line.replace(/\s+$/, ""));
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
      if (bubble) bubble.innerHTML = '<p style="color:var(--red);">Failed to connect. Check your connection.</p>';
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
    fetch(API + "/api/scanner/calls")
      .then(ok)
      .then(function (data) {
        if (data.calls && data.calls.length > 0) {
          processAndRenderScanner(data.calls);
        } else {
          return fetchScannerDirect();
        }
      })
      .catch(function () {
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

  function processAndRenderScanner(calls) {
    extractScannerIntel(calls);
    renderScannerCalls(calls);
    // Refresh live feed so scanner intel cards appear at the top immediately
    if (allIncidentData.length > 0) {
      renderLiveFeed(allIncidentData.filter(function (x) { return x.feed_tab === "live"; }));
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
      var tgInfo = TG_MAP[tg];
      var len = call.duration || call.len || 0;
      var callTime = call.time ? new Date(call.time) : null;

      // Drop anything older than 2 hours
      if (callTime && (now - callTime) > 2 * 60 * 60 * 1000) return;

      // Check critical keywords against TG name + alpha tag + description
      var searchText = [
        tgInfo ? tgInfo.name : "",
        call.talkgroup_tag || "",
        call.talkgroup_description || ""
      ].join(" ").toLowerCase();

      var hasKeyword = CRITICAL_SCANNER_KEYWORDS.some(function (kw) {
        return searchText.indexOf(kw) !== -1;
      });

      // Only show in Live feed if:
      //   (a) high-priority POLICE TG with a meaningful transmission (>= 10s), OR
      //   (b) any TG that contains a critical keyword
      var isHighPolice = tgInfo && tgInfo.priority === "high" && tgInfo.cat === "police" && len >= 10;
      var isCritical   = hasKeyword && len >= 5;

      if (!tgInfo) return;                      // skip unknown TGs in Live feed entirely
      if (!isHighPolice && !isCritical) return; // skip routine dispatches

      // Deduplicate by TG within this render pass
      if (seen[tg]) return;
      seen[tg] = true;

      significant.push({
        tgName:   tgInfo.name,
        location: tgInfo.location || "",
        cat:      tgInfo.cat,
        priority: tgInfo.priority,
        len:      len,
        time:     callTime ? timeAgo(callTime) : "",
        rawTime:  callTime ? callTime.getTime() : 0
      });
    });

    significant.sort(function (a, b) { return b.rawTime - a.rawTime; });
    scannerIntelItems = significant.slice(0, 3); // cap at 3 so they don't dominate the feed
  }

  function renderScannerCalls(calls) {
    var container = document.getElementById("scannerCallsList");
    if (!container) return;

    if (!calls || calls.length === 0) {
      renderScannerFallback();
      return;
    }

    var now = new Date();
    var recentCalls = calls.filter(function (c) {
      var t = c.time ? new Date(c.time) : (c.start_time ? new Date(c.start_time) : null);
      return !t || (now - t) < 6 * 60 * 60 * 1000;
    });

    var html = "";

    html += '<div class="scanner-status-ok">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-5"/></svg>';
    html += ' Receiving radio traffic &nbsp;·&nbsp; ' + calls.length + ' calls logged';
    html += '</div>';

    if (recentCalls.length === 0) {
      html += '<div class="scanner-no-traffic">';
      html += '<span class="material-icons" style="font-size:28px;opacity:0.25;display:block;margin-bottom:6px;">radio</span>';
      html += '<span>No recent traffic in the last 6 hours</span>';
      html += '</div>';
      container.innerHTML = html;
      var tsEl2 = document.getElementById("scannerTimestamp");
      if (tsEl2) tsEl2.textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
      return;
    }

    recentCalls.slice(0, 25).forEach(function (call) {
      var tgRaw   = call.talkgroup_num || call.talkgroupNum || call.talkgroup;
      var tgStr   = tgRaw != null ? String(tgRaw) : "";
      var tgInfo  = tgStr ? TG_MAP[tgStr] : null;
      var tgAlpha = call.talkgroup_tag || call.talkgroupAlpha || call.talkgroup_alpha_tag || "";
      var tgDesc  = call.talkgroup_description || call.talkgroupDescription || "";
      var freqHz  = call.freq || 0;
      var freqMHz = freqHz ? (freqHz / 1e6).toFixed(4) : "";
      var len     = call.duration != null ? parseFloat(call.duration) : (call.len ? parseFloat(call.len) : 0);
      var startTime = call.time ? new Date(call.time) : (call.start_time ? new Date(call.start_time) : null);
      var ta      = startTime ? timeAgo(startTime) : "";
      var audioUrl = call.url || call.audio_url || "";

      // ── Infer category from audio URL path when no TG_MAP match ──────────
      var inferredCat = "other";
      if (!tgInfo && audioUrl) {
        var urlLow = audioUrl.toLowerCase();
        if (/fire|fd|ems|medic|rescue/.test(urlLow)) inferredCat = "fire";
        else if (/ems|med|amb/.test(urlLow))         inferredCat = "ems";
        else if (/pd|police|law|sheriff/.test(urlLow)) inferredCat = "police";
      }
      var cat      = tgInfo ? tgInfo.cat : inferredCat;
      var catLabel = cat === "police" ? "Police" : cat === "fire" ? "Fire" : cat === "ems" ? "EMS" : "";
      var catClass = cat !== "other" ? " scanner-cat-" + cat : "";

      // ── Name + location ──────────────────────────────────────────────────
      var deptName, location;
      if (tgInfo) {
        deptName = tgInfo.name;
        location = tgInfo.location || "";
      } else if (tgAlpha) {
        deptName = tgAlpha; location = "";
      } else if (tgDesc) {
        deptName = tgDesc;  location = "";
      } else if (tgStr) {
        deptName = "TG " + tgStr; location = freqMHz ? freqMHz + " MHz" : "";
      } else {
        deptName = freqMHz ? freqMHz + " MHz" : "Dispatch"; location = "";
      }

      var isHigh = tgInfo && tgInfo.priority === "high";
      var priorityDot = isHigh
        ? '<span class="scanner-priority-dot scanner-dot-' + cat + '"></span>'
        : '';

      // Detail line: freq + duration
      var details = [];
      if (freqMHz) details.push(freqMHz + " MHz");
      if (len > 0)  details.push(len.toFixed(0) + "s");
      var detailLine = details.join(" \u00b7 ");

      html += '<div class="scanner-call-item' + catClass + '">';

      // Top row: priority dot + "Dept Name — Location" + time-ago
      html += '<div class="scanner-call-top">';
      html += '<span class="scanner-call-tg">' + priorityDot + esc(deptName);
      if (location) html += '<span class="scanner-call-loc"> \u2014 ' + esc(location) + '</span>';
      html += '</span>';
      html += '<span class="scanner-call-time">' + esc(ta) + '</span>';
      html += '</div>';

      // Middle detail row: freq · duration (smaller, muted)
      if (detailLine) {
        html += '<div class="scanner-call-detail">' + esc(detailLine) + '</div>';
      }

      // Bottom row: category badge | play button
      html += '<div class="scanner-call-bottom">';
      if (catLabel) {
        html += '<span class="scanner-call-cat scanner-cat-tag-' + esc(cat) + '">' + esc(catLabel) + '</span>';
      }
      if (audioUrl) {
        html += '<button class="scanner-play-btn" data-audio="' + escAttr(audioUrl) + '" title="Play transmission">';
        html += '<span class="material-icons" style="font-size:14px;">play_arrow</span>';
        html += '</button>';
      }
      html += '</div>';

      html += '</div>';
    });

    container.innerHTML = html;
    bindScannerAudio(container);
    updateMainPlayer(recentCalls);

    var tsEl = document.getElementById("scannerTimestamp");
    if (tsEl) tsEl.textContent = "Updated " + new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  }

  // ── Main (top) scanner player — uses clean OpenMHz MP3, no commercials ──
  function updateMainPlayer(calls) {
    var btn    = document.getElementById("mainPlayerBtn");
    var deptEl = document.getElementById("mainPlayerDept");
    var metaEl = document.getElementById("mainPlayerMeta");
    var badge  = document.getElementById("mainPlayerBadge");
    if (!btn || !calls || calls.length === 0) return;

    // Pick the most recent call that has an audio URL
    var call = null;
    for (var i = 0; i < calls.length; i++) {
      if (calls[i].url || calls[i].audio_url) { call = calls[i]; break; }
    }
    if (!call) return;

    var tgStr   = call.talkgroup_num != null ? String(call.talkgroup_num) : "";
    var tgInfo  = tgStr ? TG_MAP[tgStr] : null;
    var deptName = tgInfo ? tgInfo.name
                          : (call.talkgroup_tag || call.talkgroup_alpha_tag || "Dispatch");
    var len      = call.duration != null ? parseFloat(call.duration) : 0;
    var startTime = call.time ? new Date(call.time) : (call.start_time ? new Date(call.start_time) : null);
    var ta       = startTime ? timeAgo(startTime) : "";
    var audioUrl = call.url || call.audio_url || "";

    var cat = tgInfo ? tgInfo.cat : "other";
    var catLabels = { police: "Police", fire: "Fire", ems: "EMS" };

    if (deptEl) deptEl.textContent = deptName;
    if (metaEl) {
      var parts = [];
      if (catLabels[cat]) parts.push(catLabels[cat]);
      if (ta) parts.push(ta);
      if (len > 0) parts.push(len.toFixed(0) + "s");
      metaEl.textContent = parts.join(" \u00b7 ");
    }
    if (badge) badge.style.opacity = "1";

    btn.disabled = !audioUrl;
    btn.setAttribute("data-audio", audioUrl);
    btn.onclick = function () { playMainAudio(btn, audioUrl, len); };
  }

  function playMainAudio(btn, url, len) {
    // Stop any existing main playback
    if (mainAudio) {
      mainAudio.pause();
      mainAudio = null;
    }
    if (mainProgressTimer) {
      clearInterval(mainProgressTimer);
      mainProgressTimer = null;
    }
    var bar = document.getElementById("mainPlayerBar");

    if (btn.classList.contains("playing")) {
      // Tapped while playing → stop
      btn.classList.remove("playing");
      btn.innerHTML = '<span class="material-icons">play_arrow</span>';
      if (bar) bar.style.width = "0%";
      return;
    }

    var audio = new Audio(url);
    mainAudio = audio;

    btn.classList.add("playing");
    btn.innerHTML = '<span class="material-icons">stop</span>';

    // Progress bar
    if (bar && len > 0) {
      bar.style.width = "0%";
      var elapsed = 0;
      mainProgressTimer = setInterval(function () {
        elapsed += 0.5;
        bar.style.width = Math.min((elapsed / len) * 100, 100) + "%";
        if (elapsed >= len) {
          clearInterval(mainProgressTimer);
          mainProgressTimer = null;
        }
      }, 500);
    }

    audio.play().catch(function () {
      btn.classList.remove("playing");
      btn.innerHTML = '<span class="material-icons">play_arrow</span>';
      if (bar) bar.style.width = "0%";
    });

    audio.addEventListener("ended", function () {
      btn.classList.remove("playing");
      btn.innerHTML = '<span class="material-icons">play_arrow</span>';
      if (bar) bar.style.width = "0%";
      if (mainAudio === audio) mainAudio = null;
      if (mainProgressTimer) { clearInterval(mainProgressTimer); mainProgressTimer = null; }
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
