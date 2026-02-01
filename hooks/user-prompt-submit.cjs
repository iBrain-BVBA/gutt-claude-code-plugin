#!/usr/bin/env node
/**
 * UserPromptSubmit hook script (Node.js - cross-platform)
 * Logs hook invocations and outputs reminder message
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const logFile = path.join(projectDir, ".claude", "hooks", "hook-invocations.log");
const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  // Check if gutt-mcp-remote is configured - exit silently if not
  if (!isGuttMcpConfigured(projectDir)) {
    process.exit(0);
  }

  let prompt = "unknown";
  try {
    const data = JSON.parse(input);
    prompt = (data.prompt || data.message || "unknown").substring(0, 200);
  } catch {
    // Ignore parse errors
  }

  // Ensure log directory exists
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Log the hook invocation
  fs.appendFileSync(logFile, `[${timestamp}] Prompt: ${prompt}\n`);

  // Output actionable memory search instruction
  // Extract key terms for suggested search
  const searchTerms = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5)
    .join(" ");

  console.log(`🟠 GUTT MEMORY: Search organizational memory BEFORE starting this task.

ACTION REQUIRED: Call one of these tools first:
  - mcp__gutt-mcp-remote__search_memory_facts(query: "${searchTerms || "relevant context"}")
  - mcp__gutt-mcp-remote__fetch_lessons_learned(query: "${searchTerms || "lessons"}")

This retrieves past decisions, patterns, and lessons that may apply to this task.`);
});
