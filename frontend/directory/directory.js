(function (global) {
  "use strict";

  function renderUnavailable(container, message) {
    if (!container) return;
    var msg = message || "Directory data unavailable.";
    container.innerHTML = '<div class="empty-state">' + (global.ACTUtils ? global.ACTUtils.esc(msg) : msg) + "</div>";
  }

  global.ACTDirectory = {
    renderUnavailable: renderUnavailable
  };
})(window);

