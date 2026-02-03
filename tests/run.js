// Node.js test runner for CI
// Runs the same tests as test.html but in Node

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

// ============ Token Estimation Tests ============
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

test('estimateTokens: empty string returns 0', () => {
  assertEqual(estimateTokens(''), 0);
});

test('estimateTokens: null returns 0', () => {
  assertEqual(estimateTokens(null), 0);
});

test('estimateTokens: 4 chars = 1 token', () => {
  assertEqual(estimateTokens('test'), 1);
});

test('estimateTokens: 5 chars = 2 tokens (ceiling)', () => {
  assertEqual(estimateTokens('hello'), 2);
});

test('estimateTokens: 100 chars = 25 tokens', () => {
  assertEqual(estimateTokens('a'.repeat(100)), 25);
});

// ============ Nudge Threshold Tests ============
const NUDGE_THRESHOLDS = [
  { pct: 95, level: 'critical' },
  { pct: 85, level: 'red' },
  { pct: 70, level: 'warning' },
  { pct: 40, level: 'yellow' },
];

function getNudgeLevel(pct) {
  for (const t of NUDGE_THRESHOLDS) {
    if (pct >= t.pct) return t.level;
  }
  return 'green';
}

test('nudge: 0% = green', () => {
  assertEqual(getNudgeLevel(0), 'green');
});

test('nudge: 39% = green', () => {
  assertEqual(getNudgeLevel(39), 'green');
});

test('nudge: 40% = yellow', () => {
  assertEqual(getNudgeLevel(40), 'yellow');
});

test('nudge: 70% = warning', () => {
  assertEqual(getNudgeLevel(70), 'warning');
});

test('nudge: 85% = red', () => {
  assertEqual(getNudgeLevel(85), 'red');
});

test('nudge: 95% = critical', () => {
  assertEqual(getNudgeLevel(95), 'critical');
});

// ============ Percentage Calculation Tests ============
function calcPct(totalTokens, maxTokens) {
  return Math.min(100, (totalTokens / maxTokens) * 100);
}

test('pct: 0 / 200000 = 0%', () => {
  assertEqual(calcPct(0, 200000), 0);
});

test('pct: 100000 / 200000 = 50%', () => {
  assertEqual(calcPct(100000, 200000), 50);
});

test('pct: 300000 / 200000 caps at 100%', () => {
  assertEqual(calcPct(300000, 200000), 100);
});

// ============ Model Detection Pattern Tests ============
const MODEL_PATTERNS = [
  { pattern: /extended/i, maxTokens: 1000000 },
  { pattern: /opus/i, maxTokens: 200000 },
  { pattern: /sonnet/i, maxTokens: 200000 },
  { pattern: /haiku/i, maxTokens: 200000 },
];

function detectModelFromText(text) {
  for (const m of MODEL_PATTERNS) {
    if (m.pattern.test(text)) return m.maxTokens;
  }
  return null;
}

test('model: "Opus 4.5" = 200K', () => {
  assertEqual(detectModelFromText('Opus 4.5'), 200000);
});

test('model: "Extended thinking" = 1M', () => {
  assertEqual(detectModelFromText('Extended thinking'), 1000000);
});

test('model: "Unknown" = null', () => {
  assertEqual(detectModelFromText('Unknown'), null);
});

// ============ Format Tokens Tests ============
function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

test('format: 500 = "500"', () => {
  assertEqual(formatTokens(500), '500');
});

test('format: 1000 = "1.0K"', () => {
  assertEqual(formatTokens(1000), '1.0K');
});

test('format: 1000000 = "1.0M"', () => {
  assertEqual(formatTokens(1000000), '1.0M');
});

// ============ Summary ============
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
