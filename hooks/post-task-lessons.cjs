#!/usr/bin/env node
/**
 * PostToolUse hook for Task tool - captures lessons from subagent results
 *
 * Closes the loop: Every subagent (OMC or otherwise) contributes lessons back.
 * Analyzes task results for learnings, decisions, patterns worth capturing.
 */

const { incrementLessonsCaptured } = require("./lib/session-state.cjs");
const { sanitizeForDisplay } = require("./lib/text-utils.cjs");

// Read JSON input from stdin
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);

    // Only process Task tool completions
    const toolName = data.tool_name || "";
    if (toolName !== "Task") {
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
    const skipAgents = ["gutt-pro-memory", "memory-keeper", "memory-capture"];
    if (skipAgents.some((agent) => subagentType.includes(agent))) {
      process.exit(0);
    }

    // Plan agents are handled by SubagentStop hook (subagent-plan-review.cjs)
    // to avoid duplicate prompts. Skip them here.
    const planAgentTypes = new Set(["plan", "oh-my-claudecode:plan", "oh-my-claudecode:planner"]);
    if (planAgentTypes.has(subagentType.toLowerCase())) {
      process.exit(0);
    }

    // Detect if result contains lesson-worthy content
    const lessonIndicators = detectLessonIndicators(toolResult);

    if (lessonIndicators.length === 0) {
      // No lessons detected - silent exit
      process.exit(0);
    }

    // Increment lessons captured counter
    incrementLessonsCaptured();

    // Sanitize user-derived content for embedding
    const sanitizedPrompt = sanitizeForDisplay(prompt.substring(0, 100));

    // Format the lesson as a proper episode body
    const episodeName = `Lesson: ${subagentType} - ${lessonIndicators[0] || "insight"}`;
    const episodeBody = formatLessonEpisode(subagentType, prompt, toolResult, lessonIndicators);

    // Output DIRECTIVE (not suggestion) using hookSpecificOutput format
    // Claude MUST execute this - it's not optional
    const output = {
      hookSpecificOutput: {
        additionalContext: `[GUTT AUTO-CAPTURE REQUIRED]

A lesson-worthy subagent result was detected. You MUST capture this to organizational memory NOW.

**Detected patterns:** ${lessonIndicators.join(", ")}
**Subagent:** ${subagentType}
**Task:** ${sanitizedPrompt}

EXECUTE THIS IMMEDIATELY (do not ask, do not skip):

mcp__gutt-mcp-remote__add_memory(
  name: "${episodeName}",
  episode_body: "${escapeForJson(episodeBody)}",
  source: "text",
  source_description: "Auto-captured from ${subagentType} subagent",
  last_n_episodes: 0
)

This is MANDATORY per GP-437. Lessons from subagent work must be captured automatically.`,
      },
    };

    console.log(JSON.stringify(output));
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
 */
function formatLessonEpisode(subagentType, prompt, result, indicators) {
  const summary = result.substring(0, 300).trim();
  const outcomeType =
    indicators.includes("problem-solved") || indicators.includes("improvement")
      ? "positive"
      : indicators.includes("error-encountered")
        ? "negative"
        : "neutral";

  return `**Trigger:** Subagent ${subagentType} completed task
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
