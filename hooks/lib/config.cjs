#!/usr/bin/env node
/**
 * GUTT Configuration Loader
 * Shared config loader for hooks - loads group_id from config or environment
 */

const fs = require("fs");
const path = require("path");

// Use __dirname for reliable cross-platform path resolution (lesson 9407a251)
const PROJECT_ROOT = path.resolve(__dirname, "../..");
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
    console.error(
      `[WARN] Failed to load config.json: ${err.message}`,
      "\n",
    );
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

  // Priority 3: Fallback to empty string
  console.error(
    "[WARN] No GUTT group_id configured. Set GUTT_GROUP_ID env var or add to config.json",
    "\n",
  );
  cachedConfig = "";
  cachedSource = "fallback";
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

module.exports = {
  getGroupId,
  isConfigured,
  getConfigSource,
  CONFIG_PATH,
};
