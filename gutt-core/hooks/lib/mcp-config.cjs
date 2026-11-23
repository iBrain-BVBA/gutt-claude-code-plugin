#!/usr/bin/env node
/**
 * Shared MCP configuration utilities
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_DIR, HOME_DIR, PLUGIN_ROOT, IDE } = require("./env.cjs");
const { debugLog } = require("./debug.cjs");

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
 * The plugin root. Claude Code sets CLAUDE_PLUGIN_ROOT for hooks but not for the Bash
 * tool, where `/gutt-pro:health` loads this module, so fall back to the root that holds
 * this file (`<root>/hooks/lib`). Cursor does not load the plugin's own servers, so it
 * has no plugin root to consult.
 */
const ROOT = PLUGIN_ROOT || (IDE === "claude" ? path.resolve(__dirname, "..", "..") : null);

/**
 * Read a plugin `userConfig` value the way Claude Code would substitute it.
 *
 * Claude Code exports every option to hook processes as
 * `CLAUDE_PLUGIN_OPTION_<KEY>` (key uppercased). When that variable is absent, either
 * because the user never set the option or because this process is not a hook (the
 * Bash tool does not get it), fall back to the manifest's `default` in
 * `<pluginRoot>/.claude-plugin/plugin.json`. This assumes Claude Code substitutes the
 * same default when the option is unset (unverified; see the PR #103 test plan).
 * `diagnoseGuttMcp()` reports `source: "plugin-default"` when this fallback was used.
 * @param {string} key - option key as written in `${user_config.<key>}`
 * @param {string|null} [pluginRoot] - plugin root; defaults to the plugin holding this file
 * @returns {string}
 */
function resolveUserConfig(key, pluginRoot = ROOT) {
  const fromEnv = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  if (fromEnv) {
    return fromEnv;
  }
  if (!pluginRoot) {
    return "";
  }
  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const option = manifest.userConfig && manifest.userConfig[key];
    return option && typeof option.default === "string" ? option.default : "";
  } catch (err) {
    debugLog("mcp-config", { message: `${manifestPath}: ${err.message}`, stack: err.stack });
    return "";
  }
}

/**
 * Resolve interpolation in a URL string. Mirrors Claude Code's `${user_config.KEY}`,
 * `${VAR}` and `${VAR:-default}`; bare `$VAR` is also accepted for older hand-written
 * configs (Claude Code itself does not expand it).
 * @param {string} url
 * @param {string|null} [pluginRoot] - plugin root for `${user_config.*}` defaults
 * @returns {string}
 */
function resolveEnvVars(url, pluginRoot = ROOT) {
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
  return null;
}

/**
 * Compare two endpoint URLs the way a person would: host case and a trailing slash do
 * not make a different server.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return String(url).trim().replace(/\/+$/, "");
  }
}

/**
 * Places a gutt server can be registered outside the plugin, in the order hooks consult
 * them. The list depends on the host IDE, since each runs only its own registrations.
 *
 * Claude Code: `claude mcp add` does not write settings.json. It stores local-scope
 * servers (the CLI default) under `projects[<dir>].mcpServers` in `~/.claude.json`, and
 * user-scope ones under that file's top-level `mcpServers`; project scope is
 * `<project>/.mcp.json`. Earlier versions of `/gutt-pro:setup` ran
 * `claude mcp add --scope user`, so an upgrading user's organization endpoint lives
 * there. The order is Claude Code's precedence for same-named servers: local, project,
 * user. The settings.json files and `~/.mcp.json` are legacy places older setups wrote
 * to; they come last and carry no scope.
 *
 * Cursor: `~/.cursor/mcp.json` first (what `/gutt-pro:setup` writes there), then the
 * same legacy files as before; never `~/.claude.json`, which Cursor does not load.
 * @returns {Array<{ path: string, scope: string|null, servers: (json: Object) => Object }>}
 */
