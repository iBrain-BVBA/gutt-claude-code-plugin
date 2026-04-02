#!/usr/bin/env node
/**
 * UserPromptSubmit hook — logs prompt, resets lesson state, outputs memory reminder.
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_STATE_DIR } = require("./lib/env.cjs");

const LOG_FILE = path.join(PROJECT_STATE_DIR, "hooks", "hook-invocations.log");
const STATE_DIR = path.join(PROJECT_STATE_DIR, "hooks", ".state");

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

  // Ensure log directory exists
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, `[${timestamp}] Prompt: ${prompt}\n`);
  } catch {
    // Non-blocking
  }

  // Clear lessons-prompted state for this session
  const stateFile = path.join(STATE_DIR, `${sessionId}.lessons-prompted`);
  try {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
      fs.appendFileSync(
        LOG_FILE,
        `[${timestamp}] Cleared lessons-prompted state for session ${sessionId}\n`
      );
    }
  } catch {
    // Non-blocking
  }

  // Output the reminder message
  console.log(
    'REMINDER: ALWAYS use the gutt-pro-memory agent (Task tool with subagent_type="gutt-pro-memory") to search organizational memory for relevant context, lessons learned, and decisions before starting work.'
  );

  process.exit(0);
});
