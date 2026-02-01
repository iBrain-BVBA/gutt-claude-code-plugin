#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 * Clears memory cache for fresh state each session
 */

const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { clearMemoryCache } = require("./lib/memory-cache.cjs");
const { debugLog } = require("./lib/debug.cjs");

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
