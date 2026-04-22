#!/usr/bin/env node
/**
 * End-to-end flow test for gutt-agent-intelligence-plugin.
 *
 * Drives all three hooks against a single CLAUDE_PLUGIN_DATA directory
 * to verify they cooperate correctly:
 *
 *   1. SessionStart writes agent-identity.json
 *   2. UserPromptSubmit reads that identity and emits grounding
 *   3. UserPromptSubmit on a second prompt in the same session is silent
 *   4. UserPromptSubmit on a new session injects again
 *   5. SubagentStart (memory-keeper) reads the same identity and emits
 *      a proxy-binding block pointing at the parent agent_id
 *   6. SubagentStart (worker subagent) emits self-scoped binding that
 *      does not leak the parent's agent_id
 *
 * No live MCP is contacted — GUTT_MCP_URL is explicitly unset.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOKS_DIR = path.resolve(__dirname, "..", "hooks");

function run(hookFile, payload, env) {
  return spawnSync("node", [path.join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 8000,
  });
}

test("full pipeline: SessionStart → UserPromptSubmit → SubagentStart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-intel-e2e-"));
  const env = {
    CLAUDE_PLUGIN_DATA: dir,
    GUTT_MCP_URL: "",
    CLAUDE_PLUGIN_OPTION_AGENT_ID: "e2e-fixture",
  };

  try {
    // ---- Step 1: SessionStart writes identity ----
    const start = run("session-start.cjs", { session_id: "e2e-sess-A" }, env);
    assert.equal(start.status, 0, `SessionStart exit: ${start.stderr}`);

    const identityPath = path.join(dir, "agent-intelligence", "agent-identity.json");
    assert.ok(fs.existsSync(identityPath), "identity file must exist after SessionStart");
    const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    assert.equal(identity.agentId, "gutt-agent-e2e-fixture");

    // SessionStart no longer fetches lessons — that now happens inside
    // Claude via the ACTION REQUIRED directive in UserPromptSubmit, with
    // the post-lesson-scrape PostToolUse hook persisting the result. So
    // at this point no cache or registration marker should exist yet.
    const cachePath = path.join(dir, "agent-intelligence", `lessons-${identity.agentId}.json`);
    assert.equal(fs.existsSync(cachePath), false, "no cache before Claude calls MCP");
    const markerPath = path.join(
      dir,
      "agent-intelligence",
      `.registered-${identity.agentId}.marker`
    );
    assert.equal(
      fs.existsSync(markerPath),
      false,
      "no registration marker before Claude calls MCP"
    );

    // ---- Step 2: UserPromptSubmit emits grounding on first prompt ----
    const prompt1 = run("user-prompt-submit.cjs", { session_id: "e2e-sess-A" }, env);
    assert.equal(prompt1.status, 0);
    assert.ok(prompt1.stdout.length > 0, "first prompt must emit additionalContext");
    const prompt1Out = JSON.parse(prompt1.stdout);
    assert.equal(prompt1Out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const sessionCtx = prompt1Out.hookSpecificOutput.additionalContext;
    assert.match(sessionCtx, /gutt-agent-e2e-fixture/);
    assert.match(sessionCtx, /add_memory/);

    // ---- Step 3: Second prompt in same session is silent ----
    const prompt2 = run("user-prompt-submit.cjs", { session_id: "e2e-sess-A" }, env);
    assert.equal(prompt2.status, 0);
    assert.equal(prompt2.stdout.trim(), "", "second prompt in same session must be silent");

    // ---- Step 4: A fresh session re-injects ----
    const prompt3 = run("user-prompt-submit.cjs", { session_id: "e2e-sess-B" }, env);
    assert.equal(prompt3.status, 0);
    assert.ok(prompt3.stdout.length > 0, "new session must re-inject");

    // ---- Step 5: memory-keeper subagent gets proxy binding ----
    const keeper = run(
      "subagent-start-binding.cjs",
      { session_id: "e2e-sess-A", agent_id: "k-inst", agent_type: "memory-keeper" },
      env
    );
    assert.equal(keeper.status, 0);
    const keeperOut = JSON.parse(keeper.stdout);
    assert.equal(keeperOut.hookSpecificOutput.hookEventName, "SubagentStart");
    const keeperCtx = keeperOut.hookSpecificOutput.additionalContext;
    assert.match(keeperCtx, /memory-keeper/);
    assert.match(keeperCtx, /agent_id="gutt-agent-e2e-fixture"/);
    assert.match(keeperCtx, /Lessons bind to the learner/);

    // ---- Step 6: Worker subagent gets self-scoped binding ----
    const worker = run(
      "subagent-start-binding.cjs",
      { session_id: "e2e-sess-A", agent_id: "w-inst", agent_type: "plugin-dev" },
      env
    );
    assert.equal(worker.status, 0);
    const workerOut = JSON.parse(worker.stdout);
    const workerCtx = workerOut.hookSpecificOutput.additionalContext;
    assert.match(workerCtx, /plugin-dev/);
    assert.match(workerCtx, /agent_id="plugin-dev"/);
    assert.ok(
      !workerCtx.includes("gutt-agent-e2e-fixture"),
      "default branch must not leak parent's agent_id"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scraper round-trip: Claude's MCP calls warm the cache for the next session", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-intel-e2e-proj-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-intel-e2e-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-intel-e2e-data-"));

  // MCP configured → UserPromptSubmit should emit the ACTION REQUIRED block.
  fs.writeFileSync(
    path.join(projectDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "gutt-mcp-remote": { url: "http://example.invalid" } } })
  );

  const env = {
    CLAUDE_PROJECT_DIR: projectDir,
    CURSOR_PROJECT_DIR: projectDir,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_PLUGIN_DATA: dataDir,
    GUTT_MCP_URL: "",
    CLAUDE_PLUGIN_OPTION_AGENT_ID: "round-trip",
  };

  try {
    // ---- Session 1: identity + grounding with ACTION REQUIRED ----
    const start = run("session-start.cjs", { session_id: "rt-1" }, env);
    assert.equal(start.status, 0);

    const prompt1 = run("user-prompt-submit.cjs", { session_id: "rt-1" }, env);
    assert.equal(prompt1.status, 0);
    const ctx1 = JSON.parse(prompt1.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx1, /ACTION REQUIRED/);
    // Fixture configures the server as gutt-mcp-remote, so the emitted
    // tool prefix must match that literal key — not the plugin default.
    assert.match(ctx1, /mcp__gutt-mcp-remote__register_agent/);
    assert.match(ctx1, /mcp__gutt-mcp-remote__fetch_lessons_learned/);
    assert.match(ctx1, /No accumulated lessons for this agent yet/);

    // ---- Simulate Claude acting on the directives ----
    // Claude calls register_agent; PostToolUse fires post-lesson-scrape.cjs:
    const reg = run(
      "post-lesson-scrape.cjs",
      {
        tool_name: "mcp__gutt-pro-memory__register_agent",
        tool_input: { name: "gutt-agent-round-trip", description: "x" },
        tool_response: {},
      },
      env
    );
    assert.equal(reg.status, 0);

    // Claude calls fetch_lessons_learned; scraper writes the cache:
    const fetch = run(
      "post-lesson-scrape.cjs",
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-round-trip" },
        tool_response: {
          result: {
            lessons: [
              { summary: "always include agent_id on add_memory" },
              { summary: "hook matchers are regex, not glob" },
            ],
          },
        },
      },
      env
    );
    assert.equal(fetch.status, 0);

    // ---- Disk state after scrape ----
    const markerFile = path.join(
      dataDir,
      "agent-intelligence",
      ".registered-gutt-agent-round-trip.marker"
    );
    assert.ok(fs.existsSync(markerFile), "register marker must be written by scraper");

    const cacheFile = path.join(
      dataDir,
      "agent-intelligence",
      "lessons-gutt-agent-round-trip.json"
    );
    assert.ok(fs.existsSync(cacheFile), "lesson cache must be written by scraper");
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.equal(cached.lessons.length, 2);

    // ---- Session 2: grounding should now surface the cached lessons AND
    //      drop the register_agent directive (marker present). ----
    run("session-start.cjs", { session_id: "rt-2" }, env);
    const prompt2 = run("user-prompt-submit.cjs", { session_id: "rt-2" }, env);
    assert.equal(prompt2.status, 0);
    const ctx2 = JSON.parse(prompt2.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx2, /always include agent_id on add_memory/);
    assert.match(ctx2, /hook matchers are regex, not glob/);
    assert.match(ctx2, /mcp__gutt-mcp-remote__fetch_lessons_learned/);
    assert.ok(!ctx2.includes("register_agent"), "session 2 should not re-nag register_agent");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
