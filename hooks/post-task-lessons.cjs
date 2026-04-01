#!/usr/bin/env node
/**
 * PostToolUse hook for Task tool - captures lessons from subagent results
 *
 * Analyzes task results for learnings, decisions, patterns worth capturing.
 */

const { incrementLessonsCaptured } = require("./lib/session-state.cjs");
const { sanitizeForDisplay } = require("./lib/text-utils.cjs");
const { getAgentSeed } = require("./lib/seed-registry.cjs");
const { getGroupId } = require("./lib/config.cjs");
const { getResolvedGroupId } = require("./lib/memory-cache.cjs");
const { LESSON_SKIP_AGENTS, PLAN_AGENT_TYPES } = require("./lib/constants.cjs");
const { classifySignal } = require("./lib/memory-classifier.cjs");

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");

    // Only process Task/Agent tool completions
    const toolName = data.tool_name || "";
    if (toolName !== "Task" && toolName !== "Agent") {
      process.exit(0);
    }

    // Extract task details
    const toolInput = data.tool_input || {};
    const toolResult = data.tool_response || data.tool_result || data.result || "";
    const prompt = toolInput.prompt || "";
    const subagentType = toolInput.subagent_type || "";

    // Skip if no meaningful result
    if (!toolResult || toolResult.length < 100) {
      process.exit(0);
    }

    // Skip memory-related agents (they handle their own capture)
    if (LESSON_SKIP_AGENTS.some((agent) => subagentType.toLowerCase().includes(agent))) {
      process.exit(0);
    }

    // Plan agents are handled by SubagentStop hook (subagent-plan-review.cjs)
    // to avoid duplicate prompts. Skip them here.
    if (PLAN_AGENT_TYPES.has(subagentType.toLowerCase())) {
      process.exit(0);
    }

    // Detect if result contains lesson-worthy content
    const lessonIndicators = detectLessonIndicators(toolResult);

    // Classify signal for memory capture labeling (type/trust/priority)
    const classification = classifySignal(toolResult);

    // Only skip if NEITHER detector finds anything
    if (!classification.shouldCapture && lessonIndicators.length === 0) {
      // No capture-worthy signals detected - silent exit
      process.exit(0);
    }

    // Sanitize user-derived content for embedding
    const sanitizedPrompt = sanitizeForDisplay(prompt.substring(0, 100));

    // Check for agent seed (Hybrid D: seed-aware formatting)
    // Try subagent_type first, then fall back to agent name from tool input
    let seed = getAgentSeed(subagentType);
    if (!seed) {
      const agentName = toolInput.name || "";
      if (agentName) {
        seed = getAgentSeed(agentName);
      }
    }
    const groupId = getResolvedGroupId() || getGroupId();
    const groupParam = groupId ? `,\n  group_id: "${groupId}"` : "";

    // Determine if this is a surprise (reality != expectation) or outcome
    const surpriseIndicators = [
      "error-encountered",
      "alternative-found",
      "workaround",
      "discovery",
    ];
    const isSurprise = lessonIndicators.some((ind) => surpriseIndicators.includes(ind));

    // Format episode name and body based on seed awareness
    let episodeName;
    let episodeBody;

    if (seed) {
      // Seed-aware Hybrid D formatting
      if (isSurprise && seed.learningProtocol.surpriseName) {
        episodeName = seed.learningProtocol.surpriseName.replace(
          /\[.*?\]/,
          sanitizedPrompt.substring(0, 60)
        );
      } else if (seed.learningProtocol.outcomeName) {
        episodeName = seed.learningProtocol.outcomeName.replace(
          /\[.*?\]/,
          sanitizedPrompt.substring(0, 60)
        );
      } else {
        episodeName = `${seed.name}: ${sanitizedPrompt.substring(0, 60)}`;
      }
      episodeBody = formatLessonEpisode(subagentType, prompt, toolResult, lessonIndicators, seed);
    } else {
      // Generic formatting (no seed)
      episodeName = `Lesson: ${subagentType} - ${lessonIndicators[0] || "insight"}`;
      episodeBody = formatLessonEpisode(subagentType, prompt, toolResult, lessonIndicators, null);
    }

    // Output DIRECTIVE (not suggestion) using hookSpecificOutput format
    // Claude MUST execute this - it's not optional
    const output = {
      hookSpecificOutput: {
        additionalContext: `[GUTT AUTO-CAPTURE REQUIRED]

A lesson-worthy subagent result was detected. You MUST capture this to organizational memory NOW.

**Detected patterns:** ${lessonIndicators.join(", ")}
**Capture type:** ${classification.type} (trust: ${classification.trust}, priority: ${classification.priority})
**Subagent:** ${subagentType}${seed ? ` (seed: ${seed.name}, type: ${seed.type})` : ""}
**Category:** ${isSurprise ? "SURPRISE (reality != expectation)" : "OUTCOME (task completion)"}
**Task:** ${sanitizedPrompt}

EXECUTE THIS IMMEDIATELY (do not ask, do not skip):

mcp__gutt-mcp-remote__add_memory(
  name: "${episodeName}",
  episode_body: "${escapeForJson(episodeBody)}",
  source: "text",
  source_description: "Auto-captured from ${subagentType} subagent"${groupParam},
  last_n_episodes: 0
)

This is MANDATORY per GP-437. Lessons from subagent work must be captured automatically.`,
      },
    };

    console.log(JSON.stringify(output));

    // Increment counter AFTER successful output
    incrementLessonsCaptured();
  } catch {
    // Silent exit on errors - don't block the tool
    process.exit(0);
  }
});

