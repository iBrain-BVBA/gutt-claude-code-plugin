#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Check if gutt-mcp-remote MCP server is configured in settings
 * Checks both user scope (~/.claude/settings.json) and project scope
 * (.claude/settings.json in CLAUDE_PROJECT_DIR).
 * @returns {boolean} true if gutt-mcp-remote is configured
 */
function isGuttMcpConfigured() {
  // Check user scope (~/.claude/settings.json)
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (checkSettingsFile(userSettingsPath)) {
    return true;
  }

  // Check project scope (.claude/settings.json in project dir)
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectSettingsPath = path.join(projectDir, ".claude", "settings.json");
  if (checkSettingsFile(projectSettingsPath)) {
    return true;
  }

  return false;
}

/**
 * Check if a settings file contains gutt-mcp-remote configuration
 */
function checkSettingsFile(settingsPath) {
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const mcpConfig = settings.mcpServers && settings.mcpServers["gutt-mcp-remote"];
      // Accept any valid config (with url, command, or just presence)
      if (mcpConfig) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }
  return false;
}

module.exports = { isGuttMcpConfigured };
