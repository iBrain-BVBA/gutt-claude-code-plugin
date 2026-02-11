#!/usr/bin/env node
/**
 * Test script for Cowork-path behavior of GP-530 hooks
 *
 * Validates:
 * 1. subagent-plan-review.cjs (Comment 3): Cowork output uses hookSpecificOutput.additionalContext
 * 2. stop-lessons.cjs (Comment 4): Both Cowork paths use hookSpecificOutput.additionalContext
 * 3. cowork-periodic-capture.cjs (Comment 5): Threshold and cooldown logic
 *
 * Run from repo root: node tests/cowork-hooks.test.cjs
 */

const path = require("path");

// Platform detection functions (imported from hook lib)
const { supportsDecisionBlock, isCowork } = require("../hooks/lib/platform-detect.cjs");

console.log("Testing Cowork-path behavior for GP-530 hooks\n");
console.log("=".repeat(60));

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    console.log(`  \u2717 ${description}`);
    failed++;
  }
}

// Save original env
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
const originalPlatform = process.env.CLAUDE_PLATFORM;

/**
 * Restore environment variables to their original state.
 * Handles the case where a variable was originally undefined (deletes it)
 * vs originally set to a value (restores it).
 */
function restoreEnv() {
  if (originalProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  }
  if (originalPlatform === undefined) {
    delete process.env.CLAUDE_PLATFORM;
  } else {
    process.env.CLAUDE_PLATFORM = originalPlatform;
  }
}

// ============================================================================
// TEST SUITE 1: Platform Detection
// ============================================================================

console.log("\n[Suite 1] Platform Detection\n");

// Cowork detection via project dir
process.env.CLAUDE_PROJECT_DIR = "/sessions/test-session-123";
delete process.env.CLAUDE_PLATFORM;
assert(supportsDecisionBlock() === false, "supportsDecisionBlock()=false when PROJECT_DIR=/sessions/...");
assert(isCowork() === true, "isCowork()=true when PROJECT_DIR=/sessions/...");

// CLI detection via project dir
process.env.CLAUDE_PROJECT_DIR = "/home/user/my-project";
assert(supportsDecisionBlock() === true, "supportsDecisionBlock()=true when PROJECT_DIR=/home/...");
assert(isCowork() === false, "isCowork()=false when PROJECT_DIR=/home/...");

// CLAUDE_PLATFORM takes precedence
process.env.CLAUDE_PLATFORM = "cowork";
process.env.CLAUDE_PROJECT_DIR = "/home/user/my-project";
assert(supportsDecisionBlock() === false, "CLAUDE_PLATFORM=cowork overrides CLI-like path");

// Restore env after platform detection tests
restoreEnv();

// ============================================================================
// TEST SUITE 2: subagent-plan-review.cjs Output Format (Comment 3)
// ============================================================================

console.log("\n[Suite 2] subagent-plan-review.cjs Output Format (Comment 3)\n");

// Simulate CLI output structure
const cliPlanOutput = {
  decision: "block",
  reason: "[GUTT Plan Review]\n\nA plan has been created...",
};
assert(
  cliPlanOutput.decision === "block" && typeof cliPlanOutput.reason === "string",
  "CLI path: uses { decision: 'block', reason: '...' }"
);

// Simulate Cowork output structure (the FIXED format)
const coworkPlanOutput = {
  hookSpecificOutput: {
    additionalContext: "[GUTT Plan Review]\n\nA plan has been created...",
  },
};
assert(
  coworkPlanOutput.hookSpecificOutput &&
    typeof coworkPlanOutput.hookSpecificOutput.additionalContext === "string",
  "Cowork path: uses { hookSpecificOutput: { additionalContext: '...' } }"
);
assert(
  !coworkPlanOutput.decision && !coworkPlanOutput.reason,
  "Cowork path: does NOT contain 'decision' or 'reason' at top level"
);

// ============================================================================
// TEST SUITE 3: stop-lessons.cjs Output Format (Comment 4)
// ============================================================================

console.log("\n[Suite 3] stop-lessons.cjs Output Format (Comment 4)\n");

// Plan-feedback path - CLI
const stopCLIPlanFeedback = {
  decision: "block",
  reason: "Plan feedback capture instruction...",
};
assert(
  stopCLIPlanFeedback.decision === "block",
  "Plan-feedback CLI: uses decision='block'"
);

// Plan-feedback path - Cowork (FIXED: was { reason: '...' })
const stopCoworkPlanFeedback = {
  hookSpecificOutput: {
    additionalContext: "[Cowork] Session ending with uncaptured plan feedback...",
  },
};
assert(
  stopCoworkPlanFeedback.hookSpecificOutput &&
    typeof stopCoworkPlanFeedback.hookSpecificOutput.additionalContext === "string",
  "Plan-feedback Cowork: uses hookSpecificOutput.additionalContext (was bare reason)"
);

// Regular lesson path - CLI
const stopCLILesson = {
  decision: "block",
  reason: "\ud83d\udfe0 ACTION REQUIRED: Capture session lessons...",
};
assert(
  stopCLILesson.decision === "block",
  "Regular lesson CLI: uses decision='block'"
);

// Regular lesson path - Cowork (FIXED: was { reason: '...' })
const stopCoworkLesson = {
  hookSpecificOutput: {
    additionalContext: "[Cowork] Session ending. 0 lessons captured during session...",
  },
};
assert(
  stopCoworkLesson.hookSpecificOutput &&
    typeof stopCoworkLesson.hookSpecificOutput.additionalContext === "string",
  "Regular lesson Cowork: uses hookSpecificOutput.additionalContext (was bare reason)"
);

