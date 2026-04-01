const assert = require("assert");
const {
  classifySignal,
  CAPTURE_TYPES,
  TRUST_LEVELS,
} = require("../hooks/lib/memory-classifier.cjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  \u2713", name);
    passed++;
  } catch (err) {
    console.log("  \u2717", name);
    console.log("    ", err.message);
    failed++;
  }
}

console.log("Memory Classifier Unit Tests\n");

console.log("Lesson detection:");
test('"no that\'s wrong, the price is \u20ac90" \u2192 Lesson, human', () => {
  const r = classifySignal("no that's wrong, the price is \u20ac90");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.LESSON);
  assert.strictEqual(r.trust, TRUST_LEVELS.HUMAN);
});

test('"you keep doing X wrong" \u2192 Lesson, human, high priority', () => {
  const r = classifySignal("you keep doing X wrong");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.LESSON);
  assert.strictEqual(r.trust, TRUST_LEVELS.HUMAN);
  assert.strictEqual(r.priority, "high");
});

console.log("\nUserPreference detection:");
test('"I prefer bullet points" \u2192 UserPreference, human', () => {
  const r = classifySignal("I prefer bullet points");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.USER_PREFERENCE);
  assert.strictEqual(r.trust, TRUST_LEVELS.HUMAN);
});

console.log("\nWorkingAgreement detection:");
test('"All PRs must have Copilot review" \u2192 WorkingAgreement, human', () => {
  const r = classifySignal("All PRs must have Copilot review");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.WORKING_AGREEMENT);
  assert.strictEqual(r.trust, TRUST_LEVELS.HUMAN);
});

console.log("\nDecision detection:");
test('"We decided to use streaming" \u2192 Decision, human', () => {
  const r = classifySignal("We decided to use streaming");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.DECISION);
  assert.strictEqual(r.trust, TRUST_LEVELS.HUMAN);
});

test('"Yes, go ahead with approach A" \u2192 Decision, human', () => {
  const r = classifySignal("Yes, go ahead with approach A");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.DECISION);
  assert.strictEqual(r.trust, TRUST_LEVELS.HUMAN);
});

console.log("\nInsight detection:");
test('"Noticed that auth module caused 3 incidents" \u2192 Insight, agent', () => {
  const r = classifySignal("Noticed that auth module caused 3 incidents");
  assert.strictEqual(r.shouldCapture, true);
  assert.strictEqual(r.type, CAPTURE_TYPES.INSIGHT);
  assert.strictEqual(r.trust, TRUST_LEVELS.AGENT);
});

console.log("\nNon-capture cases:");
test('"The function returns a string" \u2192 shouldCapture: false', () => {
  const r = classifySignal("The function returns a string");
  assert.strictEqual(r.shouldCapture, false);
});

test("Empty string \u2192 shouldCapture: false", () => {
  const r = classifySignal("");
  assert.strictEqual(r.shouldCapture, false);
});

test("null input \u2192 shouldCapture: false", () => {
  const r = classifySignal(null);
  assert.strictEqual(r.shouldCapture, false);
});

test("undefined input \u2192 shouldCapture: false", () => {
  const r = classifySignal(undefined);
  assert.strictEqual(r.shouldCapture, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
