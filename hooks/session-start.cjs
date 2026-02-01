#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function isGuttMcpConfigured() {
  // Check user scope (~/.claude/settings.json)
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(userSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(userSettingsPath, "utf8"));
      if (settings.mcpServers && settings.mcpServers["gutt-mcp-remote"]) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check project scope (.mcp.json)
  const projectMcpPath = path.join(projectDir, ".mcp.json");
  if (fs.existsSync(projectMcpPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(projectMcpPath, "utf8"));
      if (mcpConfig["gutt-mcp-remote"]) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

// Read JSON input from stdin (required for hooks)
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // Consume stdin data (required for hook protocol)
});
process.stdin.on("end", () => {
  // Check if gutt-mcp-remote is configured
  if (!isGuttMcpConfigured()) {
    console.log(`💡 gutt memory features are available but not configured.

Run /gutt-claude-code-plugin:setup to enable organizational memory integration.`);
  }

  process.exit(0);
});
