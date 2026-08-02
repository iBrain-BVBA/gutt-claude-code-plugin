#!/usr/bin/env node
/**
 * Test script for non-CLI-host behavior of the gutt hooks.
 *
 * Validates BOM stripping and env.cjs priority — the things that differ when a host
 * other than the Claude Code CLI runs the hooks. Cursor sets both `CLAUDE_*` and
 * `CURSOR_*` variables, so which one wins is a real decision, and it writes its stdin
 * payload with a byte-order mark that `JSON.parse` rejects outright.
 *
 * A platform-detection suite used to sit alongside this, covering a
 * `supportsDecisionBlock`/`isCowork`/`isCursor` lib. GP-933 removed that lib: no hook
 * had called it since the plugin it was written for was retired, so it was testing
 * code that could not run.
 *
 * Run from repo root: node tests/cowork-hooks.test.cjs
 */

console.log("Testing non-CLI-host behavior for the gutt hooks\n");
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
