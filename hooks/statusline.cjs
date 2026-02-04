#!/usr/bin/env node
/**
 * GUTT Statusline Hook
 * Displays GUTT connection status and session metrics
 * Supports chaining with other statusline scripts via passthroughCommand
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { getState } = require("./lib/session-state.cjs");
const { getGroupId, isConfigured, getConfig } = require("./lib/config.cjs");
const { debugLog } = require("./lib/debug.cjs");

/**
 * Validate passthrough command to prevent command injection
 * Allows: file paths, node/npx commands, common statusline scripts
 * Rejects: shell metacharacters that could chain commands
 * @param {string} command - Command string to validate
 * @returns {boolean} True if command is safe to execute
 */
function isValidPassthroughCommand(command) {
  if (!command || typeof command !== "string") {
    return false;
  }

  // Reject commands with dangerous shell metacharacters
  // These could be used to chain arbitrary commands
  const dangerousPatterns = [
    /[;&|]/, // Command chaining: ; && || |
    /\$\(/, // Command substitution: $(...)
    /`/, // Backtick substitution
    />\s*[&]?/, // Output redirection: > >> >&
    /<\s*[&]?/, // Input redirection: < <<
    /\n|\r/, // Newlines (could execute multiple commands)
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      debugLog("statusline", `Rejected passthrough command with dangerous pattern: ${pattern}`);
      return false;
    }
  }

  return true;
}

/**
 * Format ticker with toast-style display
 * Shows each item for 5 seconds then disappears
 * @param {Array} items - Ticker items with icon and text
 * @returns {string|null} Formatted ticker text or null if nothing to show
 */
function formatTicker(items) {
  if (!items || items.length === 0) {
    return null;
  }

  const now = Date.now();
  const DISPLAY_DURATION = 5000; // 5 seconds

  // Find items that are less than 5 seconds old (most recent first)
  const freshItems = items
    .filter((item) => now - item.createdAt < DISPLAY_DURATION)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (freshItems.length === 0) {
    return null; // Nothing to show - all items expired
  }

  // Show the most recent fresh item
  const item = freshItems[0];
  return `${item.icon} ${item.text}`;
}

/**
 * Load user settings from ~/.claude/settings.json
 * Returns empty object on failure (fail-safe)
 * @returns {Object} Parsed settings or empty object
 */
function loadUserSettings() {
  try {
    const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const settingsPath = path.join(HOME_DIR, ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    const content = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Execute passthrough statusline with timeout
 * Returns empty string on failure (graceful fallback)
 * @param {string} command - Shell command to execute
 * @param {Object} inputData - JSON data to pipe to stdin
 * @param {number} timeoutMs - Timeout in milliseconds (default 500ms)
 * @returns {Promise<string>} Output from passthrough command
 */
function execPassthrough(command, inputData, timeoutMs = 500) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, { shell: true });
      let output = "";

      const timer = setTimeout(() => {
        child.kill();
        resolve("");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        output += chunk;
      });

      child.on("close", () => {
        clearTimeout(timer);
        resolve(output.trim());
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolve("");
      });

      child.stdin.write(JSON.stringify(inputData));
      child.stdin.end();
    } catch {
      resolve("");
    }
  });
}

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", async () => {
  const state = getState();
  const config = getConfig();

  let data = {};
  try {
    const trimmed = input.trim();
    if (trimmed !== "") {
      data = JSON.parse(trimmed);
    }
  } catch {
    // If stdin is not valid JSON, fall back to empty data and still
    // show GUTT session metrics in the statusline.
    data = {};
  }

  // Get group_id and configuration status
  const groupId = getGroupId();
  const configured = isConfigured();

  // Truncate group_id to max 15 characters if needed
  const displayGroupId = groupId.length > 15 ? groupId.substring(0, 12) + "..." : groupId;

  // Format gutt status (lowercase branding with colored circles)
  const statusIcon =
    state.connectionStatus === "ok" ? "🟢" : state.connectionStatus === "error" ? "🔴" : "⚪";

  // Add warning indicator (!) if not configured
  const configWarning = !configured ? "!" : "";

  const guttSegment = `[gutt${statusIcon}${configWarning} ${displayGroupId || "(no group_id)"} mem:${state.memoryQueries || 0} lessons:${state.lessonsCaptured || 0}]`;

  // Extract Claude Code data if available
  let claudeSegment = "";
  if (data.model?.display_name || data.cost?.total_cost_usd !== undefined) {
    const model = data.model?.display_name || "unknown";
    const cost =
      data.cost?.total_cost_usd !== undefined ? `~$${data.cost.total_cost_usd.toFixed(2)}` : "";
    claudeSegment = ` | [${model}]${cost ? " " + cost : ""}`;
  }

  // Check for passthrough config - try user settings first, then project config
  const userSettings = loadUserSettings();
  const passthroughCmd =
    userSettings?.gutt?.statusline?.passthroughCommand ||
    config?.gutt?.statusline?.passthroughCommand;
  const multiLine =
    userSettings?.gutt?.statusline?.multiLine === true ||
    config?.gutt?.statusline?.multiLine === true;
  const showTicker =
    userSettings?.gutt?.statusline?.showTicker === true ||
    config?.gutt?.statusline?.showTicker === true;

  // Generate ticker line if enabled (toast-style: shows for 5 seconds then disappears)
  let tickerLine = null;
  if (showTicker) {
    const tickerItems = state.ticker?.items || [];
    tickerLine = formatTicker(tickerItems);
  }

  if (passthroughCmd && isValidPassthroughCommand(passthroughCmd)) {
    debugLog("statusline", `Executing passthrough command: ${passthroughCmd}`);
    const passthroughOutput = await execPassthrough(passthroughCmd, data, 500);
    if (passthroughOutput) {
      if (multiLine && tickerLine) {
        // Line 1: passthrough, Line 2: GUTT, Line 3: ticker (toast)
        console.log(`${passthroughOutput}\n${guttSegment}\n${tickerLine}`);
      } else if (multiLine) {
        // Line 1: passthrough, Line 2: GUTT
        console.log(`${passthroughOutput}\n${guttSegment}`);
      } else if (tickerLine) {
        // Line 1: passthrough + GUTT, Line 2: ticker (toast)
        console.log(`${passthroughOutput} ${guttSegment}\n${tickerLine}`);
      } else {
        // Single line: passthrough + GUTT
        console.log(`${passthroughOutput} ${guttSegment}`);
      }
    } else {
      if (tickerLine) {
        console.log(`${guttSegment}${claudeSegment}\n${tickerLine}`);
      } else {
        console.log(guttSegment + claudeSegment);
      }
    }
  } else {
    if (tickerLine) {
      console.log(`${guttSegment}${claudeSegment}\n${tickerLine}`);
    } else {
      console.log(guttSegment + claudeSegment);
    }
  }
});