function configSources() {
  const claudeJson = path.join(HOME_DIR, ".claude.json");
  const top = (json) => json.mcpServers;
  const legacy = [
    { path: path.join(HOME_DIR, ".claude", "settings.json"), scope: null, servers: top },
    { path: path.join(PROJECT_DIR, ".claude", "settings.json"), scope: null, servers: top },
    { path: path.join(HOME_DIR, ".mcp.json"), scope: null, servers: top },
  ];
  if (IDE === "cursor") {
    return [
      { path: path.join(HOME_DIR, ".cursor", "mcp.json"), scope: null, servers: top },
      ...legacy,
      { path: path.join(PROJECT_DIR, ".mcp.json"), scope: null, servers: top },
    ];
  }
  return [
    {
      path: claudeJson,
      scope: "local",
      servers: (json) =>
        json.projects && json.projects[PROJECT_DIR] && json.projects[PROJECT_DIR].mcpServers,
    },
    { path: path.join(PROJECT_DIR, ".mcp.json"), scope: "project", servers: top },
    { path: claudeJson, scope: "user", servers: top },
    ...legacy,
  ];
}

/**
 * Find the gutt server entry in one config file. A missing file is normal; a file that
 * exists but cannot be read or parsed is logged and, when `problems` is given, recorded
 * there so the caller can say its answer may be incomplete.
 * @param {string} filePath
 * @param {(json: Object) => Object} [pickServers] - selects the mcpServers map
 * @param {string[]|null} [problems]
 * @returns {{ name: string, config: Object }|null}
 */
function readGuttServer(filePath, pickServers = (json) => json.mcpServers, problems = null) {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return findGuttServerConfig(json && pickServers(json));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return null;
    }
    debugLog("mcp-config", { message: `${filePath}: ${err.message}`, stack: err.stack });
    if (problems) {
      problems.push(`could not read ${filePath} (${err.message})`);
    }
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
 * The plugin's own server (gutt-core/.mcp.json, URL from userConfig.mcp_url), and
 * whether its URL came from the manifest default because no `CLAUDE_PLUGIN_OPTION_*`
 * value was visible to this process.
 * @returns {{ url: string, fromDefault: boolean }|null}
 */
function pluginServer() {
  if (!ROOT) {
    return null;
  }
  const found = readGuttServer(path.join(ROOT, ".mcp.json"));
  const url = found && extractUrlFromConfig(found.config);
  if (!url) {
    return null;
  }
  const raw = String(found.config.url);
  const fromDefault = [...raw.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].some(
    (m) => !process.env[`CLAUDE_PLUGIN_OPTION_${m[1].toUpperCase()}`]
  );
  return { url, fromDefault };
}

/**
 * First gutt server found in configSources() order, else the plugin's own.
 * @param {string[]|null} [problems] - collects config files that could not be read
 * @returns {{ url: string, name: string|null, source: string, scope: string|null }|null}
 */
function locateGuttMcp(problems = null) {
  for (const source of configSources()) {
    const found = readGuttServer(source.path, source.servers, problems);
    const url = found && extractUrlFromConfig(found.config);
    if (url) {
      return { url, name: found.name, source: source.path, scope: source.scope };
    }
  }

  const plugin = pluginServer();
  if (plugin) {
    return { url: plugin.url, name: null, source: "plugin", scope: "plugin" };
  }

  return null;
}

/**
 * The gutt MCP URL: the first registration in configSources(), else the plugin's own.
 * Same sources as isGuttMcpConfigured(); unlike it, a bare marketplace checkout does not
 * count.
 * @returns {string|null} The MCP base URL, or null if not found
 */
function getGuttMcpUrl() {
  const located = locateGuttMcp();
  return located ? located.url : null;
}

/**
 * Check whether a gutt MCP server is configured: in any configSources() entry for the
 * host IDE, in the plugin's own `.mcp.json`, or (legacy) because the gutt marketplace is
 * checked out.
 * @param {string[]|null} [problems] - collects config files that could not be read
 * @returns {boolean}
 */
