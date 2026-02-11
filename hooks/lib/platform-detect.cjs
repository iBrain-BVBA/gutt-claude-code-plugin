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
  // 1. Explicit platform env var
  const platform = (process.env.CLAUDE_PLATFORM || "").toLowerCase();
  if (platform.includes("cowork") || platform.includes("desktop")) {
    return false;
  }
  if (platform.includes("cli") || platform.includes("code")) {
    return true;
  }

  // 2. Cowork session path detection
  // Cowork uses paths like /sessions/<session-id>/ as project dirs
  const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
  if (/^\/sessions\/[^/]+/.test(projectDir)) {
    return false;
  }

  // 3. Default to CLI behavior (safer - existing hooks work unchanged)
  return true;
}

/**
 * Check if running in Cowork (Claude Desktop) environment.
 * Convenience inverse of supportsDecisionBlock().
 *
 * @returns {boolean} true if running in Cowork
 */
function isCowork() {
  return !supportsDecisionBlock();
}

module.exports = { supportsDecisionBlock, isCowork };
