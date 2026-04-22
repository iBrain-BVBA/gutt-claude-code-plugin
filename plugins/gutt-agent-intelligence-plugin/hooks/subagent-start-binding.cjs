#!/usr/bin/env node
/**
 * SubagentStart hook for gutt-agent-intelligence-plugin.
 *
 * Fires once per spawned subagent, BEFORE its first turn. Emits a
 * hookSpecificOutput.additionalContext block telling the subagent
 * which agent_id to pass on its memory tool calls. The binding rule
 * depends on the subagent's role:
 *
 *   - memory-keeper     → proxy capture, use the PARENT's agent_id
 *   - gutt-pro-memory   → read-only search, agent_id is an optional filter
 *   - every other type  → self-capture, use its own subagent name.
 *                         When gutt MCP is configured and no prior
 *                         registration marker exists for this subagent
 *                         type, an ACTION REQUIRED: register_agent
 *                         directive is included. The post-lesson-scrape
 *                         PostToolUse hook writes the marker after
 *                         Claude actually makes the call.
 *
 * Composition with sibling plugins: gutt-subagent-hooks-plugin also
 * emits additionalContext on SubagentStart. Both hooks fire, both
 * contributions reach the subagent — additive, no conflict.
 *
 * Why SubagentStart and not PreToolUse[Task]: captured lesson in org
 * memory (Feb 2026) — additionalContext emitted from PreToolUse[Task]
 * stays in the parent conversation and does NOT reach the spawned
 * subagent. SubagentStart is the only event whose additionalContext
 * reliably lands in the subagent's initial context.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { resolveCacheDir } = require("./lib/lesson-cache.cjs");
const { renderSubagentGrounding } = require("./lib/grounding-formatter.cjs");
const { isGuttMcpConfigured, getGuttMcpServerName } = require("./lib/mcp-config.cjs");
const { MEMORY_KEEPER_AGENT, GUTT_PRO_MEMORY_AGENT } = require("./lib/constants.cjs");
const { debugLog } = require("./lib/debug.cjs");

const IDENTITY_FILE = "agent-identity.json";
// Agents that should NOT be self-registered as learners in the graph:
//   - memory-keeper / gutt-pro-memory: proxy capture + read-only search (parent binds).
//   - config-discovery: tool-scanner role, not a learner. Registering it
//     would conflate cross-project scans into a global subgraph.
// Intentionally diverges from gutt-subagent-hooks-plugin's skipAgents list:
// that sibling adds substring "memory" (catching memory-curator, memory-scribe)
// because its skip gate applies to plan-review. Here we gate self-registration
// with exact match, so new `memory-*` worker agents WILL register under their
// own name — the correct behavior for learners.
const PROXY_AGENTS = new Set([MEMORY_KEEPER_AGENT, GUTT_PRO_MEMORY_AGENT, "config-discovery"]);

function readParentAgentId(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.agentId !== "string") {
      debugLog("agent-intel/subagent-start", "agent-identity.json present but malformed");
      return null;
    }
    return parsed.agentId;
  } catch (err) {
    // ENOENT is expected when SessionStart hasn't completed yet. Anything
    // else is unexpected and worth surfacing.
    if (err && err.code !== "ENOENT") {
      debugLog("agent-intel/subagent-start", `identity read: ${err.message}`);
    }
    return null;
  }
}

function sanitizeSubagentType(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function registrationMarkerExists(cacheDir, name) {
  const safe = sanitizeSubagentType(name);
  if (!safe) {
    return false;
  }
  return fs.existsSync(path.join(cacheDir, `.registered-${safe}.marker`));
}

function runSubagentStart(agentType) {
  const cacheDir = resolveCacheDir();
  const parentAgentId = readParentAgentId(cacheDir);
  if (!parentAgentId) {
    debugLog("agent-intel/subagent-start", "no parent agent-identity.json on disk");
    return null;
  }

  const mcpConfigured = isGuttMcpConfigured();
  // The register directive is only meaningful for worker subagents — proxy
  // agents use the parent's identity, which is already covered by the session
  // grounding's register_agent step.
  const isProxy = PROXY_AGENTS.has(agentType);
  const needsRegister = mcpConfigured && !isProxy && !registrationMarkerExists(cacheDir, agentType);
  const serverName = mcpConfigured ? getGuttMcpServerName() : null;
  const mcpToolPrefix = serverName ? `mcp__${serverName}__` : undefined;

  return renderSubagentGrounding({
    subagentType: agentType,
    parentAgentId,
    mcpConfigured,
    needsRegister,
    mcpToolPrefix,
  });
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let agentType = "";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    agentType = typeof data.agent_type === "string" ? data.agent_type.trim() : "";
  } catch (err) {
    // Malformed payload — fall through to empty-agent-type silent exit,
    // but surface the parse error so contract regressions are visible.
    debugLog("agent-intel/subagent-start", `stdin parse: ${err.message}`);
  }

  if (!agentType) {
    process.exitCode = 0;
    return;
  }

  let block = null;
  try {
    block = runSubagentStart(agentType);
  } catch (err) {
    debugLog("agent-intel/subagent-start", `top-level: ${err.message || err}`);
  }

  if (block) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
          additionalContext: block,
        },
      })
    );
  }

  process.exitCode = 0;
});
