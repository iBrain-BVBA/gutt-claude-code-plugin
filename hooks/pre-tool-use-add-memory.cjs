#!/usr/bin/env node
/**
 * GUTT Decision Authority — PreToolUse Hook for add_memory
 *
 * Intercepts add_memory tool calls and classifies them into authority tiers.
 * - auto: allows silently
 * - review: allows with notification to user (additionalContext)
 * - gated: BLOCKS the call and asks for human approval
 *
 * See docs/DECISION-AUTHORITY.md in gutt-agents for the full model.
 */

const { classifyWrite, enforceAuthority } = require("./lib/decision-authority.cjs");
const { debugLog } = require("./lib/debug.cjs");

const HOOK_NAME = "pre-tool-use-add-memory";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");

    // Only intercept add_memory tool calls (handles both direct and MCP-prefixed names)
    const toolName = data.tool_name || "";
    if (!toolName.includes("add_memory")) {
      process.exit(0);
    }

    // Extract the tool input parameters
    const toolInput = data.tool_input || {};

    debugLog(HOOK_NAME, `Intercepted add_memory: name="${toolInput.name || "(unnamed)"}"`);

    // Classify the write
    const classification = classifyWrite(toolInput);

    debugLog(
      HOOK_NAME,
      `Classification: tier=${classification.tier}, reason=${classification.reason}`
    );

    // Enforce authority
    const result = enforceAuthority(classification, toolInput);

    if (!result.allowed) {
      // BLOCK: Output JSON decision that tells Claude Code to block the tool call
      const blockResponse = {
        decision: "block",
        reason: result.message,
      };
      process.stdout.write(JSON.stringify(blockResponse));
      process.exit(0);
    }

    if (result.message) {
      // REVIEW: Allow but surface notification to the model via additionalContext
      const reviewResponse = {
        decision: "allow",
        additionalContext: result.message,
      };
      process.stdout.write(JSON.stringify(reviewResponse));
      process.exit(0);
    }

    // AUTO: Silent allow — no output, exit 0
    process.exit(0);
  } catch (err) {
    debugLog(HOOK_NAME, err);
    // On error, allow the write (fail open — blocking all writes would break learning)
    process.exit(0);
  }
});
