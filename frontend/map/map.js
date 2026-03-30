(function (global) {
  "use strict";

  function mountMapUnavailableMessage(el, reason) {
    if (!el) return;
    var msg = reason || "Map unavailable";
    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:13px;">' +
      (global.ACTUtils ? global.ACTUtils.esc(msg) : msg) +
      "</div>";
  }

  global.ACTMap = {
    mountMapUnavailableMessage: mountMapUnavailableMessage
  };
})(window);

