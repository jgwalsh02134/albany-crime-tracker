// Scanner v4 Advanced Frontend
// Rich cards, critical filter toggle, multi-source badges, timeline ready

export async function loadCriticalScannerFeed() {
  const res = await fetch('/scanner/v4/critical');
  const data = await res.json();
  return data; // Render rich cards with transcript, AI summary, map button, etc.
}

export async function loadAllScannerFeed() {
  const res = await fetch('/scanner/v4/all');
  return await res.json();
}

// Example card render function (vanilla or React)
function renderScannerCard(call) {
  return `
    <div class="scanner-card ${call.is_critical ? 'critical' : ''}">
      <div class="header">
        <span class="municipality">${call.municipality}</span>
        <span class="time">${new Date(call.timestamp).toLocaleTimeString()}</span>
        <span class="criticality">Criticality: ${call.criticality}</span>
      </div>
      <div class="summary">${call.ai_summary}</div>
      <div class="transcript">${call.transcript_snippet}</div>
      <div class="meta">Units: ${call.units?.join(', ') || 'N/A'} | Source: ${call.source}</div>
      <div class="actions">
        <button onclick="playAudio('${call.id}')">Play</button>
        <button onclick="explainCall('${call.id}')">AI Explain</button>
        <button onclick="showOnMap('${call.id}')">Map</button>
      </div>
    </div>
  `;
}

// Add toggle: Critical Only / Show All + keyword alerts + voice input stub
console.log('Scanner v4 frontend ready');