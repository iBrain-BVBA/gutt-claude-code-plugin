// hooks/subagent-plan-review.cjs
const fs = require("fs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");

    // Read transcript content from any subagent
    const transcriptPath = data.agent_transcript_path;
    const transcriptContent = extractPlanFromTranscript(transcriptPath);

    // Check if transcript contains plan-like content
    if (!hasPlanContent(transcriptContent)) {
      process.exitCode = 0;
      return;
    }

    const planSummary = transcriptContent;

    // Create search query from plan
    const searchQuery = createSearchQuery(planSummary);

    // Sanitize for safe embedding in output
    const sanitizedQuery = sanitizeForDisplay(searchQuery);
    const sanitizedSummary = sanitizeForDisplay(planSummary.substring(0, 200));

    // Output context injection via hookSpecificOutput
    const output = {
      hookSpecificOutput: {
        hookEventName: "SubagentStop",
        additionalContext: `[GUTT Plan Review]

A plan has been created. Before proceeding with implementation:

**Search organizational memory for:**
- Similar past implementations
- Lessons learned from related work
- Potential pitfalls to avoid

Suggested queries:
- mcp__gutt-mcp-remote__fetch_lessons_learned(query="${sanitizedQuery}")
- mcp__gutt-mcp-remote__search_memory_facts(query="${sanitizedQuery}")

Plan summary: "${sanitizedSummary}${planSummary.length > 200 ? "..." : ""}"`,
      },
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
 * Matches the content-based approach used in post-task-lessons.cjs
 */
function hasPlanContent(text) {
  if (!text || text.length < 50) {
    return false;
  }

  const planPatterns = [
    /##?\s*(plan|implementation|steps|approach|overview)/i,
    /\b(will|going to|need to)\s+(implement|create|build|add|refactor|update|migrate)/i,
    /\d+\.\s+(create|add|implement|update|modify|build|configure|set up)/i,
    /files?\s+to\s+(create|modify|update|change)/i,
    /\btask\s*\d+[:\s]/i,
    /\b(phase|step)\s+\d+/i,
    /(implementation|execution|development)\s+(plan|steps|tasks)/i,
  ];

  // Require at least 2 pattern matches for confidence
  const matches = planPatterns.filter((p) => p.test(text)).length;
  return matches >= 2;
}

function extractPlanFromTranscript(transcriptPath) {
  if (!transcriptPath) {
    return "";
  }

  try {
    // Handle ~ expansion for cross-platform
    const expandedPath = transcriptPath.replace(
      /^~/,
      process.env.HOME || process.env.USERPROFILE || ""
    );

    if (!fs.existsSync(expandedPath)) {
      return "";
    }

    const content = fs.readFileSync(expandedPath, "utf8");
    const lines = content.trim().split("\n");

    // Parse JSONL and find assistant messages
    const assistantMessages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role === "assistant" && entry.content) {
          const text = Array.isArray(entry.content)
            ? entry.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            : entry.content;
          assistantMessages.push(text);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Get the last substantial assistant message (likely the plan)
    const lastMessage = assistantMessages[assistantMessages.length - 1] || "";

    // Extract first meaningful paragraphs
    const paragraphs = lastMessage.split("\n").filter((l) => l.trim().length > 10);
    return paragraphs.slice(0, 5).join(" ").substring(0, 500);
  } catch {
    return "";
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
      /\b(implement|create|add|fix|refactor|update|build|api|hook|component|service|database|auth|test|feature|endpoint|migration)\w*/gi
    ) || [];
  const uniqueTerms = [...new Set(techTerms.map((t) => t.toLowerCase()))];
  return uniqueTerms.slice(0, 5).join(" ") || summary.substring(0, 50);
}
