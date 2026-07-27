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
 * The breadcrumb logs in the R37 state contract. Named here — the leaf module —
 * because plugin-state.cjs cannot be the owner without creating the require
 * cycle this file exists to avoid. The SessionStart sweep bounds both, so a new
 * log must be added here to be reclaimed.
 */
const LOG_FILES = {
  errors: "hook-errors.log",
  invocations: "hook-invocations.log",
};

/**
 * Resolve the log path live, or null when ${CLAUDE_PLUGIN_DATA} is unset.
 * @returns {string|null}
 */
function logFile() {
  const root = process.env.CLAUDE_PLUGIN_DATA;
  return root ? path.join(root, LOG_FILES.errors) : null;
}

/**
 * Run `fn`, logging and swallowing any failure. Hook steps use this so one
 * failing step cannot take down the session — a hook that throws is a hook that
 * broke the user's session.
 * @param {string} hook - scope label for the log line
 * @param {string} label - which step failed
 * @param {Function} fn
 * @returns {*} fn's return value, or undefined when it threw
 */
function guard(hook, label, fn) {
  try {
    return fn();
  } catch (err) {
    // Hand debugLog the stack, not just a formatted string. It appends `.stack`
    // when it gets one, and a swallowed exception with no stack is close to
    // undiagnosable — several sweep steps share one log and the throw is often
    // three or four frames inside a shared helper.
    debugLog(hook, { message: `${label}: ${err?.message ?? err}`, stack: err?.stack });
    return undefined;
  }
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

module.exports = { LOG_FILES, debugLog, guard, logFile };
