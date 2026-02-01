#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 * Clears memory cache for fresh state each session
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { clearMemoryCache } = require("./lib/memory-cache.cjs");

// Debug logging for troubleshooting
function debugLog(hook, error) {
  try {
    const logFile = path.join(process.cwd(), ".claude", "hooks", ".state", "hook-errors.log");
    const entry = `${new Date().toISOString()} [${hook}] ${error?.message || error}\n`;
    fs.appendFileSync(logFile, entry);
  } catch {
    /* ignore */
  }
}

// Read JSON input from stdin (required for hooks)
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // Consume stdin data (required for hook protocol)
});
process.stdin.on("end", () => {
  // Clear memory cache for fresh state each session
  try {
    clearMemoryCache();
  } catch (err) {
    debugLog("SessionStart", err);
  }

  // Check if gutt-mcp-remote is configured
  if (!isGuttMcpConfigured()) {
    console.log(`💡 gutt memory features are available but not configured.

Run /gutt-claude-code-plugin:setup to enable organizational memory integration.`);
  }

  // Use exitCode instead of process.exit() to allow stdout to flush
  process.exitCode = 0;
});
