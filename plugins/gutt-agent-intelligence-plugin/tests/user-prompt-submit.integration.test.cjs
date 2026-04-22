#!/usr/bin/env node
/**
 * UserPromptSubmit hook — integration tests.
 *
 * Spawns the hook as a child process with stdin, verifies:
 *   - First prompt in a session emits additionalContext.
 *   - Subsequent prompts in the same session emit nothing (flag).
 *   - Missing identity file results in a clean silent exit.
 *   - Output shape matches the hookSpecificOutput contract.
 *   - When gutt MCP is configured, the grounding includes ACTION REQUIRED
 *     directives for register_agent (if no marker) and fetch_lessons_learned.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "..", "hooks", "user-prompt-submit.cjs");

function runHook(payload, env) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

function setupFixture(agentId, lessons, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-prompt-submit-"));
  const subdir = path.join(dir, "agent-intelligence");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(
    path.join(subdir, "agent-identity.json"),
    JSON.stringify({ agentId, resolvedAt: Date.now() })
  );
  fs.writeFileSync(
    path.join(subdir, `lessons-${agentId}.json`),
    JSON.stringify({ agentId, updatedAt: Date.now(), lessons })
  );
  if (options.registered) {
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    fs.writeFileSync(path.join(subdir, `.registered-${safe}.marker`), String(Date.now()));
  }
  return dir;
}

/**
 * Pin HOME + project dir to tmpdirs so isGuttMcpConfigured() answer is
 * deterministic in the test environment. `configured=true` writes an
 * .mcp.json with a gutt entry; `configured=false` leaves everything empty.
 */
function mcpEnv(configured, options = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ups-proj-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ups-home-"));
  if (configured) {
    const serverName = options.serverName || "gutt-mcp-remote";
    fs.writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { [serverName]: { url: "http://example.invalid" } } })
    );
  }
  return {
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
      CURSOR_PROJECT_DIR: projectDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      GUTT_MCP_URL: "",
    },
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

