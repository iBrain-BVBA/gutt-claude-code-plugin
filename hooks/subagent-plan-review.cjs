// hooks/subagent-plan-review.cjs
const fs = require("fs");

// Shared plan detection patterns - used by both hasPlanContent and countPlanPatterns
const PLAN_PATTERNS = [
  /##?\s*(plan|implementation|steps|approach|overview)/i,
  /\b(will|going to|need to)\s+(implement|create|build|add|refactor|update|migrate)/i,
  /\d+\.\s+(create|add|implement|update|modify|build|configure|set up)/i,
  /files?\s+to\s+(create|modify|update|change)/i,
  /\btask\s*\d+[:\s]/i,
  /\b(phase|step)\s+\d+/i,
  /(implementation|execution|development)\s+(plan|steps|tasks)/i,
];

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");

    // Read transcript content from any subagent
    const transcriptPath = data.agent_transcript_path;
    const { fullText, summary } = extractPlanFromTranscript(transcriptPath);

    // Check if the best-matching transcript message contains plan-like content
    if (!hasPlanContent(fullText)) {
      process.exitCode = 0;
      return;
    }

    // Create search query from plan summary
    const searchQuery = createSearchQuery(summary);

    // Sanitize for safe embedding in output
    const sanitizedQuery = sanitizeForDisplay(searchQuery);
    const sanitizedSummary = sanitizeForDisplay(summary.substring(0, 200));

    // Output using blocking format for SubagentStop
    const output = {
      decision: "block",
      reason: `[GUTT Plan Review]

A plan has been created. Before proceeding with implementation:

**Search organizational memory for:**
- Similar past implementations
- Lessons learned from related work
- Potential pitfalls to avoid

Delegate to memory-keeper agent:

Task(subagent_type="memory-keeper", model="haiku", prompt="Search for lessons and context about: ${sanitizedQuery}")

Plan summary: "${sanitizedSummary}${summary.length > 200 ? "..." : ""}"`,
    };

    console.log(JSON.stringify(output));
    process.exitCode = 0;
  } catch {
    // Silent failure - don't block workflow
    process.exitCode = 0;
  }
});

/**
 * Detect if content contains plan-like patterns
 * Requires at least 2 pattern matches for confidence
 */
function hasPlanContent(text) {
  if (!text || text.length < 50) {
    return false;
  }

  const matches = PLAN_PATTERNS.filter((p) => p.test(text)).length;
  return matches >= 2;
}

/**
 * Count how many plan patterns match in text
 */
function countPlanPatterns(text) {
  if (!text || text.length < 50) {
    return 0;
  }

  return PLAN_PATTERNS.filter((p) => p.test(text)).length;
}

function extractPlanFromTranscript(transcriptPath) {
  const emptyResult = { fullText: "", summary: "" };

  if (!transcriptPath) {
    return emptyResult;
  }

  try {
    // Handle ~ expansion for cross-platform
    const expandedPath = transcriptPath.replace(
      /^~/,
      process.env.HOME || process.env.USERPROFILE || ""
    );

    if (!fs.existsSync(expandedPath)) {
      return emptyResult;
    }

    const content = fs.readFileSync(expandedPath, "utf8");
    const lines = content.trim().split("\n");

    // Parse JSONL and find assistant messages
    // Handles both nested format {message: {role, content}} and flat format {role, content}
    const assistantMessages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Handle both nested and flat message formats
        const msg = entry.message || entry;
        const role = msg.role;
        const msgContent = msg.content;

        if (role === "assistant" && msgContent) {
          const text = Array.isArray(msgContent)
            ? msgContent
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            : msgContent;
          if (text) {
            assistantMessages.push(text);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Find the message with the most plan patterns (not just the last message)
    let bestMessage = "";
    let bestPatternCount = 0;

    for (let i = 0; i < assistantMessages.length; i++) {
      const msg = assistantMessages[i];
      const patternCount = countPlanPatterns(msg);
      if (patternCount > bestPatternCount) {
        bestPatternCount = patternCount;
        bestMessage = msg;
      }
    }

    // If no plan-like patterns were found in any message, return empty result
    if (bestPatternCount === 0) {
      return emptyResult;
    }

    // Extract first meaningful paragraphs for summary
    const paragraphs = bestMessage.split("\n").filter((l) => l.trim().length > 10);
    const summary = paragraphs.slice(0, 5).join(" ").substring(0, 500);

    // Return both full text (for pattern matching) and summary (for display)
    return { fullText: bestMessage, summary };
  } catch {
    return emptyResult;
  }
}

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

function createSearchQuery(summary) {
  const techTerms =
    summary.match(
      /\b(implement|create|add|fix|refactor|update|build|api|hook|component|service|database|auth|test|feature|endpoint|migration)\w*\b/gi
    ) || [];
  const uniqueTerms = [...new Set(techTerms.map((t) => t.toLowerCase()))];
  return uniqueTerms.slice(0, 5).join(" ") || summary.substring(0, 50);
}
