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
 * 4. If no cache, exit silently (do NOT instruct agents to call MCP tools)
 */

const { hasCachedContent, formatMemoryContext } = require("./lib/memory-cache.cjs");
const { debugLog } = require("./lib/debug.cjs");

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
      // No cached content - just exit silently
      // DO NOT instruct agents to call MCP tools - that causes them to go off the rails
      process.exitCode = 0;
      return;
    }

    process.exitCode = 0;
  } catch (err) {
    // Log error for debugging, but don't block workflow
    debugLog("SubagentStart", err);
    process.exitCode = 0;
  }
});
