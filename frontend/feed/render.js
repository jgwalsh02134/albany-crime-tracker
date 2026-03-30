(function (global) {
  "use strict";

  function renderEmptyState(container, message) {
    if (!container) return;
    container.innerHTML = '<div class="empty-state">' + (global.ACTUtils ? global.ACTUtils.esc(message) : message) + "</div>";
  }

  function renderLoadingState(container, message) {
    if (!container) return;
    container.innerHTML = '<div class="empty-state">' + (global.ACTUtils ? global.ACTUtils.esc(message) : message) + "</div>";
  }

  function renderErrorState(container, message) {
    if (!container) return;
    container.innerHTML = '<div class="empty-state">' + (global.ACTUtils ? global.ACTUtils.esc(message) : message) + "</div>";
  }

  global.ACTFeed = {
    renderEmptyState: renderEmptyState,
    renderLoadingState: renderLoadingState,
    renderErrorState: renderErrorState
  };
})(window);

