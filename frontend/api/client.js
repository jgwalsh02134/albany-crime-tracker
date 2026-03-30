(function (global) {
  "use strict";

  function requestJSON(url, options) {
    return fetch(url, options).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function createApiClient(baseUrl) {
    var base = baseUrl || "";
    function toQuery(params) {
      if (!params) return "";
      var parts = [];
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v === undefined || v === null || v === "") return;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
      });
      return parts.length ? "?" + parts.join("&") : "";
    }
    return {
      getIncidents: function () { return requestJSON(base + "/api/crimes"); },
      getPersistedIncidents: function (params) { return requestJSON(base + "/api/incidents" + toQuery(params)); },
      getIncidentMarkers: function (params) { return requestJSON(base + "/api/incidents/map" + toQuery(params)); },
      getIncidentSummary: function (params) { return requestJSON(base + "/api/incidents/summary" + toQuery(params)); },
      getIncidentTrends: function (params) { return requestJSON(base + "/api/incidents/trends" + toQuery(params)); },
      getScannerCalls: function () { return requestJSON(base + "/api/scanner/calls"); },
      getScannerTalkgroups: function () { return requestJSON(base + "/api/scanner/talkgroups"); },
      getSituation: function () { return requestJSON(base + "/api/situation"); },
      getDailySummary: function () { return requestJSON(base + "/api/daily_summary"); },
      getMonthlySummary: function () { return requestJSON(base + "/api/monthly_summary"); },
      getSocialIntel: function () { return requestJSON(base + "/api/social_intel"); },
      getMethodology: function () { return requestJSON(base + "/api/methodology"); },
      getDirectoryPart: function (path) { return requestJSON(base + path); },
      streamChat: function (payload) {
        return fetch(base + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }
    };
  }

  global.ACTApiClient = { createApiClient: createApiClient, requestJSON: requestJSON };
})(window);

