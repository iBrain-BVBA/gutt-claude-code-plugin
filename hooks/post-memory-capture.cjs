#!/usr/bin/env node
/**
 * GUTT Post-Memory Capture Hook
 * Tracks add_memory calls for statusline stats
 */

const { incrementLessonsCaptured } = require("./lib/session-state.cjs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    // Check if this is add_memory tool
    if (data.tool_name === "mcp__gutt-mcp-remote__add_memory") {
      incrementLessonsCaptured();
    }
  } catch {
    // Silent exit
  }
  process.exit(0);
});
