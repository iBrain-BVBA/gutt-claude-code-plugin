#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Check if gutt-mcp-remote MCP server is configured
 * Checks both user scope (~/.claude/settings.json) and project scope (.mcp.json)
 * @param {string} projectDir - The project directory to check for .mcp.json
 * @returns {boolean} true if gutt-mcp-remote is configured
 */
function isGuttMcpConfigured(projectDir) {
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

module.exports = { isGuttMcpConfigured };
