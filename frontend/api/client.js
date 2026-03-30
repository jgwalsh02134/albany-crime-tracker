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
    return {
      getIncidents: function () { return requestJSON(base + "/api/crimes"); },
      getScannerCalls: function () { return requestJSON(base + "/api/scanner/calls"); },
      getScannerTalkgroups: function () { return requestJSON(base + "/api/scanner/talkgroups"); },
      getSituation: function () { return requestJSON(base + "/api/situation"); },
      getDailySummary: function () { return requestJSON(base + "/api/daily_summary"); },
      getMonthlySummary: function () { return requestJSON(base + "/api/monthly_summary"); },
      getSocialIntel: function () { return requestJSON(base + "/api/social_intel"); },
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

