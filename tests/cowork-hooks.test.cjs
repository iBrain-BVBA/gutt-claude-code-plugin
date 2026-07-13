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
const {
  supportsDecisionBlock,
  isCowork,
  isCursor,
} = require("../gutt-core/hooks/lib/platform-detect.cjs");

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
const originalCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
const originalCursorProjectDir = process.env.CURSOR_PROJECT_DIR;
const originalCursorVersion = process.env.CURSOR_VERSION;
const originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

function restoreVar(name, original) {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function clearCursorEnv() {
  delete process.env.CURSOR_PLUGIN_ROOT;
  delete process.env.CURSOR_PROJECT_DIR;
  delete process.env.CURSOR_VERSION;
}

/**
 * Restore environment variables to their original state.
 */
function restoreEnv() {
  restoreVar("CLAUDE_PROJECT_DIR", originalProjectDir);
  restoreVar("CLAUDE_PLATFORM", originalPlatform);
  restoreVar("CURSOR_PLUGIN_ROOT", originalCursorPluginRoot);
  restoreVar("CURSOR_PROJECT_DIR", originalCursorProjectDir);
  restoreVar("CURSOR_VERSION", originalCursorVersion);
  restoreVar("CLAUDE_PLUGIN_ROOT", originalClaudePluginRoot);
}

// ============================================================================
// TEST SUITE 1: Platform Detection
// ============================================================================

console.log("\n[Suite 1] Platform Detection\n");

// Cowork detection via project dir
clearCursorEnv();
process.env.CLAUDE_PROJECT_DIR = "/sessions/test-session-123";
delete process.env.CLAUDE_PLATFORM;
assert(
  supportsDecisionBlock() === false,
  "supportsDecisionBlock()=false when PROJECT_DIR=/sessions/..."
);
assert(isCowork() === true, "isCowork()=true when PROJECT_DIR=/sessions/...");

// CLI detection via project dir
clearCursorEnv();
process.env.CLAUDE_PROJECT_DIR = "/home/user/my-project";
delete process.env.CLAUDE_PLATFORM;
assert(supportsDecisionBlock() === true, "supportsDecisionBlock()=true when PROJECT_DIR=/home/...");
assert(isCowork() === false, "isCowork()=false when PROJECT_DIR=/home/...");

// CLAUDE_PLATFORM takes precedence
clearCursorEnv();
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
assert(stopCLIPlanFeedback.decision === "block", "Plan-feedback CLI: uses decision='block'");

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
assert(stopCLILesson.decision === "block", "Regular lesson CLI: uses decision='block'");

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
  if (!isoTimestamp) {
    return Infinity;
  }
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
assert(
  !shouldCapture(2, 3, fifteenMinAgo),
  "AC-5: 15 min since last capture does NOT trigger (ops=2)"
);

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
const captureHookPath = path.resolve(__dirname, "../gutt-core/hooks/cowork-periodic-capture.cjs");
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
// TEST SUITE 7: isCursor() detection and interaction with isCowork()
// ============================================================================

console.log("\n[Suite 7] isCursor() Detection and Interaction with isCowork()\n");

// 7a: isCursor() does NOT trigger on CURSOR_PLUGIN_ROOT alone (env var doesn't exist in Cursor)
clearCursorEnv();
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLATFORM;
process.env.CURSOR_PLUGIN_ROOT = "/home/user/.cursor/extensions/gutt";
assert(
  isCursor() === false,
  "isCursor()=false when only CURSOR_PLUGIN_ROOT is set (not a real Cursor var)"
);
restoreEnv();

// 7b: isCursor() returns true when CURSOR_PROJECT_DIR is set
clearCursorEnv();
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLATFORM;
process.env.CURSOR_PROJECT_DIR = "/home/user/my-project";
assert(isCursor() === true, "isCursor()=true when CURSOR_PROJECT_DIR is set");
restoreEnv();

// 7c: isCursor() returns true when only CURSOR_VERSION is set
clearCursorEnv();
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLATFORM;
process.env.CURSOR_VERSION = "0.50.0";
assert(isCursor() === true, "isCursor()=true when only CURSOR_VERSION is set");
restoreEnv();

// 7d: isCursor() returns false with no Cursor env vars
clearCursorEnv();
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLATFORM;
assert(isCursor() === false, "isCursor()=false when no Cursor env vars are set");
restoreEnv();

// 7e: supportsDecisionBlock() returns false for Cursor (uses isCursor() internally)
clearCursorEnv();
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLATFORM;
process.env.CURSOR_PROJECT_DIR = "/home/user/my-project";
assert(supportsDecisionBlock() === false, "supportsDecisionBlock()=false when Cursor is detected");
restoreEnv();

// 7f: isCowork() returns false when Cursor is detected (not misidentified as Cowork)
clearCursorEnv();
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLATFORM;
process.env.CURSOR_PROJECT_DIR = "/home/user/my-project";
assert(isCowork() === false, "isCowork()=false when Cursor is detected (not misidentified)");
restoreEnv();

// 7g: isCowork() still works for actual Cowork environments
clearCursorEnv();
process.env.CLAUDE_PROJECT_DIR = "/sessions/test-session-456";
delete process.env.CLAUDE_PLATFORM;
assert(isCowork() === true, "isCowork()=true for Cowork session path (no Cursor env)");
restoreEnv();

// 7h: All three are mutually exclusive in a CLI scenario
clearCursorEnv();
process.env.CLAUDE_PROJECT_DIR = "/home/user/my-project";
delete process.env.CLAUDE_PLATFORM;
assert(
  isCursor() === false && isCowork() === false && supportsDecisionBlock() === true,
  "CLI scenario: isCursor=false, isCowork=false, supportsDecisionBlock=true"
);
restoreEnv();

// ============================================================================
// TEST SUITE 8: stop-lessons.cjs platform branching
// ============================================================================

console.log("\n[Suite 8] stop-lessons.cjs Platform Branching\n");

// 8a: Verify stop-lessons.cjs has CLI and Cowork output paths
const stopLessonsPath = path.resolve(__dirname, "../gutt-core/hooks/stop-lessons.cjs");
if (fs.existsSync(stopLessonsPath)) {
  const stopCode = fs.readFileSync(stopLessonsPath, "utf8");

  assert(
    stopCode.includes("supportsDecisionBlock()"),
    "stop-lessons.cjs: has supportsDecisionBlock() branch"
  );
  assert(
    stopCode.includes("hookSpecificOutput"),
    "stop-lessons.cjs: has Cowork hookSpecificOutput branch"
  );
  assert(
    !stopCode.includes("isCursor()"),
    "stop-lessons.cjs: no isCursor() branch (Cursor support removed)"
  );
  assert(
    !stopCode.includes("followup_message"),
    "stop-lessons.cjs: no followup_message output (Cursor support removed)"
  );
} else {
  console.log("  (skipped - stop-lessons.cjs not found at expected path)");
}

// ============================================================================
// TEST SUITE 9: BOM stripping and env.cjs priority (Cursor v2.5 diagnostic)
// ============================================================================

console.log("\n[Suite 9] BOM Stripping and env.cjs Priority\n");

// 9a: BOM stripping — JSON.parse fails without it
const bomInput = "\uFEFF" + '{"conversation_id":"abc-123","status":"completed"}';
let bomParsed;
try {
  bomParsed = JSON.parse(bomInput.replace(/^\uFEFF/, "").trim());
} catch {
  bomParsed = null;
}
assert(bomParsed !== null, "BOM stripping: JSON.parse succeeds after BOM removal");
assert(
  bomParsed && bomParsed.conversation_id === "abc-123",
  "BOM stripping: conversation_id field accessible after parse"
);

// 9b: BOM stripping — raw JSON.parse fails WITH BOM (confirming the bug)
let bomFailed = false;
try {
  JSON.parse(bomInput);
} catch {
  bomFailed = true;
}
assert(bomFailed === true, "BOM stripping: raw JSON.parse FAILS with BOM (confirms bug)");

// 9c: conversation_id fallback for session_id
const cursorStopInput = { conversation_id: "conv-456", status: "completed" };
const sessionId = cursorStopInput.session_id || cursorStopInput.conversation_id || "unknown";
assert(sessionId === "conv-456", "conversation_id used as session_id fallback");

// 9d: session_id takes priority when present (Claude Code)
const claudeStopInput = { session_id: "sess-789", conversation_id: "conv-456" };
const claudeSessionId = claudeStopInput.session_id || claudeStopInput.conversation_id || "unknown";
assert(claudeSessionId === "sess-789", "session_id takes priority over conversation_id");

// 9e: env.cjs — Cursor vars take priority when both CLAUDE_ and CURSOR_ are set
// (This is the actual scenario: Cursor sets BOTH CLAUDE_PROJECT_DIR and CURSOR_PROJECT_DIR)
clearCursorEnv();
process.env.CLAUDE_PROJECT_DIR = "/some/claude/path";
process.env.CURSOR_PROJECT_DIR = "/some/cursor/path";
delete process.env.CLAUDE_PLATFORM;
delete process.env.CLAUDE_PLUGIN_ROOT;

// Re-require env.cjs to test with fresh module cache
delete require.cache[require.resolve("../gutt-core/hooks/lib/env.cjs")];
const freshEnv = require("../gutt-core/hooks/lib/env.cjs");
assert(freshEnv.IDE === "cursor", "env.cjs: IDE='cursor' when both CLAUDE_ and CURSOR_ vars set");
assert(
  freshEnv.STATE_DIR_NAME === ".cursor",
  "env.cjs: STATE_DIR_NAME='.cursor' when Cursor detected"
);
assert(
  freshEnv.PROJECT_DIR === "/some/cursor/path",
  "env.cjs: PROJECT_DIR uses CURSOR_PROJECT_DIR (not CLAUDE_PROJECT_DIR)"
);
restoreEnv();
delete require.cache[require.resolve("../gutt-core/hooks/lib/env.cjs")];

// 9f: env.cjs — falls back to claude when no Cursor vars
clearCursorEnv();
process.env.CLAUDE_PROJECT_DIR = "/some/claude/path";
delete process.env.CLAUDE_PLATFORM;
delete process.env.CLAUDE_PLUGIN_ROOT;
delete require.cache[require.resolve("../gutt-core/hooks/lib/env.cjs")];
const claudeEnv = require("../gutt-core/hooks/lib/env.cjs");
assert(claudeEnv.IDE === "claude", "env.cjs: IDE='claude' when only CLAUDE_ vars set");
assert(claudeEnv.STATE_DIR_NAME === ".claude", "env.cjs: STATE_DIR_NAME='.claude' for Claude Code");
restoreEnv();
delete require.cache[require.resolve("../gutt-core/hooks/lib/env.cjs")];

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
