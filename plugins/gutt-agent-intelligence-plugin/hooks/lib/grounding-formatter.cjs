#!/usr/bin/env node
/**
 * Render the agent-identity / mandatory-usage / lesson blocks that get
 * injected into the conversation via hookSpecificOutput.additionalContext.
 *
 * Two templates:
 *   renderSessionGrounding(...)  — for the main Claude session at
 *     UserPromptSubmit time. Banner + 3 tool instructions + lessons list,
 *     plus ACTION REQUIRED directives for register_agent / fetch_lessons_learned
 *     when MCP is configured (those calls warm the on-disk cache via the
 *     PostToolUse scraper).
 *
 *   renderSubagentGrounding(...) — for SubagentStart spawns. Role-aware:
 *     memory-keeper      → capture on behalf of the parent agent (no self-register)
 *     gutt-pro-memory    → agent_id is an optional scope filter (no self-register)
 *     default            → subagent captures under its own identity
 *                          (ACTION REQUIRED: register_agent when MCP configured
 *                          and no prior registration marker)
 *
 * Why the procedural phrasing:
 *   OAuth-authenticated MCP servers are unreachable from hook subprocesses,
 *   so warming the cache requires Claude itself to make the MCP call. Memory
 *   decision `Scope-limited-to-GUTT-usage` (2026-01-21) accepts this trade-off:
 *   procedural ACTION REQUIRED directives with exact tool names have better
 *   LLM compliance than generic reminders, but are not 100% reliable. On a
 *   skip, the cache stays stale; the session does not break.
 */

"use strict";

const { MEMORY_KEEPER_AGENT, GUTT_PRO_MEMORY_AGENT } = require("./constants.cjs");
const { debugLog } = require("./debug.cjs");

const DEFAULT_MCP_TOOL_PREFIX = "mcp__gutt-pro-memory__";
// Back-compat alias — external callers imported this constant directly.
const GUTT_MCP_TOOL_PREFIX = DEFAULT_MCP_TOOL_PREFIX;
// Deliberately verbose: fetch_lessons_learned requires `query` (semantic
// search term). A bare agent_id scope is not enough — the MCP server
// returns a 422 without it. This default asks the server to surface the
// agent's recent accumulated wisdom; Claude may override with a topic-
// specific term pulled from the user's prompt if that is clearly better.
const DEFAULT_LESSON_QUERY = "recent lessons";

/**
 * Truncate a string to a readable preview. Keeps the UserPromptSubmit
 * additionalContext under the 10 000-char cap even for verbose lessons.
 */
