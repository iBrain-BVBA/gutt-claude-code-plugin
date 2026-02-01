#!/usr/bin/env node
/**
 * GUTT SubagentStart Memory Injection Hook
 * Injects cached memory results directly into subagent context
 *
 * This hook fires when a subagent starts and injects ACTUAL cached results
 * (not instructions) into the subagent's context via hookSpecificOutput.additionalContext
 *
 * Data flow:
 * 1. PostToolUse caches memory results from MCP calls
 * 2. PreToolUse on Task extracts search query and stores it
 * 3. THIS HOOK injects cached results directly into subagent context
 * 4. Fallback: if cache empty, inject instruction to call MCP tools
 */

const fs = require("fs");
const path = require("path");
const {
  hasCachedContent,
  formatMemoryContext,
  getLastSearchQuery,
} = require("./lib/memory-cache.cjs");

// Debug logging for troubleshooting (writes to .state dir)
function debugLog(hook, error) {
  try {
    const logFile = path.join(process.cwd(), ".claude", "hooks", ".state", "hook-errors.log");
    const entry = `${new Date().toISOString()} [${hook}] ${error?.message || error}\n`;
    fs.appendFileSync(logFile, entry);
  } catch {
    /* ignore logging errors */
  }
}

// Capture stdin to variable first (can only read once - per GUTT lesson)
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");

    // Get agent info (SubagentStart provides agent_type and agent_id)
    const agentType = data.agent_type || "";

    // Skip memory injection for memory-related agents (they do their own queries)
    const memoryAgents = ["gutt-pro-memory", "memory-keeper", "gutt-mcp"];
    if (memoryAgents.some((agent) => agentType.toLowerCase().includes(agent))) {
      process.exitCode = 0;
      return;
    }

    // Check if we have cached content
    if (hasCachedContent()) {
      // Inject actual cached results
      const memoryContext = formatMemoryContext();

      const output = {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: memoryContext,
        },
      };

      console.log(JSON.stringify(output));
    } else {
      // Fallback: inject instruction to call MCP tools
      const lastQuery = getLastSearchQuery();
      const searchQuery = lastQuery || "organizational context patterns";

      const fallbackContext = `[GUTT Memory]
No cached organizational memory available yet.

To fetch relevant context, use these MCP tools:
- mcp__gutt-mcp-remote__fetch_lessons_learned(query: "${sanitizeQuery(searchQuery)}")
- mcp__gutt-mcp-remote__search_memory_facts(query: "${sanitizeQuery(searchQuery)}")

Apply any relevant lessons and patterns to inform your approach.
[End GUTT Memory]`;

      const output = {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: fallbackContext,
        },
      };

      console.log(JSON.stringify(output));
    }

    process.exitCode = 0;
  } catch (err) {
    // Log error for debugging, but don't block workflow
    debugLog("SubagentStart", err);
    process.exitCode = 0;
  }
});

/**
 * Sanitize query for safe embedding in output
 */
function sanitizeQuery(query) {
  if (!query) {
    return "organizational context";
  }
  return query
    .replace(/[\r\n]+/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
}
