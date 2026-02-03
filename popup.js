// Popup logic — reads/writes chrome.storage

const modelSelect = document.getElementById('model-select');
const nudgeToggle = document.getElementById('nudge-toggle');
const statusLine = document.getElementById('status-line');
const detectedLine = document.getElementById('detected-model');

// Load saved settings
chrome.storage.local.get(['maxTokens', 'nudgesEnabled', 'detectedModel'], (result) => {
  if (result.maxTokens) modelSelect.value = String(result.maxTokens);
  if (result.nudgesEnabled !== undefined) nudgeToggle.checked = result.nudgesEnabled;
  if (result.detectedModel) {
    detectedLine.textContent = 'Detected: ' + result.detectedModel;
    detectedLine.style.display = 'block';
  }
});

modelSelect.addEventListener('change', () => {
  const maxTokens = parseInt(modelSelect.value, 10);
  chrome.storage.local.set({ maxTokens });
});

nudgeToggle.addEventListener('change', () => {
  chrome.storage.local.set({ nudgesEnabled: nudgeToggle.checked });
});

// Show current state
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError || !response) {
    statusLine.textContent = 'Open claude.ai to see stats';
    return;
  }
  statusLine.textContent = `${response.pct}% used - ${formatTokens(response.totalTokens)} / ${formatTokens(response.maxTokens)} tokens`;
});

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
