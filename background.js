// Background service worker — authoritative state + nudge logic

const NUDGE_THRESHOLDS = [
  { pct: 95, level: 'critical', message: 'Context nearly full! Start a new chat with your summary now.' },
  { pct: 85, level: 'red', message: 'Running low. Ask Claude to summarize this conversation soon.' },
  { pct: 70, level: 'warning', message: 'Good time to ask: "Summarize our conversation so far" — then copy it for a new chat.' },
  { pct: 40, level: 'yellow', message: 'Context healthy. No action needed.' },
];

let state = {
  totalTokens: 0,
  maxTokens: 200000,
  nudgesEnabled: true,
};

// Load saved preferences
chrome.storage.local.get(['maxTokens', 'nudgesEnabled'], (result) => {
  if (result.maxTokens) state.maxTokens = result.maxTokens;
  if (result.nudgesEnabled !== undefined) state.nudgesEnabled = result.nudgesEnabled;
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxTokens) state.maxTokens = changes.maxTokens.newValue;
  if (changes.nudgesEnabled !== undefined) state.nudgesEnabled = changes.nudgesEnabled.newValue;
});

function getNudge(pct) {
  if (!state.nudgesEnabled) return null;
  for (const t of NUDGE_THRESHOLDS) {
    if (pct >= t.pct) return { level: t.level, message: t.message };
  }
  return { level: 'green', message: 'Plenty of context remaining.' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'UPDATE_TOKENS') {
    state.totalTokens = msg.totalTokens;
    const pct = Math.min(100, (state.totalTokens / state.maxTokens) * 100);
    const nudge = getNudge(pct);
    sendResponse({
      pct: Math.round(pct * 10) / 10,
      totalTokens: state.totalTokens,
      maxTokens: state.maxTokens,
      nudge,
    });
  } else if (msg.type === 'MODEL_DETECTED') {
    state.maxTokens = msg.maxTokens;
    chrome.storage.local.set({ maxTokens: msg.maxTokens, detectedModel: msg.modelName });
    sendResponse({ ok: true });
  } else if (msg.type === 'GET_STATE') {
    const pct = Math.min(100, (state.totalTokens / state.maxTokens) * 100);
    sendResponse({
      pct: Math.round(pct * 10) / 10,
      totalTokens: state.totalTokens,
      maxTokens: state.maxTokens,
      nudge: getNudge(pct),
    });
  }
  return true; // keep channel open for async sendResponse
});
