#!/usr/bin/env node
/**
 * GUTT SessionStart Setup Hook
 * Auto-enables GUTT HUD statusline on first session
 *
 * This hook runs at the start of every Claude Code session.
 * On first run, it automatically configures the GUTT statusline
 * and stores the existing statusline for passthrough.
 *
 * Requirements:
 * - Check marker file: ~/.claude/.gutt-statusline-configured
 * - If marker doesn't exist, auto-configure statusline
 * - Store existing statusline as guttPassthroughStatusline
 * - Write marker file with timestamp
 * - ALWAYS exit 0 (never block session start)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Respect HOME env var for testing (process.env.HOME || process.env.USERPROFILE for Windows || os.homedir())
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const MARKER_FILE = path.join(HOME_DIR, ".claude", ".gutt-statusline-configured");
const SETTINGS_FILE = path.join(HOME_DIR, ".claude", "settings.json");

/**
 * Atomic write for Windows compatibility
 * Windows can't overwrite files atomically, so we delete first
 * @param {string} filePath - Target file path
 * @param {string} content - Content to write
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Windows-safe atomic write: delete before rename
  const tempPath = filePath + ".tmp";

  try {
    fs.writeFileSync(tempPath, content, "utf8");

    // Delete existing file if present (Windows requirement)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Rename temp to final
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on error
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/**
 * Load existing settings.json
 * @returns {Object} Parsed settings or empty object
 */
function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return {};
    }
    const content = fs.readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(content);
  } catch (err) {
    // If settings.json is invalid, return empty object
    // This is fail-safe: we still configure GUTT
    console.error(`[WARN] Failed to load settings.json: ${err.message}`); // eslint-disable-line no-console
    return {};
  }
}

/**
 * Save settings.json with atomic write
 * @param {Object} settings - Settings object to save
 */
function saveSettings(settings) {
  const content = JSON.stringify(settings, null, 2);
  atomicWrite(SETTINGS_FILE, content);
}

/**
 * Get plugin version from package.json
 * @returns {string} Plugin version or "unknown"
 */
function getPluginVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return pkg.version || "unknown";
    }
  } catch {
    // ignore
  }
  return "unknown";
}

/**
 * Write marker file with timestamp and version
 */
function writeMarker() {
  const marker = {
    configuredAt: new Date().toISOString(),
    version: getPluginVersion(),
  };
  const content = JSON.stringify(marker, null, 2);
  atomicWrite(MARKER_FILE, content);
}

/**
 * Main setup logic
 */
function setup() {
  try {
    // Check if already configured
    if (fs.existsSync(MARKER_FILE)) {
      // Already configured, exit silently
      process.exit(0);
    }

    // Load existing settings
    const settings = loadSettings();

    // Store existing statusLine as passthrough (if present)
    // Note: Claude Code uses "statusLine" (camelCase) in settings.json
    if (settings.statusLine) {
      if (!settings.gutt) {
        settings.gutt = {};
      }
      if (!settings.gutt.statusline) {
        settings.gutt.statusline = {};
      }
      // Store the existing statusLine command for passthrough
      settings.gutt.statusline.passthroughCommand =
        settings.statusLine.command || settings.statusLine;
    }

    // Configure GUTT statusline using dynamic path
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) {
      // If CLAUDE_PLUGIN_ROOT is not set, skip setup
      // This shouldn't happen in normal operation, but fail-safe
      console.error("[WARN] CLAUDE_PLUGIN_ROOT not set, skipping GUTT statusline setup"); // eslint-disable-line no-console
      process.exit(0);
    }

    const statuslineHook = path.join(pluginRoot, "hooks", "statusline.cjs");
    settings.statusLine = {
      type: "command",
      command: `node "${statuslineHook}"`,
    };

    // Save updated settings
    saveSettings(settings);

    // Write marker file
    writeMarker();

    // Output success message
    console.log("✅ GUTT HUD enabled automatically"); // eslint-disable-line no-console
  } catch {
    // ALWAYS exit 0 - never block session start
    // Silent failure is better than blocking the user
    process.exit(0);
  }
}

// Read JSON input from stdin (required for hooks)
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  // Consume stdin data (required for hook protocol)
});
process.stdin.on("end", () => {
  setup();
});
