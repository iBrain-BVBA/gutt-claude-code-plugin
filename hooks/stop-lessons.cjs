#!/usr/bin/env node
/**
 * Stop hook script for capturing lessons learned (Node.js - cross-platform)
 * Auto-extracts session context and prompts for GUTT memory capture
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { getState } = require("./lib/session-state.cjs");
const {
  parseTranscript,
  getSessionDuration,
  generateSummary,
} = require("./lib/transcript-parser.cjs");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logFile = path.join(projectDir, ".claude", "hooks", "hook-invocations.log");
const stateDir = path.join(projectDir, ".claude", "hooks", ".state");
const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

// Read JSON input from stdin (parse once per GUTT lesson)
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  // Check if gutt-mcp-remote is configured - exit silently if not (allow stop)
  if (!isGuttMcpConfigured()) {
    process.exit(0);
  }

  let hookInput;
  let sessionId = "unknown";
  try {
    hookInput = JSON.parse(input);
    sessionId = hookInput.session_id || "unknown";
  } catch {
    // Parse error - allow stop
    process.exit(0);
  }

  const stateFile = path.join(stateDir, `${sessionId}.lessons-prompted`);

  // Ensure directories exist
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Check if we've already prompted this session
  if (fs.existsSync(stateFile)) {
    // Already prompted - allow stop
    fs.appendFileSync(
      logFile,
      `[${timestamp}] Stop hook: Session ${sessionId} already prompted, allowing stop\n`
    );
    process.exit(0);
  }

  // Get session state
  const sessionState = getState();
  const memoryQueries = sessionState.memoryQueries || 0;
  const lessonsCaptured = sessionState.lessonsCaptured || 0;
  const startedAt = sessionState.startedAt;
  const durationMinutes = getSessionDuration(startedAt);

  // Parse transcript if provided
  const transcriptPath = hookInput.transcript_path;
  const transcriptData = parseTranscript(transcriptPath);

  // Determine if we should skip capture (allow stop)
  const shouldSkip =
    memoryQueries === 0 && // No memory was consulted
    durationMinutes < 10 && // Short session
    lessonsCaptured > 0; // Already captured something

  if (shouldSkip) {
    fs.appendFileSync(
      logFile,
      `[${timestamp}] Stop hook: Trivial session (queries=${memoryQueries}, duration=${durationMinutes}m, captured=${lessonsCaptured}), allowing stop\n`
    );
    process.exit(0);
  }

  // Extract session goal
  const goal = transcriptData.firstUserMessage || "Session work (no goal extracted)";

  // Generate episode body
  const episodeLines = [
    "## Session Summary",
    `- Goal: ${goal}`,
    `- Duration: ${durationMinutes} minutes`,
    `- Files modified: ${transcriptData.filesModified}`,
    `- Memory queries: ${memoryQueries}`,
    "",
    "## Work Done",
    generateSummary(transcriptData),
  ];

  const episodeBody = episodeLines.join("\\n");

  // Create state file to track first block
  fs.writeFileSync(stateFile, "");
  fs.appendFileSync(
    logFile,
    `[${timestamp}] Stop hook: Blocking stop for session ${sessionId} - significant work detected\n`
  );

  // Block Claude from stopping with structured capture instruction
  const captureInstruction = `mcp__gutt-mcp-remote__add_memory(
  name="Session: ${goal.replace(/"/g, '\\"')}",
  episode_body="${episodeBody}"
)`;

  console.log(
    JSON.stringify({
      decision: "block",
      reason: `🟠 ACTION REQUIRED: Capture session lessons before stopping.

Session Context:
- Duration: ${durationMinutes} minutes
- Files modified: ${transcriptData.filesModified}
- Memory queries: ${memoryQueries}
- Lessons captured: ${lessonsCaptured}

Use this exact command to capture:
${captureInstruction}

Or describe what you learned and I'll format it properly.`,
    })
  );
});
