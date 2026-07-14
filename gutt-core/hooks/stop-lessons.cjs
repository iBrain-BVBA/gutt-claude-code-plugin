#!/usr/bin/env node
/**
 * Stop hook — prompts lesson capture once per session, then allows stop.
 *
 * Block the first stop with a lesson-capture prompt, allow all subsequent
 * stops. No transcript parsing — session state provides the context.
 */

const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { getState, init, sanitizeSessionId } = require("./lib/session-state.cjs");
const { supportsDecisionBlock } = require("./lib/platform-detect.cjs");
const { statePath, exists, appendLine, writeJson } = require("./lib/plugin-state.cjs");
const { debugLog } = require("./lib/debug.cjs");

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

    // Subagent completions have agent_id — only block the main session
    if (hookInput.agent_id) {
      debugLog("stop-lessons", `Skipping subagent stop: ${hookInput.agent_id}`);
      process.exit(0);
    }
  } catch (err) {
    debugLog("stop-lessons", `Failed to parse hook input: ${err.message}`);
    process.exit(0);
  }

  try {
    init(sessionId);

    const invocationLog = statePath("hook-invocations.log");
    const marker = statePath(`${sanitizeSessionId(sessionId)}.lessons-prompted`);

    // Already prompted this session — allow stop
    if (exists(marker)) {
      appendLine(
        invocationLog,
        `[${timestamp}] Stop hook: Session ${sessionId} already prompted, allowing stop`
      );
      process.exit(0);
    }

    // Mark as prompted so the next stop goes through. If the marker can't be
    // persisted (data dir unavailable/unwritable), allow the stop rather than
    // block — otherwise we'd re-block every stop with no way to record that we
    // already prompted. The pre-GP-855 fs.writeFileSync threw here and hit the
    // outer catch (fail open); writeJson returns false instead, so check it.
    if (!writeJson(marker, { promptedAt: new Date().toISOString() })) {
      debugLog("stop-lessons", "could not persist lessons-prompted marker; allowing stop");
      process.exit(0);
    }

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

    appendLine(
      invocationLog,
      `[${timestamp}] Stop hook: Prompting lesson capture for session ${sessionId}`
    );

    // Platform-appropriate output
    if (supportsDecisionBlock()) {
      console.log(JSON.stringify({ decision: "block", reason }));
    } else {
      // Cowork: non-blocking suggestion
      console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: reason } }));
    }
  } catch (err) {
    debugLog("stop-lessons", `Unexpected error, allowing stop: ${err.message}`);
    process.exit(0);
  }
});
