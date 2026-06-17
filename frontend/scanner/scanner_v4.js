// Scanner v4 Advanced Frontend — Albany County Crime Tracker
// Self-contained (no ES module exports); attaches to window.ACTScannerV4.
// Features: rich incident cards, critical/all toggle, source badges,
//           30s cache, loading skeleton, lazy audio, municipality display.

(function (global) {
  "use strict";

  // ── Constants ────────────────────────────────────────────────────────────
  var CRITICAL_ENDPOINT = "/scanner/v4/critical";
  var ALL_ENDPOINT      = "/scanner/v4/all";
  var CACHE_TTL_MS      = 30000; // 30 s client-side cache

  // Source badge labels and colours
  var SOURCE_META = {
    scanner:   { label: "Radio",     cls: "sv4-badge--scanner"   },
    "511ny":   { label: "511NY",     cls: "sv4-badge--511ny"     },
    open_data: { label: "Open Data", cls: "sv4-badge--opendata"  },
    social:    { label: "Social",    cls: "sv4-badge--social"    },
    news:      { label: "News",      cls: "sv4-badge--news"      },
  };

  // ── In-memory cache ──────────────────────────────────────────────────────
  var _cache = {
    critical: { data: null, ts: 0 },
    all:      { data: null, ts: 0 },
  };

  function _isFresh(key) {
    return _cache[key].data !== null && (Date.now() - _cache[key].ts) < CACHE_TTL_MS;
  }

  // ── Fetch helpers ────────────────────────────────────────────────────────
  async function loadCriticalScannerFeed() {
    if (_isFresh("critical")) return _cache.critical.data;
    try {
      var res = await fetch(CRITICAL_ENDPOINT);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      _cache.critical = { data: data, ts: Date.now() };
      return data;
    } catch (e) {
      console.warn("[ScannerV4] critical feed error:", e);
      return _cache.critical.data || [];
    }
  }

  async function loadAllScannerFeed() {
    if (_isFresh("all")) return _cache.all.data;
    try {
      var res = await fetch(ALL_ENDPOINT);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      _cache.all = { data: data, ts: Date.now() };
      return data;
    } catch (e) {
      console.warn("[ScannerV4] all feed error:", e);
      return _cache.all.data || [];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function _fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) { return ""; }
  }

  function _sourceBadge(source) {
    var meta = SOURCE_META[source] || { label: _esc(source || "scanner"), cls: "sv4-badge--scanner" };
    return '<span class="sv4-badge ' + meta.cls + '">' + meta.label + "</span>";
  }

  function _criticalityBar(score) {
    var pct = Math.min(100, Math.max(0, score));
    var cls = pct >= 80 ? "sv4-bar--high" : pct >= 50 ? "sv4-bar--med" : "sv4-bar--low";
    return (
      '<div class="sv4-crit-wrap" title="Criticality ' + Math.round(pct) + '/100">' +
        '<div class="sv4-crit-bar ' + cls + '" style="width:' + pct + '%"></div>' +
      "</div>"
    );
  }

  // ── Card renderer ────────────────────────────────────────────────────────
  function renderScannerCard(call) {
    var isCrit = call.is_critical;
    var units  = Array.isArray(call.units) && call.units.length
      ? _esc(call.units.join(", "))
      : "N/A";
    var loc    = call.location ? _esc(call.location) : "";
    var mapBtn = (call.map_link && call.map_link !== "/map?lat=&lon=")
      ? '<a class="sv4-action-btn" href="' + _esc(call.map_link) + '" target="_blank" rel="noopener">' +
          '<span class="material-icons" style="font-size:14px;vertical-align:middle;">map</span> Map</a>'
      : "";

    return (
      '<div class="sv4-card' + (isCrit ? " sv4-card--critical" : "") + '" data-id="' + _esc(call.id) + '">' +
        '<div class="sv4-card-header">' +
          '<span class="sv4-muni">' + _esc(call.municipality || "Albany County") + "</span>" +
          _sourceBadge(call.source) +
          (isCrit ? '<span class="sv4-badge sv4-badge--critical"><span class="live-pulse"></span>Critical</span>' : "") +
          '<span class="sv4-time">' + _fmtTime(call.timestamp) + "</span>" +
        "</div>" +
        (call.ai_summary
          ? '<div class="sv4-summary">' + _esc(call.ai_summary) + "</div>"
          : "") +
        (call.transcript_snippet
          ? '<div class="sv4-transcript">' + _esc(call.transcript_snippet) + "</div>"
          : "") +
        '<div class="sv4-meta">' +
          (call.type && call.type !== "Unknown"
            ? '<span class="sv4-type">' + _esc(call.type) + "</span>" : "") +
          (loc ? '<span class="sv4-loc"><span class="material-icons" style="font-size:12px;vertical-align:middle;">place</span> ' + loc + "</span>" : "") +
          '<span class="sv4-units">Units: ' + units + "</span>" +
        "</div>" +
        _criticalityBar(call.criticality || 0) +
        '<div class="sv4-actions">' +
          mapBtn +
          '<button class="sv4-action-btn" onclick="window.ACTScannerV4.explainCall(\'' + _esc(call.id) + '\')">' +
            '<span class="material-icons" style="font-size:14px;vertical-align:middle;">psychology</span> Explain</button>' +
        "</div>" +
      "</div>"
    );
  }

  // ── Skeleton loader ──────────────────────────────────────────────────────
  function _skeletonHTML(n) {
    var out = "";
    for (var i = 0; i < (n || 3); i++) {
      out += '<div class="sv4-skeleton">' +
        '<div class="skeleton skeleton-text"></div>' +
        '<div class="skeleton skeleton-text short"></div>' +
        '<div class="skeleton skeleton-text" style="width:60%"></div>' +
      "</div>";
    }
    return out;
  }

  // ── Main render ──────────────────────────────────────────────────────────
  var _showCriticalOnly = true;

  async function renderFeed(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = _skeletonHTML(4);

    var data;
    try {
      data = _showCriticalOnly
        ? await loadCriticalScannerFeed()
        : await loadAllScannerFeed();
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Scanner v4 feed unavailable.</div>';
      return;
    }

    if (!data || !data.length) {
      container.innerHTML =
        '<div class="empty-state">' +
          (_showCriticalOnly
            ? "No critical incidents at this time. Toggle <strong>Show All</strong> to see all traffic."
            : "No scanner traffic available right now.") +
        "</div>";
      return;
    }

    container.innerHTML = data.map(renderScannerCard).join("");
  }

  // ── Toggle button ────────────────────────────────────────────────────────
  function initToggle(btnId, containerId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    _updateToggleLabel(btn);
    btn.addEventListener("click", function () {
      _showCriticalOnly = !_showCriticalOnly;
      _updateToggleLabel(btn);
      renderFeed(containerId);
    });
  }

  function _updateToggleLabel(btn) {
    btn.textContent = _showCriticalOnly ? "Show All" : "Critical Only";
    btn.classList.toggle("sc-filter--active", !_showCriticalOnly);
  }

  // ── Explain stub ─────────────────────────────────────────────────────────
  function explainCall(id) {
    // Future: open AI explain sheet for this call id
    console.log("[ScannerV4] explainCall:", id);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  global.ACTScannerV4 = {
    loadCriticalScannerFeed: loadCriticalScannerFeed,
    loadAllScannerFeed:      loadAllScannerFeed,
    renderScannerCard:       renderScannerCard,
    renderFeed:              renderFeed,
    initToggle:              initToggle,
    explainCall:             explainCall,
  };

  console.log("[ScannerV4] frontend ready — critical filter, rich cards, multi-source badges.");
})(window);