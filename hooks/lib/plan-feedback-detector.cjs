#!/usr/bin/env node
/**
 * Plan Feedback Detector
 * Detects plan context and extracts user feedback for lesson capture
 *
 * Expects: Array of parsed transcript entries (from parseTranscriptRaw)
 */

const { debugLog } = require("./debug.cjs");

const rejectionPatterns = [
  /no,?\s*(that's\s+)?wrong/i,
  /wrong approach/i,
  /start over/i,
  /scrap (this|that|it)/i,
  /reject/i,
  /don't do that/i,
  /not what I (asked|wanted|meant)/i,
];

const modificationPatterns = [
  /change\s+(\w+)\s+to\s+(\w+)/i,
  /instead of\s+(.+?),?\s+(use|do|try)/i,
  /but\s+(add|remove|change|modify)/i,
  /good,?\s+but/i,
  /almost,?\s+but/i,
  /modify the plan/i,
];

const approvalPatterns = [
  /looks good/i,
  /perfect/i,
  /exactly (what I wanted|right)/i,
  /approved?/i,
  /go ahead/i,
  /proceed/i,
];

/**
 * Check if transcript contains plan subagent execution
 */
function detectPlanContext(transcriptData) {
  if (!transcriptData) {
    debugLog("plan-feedback-detector", "No transcript data provided");
    return null;
  }

  debugLog("plan-feedback-detector", `Scanning ${transcriptData.length} entries for plan context`);

  // Look for Task tool with planner subagent
  for (let i = 0; i < transcriptData.length; i++) {
    const entry = transcriptData[i];
    if (entry.type === "tool_use" && entry.name === "Task") {
      const subagentType = entry.input?.subagent_type || "";
      if (subagentType.includes("planner") || subagentType.includes("Plan")) {
        debugLog("plan-feedback-detector", `Found plan context: ${subagentType} at index ${i}`);
        return {
          found: true,
          subagentType,
          index: i,
        };
      }
    }
  }

  debugLog("plan-feedback-detector", "No plan context found");
  return null;
}

/**
 * Extract plan feedback from user messages after plan output
 */
function extractPlanFeedback(transcriptData, planContext) {
  if (!planContext) {
    debugLog("plan-feedback-detector", "No plan context provided");
    return null;
  }

  // Get user messages after plan completion
  const messagesAfterPlan = transcriptData
    .slice(planContext.index + 1)
    .filter((e) => e.type === "user_message");

  debugLog("plan-feedback-detector", `Found ${messagesAfterPlan.length} user messages after plan`);

  for (const msg of messagesAfterPlan) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content?.find((c) => c.type === "text")?.text || "";

    debugLog("plan-feedback-detector", `Analyzing message: ${content.substring(0, 50)}...`);

    // Check rejection
    for (const pattern of rejectionPatterns) {
      if (pattern.test(content)) {
        debugLog("plan-feedback-detector", `Detected REJECTION pattern: ${pattern}`);
        return {
          type: "rejected",
          outcome: "negative",
          reason: content,
          topic: extractTopic(transcriptData, planContext),
        };
      }
    }

    // Check modification
    for (const pattern of modificationPatterns) {
      const match = content.match(pattern);
      if (match) {
        debugLog("plan-feedback-detector", `Detected MODIFICATION pattern: ${pattern}`);
        return {
          type: "modified",
          outcome: "positive",
          reason: content,
          topic: extractTopic(transcriptData, planContext),
          modification: match[0],
        };
      }
    }

    // Check approval (skip capture)
    for (const pattern of approvalPatterns) {
      if (pattern.test(content)) {
        debugLog("plan-feedback-detector", `Detected APPROVAL pattern: ${pattern}`);
        return { type: "approved", skip: true };
      }
    }
  }

  debugLog("plan-feedback-detector", "No clear feedback detected");
  return null; // No clear feedback
}

/**
 * Extract plan topic from initial user message
 */
function extractTopic(transcriptData, planContext) {
  // Get first user message before plan
  const userMsgs = transcriptData
    .slice(0, planContext.index)
    .filter((e) => e.type === "user_message");

  if (userMsgs.length > 0) {
    const content = userMsgs[0].content;
    const topic = (
      typeof content === "string" ? content : content?.find((c) => c.type === "text")?.text || ""
    )
      .substring(0, 100)
      .replace(/\n/g, " ")
      .trim();
    debugLog("plan-feedback-detector", `Extracted topic: ${topic}`);
    return topic;
  }

  debugLog("plan-feedback-detector", "No topic found, using default");
  return "Unknown topic";
}

/**
 * Escape a string for use in MCP tool call arguments
 * Handles backslashes, quotes, and newlines
 */
function escapeForMcp(str) {
  return str
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\n/g, "\\n"); // Escape newlines
}

/**
 * Build capture instruction with exact MCP tool call
 */
function buildCaptureInstruction(feedback) {
  const outcomeText =
    feedback.outcome === "negative"
      ? "Plan was REJECTED"
      : "Plan was MODIFIED (constructive feedback)";

  const guidance =
    feedback.outcome === "negative"
      ? `Avoid this approach when planning similar features`
      : `Apply this modification pattern for similar planning tasks`;

  const episodeBody = `Plan for '${feedback.topic}' - ${outcomeText}

Feedback: ${feedback.reason}
${feedback.modification ? `Modification: ${feedback.modification}` : ""}

Outcome: ${feedback.outcome}
Guidance: ${guidance}`;

  debugLog("plan-feedback-detector", `Built capture instruction for ${feedback.type} feedback`);

  const escapedName = escapeForMcp(`Plan Lesson: ${feedback.topic.substring(0, 50)}`);
  const escapedBody = escapeForMcp(episodeBody);

  return `🟠 ACTION REQUIRED: Capture plan feedback as lesson.

${outcomeText}. Use this exact command:

mcp__gutt-mcp-remote__add_memory(
  name="${escapedName}",
  episode_body="${escapedBody}",
  source="text",
  source_description="Human plan review feedback"
)

Or describe the lesson in your own words and I'll capture it.`;
}

module.exports = {
  detectPlanContext,
  extractPlanFeedback,
  buildCaptureInstruction,
  rejectionPatterns,
  modificationPatterns,
  approvalPatterns,
};
