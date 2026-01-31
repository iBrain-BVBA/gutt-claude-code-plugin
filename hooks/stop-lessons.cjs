#!/usr/bin/env node
/**
 * Stop hook script for capturing lessons learned (Node.js - cross-platform)
 * Blocks first stop attempt to prompt lesson capture, allows subsequent attempts
 */

const fs = require("fs");
const path = require("path");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logFile = path.join(projectDir, ".claude", "hooks", "hook-invocations.log");
const stateDir = path.join(projectDir, ".claude", "hooks", ".state");
const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let sessionId = "unknown";
  try {
    const data = JSON.parse(input);
    sessionId = data.session_id || "unknown";
  } catch {
    // Ignore parse errors
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

  // First stop attempt - create state file and block
  fs.writeFileSync(stateFile, "");
  fs.appendFileSync(
    logFile,
    `[${timestamp}] Stop hook: Blocking first stop for session ${sessionId} to prompt lessons\n`
  );

  // Block Claude from stopping and provide reason
  console.log(
    JSON.stringify({
      decision: "block",
      reason:
        "Before completing, consider capturing lessons learned. If significant work was done (decisions, patterns, challenges), use the memory-keeper agent. If trivial work, proceed - you won't be blocked again.",
    })
  );
});
