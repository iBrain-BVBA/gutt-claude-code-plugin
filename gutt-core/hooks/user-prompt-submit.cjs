#!/usr/bin/env node
/**
 * UserPromptSubmit hook — logs prompt, resets lesson state, outputs memory reminder.
 */

const { statePath, appendLine } = require("./lib/plugin-state.cjs");
const { LOG_FILES } = require("./lib/debug.cjs");
const { init, clearLessonsPrompted } = require("./lib/session-state.cjs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  let prompt = "unknown";
  let sessionId = "unknown";

  try {
    const data = JSON.parse(input || "{}");
    prompt = (data.prompt || data.message || "unknown").substring(0, 200);
    sessionId = data.session_id || "unknown";
  } catch {
    // Ignore parse errors
  }

  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
  const invocationLog = statePath(LOG_FILES.invocations);

  appendLine(invocationLog, `[${timestamp}] Prompt: ${prompt}`);

  // Re-arm the lesson-capture prompt for this session so the next Stop prompts
  // again. Since GP-863 this is a field in sessions/<id>.json, not a marker file.
  init(sessionId);
  if (clearLessonsPrompted()) {
    appendLine(
      invocationLog,
      `[${timestamp}] Cleared lessons-prompted state for session ${sessionId}`
    );
  }

  // Output the reminder message — forceful wording to ensure LLM compliance
  console.log(
    "MANDATORY REQUIREMENT — YOU MUST FOLLOW THIS INSTRUCTION:\n" +
      'BEFORE doing ANY work, you MUST use the Agent tool with subagent_type="gutt-claude-code-plugin:gutt-pro-memory" to search organizational memory for relevant context, lessons learned, and prior decisions.\n' +
      "This is NOT optional. NEVER skip this step. ALWAYS search memory FIRST, THEN begin work.\n" +
      "FAILURE to search memory before starting work is a CRITICAL violation of your operating instructions."
  );

  process.exit(0);
});