test("first prompt in a session emits additionalContext", () => {
  const dir = setupFixture("gutt-agent-demo", [
    { summary: "always include agent_id on add_memory" },
  ]);
  const mcp = mcpEnv(false);
  try {
    const res = runHook({ session_id: "s-first" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    assert.ok(res.stdout.length > 0, "expected stdout output on first prompt");
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(parsed.hookSpecificOutput.additionalContext, /gutt-agent-demo/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /add_memory/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /always include agent_id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("second prompt in the same session emits nothing", () => {
  const dir = setupFixture("gutt-agent-demo", []);
  const mcp = mcpEnv(false);
  try {
    const first = runHook({ session_id: "s-same" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(first.status, 0);
    assert.ok(first.stdout.length > 0, "first prompt should emit output");

    const second = runHook({ session_id: "s-same" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), "", "second prompt must be silent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("different session id re-injects", () => {
  const dir = setupFixture("gutt-agent-demo", []);
  const mcp = mcpEnv(false);
  try {
    const first = runHook({ session_id: "s-a" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.ok(first.stdout.length > 0);

    const second = runHook({ session_id: "s-b" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.ok(second.stdout.length > 0, "new session should inject again");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("empty lesson cache still emits grounding with empty-lessons message", () => {
  const dir = setupFixture("gutt-agent-empty", []);
  const mcp = mcpEnv(false);
  try {
    const res = runHook({ session_id: "s-empty" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /No accumulated lessons/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("missing identity file results in silent exit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-prompt-submit-noid-"));
  const mcp = mcpEnv(false);
  try {
    const res = runHook({ session_id: "s-no-id" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("malformed stdin does not crash", () => {
  const dir = setupFixture("gutt-agent-demo", []);
  const mcp = mcpEnv(false);
  try {
    const res = spawnSync("node", [HOOK], {
      input: "{not json",
      encoding: "utf8",
      env: { ...process.env, ...mcp.env, CLAUDE_PLUGIN_DATA: dir },
      timeout: 5000,
    });
    assert.equal(res.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("respects CLAUDE_PLUGIN_OPTION_LESSON_MAX_RESULTS", () => {
  const lessons = Array.from({ length: 20 }, (_, i) => ({ summary: `lesson ${i}` }));
  const dir = setupFixture("gutt-agent-max", lessons);
  const mcp = mcpEnv(false);
  try {
    const res = runHook(
      { session_id: "s-max" },
      {
        ...mcp.env,
        CLAUDE_PLUGIN_DATA: dir,
        CLAUDE_PLUGIN_OPTION_LESSON_MAX_RESULTS: "3",
      }
    );
    const parsed = JSON.parse(res.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /lesson 0/);
    assert.match(ctx, /lesson 2/);
    assert.ok(!ctx.includes("lesson 3"), "cap should exclude lesson 3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ACTION REQUIRED branch — gated on MCP configured and marker state.
// ---------------------------------------------------------------------------

test("MCP configured + no marker ⇒ grounding includes register_agent AND fetch_lessons_learned directives", () => {
  const dir = setupFixture("gutt-agent-demo-project", []);
  const mcp = mcpEnv(true);
  try {
    const res = runHook({ session_id: "s-mcp1" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /ACTION REQUIRED/);
    // Prefix tracks the actual configured server key (fixture: gutt-mcp-remote).
    // If the grounding ever hardcoded mcp__gutt-pro-memory__ again, installs
    // using a different server key would hit "tool not found" on the directive.
    assert.match(ctx, /mcp__gutt-mcp-remote__register_agent/);
    assert.match(ctx, /mcp__gutt-mcp-remote__fetch_lessons_learned/);
    assert.match(ctx, /name="gutt-agent-demo-project"/);
    assert.match(ctx, /agent_id="gutt-agent-demo-project"/);
    // fetch_lessons_learned requires `query` (semantic search term);
    // omitting it triggers a 422 on the MCP server.
    assert.match(ctx, /query="[^"]+"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("MCP configured + existing marker ⇒ register_agent dropped, fetch_lessons_learned kept", () => {
  const dir = setupFixture("gutt-agent-already-registered", [], { registered: true });
  const mcp = mcpEnv(true);
  try {
    const res = runHook({ session_id: "s-mcp2" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /ACTION REQUIRED/);
    assert.match(ctx, /mcp__gutt-mcp-remote__fetch_lessons_learned/);
    assert.ok(
      !ctx.includes("register_agent"),
      "existing marker must suppress register_agent directive"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("MCP NOT configured ⇒ no ACTION REQUIRED block", () => {
  const dir = setupFixture("gutt-agent-nomcp", []);
  const mcp = mcpEnv(false);
  try {
    const res = runHook({ session_id: "s-mcp3" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes("ACTION REQUIRED"));
    assert.ok(!ctx.includes("register_agent"));
    // The base memory-usage section mentions the tool name `fetch_lessons_learned`
    // as naming-convention guidance, so that bare name will still appear. What
    // must NOT appear is the fully-qualified MCP call (mcp__gutt-pro-memory__…).
    assert.ok(!ctx.includes("mcp__gutt-pro-memory__"), "no MCP configured ⇒ no MCP call directive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("ACTION REQUIRED prefix tracks a non-default server name (regression: GP-626 retest)", () => {
  // A live retest surfaced that the user's install registers the gutt MCP
  // under `gutt-pro-memory-local` (their production name is `gutt-pro-memory`,
  // their local dev instance uses the -local suffix). Before this fix the
  // directive hardcoded mcp__gutt-pro-memory__, so the LLM's obedient tool
  // call hit "tool not found".
  const dir = setupFixture("gutt-agent-local-dev", []);
  const mcp = mcpEnv(true, { serverName: "gutt-pro-memory-local" });
  try {
    const res = runHook({ session_id: "s-local" }, { ...mcp.env, CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /mcp__gutt-pro-memory-local__register_agent/);
    assert.match(ctx, /mcp__gutt-pro-memory-local__fetch_lessons_learned/);
    assert.ok(
      !ctx.includes("mcp__gutt-pro-memory__"),
      "must not leak the canonical default prefix when a different server is configured"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("ACTION REQUIRED forwards CLAUDE_PLUGIN_OPTION_LESSON_TIME_RANGE to fetch_lessons_learned", () => {
  const dir = setupFixture("gutt-agent-range", []);
  const mcp = mcpEnv(true);
  try {
    const res = runHook(
      { session_id: "s-range" },
      {
        ...mcp.env,
        CLAUDE_PLUGIN_DATA: dir,
        CLAUDE_PLUGIN_OPTION_LESSON_TIME_RANGE: "7d",
      }
    );
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /time_range="7d"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});
