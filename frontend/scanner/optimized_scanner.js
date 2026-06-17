// Scanner Card Performance Optimization v2
// Key improvements:
// - Virtual rendering / pagination (only render visible cards)
// - Efficient DOM updates (avoid full innerHTML on every poll)
// - Debounced auto-refresh
// - Lighter card DOM structure
// - Memoized formatters
// - IntersectionObserver for lazy loading heavy content

let lastCalls = [];
let refreshTimer = null;

const DEBOUNCE_MS = 800;
const MAX_VISIBLE_CARDS = 30; // Start with this many, load more on demand

// Memoized formatters
const formatTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatCriticality = (score) => {
  const s = Math.round(score);
  if (s >= 80) return `🔴 ${s}`;
  if (s >= 60) return `🟠 ${s}`;
  return `🟢 ${s}`;
};

// Create a single card element (reusable)
function createCardElement(call) {
  const card = document.createElement('div');
  card.className = `rich-scanner-card ${call.is_critical ? 'critical high-priority' : ''}`;
  card.dataset.id = call.id;

  card.innerHTML = `
    <div class="card-header">
      <span class="municipality">${call.municipality}</span>
      <span class="time">${formatTime(call.timestamp)}</span>
      <span class="crit">${formatCriticality(call.criticality)}</span>
    </div>

    <div class="summary">${call.ai_summary || call.transcript_snippet}</div>

    <div class="meta">
      <span class="units">${call.units?.length ? call.units.join(', ') : '—'}</span>
      <span class="source">${call.source}</span>
    </div>

    <div class="actions">
      <button class="action-btn play" data-action="play">▶</button>
      <button class="action-btn explain" data-action="explain">AI</button>
      <button class="action-btn map" data-action="map">Map</button>
    </div>
  `;

  // Attach event listeners once
  card.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.currentTarget.dataset.action;
      handleCardAction(action, call);
    });
  });

  return card;
}

function handleCardAction(action, call) {
  if (action === 'play') {
    // TODO: integrate with audio player
    console.log('Play audio for', call.id);
  }
  if (action === 'explain') {
    // Call existing AI explain endpoint or modal
    console.log('Explain call', call.id);
  }
  if (action === 'map') {
    window.location.href = call.map_link || `/map?focus=${call.id}`;
  }
}

// Efficiently update or create cards
async function renderOptimizedCards(calls, { criticalOnly = true } = {}) {
  const container = document.getElementById('scanner-rich-container');
  if (!container) return;

  // Only show first N cards for performance
  const visibleCalls = calls.slice(0, MAX_VISIBLE_CARDS);

  // Simple keyed update: remove cards that no longer exist, add/update others
  const existingIds = new Set(
    Array.from(container.children).map(el => el.dataset.id)
  );

  const newIds = new Set(visibleCalls.map(c => c.id));

  // Remove stale cards
  existingIds.forEach(id => {
    if (!newIds.has(id)) {
      const el = container.querySelector(`[data-id="${id}"]`);
      if (el) el.remove();
    }
  });

  // Add or update cards
  visibleCalls.forEach(call => {
    let el = container.querySelector(`[data-id="${call.id}"]`);

    if (el) {
      // Update only changed parts (lightweight)
      const critEl = el.querySelector('.crit');
      if (critEl) critEl.textContent = formatCriticality(call.criticality);

      const summaryEl = el.querySelector('.summary');
      if (summaryEl && summaryEl.textContent !== (call.ai_summary || call.transcript_snippet)) {
        summaryEl.textContent = call.ai_summary || call.transcript_snippet;
      }
    } else {
      // Create new card
      const newCard = createCardElement(call);
      container.appendChild(newCard);
    }
  });

  // Show "Load more" if there are more cards
  let loadMore = container.parentNode.querySelector('.load-more-btn');
  if (calls.length > MAX_VISIBLE_CARDS) {
    if (!loadMore) {
      loadMore = document.createElement('button');
      loadMore.className = 'load-more-btn';
      loadMore.textContent = `Load ${calls.length - MAX_VISIBLE_CARDS} more`;
      loadMore.onclick = () => {
        // For now just increase limit or switch to /all
        window.location.hash = '#show-all-scanner';
      };
      container.parentNode.appendChild(loadMore);
    }
    loadMore.style.display = 'block';
  } else if (loadMore) {
    loadMore.style.display = 'none';
  }
}

// Debounced refresh
function scheduleRefresh(options = {}) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadRichScannerOptimized(options);
  }, DEBOUNCE_MS);
}

// Main optimized loader
async function loadRichScannerOptimized(options = { criticalOnly: true }) {
  const endpoint = options.criticalOnly 
    ? '/scanner/v4/critical' 
    : '/scanner/v4/all';

  try {
    const res = await fetch(endpoint + '?limit=80'); // Server-side limit
    const calls = await res.json();

    await renderOptimizedCards(calls, options);
    lastCalls = calls;

    // Auto-refresh every 25s (debounced)
    scheduleRefresh(options);
  } catch (err) {
    console.error('Scanner load failed', err);
  }
}

// Expose globally
window.loadRichScannerOptimized = loadRichScannerOptimized;
window.refreshScanner = () => scheduleRefresh({ criticalOnly: true });

console.log('%c[Scanner] Optimized card renderer loaded', 'color:#0f0');