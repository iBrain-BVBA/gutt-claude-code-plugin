#!/usr/bin/env node
/**
 * SubagentStart hook — integration tests.
 *
 * Spawns the hook as a child process with SubagentStart payloads for
 * each of the three dispatch branches (memory-keeper, gutt-pro-memory,
 * default) plus defensive cases (empty agent_type, missing identity,
 * malformed stdin) and the ACTION REQUIRED register_agent branch.
 *
 * The hook no longer makes any MCP network calls — registration is
 * handled by the LLM, recorded by the post-lesson-scrape PostToolUse
 * hook. So these tests only verify the emitted additionalContext block.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "..", "hooks", "subagent-start-binding.cjs");

function runHook(payload, env) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

function setupIdentity(agentId, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-start-"));
  const subdir = path.join(dir, "agent-intelligence");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(
    path.join(subdir, "agent-identity.json"),
    JSON.stringify({ agentId, resolvedAt: Date.now() })
  );
  if (Array.isArray(options.markers)) {
    for (const name of options.markers) {
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      fs.writeFileSync(path.join(subdir, `.registered-${safe}.marker`), String(Date.now()));
    }
  }
  return dir;
}

/**
 * Build a project dir containing an .mcp.json that points isGuttMcpConfigured()
 * at a real (but unused) URL, plus a pinned empty HOME so the dev machine's
 * actual ~/.claude state cannot influence the result.
 */
function setupMcpConfiguredEnv() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-proj-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-home-"));
  fs.writeFileSync(
    path.join(projectDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "gutt-mcp-remote": { url: "http://example.invalid" } } })
  );
  return {
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
      CURSOR_PROJECT_DIR: projectDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

test("memory-keeper gets proxy-capture instructions with parent agent_id", () => {
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "keeper-inst", agent_type: "memory-keeper" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SubagentStart");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /memory-keeper/);
    assert.match(ctx, /gutt-agent-demo-project/);
    assert.match(ctx, /Lessons bind to the learner/);
    assert.ok(!ctx.includes("ACTION REQUIRED"), "memory-keeper must not self-register");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gutt-pro-memory gets optional-filter instructions", () => {
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "search-inst", agent_type: "gutt-pro-memory" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /gutt-pro-memory/);
    assert.match(ctx, /OPTIONAL/);
    assert.match(ctx, /gutt-agent-demo-project/);
    assert.ok(!ctx.includes("ACTION REQUIRED"), "gutt-pro-memory must not self-register");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker subagent (e.g. plugin-dev) gets self-scoped instructions", () => {
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "dev-inst", agent_type: "plugin-dev" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /plugin-dev/);
    assert.match(ctx, /agent_id="plugin-dev"/);
    assert.ok(!ctx.includes("gutt-agent-demo-project"), "default branch must not leak parent id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different worker subagent (bug-investigator) also gets self-scoped", () => {
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "bug-inst", agent_type: "bug-investigator" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /bug-investigator/);
    assert.match(ctx, /agent_id="bug-investigator"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty agent_type results in silent exit", () => {
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "x", agent_type: "" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing agent-identity.json results in silent exit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-start-noid-"));
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "x", agent_type: "plugin-dev" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed stdin does not crash", () => {
  const dir = setupIdentity("gutt-agent-demo");
  try {
    const res = spawnSync("node", [HOOK], {
      input: "{not json",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" },
      timeout: 5000,
    });
    assert.equal(res.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ACTION REQUIRED: register_agent — gated on MCP-configured AND no marker.
// Proxy agents NEVER see the directive regardless of marker state.
// ---------------------------------------------------------------------------

test("worker subagent without registration marker AND MCP configured sees ACTION REQUIRED: register_agent", () => {
  const mcp = setupMcpConfiguredEnv();
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "x", agent_type: "plugin-dev" },
      { ...mcp.env, CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /ACTION REQUIRED/);
    // Prefix tracks the actual configured server key (fixture: gutt-mcp-remote);
    // a hardcoded mcp__gutt-pro-memory__ prefix would misname the tool on
    // installations that use a different server key (e.g. gutt-pro-memory-local).
    assert.match(ctx, /mcp__gutt-mcp-remote__register_agent/);
    assert.match(ctx, /name="plugin-dev"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("worker subagent with existing registration marker skips ACTION REQUIRED", () => {
  const mcp = setupMcpConfiguredEnv();
  const dir = setupIdentity("gutt-agent-demo-project", { markers: ["plugin-dev"] });
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "x", agent_type: "plugin-dev" },
      { ...mcp.env, CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes("ACTION REQUIRED"), "marker presence must suppress register directive");
    assert.ok(!ctx.includes("register_agent"), "marker presence must suppress register directive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("worker subagent without MCP configured sees no ACTION REQUIRED", () => {
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    // Pin HOME to an empty tmpdir so isGuttMcpConfigured returns false
    // even when the dev machine has a gutt plugin installed.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-nohome-"));
    try {
      const res = runHook(
        { session_id: "s1", agent_id: "x", agent_type: "plugin-dev" },
        {
          CLAUDE_PLUGIN_DATA: dir,
          HOME: homeDir,
          USERPROFILE: homeDir,
          CLAUDE_PROJECT_DIR: homeDir,
          CURSOR_PROJECT_DIR: homeDir,
          GUTT_MCP_URL: "",
        }
      );
      assert.equal(res.status, 0);
      const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
      assert.ok(!ctx.includes("ACTION REQUIRED"), "no MCP ⇒ no directive");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PROXY_AGENTS never see ACTION REQUIRED even when MCP configured and no marker", () => {
  const mcp = setupMcpConfiguredEnv();
  const dir = setupIdentity("gutt-agent-demo-project");
  try {
    for (const proxy of ["memory-keeper", "gutt-pro-memory", "config-discovery"]) {
      const res = runHook(
        { session_id: `s-${proxy}`, agent_id: "x", agent_type: proxy },
        { ...mcp.env, CLAUDE_PLUGIN_DATA: dir }
      );
      assert.equal(res.status, 0, `${proxy} status: ${res.stderr}`);
      const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
      assert.ok(!ctx.includes("ACTION REQUIRED"), `${proxy} must never be nudged to self-register`);
      assert.ok(!ctx.includes("register_agent"), `${proxy} must never mention register_agent`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    mcp.cleanup();
  }
});

test("output contains sentinel markers so the subagent can recognize the block", () => {
  const dir = setupIdentity("gutt-agent-demo");
  try {
    const res = runHook(
      { session_id: "s1", agent_id: "x", agent_type: "plugin-dev" },
      { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" }
    );
    const parsed = JSON.parse(res.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /^\[GUTT Agent Binding/);
    assert.match(ctx, /\[End GUTT Agent Binding\]$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
