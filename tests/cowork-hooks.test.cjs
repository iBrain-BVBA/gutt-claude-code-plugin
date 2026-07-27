#!/usr/bin/env node
/**
 * Test script for Cowork-path behavior of the gutt hooks.
 *
 * Validates:
 * 1. Platform detection (Cowork / Cursor / CLI)
 * 2. BOM stripping and env.cjs priority
 *
 * Run from repo root: node tests/cowork-hooks.test.cjs
 */

// Platform detection functions (imported from hook lib)
const {
  supportsDecisionBlock,
  isCowork,
  isCursor,
} = require("../gutt-core/hooks/lib/platform-detect.cjs");

console.log("Testing Cowork-path behavior for the gutt hooks\n");
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
