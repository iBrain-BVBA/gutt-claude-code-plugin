#!/usr/bin/env node
/**
 * GP-530: Cowork Periodic Lesson Capture Hook
 *
 * PostToolUse hook that fires on Edit|Write|Task to periodically trigger
 * automatic lesson capture via the memory-keeper agent in Cowork sessions.
 *
 * In CLI, this hook exits immediately (zero overhead) because stop-lessons.cjs
 * handles lesson capture at session end via decision:block.
 *
 * Trigger thresholds:
 * - 10+ significant operations since last capture
 * - 20+ minutes since last capture prompt
 * - 5+ operations with zero lessons captured (early first-session trigger)
 *
 * Anti-spam: minimum 10-minute cooldown between capture prompts.
 *
 * @see GP-530 - Cowork: Automatic lesson capture via agents and subagents
 */

const { isCowork } = require("./lib/platform-detect.cjs");
const {
  getState,
  incrementSignificantOps,
  recordCapturePrompt,
} = require("./lib/session-state.cjs");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    // AC-8: In CLI, exit immediately \u2014 stop-lessons.cjs handles capture
    if (!isCowork()) {
      process.exit(0);
    }

    // Guard: skip if gutt-mcp-remote is not configured
    if (!isGuttMcpConfigured()) {
      process.exit(0);
    }

    const data = JSON.parse(input || "{}");
    const toolName = data.tool_name || "";

    // Only count significant tools (Edit, Write, Task)
    // Skip memory tools to avoid self-triggering loops
    if (!isSignificantTool(toolName)) {
      process.exit(0);
    }

    // Skip if this is a memory-keeper or memory-related Task completing
    // (prevents re-entrant loop: capture -> Task -> PostToolUse -> capture)
    if (toolName === "Task") {
      const toolInput = data.tool_input || {};
      const subagentType = (toolInput.subagent_type || "").toLowerCase();
      const skipAgents = [
        "memory-keeper",
        "gutt-pro-memory",
        "config-discovery",
        "memory-capture",
        "memory",
      ];
      if (skipAgents.some((agent) => subagentType.includes(agent))) {
        process.exit(0);
      }
    }

    // Increment the significant ops counter
    incrementSignificantOps();

    // Check if we should trigger a capture prompt
    const state = getState();
    const ops = state.significantOps || 0;
    const lessonsCaptured = state.lessonsCaptured || 0;
    const lastCapturePromptAt = state.lastCapturePromptAt;
    const minutesSinceCapture = getMinutesSince(lastCapturePromptAt);
    const neverCaptured = lessonsCaptured === 0;

    // AC-7: Anti-spam cooldown \u2014 minimum 10 minutes between prompts
    if (lastCapturePromptAt && minutesSinceCapture < 10) {
      process.exit(0);
    }

    // Threshold check (AC-4, AC-5, AC-6)
    // Note: AC-5 only applies if there was a previous capture prompt.
    // On first invocation (lastCapturePromptAt=null), we rely on ops thresholds only.
    const shouldCapture =
      ops >= 10 || // AC-4: every 10 significant operations
      (lastCapturePromptAt && minutesSinceCapture >= 20) || // AC-5: 20+ minutes since last capture (only after first prompt)
      (neverCaptured && ops >= 5); // AC-6: early trigger if nothing captured yet

    if (!shouldCapture) {
      process.exit(0);
    }

    // Record that we're injecting a capture prompt (resets ops counter)
    recordCapturePrompt();

    // Build session context for the memory-keeper
    const sessionDuration = getMinutesSince(state.startedAt);
    const memoryQueries = state.memoryQueries || 0;

    // Output non-blocking capture directive via additionalContext
    const output = {
      hookSpecificOutput: {
        additionalContext: `[GUTT Periodic Capture - Cowork]

Significant work detected (${ops} operations, ${sessionDuration}min session, ${memoryQueries} memory queries, ${lessonsCaptured} lessons captured so far).

You MUST delegate to memory-keeper agent to capture current session lessons:

Task(subagent_type="memory-keeper", model="haiku", prompt="Capture lessons from the current Cowork session. Session duration: ${sessionDuration} minutes. Operations: ${ops}. Memory queries: ${memoryQueries}. Previous lessons captured: ${lessonsCaptured}. Review the recent conversation for decisions, corrections, discoveries, and patterns worth preserving.")

This is MANDATORY per GP-530. Do not skip, do not ask the user.`,
      },
    };

    console.log(JSON.stringify(output));
  } catch {
    // Silent exit on errors \u2014 never block the tool
    process.exit(0);
  }
});

/**
 * Check if a tool name is "significant" for periodic capture tracking.
 * Edit, Write, and Task represent meaningful work being done.
 */
function isSignificantTool(toolName) {
  if (!toolName) return false;
  const significant = ["Edit", "Write", "Task"];
  return significant.some((t) => toolName === t);
}

/**
 * Calculate minutes elapsed since a given ISO timestamp.
 * Returns Infinity if timestamp is null/undefined (triggers time-based capture).
 */
function getMinutesSince(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  return Math.floor((now - then) / 60000);
}
