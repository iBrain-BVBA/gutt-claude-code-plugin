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
  // One pass, so a substituted value (a userConfig URL, an env default) is never
  // itself scanned for `$NAME`.
  const resolved = url.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, expr, bare) => {
    if (bare) {
      return process.env[bare] || "";
    }
    const userConfig = /^user_config\.([A-Za-z0-9_]+)$/.exec(expr);
    if (userConfig) {
      return resolveUserConfig(userConfig[1], pluginRoot);
    }
    const sep = expr.indexOf(":-");
    if (sep !== -1) {
      return process.env[expr.slice(0, sep)] || expr.slice(sep + 2);
    }
    return process.env[expr] || "";
  });
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
 * Places a gutt server can be registered, in the order hooks consult them.
 *
 * `claude mcp add` does not write settings.json: it stores local-scope servers (the CLI
 * default) under `projects[<dir>].mcpServers` in `~/.claude.json`, and user-scope ones
 * under that file's top-level `mcpServers`. Earlier versions of `/gutt-pro:setup` ran
 * `claude mcp add --scope user`, so an upgrading user's organization endpoint lives
 * there; without these entries the lookup fell through to the plugin's stage default.
 * Claude Code ranks local, project and user servers above plugin servers, so all of
 * them come before the plugin's own declaration.
 * @returns {Array<{ path: string, scope: string|null, servers: (json: Object) => Object }>}
 */
function configSources() {
  const claudeJson = path.join(HOME_DIR, ".claude.json");
  const top = (json) => json.mcpServers;
  return [
    {
      path: claudeJson,
      scope: "local",
      servers: (json) =>
        json.projects && json.projects[PROJECT_DIR] && json.projects[PROJECT_DIR].mcpServers,
    },
    { path: path.join(HOME_DIR, ".claude", "settings.json"), scope: null, servers: top },
    { path: claudeJson, scope: "user", servers: top },
    { path: path.join(HOME_DIR, ".mcp.json"), scope: null, servers: top },
    { path: path.join(HOME_DIR, ".cursor", "mcp.json"), scope: null, servers: top },
    { path: path.join(PROJECT_DIR, ".claude", "settings.json"), scope: null, servers: top },
    { path: path.join(PROJECT_DIR, ".mcp.json"), scope: "project", servers: top },
  ];
}

/**
 * Find the gutt server entry in one config file.
 * @param {string} filePath
 * @param {(json: Object) => Object} [pickServers] - selects the mcpServers map
 * @returns {{ name: string, config: Object }|null}
 */
function readGuttServer(filePath, pickServers = (json) => json.mcpServers) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return findGuttServerConfig(json && pickServers(json));
  } catch {
    // Ignore read and parse errors
    return null;
  }
}

/**
 * Extract the gutt MCP URL from an .mcp.json (or settings.json) file.
 * @param {string} mcpPath
 * @returns {string|null}
 */
function extractUrlFromMcpFile(mcpPath) {
  const found = readGuttServer(mcpPath);
  return found ? extractUrlFromConfig(found.config) : null;
}

/**
 * URL of the plugin's own server (gutt-core/.mcp.json, URL from userConfig.mcp_url).
 * @returns {string|null}
 */
function pluginServerUrl() {
  return PLUGIN_ROOT ? extractUrlFromMcpFile(path.join(PLUGIN_ROOT, ".mcp.json")) : null;
}

/**
 * Locate the gutt server Claude Code (or Cursor) will treat as primary.
 * @returns {{ url: string, name: string|null, source: string, scope: string|null }|null}
 */
function locateGuttMcp() {
  for (const source of configSources()) {
    const found = readGuttServer(source.path, source.servers);
    const url = found && extractUrlFromConfig(found.config);
    if (url) {
      return { url, name: found.name, source: source.path, scope: source.scope };
    }
  }

  const fromPlugin = pluginServerUrl();
  if (fromPlugin) {
    return { url: fromPlugin, name: null, source: "plugin", scope: "plugin" };
  }

  // Check plugin cache directories
  const pluginCachePath = path.join(HOME_DIR, ".claude", "plugins", "cache");
  if (fs.existsSync(pluginCachePath)) {
    try {
      for (const entry of fs.readdirSync(pluginCachePath)) {
        const mcpPath = path.join(pluginCachePath, entry, ".mcp.json");
        const url = extractUrlFromMcpFile(mcpPath);
        if (url) {
          return { url, name: null, source: mcpPath, scope: "plugin" };
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

/**
 * Extract the gutt MCP URL from Claude Code and Cursor config files.
 * Searches the same places as isGuttMcpConfigured() in the same order.
 * @returns {string|null} The MCP base URL, or null if not found
 */
function getGuttMcpUrl() {
  const located = locateGuttMcp();
  return located ? located.url : null;
}

/**
 * Check if gutt-mcp-remote MCP server is configured in settings
 * Checks local, user and project scope for both Claude Code and Cursor.
 * @returns {boolean} true if gutt-mcp-remote is configured
 */
function isGuttMcpConfigured() {
  for (const source of configSources()) {
    if (readGuttServer(source.path, source.servers)) {
      return true;
    }
  }

  // The plugin ships its own server declaration
  if (PLUGIN_ROOT && readGuttServer(path.join(PLUGIN_ROOT, ".mcp.json"))) {
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
        if (readGuttServer(path.join(pluginCachePath, entry, ".mcp.json"))) {
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
 * Warn when a gutt server registered outside the plugin points somewhere other than
 * the plugin's own server. Claude Code namespaces plugin servers, so both run and the
 * memory tools of two endpoints are live at once.
 * @param {{ url: string, name: string|null, source: string, scope: string|null }|null} located
 * @param {string|null} pluginUrl
 * @returns {string|null}
 */
function shadowWarning(located, pluginUrl) {
  if (!located || located.scope === "plugin" || !pluginUrl || located.url === pluginUrl) {
    return null;
  }
  const scope = located.scope === "local" || located.scope === "user" ? located.scope : null;
  const remove = scope
    ? `run \`claude mcp remove ${located.name} --scope ${scope}\``
    : `remove it from ${located.source}`;
  return (
    `A gutt MCP server at ${located.url} is registered outside the plugin, so it runs ` +
    `alongside the plugin's own server at ${pluginUrl}. To keep one endpoint, ${remove} ` +
    "and set the gutt-pro option mcp_url instead."
  );
}

/**
 * Diagnose gutt MCP configuration status.
 * Returns a structured result with config status and URL.
 * Note: Cannot test reachability from a hook (no async HTTP).
 * @returns {{ configured: boolean, url: string|null, error: string|null, warning: string|null }}
 */
function diagnoseGuttMcp() {
  const configured = isGuttMcpConfigured();
  if (!configured) {
    return {
      configured: false,
      url: null,
      error: "gutt MCP server not found in any settings file",
      warning: null,
    };
  }

  const located = locateGuttMcp();
  if (!located) {
    return {
      configured: true,
      url: null,
      error: "gutt MCP configured but no HTTP URL found (may be stdio transport)",
      warning: null,
    };
  }

  return {
    configured: true,
    url: located.url,
    error: null,
    warning: shadowWarning(located, pluginServerUrl()),
  };
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
  shadowWarning,
};
