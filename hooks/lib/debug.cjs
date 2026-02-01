#!/usr/bin/env node
/**
 * Shared debug logging utility for hooks
 * Writes errors to .claude/hooks/.state/hook-errors.log
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_ROOT, ".claude", "hooks", ".state", "hook-errors.log");

/**
 * Log an error for debugging (non-blocking)
 * @param {string} hook - Hook name for context
 * @param {Error|string} error - Error to log
 */
function debugLog(hook, error) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry = `${new Date().toISOString()} [${hook}] ${error?.message || error}\n`;
    fs.appendFileSync(LOG_FILE, entry);
  } catch {
    /* ignore logging errors */
  }
}

module.exports = { debugLog, LOG_FILE };
