// Auto-load rich Scanner v4 when Scanner tab becomes active

(function() {
  function initRichScanner() {
    const scannerTab = document.querySelector('[data-tab="scanner"], #scanner, .scanner-tab');
    
    if (scannerTab) {
      // Load optimized rich cards
      if (typeof window.loadRichScannerOptimized === 'function') {
        window.loadRichScannerOptimized({ criticalOnly: true });
      } else {
        // Fallback: load the optimized script dynamically
        const script = document.createElement('script');
        script.src = '/frontend/scanner/optimized_scanner.js';
        script.onload = () => {
          if (typeof window.loadRichScannerOptimized === 'function') {
            window.loadRichScannerOptimized({ criticalOnly: true });
          }
        };
        document.head.appendChild(script);
      }
    }
  }

  // Try to init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRichScanner);
  } else {
    initRichScanner();
  }

  // Also try when tab is clicked (SPA behavior)
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tab="scanner"], .tab-scanner, #scanner-tab')) {
      setTimeout(() => {
        if (typeof window.loadRichScannerOptimized === 'function') {
          window.loadRichScannerOptimized({ criticalOnly: true });
        }
      }, 300);
    }
  });
})();