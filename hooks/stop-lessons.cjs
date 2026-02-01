#!/usr/bin/env node
/**
 * Stop hook script for capturing lessons learned (Node.js - cross-platform)
 * Blocks first stop attempt to prompt lesson capture, allows subsequent attempts
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logFile = path.join(projectDir, ".claude", "hooks", "hook-invocations.log");
const stateDir = path.join(projectDir, ".claude", "hooks", ".state");
const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

/**
 * Check if gutt-mcp-remote MCP server is configured
 * Checks both user scope (~/.claude/settings.json) and project scope (.mcp.json)
 */
function isGuttMcpConfigured() {
  // Check user scope (~/.claude/settings.json)
  const userSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(userSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(userSettingsPath, "utf8"));
      if (settings.mcpServers && settings.mcpServers["gutt-mcp-remote"]) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check project scope (.mcp.json)
  const projectMcpPath = path.join(projectDir, ".mcp.json");
  if (fs.existsSync(projectMcpPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(projectMcpPath, "utf8"));
      if (mcpConfig["gutt-mcp-remote"]) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

// Read JSON input from stdin
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
