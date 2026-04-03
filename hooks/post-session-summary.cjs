#!/usr/bin/env node
/**
 * Post-Session Summary Hook (Stop hook)
 *
 * Generates a structured episode summary at the end of sessions with
 * significant work. Outputs a followup_message suggesting memory capture
 * via add_memory — does not call MCP directly (hooks can't do async).
 *
 * Trigger: Stop event
 * Guard: Only fires for sessions with significantOps >= 3
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { getState, init } = require("./lib/session-state.cjs");
const { parseTranscript, generateSummary } = require("./lib/transcript-parser.cjs");
const { sanitizeForDisplay } = require("./lib/text-utils.cjs");
const { supportsDecisionBlock, isCursor } = require("./lib/platform-detect.cjs");
const { PROJECT_DIR, STATE_DIR_NAME } = require("./lib/env.cjs");
const { debugLog } = require("./lib/debug.cjs");

const stateDir = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", ".state");
const logFile = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", "hook-invocations.log");
const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

const MIN_SIGNIFICANT_OPS = 3;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  // Exit silently if gutt MCP is not configured
  if (!isGuttMcpConfigured()) {
    process.exit(0);
  }

  let hookInput;
  let sessionId = "unknown";
  try {
    hookInput = JSON.parse(input.replace(/^\uFEFF/, "").trim());
    sessionId = hookInput.session_id || hookInput.conversation_id || "unknown";
  } catch {
    process.exit(0);
  }
  init(sessionId);

  // Ensure directories exist
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  // Sanitize sessionId for safe use in filenames
  const safeSessionId = (sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");

  // Deduplicate: check if we already prompted this session
  const stateFile = path.join(stateDir, `${safeSessionId}.session-summary-prompted`);
  if (fs.existsSync(stateFile)) {
    debugLog("post-session-summary", `Already prompted for session ${sessionId}`);
    process.exit(0);
  }

  // Guard: only trigger for sessions with significant work
  const sessionState = getState();
  const significantOps = sessionState.significantOps || 0;

  if (significantOps < MIN_SIGNIFICANT_OPS) {
    debugLog(
      "post-session-summary",
      `Skipping: significantOps=${significantOps} < ${MIN_SIGNIFICANT_OPS}`
    );
    process.exit(0);
  }

  // Parse transcript for session metadata
  const transcriptPath = hookInput.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH;
  const transcriptData = parseTranscript(transcriptPath);

  // Extract session goal
  const goal = transcriptData.firstUserMessage || "Session work";
  const sanitizedGoal = sanitizeForDisplay(goal);

  // Build file list from edit/write calls
  const uniqueFiles = [...new Set(transcriptData.editWriteCalls.map((c) => path.basename(c.file)))];
  const fileList = uniqueFiles.length > 0 ? uniqueFiles.join(", ") : "none tracked";

  // Build action summary
  const summaryText = generateSummary(transcriptData);

  // Build structured episode body (summaryText from generateSummary already includes goal context)
  const episodeBody = [
    `Actions: ${summaryText}`,
    `Files: ${fileList}`,
    `Outcome: Session completed with ${significantOps} significant operations`,
  ].join("\n");

  const memoryName = `Session: ${sanitizedGoal}`;

  // Mark as prompted
  fs.writeFileSync(stateFile, "");

  fs.appendFileSync(
    logFile,
    `[${timestamp}] Post-session-summary: Suggesting capture for session ${sessionId} (ops=${significantOps})\n`
  );

  // Build the followup message suggesting memory capture
  const captureInstruction =
    `Capture this session summary to organizational memory:\n\n` +
    `add_memory with:\n` +
    `  name: "${memoryName}"\n` +
    `  episode_body: "${sanitizeForDisplay(episodeBody)}"`;

  // Output platform-appropriate response
  const platform = isCursor() ? "cursor" : supportsDecisionBlock() ? "cli" : "cowork";

  if (platform === "cursor") {
    console.log(JSON.stringify({ followup_message: captureInstruction }));
  } else {
    // CLI and Cowork: use additionalContext (non-blocking suggestion)
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          additionalContext: captureInstruction,
        },
      })
    );
  }
});

// Allow running directly for testing
if (require.main === module) {
  // stdin handler above will execute
}
