#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, HOME_DIR, PLUGIN_ROOT } = require("./env.cjs");

/** Known short server names for gutt MCP (case-insensitive match) */
const GUTT_SERVER_NAMES = [
  "gutt-mcp-remote",
  "gutt-pro-memory",
  "gutt_mcp",
  "gutt-mcp",
  "gutt-interactive",
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
  // Known-name match first (case-insensitive)
  for (const key of Object.keys(mcpServers)) {
    const lower = key.toLowerCase();
    if (GUTT_SERVER_NAMES.includes(lower)) {
      return { name: key, config: mcpServers[key] };
    }
  }
  // Catch-all: any server name containing "gutt" (case-insensitive)
  // Handles claude_ai_gutt*, Gutt-interactive, and any future variants
  for (const name of Object.keys(mcpServers)) {
    if (name.toLowerCase().includes("gutt")) {
      return { name, config: mcpServers[name] };
    }
  }
  return null;
}

/**
 * Read a plugin `userConfig` value the way Claude Code would substitute it.
 *
 * Claude Code exports every option to hook processes as
 * `CLAUDE_PLUGIN_OPTION_<KEY>` (key uppercased). When the user never set the option
 * that variable may be absent, and the manifest's `default` is what Claude Code
 * itself falls back to, so read it from `<pluginRoot>/.claude-plugin/plugin.json`.
 * @param {string} key - option key as written in `${user_config.<key>}`
 * @param {string|null} [pluginRoot] - plugin root; defaults to CLAUDE_PLUGIN_ROOT
 * @returns {string}
 */
function resolveUserConfig(key, pluginRoot = PLUGIN_ROOT) {
  const fromEnv = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  if (fromEnv) {
    return fromEnv;
  }
  if (!pluginRoot) {
    return "";
  }
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")
    );
    const option = manifest.userConfig && manifest.userConfig[key];
    return option && typeof option.default === "string" ? option.default : "";
  } catch {
    return "";
  }
}

/**
 * Resolve interpolation in a URL string, as Claude Code does for MCP configs.
 * Handles `${user_config.KEY}`, `${VAR}`, `${VAR:-default}` and `$VAR`.
 * @param {string} url
 * @param {string|null} [pluginRoot] - plugin root for `${user_config.*}` defaults
 * @returns {string}
 */
function resolveEnvVars(url, pluginRoot = PLUGIN_ROOT) {
  const resolved = url
    .replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const userConfig = /^user_config\.([A-Za-z0-9_]+)$/.exec(expr);
      if (userConfig) {
        return resolveUserConfig(userConfig[1], pluginRoot);
      }
      const sep = expr.indexOf(":-");
      if (sep !== -1) {
        return process.env[expr.slice(0, sep)] || expr.slice(sep + 2);
      }
      return process.env[expr] || "";
    })
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

  // The plugin's own server (gutt-core/.mcp.json, URL from userConfig.mcp_url).
  // Claude Code ranks plugin servers below user and project ones, so check it after them.
  if (PLUGIN_ROOT) {
    const url = extractUrlFromMcpFile(path.join(PLUGIN_ROOT, ".mcp.json"));
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

  // The plugin ships its own server declaration
  if (PLUGIN_ROOT && checkMcpFile(path.join(PLUGIN_ROOT, ".mcp.json"))) {
    return true;
  }

  // Check if gutt plugin is installed (plugin provides MCP at runtime)
  const pluginPath = path.join(HOME_DIR, ".claude", "plugins", "marketplaces", "gutt-plugins");
  if (fs.existsSync(pluginPath)) {
    return true;
  }

  // Check plugin cache directories for the gutt-pro plugin
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
  resolveUserConfig,
  extractUrlFromConfig,
  extractUrlFromMcpFile,
};
