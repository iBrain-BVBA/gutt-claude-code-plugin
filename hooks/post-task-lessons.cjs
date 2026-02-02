#!/usr/bin/env node
/**
 * PostToolUse hook for Task tool - captures lessons from subagent results
 *
 * Closes the loop: Every subagent (OMC or otherwise) contributes lessons back.
 * Analyzes task results for learnings, decisions, patterns worth capturing.
 */

const { incrementLessonsCaptured } = require("./lib/session-state.cjs");

/**
 * Sanitize text for safe embedding in query strings and display
 * Removes quotes, normalizes whitespace
 */
function sanitizeForDisplay(text) {
  return text
    .replace(/[\r\n]+/g, " ") // Replace newlines with space
    .replace(/["'`]/g, "") // Remove quotes
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

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

    // Output lesson capture suggestion using hookSpecificOutput format
    const output = {
      hookSpecificOutput: {
        additionalContext: `[GUTT Lesson Capture Opportunity]
Subagent "${subagentType}" completed with potential lessons:

Detected patterns: ${lessonIndicators.join(", ")}

Consider capturing lessons using memory-keeper agent:

Task(subagent_type="memory-keeper", model="haiku", prompt="Review and capture lessons from this task result: ${sanitizedPrompt}...")

Task context: "${sanitizedPrompt}..."`,
      },
    };

    console.log(JSON.stringify(output));
  } catch {
    // Silent exit on errors - don't block the tool
    process.exit(0);
  }
});

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
