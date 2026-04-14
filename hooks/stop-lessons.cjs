#!/usr/bin/env node
/**
 * Stop hook script for capturing lessons learned (Node.js - cross-platform)
 * Auto-extracts session context and prompts for GUTT memory capture
 *
 * GP-530: Added Cowork non-blocking path. In Cowork, decision:block is not
 * supported, so we output a best-effort reason. Most lessons should already
 * be captured by cowork-periodic-capture.cjs during the session.
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { getState, init } = require("./lib/session-state.cjs");
const { supportsDecisionBlock, isCursor } = require("./lib/platform-detect.cjs");
const {
  parseTranscript,
  getSessionDuration,
  generateSummary,
} = require("./lib/transcript-parser.cjs");
const { sanitizeForDisplay } = require("./lib/text-utils.cjs");
const { classifySignal } = require("./lib/memory-classifier.cjs");
const { buildLessonOutput } = require("./lib/lesson-builder.cjs");

const { PROJECT_DIR, STATE_DIR_NAME } = require("./lib/env.cjs");
const logFile = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", "hook-invocations.log");
const stateDir = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", ".state");
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
    hookInput = JSON.parse(input.replace(/^\uFEFF/, "").trim());
    sessionId = hookInput.session_id || hookInput.conversation_id || "unknown";
  } catch {
    // Parse error - allow stop
    process.exit(0);
  }
  init(sessionId);

  const stateFile = path.join(stateDir, `${sessionId}.lessons-prompted`);

  // Ensure directories exist
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Parse transcript if provided (Cursor sends transcript_path in stdin or env var)
  const transcriptPath = hookInput.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH;

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

  // Guard: skip if session is less than 5 minutes old (prevents noise from subagent stops)
  if (durationMinutes < 5) {
    fs.appendFileSync(
      logFile,
      `[${timestamp}] Stop hook: Session too young (${durationMinutes}m < 5m), allowing stop\n`
    );
    process.exit(0);
  }

  // Parse transcript metadata
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

  // Classify session goal for capture type hints
  const classification = classifySignal(goal);

  // Create state file to track first prompt
  fs.writeFileSync(stateFile, "");

  // Build session summary for agent prompt
  const sessionSummary = `## Session Summary
- Goal: ${goal}
- Duration: ${durationMinutes} minutes
- Files modified: ${transcriptData.filesModified}
- Memory queries: ${memoryQueries}

## Work Done
${generateSummary(transcriptData)}`;

  // Sanitize user-derived content for embedding
  const sanitizedGoal = sanitizeForDisplay(goal);
  const sanitizedSummary = sanitizeForDisplay(sessionSummary);

  const classificationHint = classification.shouldCapture
    ? `\n- Capture type: ${classification.type} (trust: ${classification.trust}, priority: ${classification.priority})`
    : "";

  const capturePrompt = `Session Context:
- Duration: ${durationMinutes} minutes
- Files modified: ${transcriptData.filesModified}
- Memory queries: ${memoryQueries}
- Lessons captured: ${lessonsCaptured}${classificationHint}

Delegate to memory-keeper agent to capture lessons:

Task(subagent_type="memory-keeper", model="haiku", prompt="Capture session lessons with this context:

${sanitizedSummary}

Create a memory with name 'Session: ${sanitizedGoal}' containing the key lessons and findings from this session.")`;

  const platform = isCursor() ? "cursor" : supportsDecisionBlock() ? "cli" : "cowork";
  const platformLabel =
    platform === "cursor"
      ? "Cursor followup"
      : platform === "cli"
        ? "Blocking stop"
        : "Cowork non-blocking lesson capture output";
  fs.appendFileSync(
    logFile,
    `[${timestamp}] Stop hook: ${platformLabel} for session ${sessionId} - significant work detected\n`
  );
  console.log(
    JSON.stringify(
      buildLessonOutput({
        platform,
        supportsBlock: supportsDecisionBlock(),
        classifierResult: classification,
        context: {
          capturePrompt,
          blockReason: `\ud83d\udfe0 ACTION REQUIRED: Capture session lessons before stopping.\n\n${capturePrompt}\n\nOr describe what you learned and I'll format it properly.`,
          coworkPrefix: "[Cowork] Session ending.",
          lessonsCaptured,
        },
      })
    )
  );
});
