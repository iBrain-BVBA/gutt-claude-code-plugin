#!/usr/bin/env node
/**
 * Shared debug logging utility for hooks.
 * Writes to ${CLAUDE_PLUGIN_DATA}/hook-errors.log (R37). No-op when the plugin
 * data dir is unavailable — never falls back to the project tree.
 *
 * Intentionally independent of plugin-state.cjs (which logs *through* here) to
 * avoid a require cycle; that's why it resolves its own path and is an allowlisted
 * direct writer in tests/check-state-location.cjs.
 */

const fs = require("fs");
const path = require("path");

/**
 * Resolve the log path live, or null when ${CLAUDE_PLUGIN_DATA} is unset.
 * @returns {string|null}
 */
function logFile() {
  const root = process.env.CLAUDE_PLUGIN_DATA;
  return root ? path.join(root, "hook-errors.log") : null;
}

/**
 * Log an error for debugging (non-blocking)
 * @param {string} hook - Hook name for context
 * @param {Error|string} error - Error to log
 */
function debugLog(hook, error) {
  const file = logFile();
  if (!file) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = `${new Date().toISOString()} [${hook}] ${error?.message || error}${error?.stack ? "\n" + error.stack : ""}\n`;
    fs.appendFileSync(file, entry);
  } catch {
    /* ignore logging errors */
  }
}

module.exports = { debugLog, logFile };
