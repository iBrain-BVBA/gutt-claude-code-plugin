#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Check if gutt-mcp-remote MCP server is configured in settings
 * Checks both user scope (~/.claude/settings.json, ~/.mcp.json) and project scope
 * (.claude/settings.json, .mcp.json in CLAUDE_PROJECT_DIR).
 * @returns {boolean} true if gutt-mcp-remote is configured
 */
function isGuttMcpConfigured() {
  // Check user scope (~/.claude/settings.json)
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (checkSettingsFile(userSettingsPath)) {
    return true;
  }

  // Check user scope (~/.mcp.json)
  const userMcpPath = path.join(os.homedir(), ".mcp.json");
  if (checkMcpFile(userMcpPath)) {
    return true;
  }

  // Check project scope (.claude/settings.json in project dir)
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectSettingsPath = path.join(projectDir, ".claude", "settings.json");
  if (checkSettingsFile(projectSettingsPath)) {
    return true;
  }

  // Check project scope (.mcp.json in project dir)
  const projectMcpPath = path.join(projectDir, ".mcp.json");
  if (checkMcpFile(projectMcpPath)) {
    return true;
  }

  // Check if gutt plugin is installed (plugin provides MCP at runtime)
  const pluginPath = path.join(os.homedir(), ".claude", "plugins", "marketplaces", "gutt-plugins");
  if (fs.existsSync(pluginPath)) {
    return true;
  }

  // Check plugin cache directories for gutt-claude-code-plugin
  const pluginCachePath = path.join(os.homedir(), ".claude", "plugins", "cache");
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
