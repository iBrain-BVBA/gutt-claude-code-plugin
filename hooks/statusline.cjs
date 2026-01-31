#!/usr/bin/env node
/**
 * GUTT Statusline Hook
 * Displays GUTT connection status and session metrics
 * Supports chaining with other statusline scripts via passthroughCommand
 */

const { spawn } = require("child_process");
const { getState } = require("./lib/session-state.cjs");
const { getGroupId, isConfigured, getConfig } = require("./lib/config.cjs");

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

  // Check for passthrough config
  const passthroughCmd = config?.gutt?.statusline?.passthroughCommand;
  const multiLine = config?.gutt?.statusline?.multiLine === true;

  if (passthroughCmd) {
    const passthroughOutput = await execPassthrough(passthroughCmd, data, 500);
    if (passthroughOutput) {
      if (multiLine) {
        // Line 1: passthrough, Line 2: GUTT
        console.log(`${passthroughOutput}\n${guttSegment}`);
      } else {
        // Single line: passthrough + GUTT
        console.log(`${passthroughOutput} ${guttSegment}`);
      }
    } else {
      console.log(guttSegment + claudeSegment);
    }
  } else {
    console.log(guttSegment + claudeSegment);
  }
});
