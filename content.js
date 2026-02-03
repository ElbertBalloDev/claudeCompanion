// Content script — DOM observation, message extraction, meter UI
(function () {
  'use strict';

  if (document.getElementById('cc-meter')) return; // already injected

  // Check if extension context is still valid
  function isExtensionValid() {
    try {
      return chrome.runtime && chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // Cleanup function for when extension is invalidated
  let cleanupIntervals = [];
  function registerInterval(id) {
    cleanupIntervals.push(id);
    return id;
  }

  function cleanup() {
    cleanupIntervals.forEach(id => clearInterval(id));
    cleanupIntervals = [];
    const meter = document.getElementById('cc-meter');
    if (meter) meter.remove();
    const toast = document.getElementById('cc-toast');
    if (toast) toast.remove();
    const panel = document.getElementById('cc-topic-panel');
    if (panel) panel.remove();
    const parseBtn = document.getElementById('cc-parse-btn');
    if (parseBtn) parseBtn.remove();
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
  let lastDetectedModel = '';

  function detectModel() {
    if (!isExtensionValid()) return;

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
        <button id="cc-topics-btn">Map topics</button>
      </div>
    `;
    document.body.appendChild(meter);

    document.getElementById('cc-summarize-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      summarizeConversation();
    });

    document.getElementById('cc-topics-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      mapTopics();
    });

    return meter;
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

  function mapTopics() {
    const prompt = `[INSTRUCTION - DO NOT RESPOND CONVERSATIONALLY]

List the distinct topics or threads we've covered in this conversation.

Output ONLY a numbered list:
1. [Topic name] — [One sentence description]
2. [Topic name] — [One sentence description]
...

Only list major topics, not every small tangent.

Begin list now:`;

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
      showToast('Hit send — button will appear when Claude responds', 'success');
      watchForResponse();
    } else {
      navigator.clipboard.writeText(prompt).then(() => {
        showToast('Copied prompt — paste and send', 'success');
      });
    }
  }

  // --- Watch for Claude's response to complete, then show parse button ---
  let responseWatchInterval = null;
  let initialOlCount = 0;
  let lastOlContent = '';
  let stableCount = 0;

  function watchForResponse() {
    if (responseWatchInterval) clearInterval(responseWatchInterval);

    const container = findChatContainer();
    if (container) {
      initialOlCount = container.querySelectorAll('ol').length;
    }
    lastOlContent = '';
    stableCount = 0;

    responseWatchInterval = registerInterval(setInterval(() => {
      if (!isExtensionValid()) {
        cleanup();
        return;
      }

      const container = findChatContainer();
      if (!container) return;

      const lists = container.querySelectorAll('ol');
      if (lists.length <= initialOlCount) return;

      // Get the latest list's content
      const latestOl = lists[lists.length - 1];
      const currentContent = latestOl.innerHTML;

      // Check if content has stabilized (not streaming anymore)
      if (currentContent === lastOlContent) {
        stableCount++;
        if (stableCount >= 1) { // Stable for 1 second
          clearInterval(responseWatchInterval);
          responseWatchInterval = null;
          showParseButton();
        }
      } else {
        stableCount = 0;
        lastOlContent = currentContent;
      }
    }, 1000));

    // Stop watching after 2 minutes
    setTimeout(() => {
      if (responseWatchInterval) {
        clearInterval(responseWatchInterval);
        responseWatchInterval = null;
      }
    }, 120000);
  }

  function showParseButton() {
    const existing = document.getElementById('cc-parse-btn');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = 'cc-parse-btn';
    btn.textContent = 'Show topics';
    document.body.appendChild(btn);

    setTimeout(() => btn.classList.add('cc-visible'), 10);

    btn.addEventListener('click', () => {
      btn.remove();
      parseAndShowTopics();
    });

    // Auto-remove after 2 minutes
    setTimeout(() => {
      if (btn.isConnected) btn.remove();
    }, 120000);
  }

  function parseAndShowTopics() {
    const container = findChatContainer();
    if (!container) {
      showToast('Could not find chat container', 'error');
      return;
    }

    // Find all ordered lists in the chat
    const lists = container.querySelectorAll('ol');
    let topics = [];

    // Get the last ordered list (most recent response)
    for (let i = lists.length - 1; i >= 0 && topics.length === 0; i--) {
      const items = lists[i].querySelectorAll('li');
      items.forEach(li => {
        const text = li.textContent.trim();
        const match = text.match(/^(.+?)\s*[—\-–]\s*(.+)$/);
        if (match) {
          topics.push({
            name: match[1].trim().replace(/\*\*/g, ''),
            description: match[2].trim()
          });
        } else if (text.length > 3 && text.length < 150) {
          // No description, just the topic name
          topics.push({
            name: text.replace(/\*\*/g, ''),
            description: ''
          });
        }
      });
    }

    if (topics.length >= 2) {
      showTopicButtons(topics);
    } else {
      showToast('Could not find topic list — make sure Claude responded', 'error');
    }
  }

  function showTopicButtons(topics) {
    const existing = document.getElementById('cc-topic-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'cc-topic-panel';
    panel.innerHTML = `
      <div id="cc-topic-header">
        <span>Select topics to summarize</span>
        <button id="cc-topic-close">&times;</button>
      </div>
      <div id="cc-topic-list"></div>
      <div id="cc-topic-footer">
        <span id="cc-topic-count">0 selected</span>
        <button id="cc-topic-summarize" disabled>Summarize</button>
      </div>
    `;
    document.body.appendChild(panel);

    const list = document.getElementById('cc-topic-list');
    const selected = new Set();

    topics.forEach((topic, idx) => {
      const item = document.createElement('label');
      item.className = 'cc-topic-item';
      item.innerHTML = `
        <input type="checkbox" data-idx="${idx}">
        <div class="cc-topic-content">
          <strong>${topic.name}</strong>
          ${topic.description ? '<span>' + topic.description + '</span>' : ''}
        </div>
      `;

      const checkbox = item.querySelector('input');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selected.add(idx);
          item.classList.add('cc-selected');
        } else {
          selected.delete(idx);
          item.classList.remove('cc-selected');
        }
        updateFooter();
      });

      list.appendChild(item);
    });

    function updateFooter() {
      const count = selected.size;
      document.getElementById('cc-topic-count').textContent = count + ' selected';
      document.getElementById('cc-topic-summarize').disabled = count === 0;
    }

    document.getElementById('cc-topic-summarize').addEventListener('click', () => {
      const selectedTopics = Array.from(selected).map(i => topics[i].name);
      panel.remove();
      summarizeTopics(selectedTopics);
    });

    document.getElementById('cc-topic-close').addEventListener('click', () => {
      panel.remove();
    });

    setTimeout(() => panel.classList.add('cc-visible'), 10);
  }

  function summarizeTopics(topicNames) {
    const topicList = topicNames.map((t, i) => (i + 1) + '. ' + t).join('\n');

    const prompt = `[INSTRUCTION - DO NOT RESPOND CONVERSATIONALLY]

Summarize ONLY our discussions about these specific topics from this conversation:

${topicList}

Ignore other topics. For each topic, provide:
- Key points discussed
- Decisions or conclusions
- Any code or solutions
- Open questions

Output a focused summary I can reference later.

Begin summary now:`;

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
      showToast('Prompt ready — hit send', 'success');
    }
  }

  function summarizeConversation() {
    const prompt = `[INSTRUCTION - DO NOT RESPOND CONVERSATIONALLY]

Please summarize our conversation so far. I want to continue in a new chat.

Output ONLY a structured summary with:
- What we were working on
- Key decisions made
- Current status / where we left off
- Any pending questions or next steps

Format it so I can paste it into a new conversation and continue seamlessly.

Begin summary now:`;

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
    if (!isExtensionValid()) {
      cleanup();
      return;
    }
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
  registerInterval(setInterval(() => {
    if (!isExtensionValid()) {
      cleanup();
      return;
    }

    const container = findChatContainer();
    if (container !== cachedContainer || !container.isConnected) {
      cachedContainer = null;
      currentObserver.disconnect();
      currentObserver = startObserver();
    }
    detectModel();
    recalculate();
  }, 10000)); // Every 10s instead of 5s
})();