/**
 * Escape string for embedding in JSON
 */
function escapeForJson(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Format lesson content as a proper episode body for GUTT memory
 * @param {string} subagentType - The subagent type
 * @param {string} prompt - The task prompt
 * @param {string} result - The task result
 * @param {string[]} indicators - Detected lesson indicators
 * @param {Object|null} seed - Parsed agent seed data (null for generic)
 */
function formatLessonEpisode(subagentType, prompt, result, indicators, seed) {
  const summary = result.substring(0, 300).trim();
  const outcomeType =
    indicators.includes("problem-solved") || indicators.includes("improvement")
      ? "positive"
      : indicators.includes("error-encountered")
        ? "negative"
        : "neutral";

  const agentLine = seed
    ? `**Agent:** ${seed.name} (${seed.type})`
    : `**Trigger:** Subagent ${subagentType} completed task`;

  return `${agentLine}
**Task:** ${sanitizeForDisplay(prompt.substring(0, 150))}
**Patterns:** ${indicators.join(", ")}
**Outcome:** ${outcomeType}
**Summary:** ${sanitizeForDisplay(summary)}
**Guidance:** ${generateGuidance(indicators, result)}`;
}

/**
 * Generate guidance based on detected patterns
 */
function generateGuidance(indicators, _result) {
  if (indicators.includes("problem-solved")) {
    return "Repeat: This approach successfully resolved the issue";
  }
  if (indicators.includes("error-encountered")) {
    return "Avoid: This approach encountered errors - consider alternatives";
  }
  if (indicators.includes("workaround")) {
    return "Note: Workaround used - may need proper fix later";
  }
  if (indicators.includes("decision-made")) {
    return "Decision: Architectural or design choice was made";
  }
  if (indicators.includes("discovery")) {
    return "Insight: New understanding gained about the system";
  }
  return "General: Captured for future reference";
}

/**
 * Detect indicators that suggest lesson-worthy content
 */
function detectLessonIndicators(result) {
  const indicators = [];
  const lowerResult = result.toLowerCase();

  // Pattern detection
  const patterns = [
    { pattern: /fix(ed|ing)?|resolv(ed|ing)?|solv(ed|ing)?/i, label: "problem-solved" },
    { pattern: /error|bug|issue|fail(ed|ure)?/i, label: "error-encountered" },
    { pattern: /decid(ed|ing)?|chose|decision|trade-?off/i, label: "decision-made" },
    { pattern: /learn(ed|ing)?|discover(ed|ing)?|found|realiz(ed|ing)?/i, label: "discovery" },
    { pattern: /instead of|rather than|better approach/i, label: "alternative-found" },
    { pattern: /workaround|work-?around|bypass/i, label: "workaround" },
    { pattern: /refactor(ed|ing)?|improv(ed|ing)?|optimiz(ed|ing)?/i, label: "improvement" },
    { pattern: /important|critical|key insight|note that/i, label: "insight" },
  ];

  for (const { pattern, label } of patterns) {
    if (pattern.test(lowerResult)) {
      indicators.push(label);
    }
  }

  // Limit to top 3 most relevant
  return [...new Set(indicators)].slice(0, 3);
}
