#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, HOME_DIR } = require("./env.cjs");

/** Server name patterns to match for gutt MCP */
const GUTT_SERVER_NAMES = [
  "gutt-mcp-remote",
  "gutt-pro-memory",
  "gutt_mcp",
  "gutt-mcp",
  "claude_ai_gutt_mcp",
  "claude_ai_gutt-pro-memory",
];

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
  // Exact match first
  for (const name of GUTT_SERVER_NAMES) {
    if (mcpServers[name]) {
      return { name, config: mcpServers[name] };
    }
  }
  // Fallback: any server name containing "gutt" (case-insensitive)
  for (const name of Object.keys(mcpServers)) {
    if (name.toLowerCase().includes("gutt")) {
      return { name, config: mcpServers[name] };
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
  const resolved = url
    .replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] || "")
    .replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName) => process.env[varName] || "");
  // If resolution produced an empty or clearly invalid URL, return empty
  if (!resolved || (resolved === url && url.includes("$"))) {
    return "";
  }
  return resolved;
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
  const filesToCheck = [
    { path: path.join(HOME_DIR, ".claude", "settings.json"), type: "settings" },
    { path: path.join(HOME_DIR, ".mcp.json"), type: "mcp" },
    { path: path.join(HOME_DIR, ".cursor", "mcp.json"), type: "mcp" },
    { path: path.join(PROJECT_DIR, ".claude", "settings.json"), type: "settings" },
    { path: path.join(PROJECT_DIR, ".mcp.json"), type: "mcp" },
  ];

  for (const file of filesToCheck) {
    const found = file.type === "settings" ? checkSettingsFile(file.path) : checkMcpFile(file.path);
    if (found) {
      return true;
    }
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
      for (const entry of fs.readdirSync(pluginCachePath)) {
        if (checkMcpFile(path.join(pluginCachePath, entry, ".mcp.json"))) {
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

/**
 * Diagnose gutt MCP configuration status.
 * Returns a structured result with config status and URL.
 * Note: Cannot test reachability from a hook (no async HTTP).
 * @returns {{ configured: boolean, url: string|null, error: string|null }}
 */
function diagnoseGuttMcp() {
  const configured = isGuttMcpConfigured();
  if (!configured) {
    return {
      configured: false,
      url: null,
      error: "gutt MCP server not found in any settings file",
    };
  }

  const url = getGuttMcpUrl();
  if (!url) {
    return {
      configured: true,
      url: null,
      error: "gutt MCP configured but no HTTP URL found (may be stdio transport)",
    };
  }

  return { configured: true, url, error: null };
}

module.exports = {
  isGuttMcpConfigured,
  getGuttMcpUrl,
  diagnoseGuttMcp,
  // Exported for unit testing
  findGuttServerConfig,
  resolveEnvVars,
  extractUrlFromConfig,
};
