// Rich Scanner v4 Frontend - Drop-in replacement
// Fetches from /scanner/v4/critical and renders beautiful cards

async function loadRichScanner(options = { criticalOnly: true }) {
  const endpoint = options.criticalOnly 
    ? '/scanner/v4/critical' 
    : '/scanner/v4/all';
  
  try {
    const res = await fetch(endpoint);
    const calls = await res.json();
    renderRichCards(calls, options.criticalOnly);
  } catch (e) {
    console.error('Failed to load scanner v4', e);
  }
}

function renderRichCards(calls, criticalOnly) {
  const container = document.getElementById('scanner-content') || document.querySelector('.scanner-tab');
  if (!container) return;

  container.innerHTML = `
    <div class="scanner-controls">
      <button onclick="loadRichScanner({criticalOnly: true})" class="${criticalOnly ? 'active' : ''}">Critical Only</button>
      <button onclick="loadRichScanner({criticalOnly: false})">Show All</button>
      <span class="live-dot"></span> Live • ${calls.length} calls
    </div>
    <div class="rich-cards">
      ${calls.map(call => `
        <div class="rich-scanner-card ${call.is_critical ? 'critical' : ''}">
          <div class="card-header">
            <span class="municipality-badge">${call.municipality}</span>
            <span class="time">${new Date(call.timestamp).toLocaleTimeString()}</span>
            <span class="criticality">${call.criticality}</span>
          </div>
          
          <div class="ai-summary">${call.ai_summary || call.transcript_snippet}</div>
          
          <div class="meta-row">
            <span>Units: ${call.units?.join(', ') || '—'}</span>
            <span>Source: ${call.source}</span>
          </div>
          
          <div class="transcript">${call.transcript_snippet}</div>
          
          <div class="actions">
            <button class="btn-play">▶ Play Audio</button>
            <button class="btn-explain" onclick="explainWithAI('${call.id}')">AI Explain</button>
            <button class="btn-map" onclick="showOnMap('${call.id}')">Map</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Auto-load on tab open
if (typeof window !== 'undefined') {
  window.loadRichScanner = loadRichScanner;
  // Call loadRichScanner({criticalOnly: true}) when Scanner tab is opened
}