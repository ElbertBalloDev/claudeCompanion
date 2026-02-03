// Content script — DOM observation, message extraction, meter UI
(function () {
  'use strict';

  if (document.getElementById('cc-meter')) return; // already injected

  // --- Token estimation ---
  function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
  }

  // --- DOM selector discovery (cached) ---
  let cachedContainer = null;
  let containerMiss = 0;

  function findChatContainer() {
    // Reuse cached container if still in DOM
    if (cachedContainer && cachedContainer.isConnected) return cachedContainer;

    cachedContainer = document.querySelector('main') || document.querySelector('[role="main"]');
    if (cachedContainer) return cachedContainer;

    // Fallback: largest scrollable div (expensive — only retry every few calls)
    if (++containerMiss < 3) return document.body;
    containerMiss = 0;

    let best = null;
    let bestArea = 0;
    for (const div of document.querySelectorAll('div')) {
      if (div.scrollHeight > div.clientHeight && div.clientHeight > 200) {
        const area = div.clientWidth * div.clientHeight;
        if (area > bestArea) {
          bestArea = area;
          best = div;
        }
      }
    }
    cachedContainer = best || document.body;
    return cachedContainer;
  }

  // --- Model auto-detection ---
  const MODEL_PATTERNS = [
    { pattern: /extended/i, maxTokens: 1000000 },
    { pattern: /opus/i, maxTokens: 200000 },
    { pattern: /sonnet/i, maxTokens: 200000 },
    { pattern: /haiku/i, maxTokens: 200000 },
  ];
  const DEFAULT_MAX_TOKENS = 200000;
  let lastDetectedModel = '';

  function detectModel() {
    // Look for buttons/elements near the input area containing model names
    const selectors = [
      'button', 'div[role="button"]', '[data-testid*="model"]',
      '[aria-label*="model" i]', '[aria-haspopup]',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent || '').trim();
        if (text.length > 50 || text.length < 3) continue;
        for (const m of MODEL_PATTERNS) {
          if (m.pattern.test(text)) {
            if (text !== lastDetectedModel) {
              lastDetectedModel = text;
              chrome.runtime.sendMessage({ type: 'MODEL_DETECTED', maxTokens: m.maxTokens, modelName: text });
            }
            return;
          }
        }
      }
    }
  }

  // --- Message extraction (with length cache) ---
  let lastContentLength = 0;
  let lastTokenCount = 0;
  let lastUrl = location.href;

  function extractTokenCount() {
    const container = findChatContainer();
    if (!container) return 0;

    // Reset cache if URL changed (new conversation)
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastContentLength = 0;
      lastTokenCount = 0;
      cachedContainer = null;
    }

    // Quick check: if total text length hasn't changed, skip re-counting
    const fullLength = container.textContent.length;
    if (fullLength === lastContentLength) return lastTokenCount;
    lastContentLength = fullLength;

    let totalChars = 0;

    // Strategy 1: data attributes
    const byData = container.querySelectorAll('[data-message-author-role], [data-is-streaming]');
    if (byData.length > 0) {
      for (let i = 0; i < byData.length; i++) {
        totalChars += (byData[i].textContent || '').length;
      }
      lastTokenCount = Math.ceil(totalChars / 4);
      return lastTokenCount;
    }

    // Strategy 2: ARIA-based turn containers
    const byAria = container.querySelectorAll('[role="row"], [role="listitem"], [role="article"]');
    if (byAria.length > 1) {
      for (let i = 0; i < byAria.length; i++) {
        totalChars += (byAria[i].textContent || '').length;
      }
      lastTokenCount = Math.ceil(totalChars / 4);
      return lastTokenCount;
    }

    // Strategy 3: structural heuristic
    const children = container.querySelectorAll(':scope > div > div > div');
    if (children.length > 1) {
      for (let i = 0; i < children.length; i++) {
        const len = (children[i].textContent || '').length;
        if (len > 10) totalChars += len;
      }
      if (totalChars > 0) {
        lastTokenCount = Math.ceil(totalChars / 4);
        return lastTokenCount;
      }
    }

    // Strategy 4: fallback — use full container text
    lastTokenCount = Math.ceil(fullLength / 4);
    return lastTokenCount;
  }

  // --- Meter UI ---
  function createMeter() {
    const meter = document.createElement('div');
    meter.id = 'cc-meter';
    meter.innerHTML = `
      <div id="cc-meter-ring"></div>
      <div id="cc-meter-label">0%</div>
      <div id="cc-meter-tooltip">
        <div id="cc-tooltip-tokens">0 / 200K tokens</div>
        <div id="cc-tooltip-pct">0% used</div>
        <div id="cc-tooltip-nudge">Plenty of context remaining.</div>
        <button id="cc-summarize-btn">Ask for summary</button>
      </div>
    `;
    document.body.appendChild(meter);

    document.getElementById('cc-summarize-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      summarizeConversation();
    });

    return meter;
  }

  function findMessageElements() {
    const container = findChatContainer();
    if (!container) return [];

    let messages = container.querySelectorAll('[data-message-author-role]');
    if (messages.length > 0) return Array.from(messages);

    messages = container.querySelectorAll('[role="row"], [role="listitem"], [role="article"]');
    if (messages.length > 1) return Array.from(messages);

    const candidates = container.querySelectorAll(':scope > div > div > div');
    return Array.from(candidates).filter(el => (el.textContent || '').trim().length > 20);
  }

  function findInputElement() {
    const selectors = [
      'div[contenteditable="true"]',
      'textarea',
      '[data-placeholder]',
      '[role="textbox"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function summarizeConversation() {
    const prompt = `Please summarize our conversation so far. I want to continue in a new chat.

Include:
- What we were working on
- Key decisions made
- Current status / where we left off
- Any pending questions or next steps

Format it so I can paste it into a new conversation and continue seamlessly.`;

    const input = findInputElement();
    if (input) {
      if (input.tagName === 'TEXTAREA') {
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = prompt;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));
      }
      input.focus();
      showToast('Prompt ready — hit send, then copy the summary to a new chat', 'success');
    } else {
      navigator.clipboard.writeText(prompt).then(() => {
        showToast('Copied prompt — paste it here and send', 'success');
      });
    }
  }

  // --- Toast notification ---
  function showToast(message, type = 'success') {
    const existing = document.getElementById('cc-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'cc-toast';
    toast.className = `cc-toast cc-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('cc-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('cc-visible');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // Cache DOM refs for meter elements
  let meterRefs = null;
  function getMeterRefs() {
    if (meterRefs && meterRefs.ring.isConnected) return meterRefs;
    meterRefs = {
      ring: document.getElementById('cc-meter-ring'),
      label: document.getElementById('cc-meter-label'),
      tokens: document.getElementById('cc-tooltip-tokens'),
      pct: document.getElementById('cc-tooltip-pct'),
      nudge: document.getElementById('cc-tooltip-nudge'),
      meter: document.getElementById('cc-meter'),
    };
    return meterRefs;
  }

  function updateMeterUI(data) {
    const refs = getMeterRefs();
    if (!refs.ring || !refs.label) return;

    const pct = data.pct || 0;
    const deg = (pct / 100) * 360;

    let color = '#4ade80';
    let level = 'green';
    if (pct >= 90) { color = '#ef4444'; level = 'critical'; }
    else if (pct >= 70) { color = '#ef4444'; level = 'red'; }
    else if (pct >= 40) { color = '#facc15'; level = 'yellow'; }

    refs.ring.style.background = `conic-gradient(${color} 0deg, ${color} ${deg}deg, #2a2a2e ${deg}deg, #2a2a2e 360deg)`;
    refs.label.textContent = Math.round(pct) + '%';
    refs.meter.setAttribute('data-level', level);

    if (refs.tokens) refs.tokens.textContent = `${formatTokens(data.totalTokens)} / ${formatTokens(data.maxTokens)} tokens`;
    if (refs.pct) refs.pct.textContent = `${pct}% used`;
    if (refs.nudge && data.nudge) refs.nudge.textContent = data.nudge.message;
  }

  // --- Main loop ---
  let debounceTimer = null;
  let isRecalculating = false;

  function recalculate() {
    if (isRecalculating) return;
    isRecalculating = true;

    const totalTokens = extractTokenCount();

    chrome.runtime.sendMessage({ type: 'UPDATE_TOKENS', totalTokens }, (response) => {
      isRecalculating = false;
      if (chrome.runtime.lastError) return;
      if (response) updateMeterUI(response);
    });
  }

  function scheduleRecalc() {
    if (debounceTimer) return; // already scheduled
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      recalculate();
    }, 500);
  }

  // --- Init ---
  createMeter();

  // Defer initial calculation to not block page load
  setTimeout(() => {
    detectModel();
    recalculate();
  }, 1000);

  // Observe only the chat container, not all of document.body
  function startObserver() {
    const target = findChatContainer();
    const observer = new MutationObserver(scheduleRecalc);
    observer.observe(target, { childList: true, subtree: true });
    // If target changes (navigation), restart
    return observer;
  }

  let currentObserver = startObserver();

  // Periodic fallback — also re-targets observer if container changed
  setInterval(() => {
    const container = findChatContainer();
    if (container !== cachedContainer || !container.isConnected) {
      cachedContainer = null;
      currentObserver.disconnect();
      currentObserver = startObserver();
    }
    detectModel();
    recalculate();
  }, 10000); // Every 10s instead of 5s
})();