function preview(text, max = 280) {
  if (typeof text !== "string") {
    return "";
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Format a single lesson record into a compact bullet.
 * Accepts the field names used by `fetch_lessons_learned`. Returns null
 * when the record has neither a usable summary nor a name — the caller
 * must filter out nulls rather than render a meaningless "- lesson" line.
 */
function renderLesson(lesson) {
  if (!lesson || typeof lesson !== "object") {
    debugLog("grounding-formatter", "renderLesson: dropped non-object record");
    return null;
  }
  const summaryText =
    typeof lesson.summary === "string"
      ? lesson.summary
      : lesson.summary && typeof lesson.summary === "object"
        ? lesson.summary.text
        : null;
  const headline = preview(summaryText || lesson.name || "");
  if (!headline) {
    debugLog("grounding-formatter", "renderLesson: dropped record with no summary or name");
    return null;
  }
  const guidance = lesson.guidance ? ` — ${preview(lesson.guidance, 200)}` : "";
  const outcome = lesson.outcome ? ` (outcome: ${preview(lesson.outcome, 120)})` : "";
  return `- ${headline}${guidance}${outcome}`;
}

/**
 * Build the ACTION REQUIRED block that nudges Claude to warm the cache
 * via its own OAuth-authenticated MCP client. Returns `[]` when MCP is
 * not configured on this machine — nagging about an unreachable tool
 * adds noise without benefit.
 *
 * The `timeRange` argument is forwarded verbatim to the MCP server
 * (validation is the server's concern; invalid values surface as a
 * fetch error in the scraper log).
 */
function renderActionRequired({
  agentId,
  mcpConfigured,
  needsRegister,
  maxResults,
  timeRange,
  mcpToolPrefix = DEFAULT_MCP_TOOL_PREFIX,
  lessonQuery = DEFAULT_LESSON_QUERY,
}) {
  if (!mcpConfigured) {
    return [];
  }
  const lines = ["ACTION REQUIRED — do this BEFORE answering the user, exactly once per session:"];
  if (needsRegister) {
    lines.push(
      `  1. Call ${mcpToolPrefix}register_agent with ` +
        `name="${agentId}", description="Auto-registered agent for ${agentId}".`
    );
  }
  const fetchStep = needsRegister ? "  2." : "  1.";
  lines.push(
    `${fetchStep} Call ${mcpToolPrefix}fetch_lessons_learned with ` +
      `agent_id="${agentId}", query="${lessonQuery}", max_results=${maxResults}, time_range="${timeRange}".`
  );
  lines.push(
    "  These calls warm the session's lesson cache; skipping them leaves the next",
    "  session without this project's accumulated wisdom."
  );
  return [...lines, ""];
}

/**
 * Full grounding block for the main session.
 *
 * @param {object} args
 * @param {string} args.agentId            — fully-qualified project agent id
 * @param {Array}  [args.lessons=[]]       — lesson records from warm cache
 * @param {number} [args.maxLessons=10]    — cap on rendered lessons
 * @param {boolean} [args.mcpConfigured]   — gate the ACTION REQUIRED block
 * @param {boolean} [args.needsRegister]   — include register_agent step
 * @param {string} [args.timeRange="30d"]  — forwarded to fetch_lessons_learned
 * @returns {string}
 */
function renderSessionGrounding({
  agentId,
  lessons = [],
  maxLessons = 10,
  mcpConfigured = false,
  needsRegister = false,
  timeRange = "30d",
  mcpToolPrefix = DEFAULT_MCP_TOOL_PREFIX,
  lessonQuery = DEFAULT_LESSON_QUERY,
}) {
  const capped = Array.isArray(lessons) ? lessons.slice(0, maxLessons) : [];
  const header = [
    "[GUTT Agent Grounding]",
    `You are operating as agent "${agentId}".`,
    "",
    "Memory tool usage for this session:",
    `  - add_memory: MUST include agent_id="${agentId}" so captured lessons bind to this project's subgraph.`,
    `  - fetch_lessons_learned: MUST include agent_id="${agentId}" to retrieve this project's lessons.`,
    `  - search_memory_nodes: agent_id="${agentId}" is an optional scope filter — use it when you want results narrowed to this project.`,
    "",
  ];

  const actionRequired = renderActionRequired({
    agentId,
    mcpConfigured,
    needsRegister,
    maxResults: maxLessons,
    timeRange,
    mcpToolPrefix,
    lessonQuery,
  });

  const bullets = capped.map(renderLesson).filter(Boolean);
  let body;
  if (bullets.length === 0) {
    body = ["No accumulated lessons for this agent yet."];
  } else {
    body = ["Recent lessons for this agent:", ...bullets];
  }

  return [...header, ...actionRequired, ...body, "", "[End GUTT Agent Grounding]"].join("\n");
}

/**
 * Per-subagent binding instruction. Dispatched by subagent type:
 *   - memory-keeper:  proxy capture → use parent's id (no self-register)
 *   - gutt-pro-memory: read-only search → agent_id is optional filter (no self-register)
 *   - anything else:  self-capture → use own subagent_type as id.
 *                     Emits ACTION REQUIRED: register_agent when MCP is
 *                     configured and no prior marker exists.
 *
 * @param {object} args
 * @param {string} args.subagentType
 * @param {string} args.parentAgentId
 * @param {boolean} [args.mcpConfigured=false]
 * @param {boolean} [args.needsRegister=false]  — honored only in the default branch
 * @returns {string}
 */
function renderSubagentGrounding({
  subagentType,
  parentAgentId,
  mcpConfigured = false,
  needsRegister = false,
  mcpToolPrefix = DEFAULT_MCP_TOOL_PREFIX,
}) {
  const role = String(subagentType || "").trim();
  const parent = String(parentAgentId || "").trim();

  if (role === MEMORY_KEEPER_AGENT) {
    return [
      "[GUTT Agent Binding — memory-keeper]",
      `You are capturing on behalf of agent "${parent}". Proxy rule:`,
      `  - Every add_memory call MUST include agent_id="${parent}".`,
      `  - Lessons bind to the learner, not the capturer.`,
      "[End GUTT Agent Binding]",
    ].join("\n");
  }

  if (role === GUTT_PRO_MEMORY_AGENT) {
    return [
      "[GUTT Agent Binding — gutt-pro-memory]",
      "You are performing read-only memory search. Scope guidance:",
      `  - search_memory_nodes: agent_id="${parent}" is an OPTIONAL filter. Apply it when you want results narrowed to the parent session's subgraph; omit it for broad cross-agent searches.`,
      `  - fetch_lessons_learned: prefer agent_id="${parent}" when answering project-specific questions.`,
      "[End GUTT Agent Binding]",
    ].join("\n");
  }

  const lines = [
    `[GUTT Agent Binding — ${role}]`,
    `You are operating as agent "${role}". Memory tool usage:`,
    `  - add_memory: MUST include agent_id="${role}" so your captured lessons bind to your own subgraph (not the parent's).`,
    `  - fetch_lessons_learned: MUST include agent_id="${role}" to retrieve your own accumulated wisdom.`,
    `  - search_memory_nodes: agent_id="${role}" is an optional scope filter; use it to focus on your own subgraph.`,
  ];

  if (mcpConfigured && needsRegister) {
    lines.push(
      "",
      "ACTION REQUIRED — do this BEFORE your first memory operation:",
      `  - Call ${mcpToolPrefix}register_agent with ` +
        `name="${role}", description="Worker subagent: ${role}".`,
      "  (One-time per machine. Subsequent sessions skip this step automatically.)"
    );
  }

  lines.push("[End GUTT Agent Binding]");
  return lines.join("\n");
}

module.exports = {
  renderSessionGrounding,
  renderSubagentGrounding,
  renderLesson,
  preview,
  MEMORY_KEEPER_AGENT,
  GUTT_PRO_MEMORY_AGENT,
  GUTT_MCP_TOOL_PREFIX,
};
