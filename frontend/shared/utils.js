(function (global) {
  "use strict";

  function esc(text) {
    if (!text) return "";
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(String(text)));
    return d.innerHTML;
  }

  function setElementHtml(id, html) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
  }

  global.ACTUtils = {
    esc: esc,
    setElementHtml: setElementHtml
  };
})(window);

