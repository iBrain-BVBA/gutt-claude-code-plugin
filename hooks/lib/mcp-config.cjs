#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, HOME_DIR } = require("./env.cjs");

/**
 * Check if gutt-mcp-remote MCP server is configured in settings
 * Checks both user scope and project scope for both Claude Code and Cursor.
 * @returns {boolean} true if gutt-mcp-remote is configured
 */
function isGuttMcpConfigured() {
  // Check Claude Code user scope (~/.claude/settings.json)
  const claudeUserSettingsPath = path.join(HOME_DIR, ".claude", "settings.json");
  if (checkSettingsFile(claudeUserSettingsPath)) {
    return true;
  }

  // Check user scope (~/.mcp.json)
  const userMcpPath = path.join(HOME_DIR, ".mcp.json");
  if (checkMcpFile(userMcpPath)) {
    return true;
  }

  // Check Cursor user scope (~/.cursor/mcp.json)
  const cursorUserMcpPath = path.join(HOME_DIR, ".cursor", "mcp.json");
  if (checkMcpFile(cursorUserMcpPath)) {
    return true;
  }

  // Check project scope (.claude/settings.json in project dir)
  const projectSettingsPath = path.join(PROJECT_DIR, ".claude", "settings.json");
  if (checkSettingsFile(projectSettingsPath)) {
    return true;
  }

  // Check project scope (.mcp.json in project dir)
  const projectMcpPath = path.join(PROJECT_DIR, ".mcp.json");
  if (checkMcpFile(projectMcpPath)) {
    return true;
  }

  // Check if gutt plugin is installed (plugin provides MCP at runtime)
  const pluginPath = path.join(HOME_DIR, ".claude", "plugins", "marketplaces", "gutt-plugins");
  if (fs.existsSync(pluginPath)) {
    return true;
  }

  // Check plugin cache directories for gutt-claude-code-plugin
  const pluginCachePath = path.join(HOME_DIR, ".claude", "plugins", "cache");
  if (fs.existsSync(pluginCachePath)) {
    try {
      const cacheEntries = fs.readdirSync(pluginCachePath);
      for (const entry of cacheEntries) {
        const mcpPath = path.join(pluginCachePath, entry, ".mcp.json");
        if (checkMcpFile(mcpPath)) {
          return true;
        }
      }
    } catch {
      // Ignore read errors
    }
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

/**
 * Check if an .mcp.json file contains gutt-mcp-remote configuration
 */
function checkMcpFile(mcpPath) {
  if (fs.existsSync(mcpPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      const serverConfig = mcpConfig.mcpServers && mcpConfig.mcpServers["gutt-mcp-remote"];
      // Accept any valid config (with command, args, env, etc.)
      if (serverConfig) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }
  return false;
}

module.exports = { isGuttMcpConfigured };
