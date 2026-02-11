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
const { getState } = require("./lib/session-state.cjs");
const { supportsDecisionBlock } = require("./lib/platform-detect.cjs");
const {
  parseTranscript,
  parseTranscriptRaw,
  getSessionDuration,
  generateSummary,
} = require("./lib/transcript-parser.cjs");
const {
  detectPlanContext,
  extractPlanFeedback,
  buildCaptureInstruction,
} = require("./lib/plan-feedback-detector.cjs");
const { sanitizeForDisplay } = require("./lib/text-utils.cjs");

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
  const planFeedbackStateFile = path.join(stateDir, `${sessionId}.plan-feedback-prompted`);

  // Ensure directories exist
  if (!fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Parse transcript if provided
  const transcriptPath = hookInput.transcript_path;

  // STEP 1: Check for plan feedback FIRST (before regular lesson capture)
  const transcriptEntries = parseTranscriptRaw(transcriptPath);
  const planContext = detectPlanContext(transcriptEntries);

  if (planContext) {
    // Plan detected - check for user feedback
    const planFeedback = extractPlanFeedback(transcriptEntries, planContext);

    if (planFeedback && !planFeedback.skip) {
      // Rejected or modified plan - check if already prompted
      if (fs.existsSync(planFeedbackStateFile)) {
        fs.appendFileSync(
          logFile,
          `[${timestamp}] Stop hook: Plan feedback already prompted for session ${sessionId}, allowing stop\n`
        );
        process.exit(0);
      }

      // Block stop (CLI) or best-effort output (Cowork) for plan feedback capture
      fs.writeFileSync(planFeedbackStateFile, "");

      const captureInstruction = buildCaptureInstruction(planFeedback);

      if (supportsDecisionBlock()) {
        // CLI: block stop and force capture
        fs.appendFileSync(
          logFile,
          `[${timestamp}] Stop hook: Blocking stop for plan feedback (${planFeedback.type}) in session ${sessionId}\n`
        );
        console.log(
          JSON.stringify({
            decision: "block",
            reason: captureInstruction,
          })
        );
      } else {
        // GP-530 AC-10: Cowork \u2014 best-effort non-blocking output
        fs.appendFileSync(
          logFile,
          `[${timestamp}] Stop hook: Cowork non-blocking plan feedback output (${planFeedback.type}) in session ${sessionId}\n`
        );
        console.log(
          JSON.stringify({
            reason: `[Cowork] Session ending with uncaptured plan feedback. ${captureInstruction}`,
          })
        );
      }
      return; // Exit after output
    }
    // If planFeedback.skip = true (approved), continue to regular lesson capture
  }

  // STEP 2: Regular lesson capture (existing logic)
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

  const capturePrompt = `Session Context:
- Duration: ${durationMinutes} minutes
- Files modified: ${transcriptData.filesModified}
- Memory queries: ${memoryQueries}
- Lessons captured: ${lessonsCaptured}

Delegate to memory-keeper agent to capture lessons:

Task(subagent_type="memory-keeper", model="haiku", prompt="Capture session lessons with this context:

${sanitizedSummary}

Create a memory with name 'Session: ${sanitizedGoal}' containing the key lessons and findings from this session.")`;

  if (supportsDecisionBlock()) {
    // CLI: block stop and force capture
    fs.appendFileSync(
      logFile,
      `[${timestamp}] Stop hook: Blocking stop for session ${sessionId} - significant work detected\n`
    );
    console.log(
      JSON.stringify({
        decision: "block",
        reason: `\ud83d\udfe0 ACTION REQUIRED: Capture session lessons before stopping.

${capturePrompt}

Or describe what you learned and I'll format it properly.`,
      })
    );
  } else {
    // GP-530 AC-10: Cowork \u2014 best-effort non-blocking output
    fs.appendFileSync(
      logFile,
      `[${timestamp}] Stop hook: Cowork non-blocking lesson capture output for session ${sessionId}\n`
    );
    console.log(
      JSON.stringify({
        reason: `[Cowork] Session ending. ${lessonsCaptured} lessons captured during session.${
          lessonsCaptured === 0
            ? " WARNING: No lessons captured this session. " + capturePrompt
            : " Periodic capture handled lesson collection."
        }`,
      })
    );
  }
});
