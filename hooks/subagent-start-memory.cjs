#!/usr/bin/env node
/**
 * GUTT SubagentStart Memory Injection Hook
 * Injects cached memory results directly into subagent context
 *
 * When a registered agent seed is detected (via agent_type), injects that seed's
 * specific Grounding Protocol queries with dynamic group_id. Falls back to generic
 * cached memory injection for unknown agents.
 *
 * Data flow:
 * 1. PostToolUse caches memory results from MCP calls
 * 2. PreToolUse on Task extracts search query and stores it
 * 3. THIS HOOK checks seed registry for agent-specific grounding
 * 4. If seed found: inject seed-specific grounding + any cached content
 * 5. If no seed: inject cached content only (or exit silently)
 */

const {
  hasCachedContent,
  formatMemoryContext,
  getLastAgentName,
  getResolvedGroupId,
} = require("./lib/memory-cache.cjs");
const { getAgentSeed } = require("./lib/seed-registry.cjs");
const { getGroupId } = require("./lib/config.cjs");
const { debugLog } = require("./lib/debug.cjs");
const { MEMORY_AGENTS } = require("./lib/constants.cjs");

/**
 * Format seed-specific grounding instructions with dynamic group_id
 * @param {Object} seed - Parsed agent seed data
 * @param {string} groupId - Runtime-resolved group_id
 * @returns {string} Formatted grounding instructions
 */
function formatSeedGrounding(seed, groupId) {
  const parts = [`[GUTT Agent Grounding — ${seed.name}]`];
  parts.push(`\nYou are operating as **${seed.name}** (type: ${seed.type}).`);
  parts.push("\nMANDATORY: Execute these grounding queries BEFORE responding:\n");

  const groupParam = groupId ? `, group_ids=["${groupId}"]` : "";

  seed.groundingQueries.forEach((gq, i) => {
    if (gq.query) {
      parts.push(`${i + 1}. ${gq.tool}(query="${gq.query}"${groupParam})`);
    } else {
      // fetch_lessons_learned has no query param
      parts.push(`${i + 1}. ${gq.tool}(${groupId ? `group_ids=["${groupId}"]` : ""})`);
    }
  });

  return parts.join("\n");
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
    if (MEMORY_AGENTS.some((agent) => agentType.toLowerCase().includes(agent))) {
      process.exitCode = 0;
      return;
    }

    // Check if this agent has a registered seed with specific grounding
    // Try agent_type first, then fall back to agent name stored by PreToolUse[Task]
    let seed = getAgentSeed(agentType);
    if (!seed) {
      const agentName = getLastAgentName();
      if (agentName) {
        seed = getAgentSeed(agentName);
      }
    }
    const hasCached = hasCachedContent();

    if (seed && seed.groundingQueries.length > 0) {
      // Seed found — inject agent-specific grounding with dynamic group_id
      // Prefer cached group_id from orchestrator (PreToolUse), fall back to local resolution
      const groupId = getResolvedGroupId() || getGroupId();
      const groundingContext = formatSeedGrounding(seed, groupId);

      const contextParts = [groundingContext];

      // Append cached memory if available
      if (hasCached) {
        const memoryContext = formatMemoryContext();
        if (memoryContext) {
          contextParts.push("\n--- Cached Memory (from earlier queries) ---\n");
          contextParts.push(memoryContext);
        }
      }

      contextParts.push("\n[End GUTT Agent Grounding]");

      const output = {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: contextParts.join("\n"),
        },
      };

      console.log(JSON.stringify(output));
    } else if (hasCached) {
      // No seed — fall back to generic cached memory injection
      const memoryContext = formatMemoryContext();

      const output = {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: memoryContext,
        },
      };

      console.log(JSON.stringify(output));
    } else {
      // No seed, no cache — exit silently
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
