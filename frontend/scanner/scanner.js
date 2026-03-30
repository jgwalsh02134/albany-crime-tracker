(function (global) {
  "use strict";

  function renderUnavailable(containerId, message) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var msg = message || "Scanner feed temporarily unavailable.";
    el.innerHTML = '<div class="empty-state">' + (global.ACTUtils ? global.ACTUtils.esc(msg) : msg) + "</div>";
  }

  global.ACTScanner = {
    renderUnavailable: renderUnavailable
  };
})(window);

