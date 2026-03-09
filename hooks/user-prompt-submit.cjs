#!/usr/bin/env node
/**
 * UserPromptSubmit hook — GUTT routing entry point
 *
 * Pipeline:
 *   1. extractIntent(prompt)           — keyword/entity/domain signals (sync)
 *   2. matchPlaybook(prompt)           — named workflow match (sync, checked first)
 *   3. discoverAgents(intent)          — graph search via gutt MCP (async, 2s timeout)
 *   4. makeRoutingDecision(...)        — confidence-threshold decision logic (sync)
 *   5. output routing instruction OR passthrough silently
 *
 * PASSTHROUGH CONTRACT: if decision.type === "passthrough", this hook outputs
 * nothing and exits 0. Normal Claude Code usage is never interrupted.
 *
 * Routing decisions are logged to hooks/.state/gutt-routing.log for threshold tuning.
 */

const fs = require("fs");
const path = require("path");
const { isGuttMcpConfigured } = require("./lib/mcp-config.cjs");
const { PROJECT_DIR, STATE_DIR_NAME } = require("./lib/env.cjs");
const { debugLog } = require("./lib/debug.cjs");
const { extractIntent } = require("./lib/intent-extractor.cjs");
const { discoverAgents } = require("./lib/agent-discovery.cjs");
const { matchPlaybook } = require("./lib/playbook-matcher.cjs");
const { makeRoutingDecision, loadSession, saveSession } = require("./lib/router.cjs");

// ---------------------------------------------------------------------------
// Routing decision log (for threshold tuning — NOT memory)
// ---------------------------------------------------------------------------

const ROUTING_LOG = path.join(PROJECT_DIR, STATE_DIR_NAME, "hooks", ".state", "gutt-routing.log");

/**
 * Append one JSON line to the routing log.
 * Non-blocking — errors are silently swallowed.
 *
 * @param {string} prompt - truncated prompt
 * @param {object} intent
 * @param {object} decision
 */
function logDecision(prompt, intent, decision) {
  try {
    const dir = path.dirname(ROUTING_LOG);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      prompt: prompt.substring(0, 120),
      domainSignals: intent.domainSignals,
      entityRefs: intent.entityRefs,
      decision: {
        type: decision.type,
        lead: decision.lead,
        supporting: decision.supporting,
        confidence: decision.confidence,
        reason: decision.reason,
      },
    });
    fs.appendFileSync(ROUTING_LOG, entry + "\n");
  } catch {
    /* non-blocking */
  }
}

// ---------------------------------------------------------------------------
// Format the hook output message for a routing decision
// ---------------------------------------------------------------------------

/**
 * Build the console output for a non-passthrough routing decision.
 *
 * @param {object} decision - RoutingDecision from makeRoutingDecision()
 * @param {object|null} playbookMatch - PlaybookMatch from matchPlaybook() or null
 * @returns {string}
 */
