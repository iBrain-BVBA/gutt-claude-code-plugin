#!/usr/bin/env node
/**
 * UserPromptSubmit hook — logs prompt, resets lesson state, outputs memory reminder.
 */

const { statePath, appendLine, remove } = require("./lib/plugin-state.cjs");
const { sanitizeSessionId } = require("./lib/session-state.cjs");

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
  const invocationLog = statePath("hook-invocations.log");

  appendLine(invocationLog, `[${timestamp}] Prompt: ${prompt}`);

  // Clear the lessons-prompted marker for this session so the next Stop re-prompts
  const marker = statePath(`${sanitizeSessionId(sessionId)}.lessons-prompted`);
  if (remove(marker)) {
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
