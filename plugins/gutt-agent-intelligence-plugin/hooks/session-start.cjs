#!/usr/bin/env node
/**
 * SessionStart hook for gutt-agent-intelligence-plugin.
 *
 * Non-blocking. Resolves the project's agent_id and persists it to disk so
 * the UserPromptSubmit and SubagentStart hooks can read the same value
 * without re-running git lookups on every fire.
 *
 * This hook does NOT touch the gutt MCP server. Registration and lesson
 * fetch both happen inside Claude's own OAuth-authenticated MCP client —
 * nudged by the ACTION REQUIRED directives that UserPromptSubmit injects
 * on the first prompt of the session — and land on disk via the
 * post-lesson-scrape PostToolUse hook. See that file's docstring for the
 * underlying OAuth-inaccessibility constraint.
 *
 * Silent on success. Failures are logged to hook-errors.log and never
 * propagate to the user.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { resolveProjectAgentId } = require("./lib/agent-identity.cjs");
const { resolveCacheDir } = require("./lib/lesson-cache.cjs");
const { debugLog } = require("./lib/debug.cjs");

const IDENTITY_FILE = "agent-identity.json";

function readUserConfig() {
  return {
    agentIdOverride: process.env.CLAUDE_PLUGIN_OPTION_AGENT_ID || "",
  };
}

function writeAgentIdentity(dir, agentId) {
  fs.mkdirSync(dir, { recursive: true });
  const payload = { agentId, resolvedAt: Date.now() };
  const file = path.join(dir, IDENTITY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmp, serialized, "utf8");

  // Cross-platform safe rename (see lesson-cache.write / session-state.updateState).
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    fs.renameSync(tmp, file);
  } catch (renameErr) {
    debugLog(
      "agent-intel/session-start",
      `atomic identity write failed, falling back: ${renameErr.message}`
    );
    fs.writeFileSync(file, serialized, "utf8");
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

function runSessionStart() {
  const cfg = readUserConfig();

  const agentId = resolveProjectAgentId({ userConfigOverride: cfg.agentIdOverride });
  if (!agentId) {
    // Every fallback (user override, git remote, git root, cwd basename)
    // produced an empty slug — extraordinary but possible (e.g. cwd is "/"
    // or the override is all-illegal characters). Refuse to write a sentinel
    // identity because it would cross-contaminate this machine's memory
    // graph across unrelated projects that hit the same fallback.
    const msg =
      "[gutt-agent-intel] Could not resolve a project agent_id " +
      "(user override, git remote, git root, and cwd basename all empty). " +
      "Session grounding is disabled for this session. " +
      "Set CLAUDE_PLUGIN_OPTION_AGENT_ID or run from a directory with a readable name to fix.";
    process.stderr.write(`${msg}\n`);
    debugLog("agent-intel/session-start", msg);
    return;
  }

  try {
    writeAgentIdentity(resolveCacheDir(), agentId);
  } catch (err) {
    debugLog("agent-intel/session-start", `identity write: ${err.message}`);
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
  } catch (err) {
    // We don't actually consume any fields from the payload, but a
    // malformed payload is a signal that Claude Code's hook contract
    // changed or something upstream is wrong — worth surfacing.
    debugLog("agent-intel/session-start", `stdin parse: ${err.message}`);
  }

  try {
    runSessionStart();
  } catch (err) {
    debugLog("agent-intel/session-start", `top-level: ${err.message || err}`);
  }

  process.exitCode = 0;
});