function formatRoutingMessage(decision, playbookMatch) {
  const lines = [];

  if (decision.type === "playbook" && playbookMatch) {
    lines.push(`GUTT ROUTING: Playbook matched — "${playbookMatch.name}"`);
    lines.push("");
    lines.push(`Lead agent:  ${playbookMatch.lead || "none"}`);
    if (playbookMatch.supporting && playbookMatch.supporting.length > 0) {
      lines.push(`Supporting:  ${playbookMatch.supporting.join(", ")}`);
    }
    if (decision.context && decision.context.length > 0) {
      lines.push("");
      lines.push("Relevant context from memory:");
      for (const c of decision.context) {
        lines.push(`  ${c}`);
      }
    }
    lines.push("");
    lines.push(`ACTION: Activate subagent_type="${playbookMatch.lead}" with the above context.`);
  } else if (decision.type === "single") {
    lines.push(
      `GUTT ROUTING: Single agent — ${decision.lead} (confidence ${(decision.confidence * 100).toFixed(0)}%)`
    );
    lines.push("");
    lines.push(`Reason: ${decision.reason}`);
    if (decision.context && decision.context.length > 0) {
      lines.push("");
      lines.push("Relevant context from memory:");
      for (const c of decision.context) {
        lines.push(`  ${c}`);
      }
    }
    lines.push("");
    lines.push(`ACTION: Activate subagent_type="${decision.lead}" with the above context.`);
  } else if (decision.type === "team") {
    const all = [decision.lead, ...decision.supporting].filter(Boolean);
    lines.push(
      `GUTT ROUTING: Team — ${all.join(" + ")} (confidence ${(decision.confidence * 100).toFixed(0)}%)`
    );
    lines.push("");
    lines.push(`Lead:       ${decision.lead}`);
    if (decision.supporting.length > 0) {
      lines.push(`Supporting: ${decision.supporting.join(", ")}`);
    }
    lines.push(`Reason: ${decision.reason}`);
    if (decision.context && decision.context.length > 0) {
      lines.push("");
      lines.push("Relevant context from memory:");
      for (const c of decision.context) {
        lines.push(`  ${c}`);
      }
    }
    lines.push("");
    lines.push(
      `ACTION: Activate lead subagent_type="${decision.lead}", share context with supporting agents.`
    );
  } else if (decision.type === "fallback") {
    if (decision.lead) {
      lines.push(
        `GUTT ROUTING: Low-confidence match — ${decision.lead} (${(decision.confidence * 100).toFixed(0)}%)`
      );
      lines.push(`Note: ${decision.reason}`);
      lines.push(
        `ACTION: Consider activating subagent_type="${decision.lead}" or clarifying the request.`
      );
    } else {
      lines.push(`GUTT ROUTING: No agent covers this domain.`);
      lines.push(`Note: ${decision.reason}`);
      lines.push(`ACTION: Consider creating a new agent (Principle 9).`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main hook logic
// ---------------------------------------------------------------------------

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  // Guard: only run if gutt MCP is configured
  if (!isGuttMcpConfigured()) {
    process.exit(0);
  }

  let prompt = "";
  try {
    const data = JSON.parse(input || "{}");
    prompt = (data.prompt || data.message || "").trim();
  } catch {
    // Ignore parse errors — exit silently
    process.exit(0);
  }

  if (!prompt) {
    process.exit(0);
  }

  // Run the full routing pipeline (async because discoverAgents is async)
  runRoutingPipeline(prompt).catch((err) => {
    debugLog("user-prompt-submit", `Routing pipeline error: ${err.message}`);
    process.exit(0);
  });
});

/**
 * Full routing pipeline. Errors are caught by the caller and result in silent exit.
 *
 * @param {string} prompt - Raw user prompt
 */
async function runRoutingPipeline(prompt) {
  // Step 1: Extract intent signals
  const intent = extractIntent(prompt);

  // Step 2: Check playbooks first (before graph search).
  // Use threshold 6 (requires tag/name hits, not just description stop words)
  // to avoid false positives on generic coding questions.
  const playbookMatch = matchPlaybook(prompt, { threshold: 6 });

  let decision;

  if (playbookMatch) {
    // Playbook matched — build a playbook decision directly
    // Still discover agents to get context excerpts for the lead
    let agents = [];
    try {
      agents = await discoverAgents(intent);
    } catch {
      // Context is optional — proceed without it
    }

    const context = agents
      .slice(0, 5)
      .map((a) => a.summary)
      .filter(Boolean)
      .map((s) => `• ${s.trim()}`);

    decision = {
      type: "playbook",
      lead: playbookMatch.lead || null,
      supporting: playbookMatch.supporting || [],
      playbook: playbookMatch.name,
      confidence: 1.0,
      context,
      reason: `Playbook "${playbookMatch.name}" matched by keyword overlap.`,
    };
  } else {
    // Step 3: Discover agents via graph search
    let agents = [];
    try {
      agents = await discoverAgents(intent);
    } catch (err) {
      debugLog("user-prompt-submit", `discoverAgents failed: ${err.message}`);
      // Proceed with empty list — router will emit passthrough or fallback
    }

    // Step 4: Load session state for multi-turn context
    const session = loadSession();

    // Step 5: Make routing decision
    decision = makeRoutingDecision(agents, intent, session);
  }

  // Step 6: Log every decision for threshold tuning
  logDecision(prompt, intent, decision);

  // Step 7: Passthrough — output nothing, exit cleanly
  if (decision.type === "passthrough") {
    process.exit(0);
  }

  // Step 8: Update session state with this turn's result
  try {
    const session = loadSession();
    const activeAgents = [decision.lead, ...decision.supporting].filter(Boolean);
    saveSession({
      ...session,
      activeAgents,
      lastIntent: intent,
      lastRoutingDecision: {
        type: decision.type,
        lead: decision.lead,
        supporting: decision.supporting,
        confidence: decision.confidence,
      },
      turnCount: (session.turnCount || 0) + 1,
    });
  } catch (err) {
    debugLog("user-prompt-submit", `Session save failed: ${err.message}`);
    // Non-blocking — routing still proceeds
  }

  // Step 9: Output routing instruction to Claude
  const message = formatRoutingMessage(decision, playbookMatch);
  if (message) {
    console.log(message);
  }

  process.exit(0);
}