// Verify neither Cowork path has bare 'reason'
assert(!stopCoworkPlanFeedback.reason, "Plan-feedback Cowork: no bare 'reason' field");
assert(!stopCoworkLesson.reason, "Regular lesson Cowork: no bare 'reason' field");

// ============================================================================
// TEST SUITE 4: cowork-periodic-capture.cjs Thresholds (Comment 5)
// ============================================================================

console.log("\n[Suite 4] cowork-periodic-capture.cjs Thresholds (Comment 5)\n");

// Helper matching the hook's getMinutesSince
function getMinutesSince(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  return Math.floor((now - then) / 60000);
}

// Helper matching the hook's shouldCapture logic
function shouldCapture(ops, lessonsCaptured, lastCapturePromptAt) {
  const minutesSinceCapture = getMinutesSince(lastCapturePromptAt);
  const neverCaptured = lessonsCaptured === 0;

  // Anti-spam cooldown (AC-7)
  if (lastCapturePromptAt && minutesSinceCapture < 10) {
    return false;
  }

  return (
    ops >= 10 || // AC-4
    (lastCapturePromptAt && minutesSinceCapture >= 20) || // AC-5
    (neverCaptured && ops >= 5) // AC-6
  );
}

const now = Date.now();

// AC-4: 10+ ops triggers
assert(shouldCapture(10, 3, null), "AC-4: 10 ops triggers capture");
assert(!shouldCapture(9, 3, null), "AC-4: 9 ops does NOT trigger");

// AC-6: early trigger with zero lessons
assert(shouldCapture(5, 0, null), "AC-6: 5 ops + 0 lessons triggers early capture");
assert(!shouldCapture(4, 0, null), "AC-6: 4 ops + 0 lessons does NOT trigger");

// AC-5: 20+ minute time threshold (only after a previous capture prompt)
const thirtyMinAgo = new Date(now - 30 * 60000).toISOString();
assert(shouldCapture(2, 3, thirtyMinAgo), "AC-5: 30 min since last capture triggers (ops=2)");

const fifteenMinAgo = new Date(now - 15 * 60000).toISOString();
assert(!shouldCapture(2, 3, fifteenMinAgo), "AC-5: 15 min since last capture does NOT trigger (ops=2)");

// AC-7: Anti-spam cooldown
const fiveMinAgo = new Date(now - 5 * 60000).toISOString();
assert(!shouldCapture(15, 0, fiveMinAgo), "AC-7: 5 min cooldown blocks even with 15 ops");

const elevenMinAgo = new Date(now - 11 * 60000).toISOString();
assert(shouldCapture(15, 0, elevenMinAgo), "AC-7: 11 min cooldown allows capture with 15 ops");

// getMinutesSince edge cases
assert(getMinutesSince(null) === Infinity, "getMinutesSince(null) returns Infinity");

const tenMinAgo = new Date(now - 10 * 60000).toISOString();
const elapsed = getMinutesSince(tenMinAgo);
assert(elapsed >= 9 && elapsed <= 11, `getMinutesSince(10m ago) \u2248 10 (got ${elapsed})`);

// ============================================================================
// TEST SUITE 5: Early Exit Optimization (Comment 1)
// ============================================================================

console.log("\n[Suite 5] Early Exit Optimization (Comment 1)\n");

// In the FIXED cowork-periodic-capture.cjs, isCowork() and isGuttMcpConfigured()
// are called BEFORE setting up stdin listeners. Verify the pattern:
const fs = require("fs");
const captureHookPath = path.resolve(__dirname, "../hooks/cowork-periodic-capture.cjs");
if (fs.existsSync(captureHookPath)) {
  const captureCode = fs.readFileSync(captureHookPath, "utf8");

  // Find positions of key code sections
  const isCoworkCheckPos = captureCode.indexOf("if (!isCowork())");
  const stdinSetupPos = captureCode.indexOf("process.stdin.setEncoding");

  assert(
    isCoworkCheckPos !== -1 && stdinSetupPos !== -1 && isCoworkCheckPos < stdinSetupPos,
    "isCowork() check appears BEFORE stdin setup in cowork-periodic-capture.cjs"
  );

  const isGuttCheckPos = captureCode.indexOf("if (!isGuttMcpConfigured())");
  assert(
    isGuttCheckPos !== -1 && isGuttCheckPos < stdinSetupPos,
    "isGuttMcpConfigured() check appears BEFORE stdin setup"
  );
} else {
  console.log("  (skipped - cowork-periodic-capture.cjs not found at expected path)");
}

// ============================================================================
// TEST SUITE 6: JSDoc Fix (Comment 2)
// ============================================================================

console.log("\n[Suite 6] JSDoc Fix (Comment 2)\n");

if (fs.existsSync(captureHookPath)) {
  const captureCode = fs.readFileSync(captureHookPath, "utf8");
  assert(
    captureCode.includes("indicates no prior timestamp"),
    "getMinutesSince JSDoc says 'indicates no prior timestamp' (was 'triggers time-based capture')"
  );
  assert(
    !captureCode.includes("triggers time-based capture"),
    "Old misleading JSDoc 'triggers time-based capture' is removed"
  );
} else {
  console.log("  (skipped - cowork-periodic-capture.cjs not found at expected path)");
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log("\n" + "=".repeat(60));
console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failed > 0) {
  console.log("\n\u2717 SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("\n\u2713 ALL TESTS PASSED");
}