function isGuttMcpConfigured(problems = null) {
  for (const source of configSources()) {
    if (readGuttServer(source.path, source.servers, problems)) {
      return true;
    }
  }

  // The plugin ships its own server declaration
  if (ROOT && readGuttServer(path.join(ROOT, ".mcp.json"))) {
    return true;
  }

  // Check if gutt plugin is installed (plugin provides MCP at runtime)
  const pluginPath = path.join(HOME_DIR, ".claude", "plugins", "marketplaces", "gutt-plugins");
  return fs.existsSync(pluginPath);
}

/**
 * Warn when a gutt server registered outside the plugin (local, project or user scope:
 * the scopes Claude Code runs next to plugin servers) points somewhere other than the
 * plugin's own server. Claude Code namespaces plugin servers, so both run and the
 * memory tools of two endpoints are live at once.
 * @param {{ url: string, name: string|null, source: string, scope: string|null }|null} located
 * @param {string|null} pluginUrl
 * @returns {string|null}
 */
function shadowWarning(located, pluginUrl) {
  if (
    !located ||
    !pluginUrl ||
    !["local", "project", "user"].includes(located.scope) ||
    normalizeUrl(located.url) === normalizeUrl(pluginUrl)
  ) {
    return null;
  }
  const remove =
    located.scope === "project"
      ? `remove it from ${located.source}`
      : `run \`claude mcp remove ${located.name} --scope ${located.scope}\``;
  return (
    `A gutt MCP server at ${located.url} is registered outside the plugin, so it runs ` +
    `alongside the plugin's own server at ${pluginUrl}. To keep one endpoint, ${remove} ` +
    "and set the gutt-pro option mcp_url instead."
  );
}

/**
 * Every Claude Code registration (local, project, user) that runs next to the plugin's
 * server at a different URL. A same-named server in a lower scope is overridden by the
 * higher one, so only the first entry per name counts.
 * @param {string|null} pluginUrl
 * @returns {string[]}
 */
function shadowWarnings(pluginUrl) {
  if (!pluginUrl || IDE !== "claude") {
    return [];
  }
  const seen = new Set();
  const warnings = [];
  for (const source of configSources()) {
    if (!source.scope) {
      continue;
    }
    const found = readGuttServer(source.path, source.servers);
    if (!found || seen.has(found.name.toLowerCase())) {
      continue;
    }
    seen.add(found.name.toLowerCase());
    const url = extractUrlFromConfig(found.config);
    const warning =
      url &&
      shadowWarning({ url, name: found.name, source: source.path, scope: source.scope }, pluginUrl);
    if (warning) {
      warnings.push(warning);
    }
  }
  return warnings;
}

/**
 * Diagnose gutt MCP configuration status.
 * Note: Cannot test reachability from a hook (no async HTTP).
 *
 * `source` is the config file the URL came from, or `plugin-option` / `plugin-default`
 * for the plugin's own server. `plugin-default` means no `mcp_url` option value was
 * visible to this process (the Bash tool never gets one), so the URL is the manifest
 * default and the user's configured value, if any, has to be read another way.
 * @returns {{ configured: boolean, url: string|null, source: string|null, error: string|null, warning: string|null }}
 */
function diagnoseGuttMcp() {
  const problems = [];
  const configured = isGuttMcpConfigured(problems);
  const located = configured ? locateGuttMcp(problems) : null;
  const unreadable = [...new Set(problems)].map(
    (p) => `gutt ${p}, so the URL shown may not be the one in use.`
  );

  if (!configured) {
    return {
      configured: false,
      url: null,
      source: null,
      error: "gutt MCP server not found in any settings file",
      warning: unreadable.join(" ") || null,
    };
  }

  if (!located) {
    return {
      configured: true,
      url: null,
      source: null,
      error:
        "gutt MCP configured but no URL resolved (a stdio transport, or a ${...} variable that is not set)",
      warning: unreadable.join(" ") || null,
    };
  }

  const plugin = pluginServer();
  let source = located.source;
  if (located.scope === "plugin") {
    source = plugin && plugin.fromDefault ? "plugin-default" : "plugin-option";
  }
  const warnings = [...unreadable, ...shadowWarnings(plugin && plugin.url)];
  return {
    configured: true,
    url: located.url,
    source,
    error: null,
    warning: warnings.join(" ") || null,
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
  normalizeUrl,
};
