#!/usr/bin/env node
/**
 * UserPromptSubmit hook for gutt-agent-intelligence-plugin.
 *
 * On the FIRST prompt of a session, emits a hookSpecificOutput block
 * that:
 *   - Names the resolved project agent_id.
 *   - Instructs the session to pass agent_id on add_memory and
 *     fetch_lessons_learned, with agent_id as an optional filter on
 *     search_memory_nodes.
 *   - Lists recent lessons for this agent from the on-disk cache.
 *   - When gutt MCP is configured, emits ACTION REQUIRED directives for
 *     register_agent (one-time per machine) and fetch_lessons_learned
 *     (once per session). The post-lesson-scrape PostToolUse hook
 *     writes the cache + registration marker after Claude actually
 *     makes those calls.
 *
 * Subsequent prompts in the same session are no-ops (guard flag in
 * CLAUDE_PLUGIN_DATA). The flag is session-scoped, so a new session
 * re-injects.
 *
 * Failure modes (all exit 0):
 *   - No identity file → silent skip (SessionStart did not finish or plugin new)
 *   - No cache file   → still injects banner + tool-usage guidance with an
 *                        empty lessons list (first session, or scraper has
 *                        not written yet)
 *   - Malformed input → logged to hook-errors.log; runs with default session id
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { resolveCacheDir, read: readLessonCache } = require("./lib/lesson-cache.cjs");
const { renderSessionGrounding } = require("./lib/grounding-formatter.cjs");
const { sanitizeSessionId } = require("./lib/session-state.cjs");
const { isGuttMcpConfigured, getGuttMcpServerName } = require("./lib/mcp-config.cjs");
const { debugLog } = require("./lib/debug.cjs");

const IDENTITY_FILE = "agent-identity.json";
const DEFAULT_TIME_RANGE = "30d";

function readAgentIdentity(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.agentId !== "string") {
      debugLog("agent-intel/user-prompt-submit", "agent-identity.json present but malformed");
      return null;
    }
    return parsed.agentId;
  } catch (err) {
    // ENOENT is expected when SessionStart hasn't completed yet (e.g. fresh
    // install, very first session). Anything else (EACCES, JSON parse error)
    // is unexpected and worth surfacing.
    if (err && err.code !== "ENOENT") {
      debugLog("agent-intel/user-prompt-submit", `identity read: ${err.message}`);
    }
    return null;
  }
}

function readMaxLessons() {
  const raw = process.env.CLAUDE_PLUGIN_OPTION_LESSON_MAX_RESULTS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function readTimeRange() {
  return process.env.CLAUDE_PLUGIN_OPTION_LESSON_TIME_RANGE || DEFAULT_TIME_RANGE;
}

function registrationMarkerExists(cacheDir, agentId) {
  const safe = String(agentId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return fs.existsSync(path.join(cacheDir, `.registered-${safe}.marker`));
}

function runUserPromptSubmit(sessionId) {
  const cacheDir = resolveCacheDir();
  const flagFile = path.join(cacheDir, `.injected-${sanitizeSessionId(sessionId)}.marker`);

  if (fs.existsSync(flagFile)) {
    return null; // already injected this session
  }

  const agentId = readAgentIdentity(cacheDir);
  if (!agentId) {
    debugLog("agent-intel/user-prompt-submit", "no agent-identity.json on disk");
    return null;
  }

  const cached = readLessonCache(agentId, { cacheDir });
  const lessons = cached && Array.isArray(cached.lessons) ? cached.lessons : [];

  const mcpConfigured = isGuttMcpConfigured();
  const needsRegister = mcpConfigured && !registrationMarkerExists(cacheDir, agentId);
  // Claude Code exposes MCP tools as `mcp__<serverName>__<tool>`; the server
  // name is whatever literal key the user used in their config (commonly
  // `gutt-pro-memory`, but installs like `gutt-pro-memory-local` or
  // `claude_ai_gutt-pro-memory` also exist). The ACTION REQUIRED directive
  // must name the actual prefix or the LLM's tool call will fail with
  // "tool not found".
  const serverName = mcpConfigured ? getGuttMcpServerName() : null;
  const mcpToolPrefix = serverName ? `mcp__${serverName}__` : undefined;

  const block = renderSessionGrounding({
    agentId,
    lessons,
    maxLessons: readMaxLessons(),
    mcpConfigured,
    needsRegister,
    timeRange: readTimeRange(),
    mcpToolPrefix,
  });

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(flagFile, String(Date.now()));
  } catch (err) {
    // Inject even if flag write fails — slight risk of duplicate
    // injection on rapid prompts, but better than dropping the lesson
    // grounding on the first prompt.
    debugLog("agent-intel/user-prompt-submit", `flag write: ${err.message}`);
  }

  return block;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let sessionId = "unknown";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    sessionId = data.session_id || "unknown";
  } catch (err) {
    // Malformed payload — still try with default id, but surface the
    // parse error so contract regressions are visible in hook-errors.log.
    debugLog("agent-intel/user-prompt-submit", `stdin parse: ${err.message}`);
  }

  let block = null;
  try {
    block = runUserPromptSubmit(sessionId);
  } catch (err) {
    debugLog("agent-intel/user-prompt-submit", `top-level: ${err.message || err}`);
  }

  if (block) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exitCode = 0;
});
