#!/usr/bin/env node
/**
 * GUTT Configuration Loader
 * Shared config loader for hooks - loads group_id from config or environment
 */

const fs = require("fs");
const path = require("path");

// Use CLAUDE_PROJECT_DIR to find the user's project directory (not the plugin install path)
// Falls back to cwd() if env var not set
const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");

let cachedConfig = null;
let cachedSource = null;

/**
 * Load and parse config.json from project root
 * @returns {Object|null} Parsed config or null if not found/invalid
 */
function loadConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return null;
    }
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(content);
  } catch (err) {
    console.error(`[WARN] Failed to load config.json: ${err.message}`, "\n");
    return null;
  }
}

/**
 * Get GUTT group_id with priority: env var > config.json > fallback
 * @returns {string} Group ID (may be empty string if not configured)
 */
function getGroupId() {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  // Priority 1: Environment variable
  if (process.env.GUTT_GROUP_ID) {
    cachedConfig = process.env.GUTT_GROUP_ID;
    cachedSource = "environment";
    return cachedConfig;
  }

  // Priority 2: config.json
  const config = loadConfigFile();
  if (config?.gutt?.group_id) {
    cachedConfig = config.gutt.group_id;
    cachedSource = "config.json";
    return cachedConfig;
  }

  // Priority 3: Fallback - MCP server handles group_id via authentication
  // No local config needed, no warning required
  cachedConfig = "";
  cachedSource = "mcp-auth";
  return cachedConfig;
}

/**
 * Check if GUTT is properly configured (has a non-empty group_id)
 * @returns {boolean} True if group_id is configured
 */
function isConfigured() {
  const groupId = getGroupId();
  return groupId.length > 0;
}

/**
 * Get the source of the current configuration
 * @returns {string} One of: 'environment', 'config.json', 'fallback'
 */
function getConfigSource() {
  getGroupId(); // Ensure cache is populated
  return cachedSource || "fallback";
}

/**
 * Get full config object
 * @returns {Object} Full config object with config and source
 */
function loadConfig() {
  return {
    config: loadConfigFile(),
    source: getConfigSource(),
  };
}

/**
 * Get full config object (alias for backward compatibility)
 * @returns {Object} Full config object
 */
function getConfig() {
  return loadConfigFile();
}

/**
 * Get statusline configuration
 * @returns {Object} Statusline config object
 */
function getStatuslineConfig() {
  return loadConfig().config?.gutt?.statusline || {};
}

module.exports = {
  getGroupId,
  isConfigured,
  getConfigSource,
  getConfig,
  loadConfig,
  getStatuslineConfig,
  CONFIG_PATH,
};
