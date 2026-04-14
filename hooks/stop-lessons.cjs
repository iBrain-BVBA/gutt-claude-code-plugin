#!/usr/bin/env node
/**
 * Stop hook — prompts lesson capture once per session, then allows stop.
 *
 * Follows the graphiti reference pattern: block first stop with a simple
 * prompt to use memory-keeper, allow all subsequent stops.
 * No transcript parsing — session state provides the context.
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { getState, init } = require("./lib/session-state.cjs");
const { supportsDecisionBlock, isCursor } = require("./lib/platform-detect.cjs");
const { PROJECT_DIR, STATE_DIR_NAME } = require("./lib/env.cjs");

const logFile = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", "hook-invocations.log");
const stateDir = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", ".state");
const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (!isGuttMcpConfigured()) {
    process.exit(0);
  }

  let sessionId = "unknown";
  try {
    const hookInput = JSON.parse(input.replace(/^\uFEFF/, "").trim());
    sessionId = hookInput.session_id || hookInput.conversation_id || "unknown";
  } catch {
    process.exit(0);
  }
  init(sessionId);

  // Ensure directories exist
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const stateFile = path.join(stateDir, `${sessionId}.lessons-prompted`);

  // Already prompted this session — allow stop
  if (fs.existsSync(stateFile)) {
    fs.appendFileSync(
      logFile,
      `[${timestamp}] Stop hook: Session ${sessionId} already prompted, allowing stop\n`
    );
    process.exit(0);
  }

  // Mark as prompted so the next stop goes through
  fs.writeFileSync(stateFile, "");

  // Build context from session state
  const state = getState();
  const memoryQueries = state.memoryQueries || 0;
  const lessonsCaptured = state.lessonsCaptured || 0;
  const significantOps = state.significantOps || 0;

  const reason =
    `Before completing, consider if this work warrants capturing lessons learned. ` +
    `Session stats: ${memoryQueries} memory queries, ${significantOps} significant ops, ${lessonsCaptured} lessons captured.\n\n` +
    `If significant work was done (implementation decisions, bug fixes, patterns discovered, challenges solved), ` +
    `use the memory-keeper agent (Task tool with subagent_type="memory-keeper") to capture insights.\n\n` +
    `If the work was trivial, you may proceed — you will not be blocked again.`;

  fs.appendFileSync(
    logFile,
    `[${timestamp}] Stop hook: Prompting lesson capture for session ${sessionId}\n`
  );

  // Platform-appropriate output
  if (isCursor()) {
    console.log(JSON.stringify({ followup_message: reason }));
  } else if (supportsDecisionBlock()) {
    console.log(JSON.stringify({ decision: "block", reason }));
  } else {
    // Cowork: non-blocking suggestion
    console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: reason } }));
  }
});
