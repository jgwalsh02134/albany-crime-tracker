(function (global) {
  "use strict";

  function renderUnavailable(container, message) {
    if (!container) return;
    var msg = message || "AI chat is temporarily unavailable.";
    container.innerHTML = '<p style="color:var(--red);">' + (global.ACTUtils ? global.ACTUtils.esc(msg) : msg) + "</p>";
  }

  global.ACTChat = {
    renderUnavailable: renderUnavailable
  };
})(window);

