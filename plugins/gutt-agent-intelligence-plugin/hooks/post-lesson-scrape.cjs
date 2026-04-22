#!/usr/bin/env node
/**
 * PostToolUse scraper for gutt memory MCP calls.
 *
 * Why this hook exists
 * --------------------
 * Claude Code's OAuth session token lives inside the CLI's internal MCP
 * client process and is NOT reachable from a hook subprocess. The previous
 * design made direct JSON-RPC-over-HTTP calls from session-start and
 * subagent-start, which worked only against pre-provisioned service tokens
 * (GUTT_MCP_TOKEN / GUTT_MCP_IDENTITY env vars). For end-user OAuth
 * deployments those env vars are absent, and every callMcpTool invocation
 * hit the OAuth-gated endpoint without credentials.
 *
 * The accepted workaround is to have Claude itself invoke the MCP tools
 * through Claude Code's OAuth-aware MCP client, and have this PostToolUse
 * hook "piggyback" on those calls: we observe the `tool_response` after each
 * gutt MCP tool call and persist the relevant bits to disk for the next
 * session's UserPromptSubmit to consume.
 *
 * Matcher contract
 * ----------------
 * Claude Code hook matchers are regex (not globs). `mcp__.*gutt.*__.*`
 * catches every MCP server naming variant observed across install methods
 * (gutt-pro-memory, gutt-mcp-remote, claude_ai_gutt-pro-memory, …). The
 * action name is extracted via `toolName.split("__").pop()` so the hook
 * does not depend on any particular prefix.
 *
 * Invariants
 * ----------
 *   - Never overwrite the on-disk cache with `[]` when the response is
 *     malformed or missing. `parseLessonsOrNull` returns null in those
 *     cases; this hook short-circuits on null.
 *   - Every early return passes through debugLog so silent-failure is not
 *     a debugging hazard.
 *   - Never fail the tool call. Exit code is always 0; the hook's only
 *     side effects are cache + marker writes.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { parseLessonsOrNull } = require("./lib/lesson-result.cjs");
const lessonCache = require("./lib/lesson-cache.cjs");
const { debugLog } = require("./lib/debug.cjs");

const LOG_SCOPE = "agent-intel/post-lesson-scrape";

function writeRegistrationMarker(cacheDir, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safe) {
    debugLog(LOG_SCOPE, "register_agent: sanitized name was empty; skipping marker write");
    return;
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `.registered-${safe}.marker`), String(Date.now()));
  } catch (err) {
    debugLog(LOG_SCOPE, `register marker write failed for ${safe}: ${err.message}`);
  }
}

function handleFetchLessons(toolInput, toolResponse, cacheDir) {
  const agentId = typeof toolInput.agent_id === "string" ? toolInput.agent_id.trim() : "";
  if (!agentId) {
    // An LLM compliance lapse — `fetch_lessons_learned` was called without
    // agent_id, so we have no cache key to write under. The previous cache
    // (if any) stays intact for next session.
    debugLog(LOG_SCOPE, "fetch_lessons_learned: tool_input.agent_id missing; no cache write");
    return;
  }

  const lessons = parseLessonsOrNull(toolResponse);
  if (lessons === null) {
    debugLog(
      LOG_SCOPE,
      `fetch_lessons_learned: tool_response shape unrecognized for ${agentId}; preserving prior cache`
    );
    return;
  }

  try {
    lessonCache.write(agentId, lessons, { cacheDir });
  } catch (err) {
    debugLog(LOG_SCOPE, `lessonCache.write failed for ${agentId}: ${err.message}`);
  }
}

function handleRegisterAgent(toolInput, toolResponse, cacheDir) {
  const name = typeof toolInput.name === "string" ? toolInput.name.trim() : "";
  if (!name) {
    debugLog(LOG_SCOPE, "register_agent: tool_input.name missing; skipping marker");
    return;
  }
  // PostToolUse fires on both success and failure tool_responses. Without this
  // gate a failed register call (5xx, validation error) still writes the
  // marker, permanently flipping needsRegister to false until the user deletes
  // the marker by hand. Treat a missing or error-shaped response as failure.
  if (!toolResponse || toolResponse.error || toolResponse.isError) {
    debugLog(
      LOG_SCOPE,
      `register_agent: error-shaped or missing tool_response for ${name}; skipping marker`
    );
    return;
  }
  writeRegistrationMarker(cacheDir, name);
}

function run(payload) {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!toolName) {
    debugLog(LOG_SCOPE, "no tool_name in payload; skipping");
    return;
  }

  // e.g. "mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned" → "fetch_lessons_learned"
  const action = toolName.split("__").pop() || "";
  if (action !== "fetch_lessons_learned" && action !== "register_agent") {
    // Not a branch we care about. Other gutt tools (search_memory_nodes,
    // add_memory, …) are handled elsewhere (statusline counters in the
    // main plugin's post-memory-ops.cjs).
    return;
  }

  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  // Claude Code has used both `tool_response` and `tool_result` across
  // versions; try both before giving up.
  const toolResponse =
    payload.tool_response !== undefined ? payload.tool_response : payload.tool_result;

  const cacheDir = lessonCache.resolveCacheDir();

  if (action === "fetch_lessons_learned") {
    handleFetchLessons(toolInput, toolResponse, cacheDir);
  } else if (action === "register_agent") {
    handleRegisterAgent(toolInput, toolResponse, cacheDir);
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const trimmed = input.replace(/^\uFEFF/, "").trim();
    const payload = trimmed ? JSON.parse(trimmed) : {};
    run(payload);
  } catch (err) {
    debugLog(LOG_SCOPE, `top-level: ${err && err.message ? err.message : err}`);
  }
  process.exitCode = 0;
});
