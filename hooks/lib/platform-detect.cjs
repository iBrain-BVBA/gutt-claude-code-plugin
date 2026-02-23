#!/usr/bin/env node
/**
 * GUTT Platform Detection Utility
 * Detects whether we're running in Cowork (Claude Desktop) or CLI environment.
 *
 * Key difference: Cowork does NOT support `decision: "block"` in hook output.
 * Hooks that need to block must use `hookSpecificOutput.additionalContext` instead.
 *
 * @see GP-530 - Cowork: Automatic lesson capture via agents and subagents
 */

/**
 * Detect if the current environment supports `decision: "block"` in hook output.
 * Returns true for CLI, false for Cowork.
 *
 * Detection strategy (ordered by reliability):
 * 1. Explicit CLAUDE_PLATFORM env var (most reliable when available)
 * 2. CLAUDE_PROJECT_DIR pattern matching (Cowork uses /sessions/ paths)
 * 3. Default to true (CLI behavior - safer fallback, existing hooks work)
 *
 * @returns {boolean} true if decision:block is supported (CLI), false if not (Cowork)
 */
function supportsDecisionBlock() {
  // 1. Cursor IDE detection — Cursor uses followup_message, not decision:block
  if (isCursor()) {
    return false;
  }

  // 2. Explicit platform env var
  const platform = (process.env.CLAUDE_PLATFORM || "").toLowerCase();
  if (platform.includes("cowork") || platform.includes("desktop")) {
    return false;
  }
  if (platform.includes("cli") || platform.includes("code")) {
    return true;
  }

  // 3. Cowork session path detection
  // Cowork uses paths like /sessions/<session-id>/ as project dirs
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (/^\/sessions\/[^/]+/.test(projectDir)) {
    return false;
  }

  // 4. Default to CLI behavior (safer - existing hooks work unchanged)
  return true;
}

/**
 * Check if running in Cowork (Claude Desktop) environment.
 *
 * @returns {boolean} true if running in Cowork
 */
function isCowork() {
  if (isCursor()) {
    return false;
  }
  return !supportsDecisionBlock();
}

/**
 * Check if running in Cursor IDE environment.
 *
 * @returns {boolean} true if running in Cursor
 */
function isCursor() {
  return !!(
    process.env.CURSOR_PLUGIN_ROOT ||
    process.env.CURSOR_PROJECT_DIR ||
    process.env.CURSOR_VERSION
  );
}

module.exports = { supportsDecisionBlock, isCowork, isCursor };
