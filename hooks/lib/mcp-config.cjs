#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, HOME_DIR } = require("./env.cjs");

/** Server name patterns to match for gutt MCP */
const GUTT_SERVER_NAMES = ["gutt-mcp-remote", "gutt_mcp", "gutt-mcp", "claude_ai_gutt_mcp"];

/**
 * Find gutt MCP server config object within an mcpServers map.
 * Tries known server names and pattern matches.
 * @param {Object} mcpServers - The mcpServers object from config
 * @returns {{ name: string, config: Object }|null}
 */
function findGuttServerConfig(mcpServers) {
  if (!mcpServers || typeof mcpServers !== "object") {
    return null;
  }
  for (const name of GUTT_SERVER_NAMES) {
    if (mcpServers[name]) {
      return { name, config: mcpServers[name] };
    }
  }
  // Fallback: check keys containing "gutt" and "mcp"
  for (const key of Object.keys(mcpServers)) {
    const lower = key.toLowerCase();
    if (lower.includes("gutt") && lower.includes("mcp")) {
      return { name: key, config: mcpServers[key] };
    }
  }
  return null;
}

/**
 * Resolve env var interpolation in a URL string.
 * Handles patterns like ${GUTT_MCP_URL} or $GUTT_MCP_URL.
 * @param {string} url
 * @returns {string}
 */
function resolveEnvVars(url) {
  return url.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || "";
  });
}

/**
 * Extract an HTTP URL from a gutt MCP server config object.
 * Returns the URL for HTTP/streamable transport, or null for stdio-only configs.
 * @param {Object} config - Server config from settings
 * @returns {string|null}
 */
function extractUrlFromConfig(config) {
  if (!config) {
    return null;
  }

  // Direct url field (HTTP/StreamableHTTP transport)
  if (config.url) {
    const resolved = resolveEnvVars(String(config.url));
    return resolved || null;
  }

  // stdio transport (command + args) — can't use for HTTP calls
  if (config.command) {
    return null;
  }

  return null;
}

/**
 * Extract the gutt MCP URL from Claude Code settings files.
 * Searches the same files as isGuttMcpConfigured() in the same order.
 * @returns {string|null} The MCP base URL, or null if not found
 */
function getGuttMcpUrl() {
  const filesToCheck = [
    // Claude Code user scope
    { path: path.join(HOME_DIR, ".claude", "settings.json"), type: "settings" },
    // User scope .mcp.json
    { path: path.join(HOME_DIR, ".mcp.json"), type: "mcp" },
    // Cursor user scope
    { path: path.join(HOME_DIR, ".cursor", "mcp.json"), type: "mcp" },
    // Project scope settings
    { path: path.join(PROJECT_DIR, ".claude", "settings.json"), type: "settings" },
    // Project scope .mcp.json
    { path: path.join(PROJECT_DIR, ".mcp.json"), type: "mcp" },
  ];

  for (const file of filesToCheck) {
    const url =
      file.type === "settings"
        ? extractUrlFromSettingsFile(file.path)
        : extractUrlFromMcpFile(file.path);
    if (url) {
      return url;
    }
  }

  // Check plugin cache directories
  const pluginCachePath = path.join(HOME_DIR, ".claude", "plugins", "cache");
  if (fs.existsSync(pluginCachePath)) {
    try {
      const cacheEntries = fs.readdirSync(pluginCachePath);
      for (const entry of cacheEntries) {
        const mcpPath = path.join(pluginCachePath, entry, ".mcp.json");
        const url = extractUrlFromMcpFile(mcpPath);
        if (url) {
          return url;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

/**
 * Check if gutt-mcp-remote MCP server is configured in settings
 * Checks both user scope and project scope for both Claude Code and Cursor.
 * @returns {boolean} true if gutt-mcp-remote is configured
 */
function isGuttMcpConfigured() {
  // If we can extract a URL, it's configured
  if (getGuttMcpUrl()) {
    return true;
  }

  // Also check for stdio-based configs (command/args) which don't yield a URL
  const claudeUserSettingsPath = path.join(HOME_DIR, ".claude", "settings.json");
  if (checkSettingsFile(claudeUserSettingsPath)) {
    return true;
  }

  const userMcpPath = path.join(HOME_DIR, ".mcp.json");
  if (checkMcpFile(userMcpPath)) {
    return true;
  }

  const cursorUserMcpPath = path.join(HOME_DIR, ".cursor", "mcp.json");
  if (checkMcpFile(cursorUserMcpPath)) {
    return true;
  }

  const projectSettingsPath = path.join(PROJECT_DIR, ".claude", "settings.json");
  if (checkSettingsFile(projectSettingsPath)) {
    return true;
  }

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
 * Extract gutt MCP URL from a settings.json file (Claude Code format).
 * settings.mcpServers["gutt-mcp-remote"].url
 * @param {string} settingsPath
 * @returns {string|null}
 */
function extractUrlFromSettingsFile(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const found = findGuttServerConfig(settings.mcpServers);
    if (found) {
      return extractUrlFromConfig(found.config);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Extract gutt MCP URL from an .mcp.json file.
 * mcpConfig.mcpServers["gutt-mcp-remote"].url
 * @param {string} mcpPath
 * @returns {string|null}
 */
function extractUrlFromMcpFile(mcpPath) {
  if (!fs.existsSync(mcpPath)) {
    return null;
  }
  try {
    const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    const found = findGuttServerConfig(mcpConfig.mcpServers);
    if (found) {
      return extractUrlFromConfig(found.config);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Check if a settings file contains gutt-mcp-remote configuration
 */
function checkSettingsFile(settingsPath) {
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (findGuttServerConfig(settings.mcpServers)) {
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
      if (findGuttServerConfig(mcpConfig.mcpServers)) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }
  return false;
}

module.exports = { isGuttMcpConfigured, getGuttMcpUrl };
