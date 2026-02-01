#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Check if gutt-mcp-remote MCP server is configured in user settings
 * Only checks user scope (~/.claude/settings.json) since that's where
 * `claude mcp add --scope user` writes the configuration.
 * @returns {boolean} true if gutt-mcp-remote is configured with a valid URL
 */
function isGuttMcpConfigured() {
  // Check user scope (~/.claude/settings.json)
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(userSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(userSettingsPath, "utf8"));
      const mcpConfig = settings.mcpServers && settings.mcpServers["gutt-mcp-remote"];
      // Verify it has a valid URL (not empty/placeholder)
      if (mcpConfig && mcpConfig.url && mcpConfig.url.startsWith("https://")) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

module.exports = { isGuttMcpConfigured };
