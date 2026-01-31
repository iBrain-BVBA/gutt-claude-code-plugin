#!/usr/bin/env node
/**
 * GUTT Statusline Hook
 * Displays GUTT connection status and session metrics
 */

const { getState } = require("./lib/session-state.cjs");

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  const state = getState();

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

  // Format GUTT status
  const statusIcon =
    state.connectionStatus === "ok" ? "OK" : state.connectionStatus === "error" ? "ERR" : "?";

  const guttSegment = `[GUTT:${statusIcon} mem:${state.memoryQueries || 0} lessons:${state.lessonsCaptured || 0}]`;

  // Extract Claude Code data if available
  let claudeSegment = "";
  if (data.model?.display_name || data.cost?.total_cost_usd !== undefined) {
    const model = data.model?.display_name || "unknown";
    const cost =
      data.cost?.total_cost_usd !== undefined ? `~$${data.cost.total_cost_usd.toFixed(2)}` : "";
    claudeSegment = ` | [${model}]${cost ? " " + cost : ""}`;
  }

  console.log(guttSegment + claudeSegment);
});
