#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 */

const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Read JSON input from stdin (required for hooks)
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // Consume stdin data (required for hook protocol)
});
process.stdin.on("end", () => {
  // Check if gutt-mcp-remote is configured
  if (!isGuttMcpConfigured(projectDir)) {
    console.log(`💡 gutt memory features are available but not configured.

Run /gutt-claude-code-plugin:setup to enable organizational memory integration.`);
  }

  // Use exitCode instead of process.exit() to allow stdout to flush
  process.exitCode = 0;
});
