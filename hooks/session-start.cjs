#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 * Clears memory cache for fresh state each session
 */

const { diagnoseGuttMcp } = require("./lib/mcp-config.cjs");
const { clearMemoryCache } = require("./lib/memory-cache.cjs");
const { clearSeedCache } = require("./lib/seed-registry.cjs");
const { debugLog } = require("./lib/debug.cjs");

// Read JSON input from stdin (required for hooks)
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // Consume stdin data (required for hook protocol)
});
process.stdin.on("end", () => {
  // Clear caches for fresh state each session
  try {
    clearMemoryCache();
    clearSeedCache();
  } catch (err) {
    debugLog("SessionStart", err);
  }

  // Check gutt MCP configuration status
  const diag = diagnoseGuttMcp();
  if (!diag.configured) {
    console.log(
      `💡 gutt memory not configured. Run /gutt-claude-code-plugin:setup or /gutt-claude-code-plugin:onboard to get started.`
    );
  } else if (diag.url) {
    const display = diag.url.length > 50 ? diag.url.slice(0, 47) + "..." : diag.url;
    console.log(`✅ gutt memory connected (${display})`);
  }

  // Use exitCode instead of process.exit() to allow stdout to flush
  process.exitCode = 0;
});
