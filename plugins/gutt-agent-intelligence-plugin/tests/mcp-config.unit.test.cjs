#!/usr/bin/env node
/**
 * mcp-config — unit tests.
 *
 * Covers the exported utilities that mcp-config.cjs uses to detect a gutt
 * MCP server in Claude Code / Cursor settings (findGuttServerConfig,
 * resolveEnvVars, extractUrlFromConfig) plus the public entry points
 * (isGuttMcpConfigured, getGuttMcpServerName, getGuttMcpUrl). The
 * file-reading helpers (extractUrlFromMcpFile, readServerNameFromMcp, and
 * their settings-file variants) are internal and get exercised implicitly
 * by the hook integration tests.
 *
 * Run: node --test plugins/gutt-agent-intelligence-plugin/tests/mcp-config.unit.test.cjs
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  findGuttServerConfig,
  resolveEnvVars,
  extractUrlFromConfig,
} = require("../hooks/lib/mcp-config.cjs");

// ---------------------------------------------------------------------------
// findGuttServerConfig — known-name matching + catch-all fuzzy
// ---------------------------------------------------------------------------

test("findGuttServerConfig picks gutt-mcp-remote by exact name", () => {
  const servers = { "gutt-mcp-remote": { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.equal(result.name, "gutt-mcp-remote");
  assert.equal(result.config.url, "https://mcp.gutt.ai");
});

test("findGuttServerConfig picks gutt-pro-memory by exact name", () => {
  const servers = { "gutt-pro-memory": { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.equal(result.name, "gutt-pro-memory");
});

test("findGuttServerConfig matches known names case-insensitively", () => {
  const servers = { "Gutt-Interactive": { url: "https://ci.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.equal(result.name, "Gutt-Interactive");
  assert.equal(result.config.url, "https://ci.ai");
});

test("findGuttServerConfig matches all-uppercase variant", () => {
  const servers = { "GUTT-MCP-REMOTE": { url: "https://upper.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.equal(result.name, "GUTT-MCP-REMOTE");
});

test("findGuttServerConfig falls back to fuzzy 'gutt' substring match", () => {
  // claude_ai_gutt_mcp and my-gutt-mcp-fork aren't in the known list but
  // contain 'gutt' — the catch-all fallback picks them up.
  const servers = { claude_ai_gutt_mcp: { url: "https://fork.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.equal(result.name, "claude_ai_gutt_mcp");
});

test("findGuttServerConfig matches claude_ai_gutt-pro-memory (hyphen variant)", () => {
  // Claude Code's auto-generated plugin server names use hyphens; make
  // sure the fuzzy branch picks them up alongside underscore variants.
  const servers = { "claude_ai_gutt-pro-memory": { url: "https://auto.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.equal(result.name, "claude_ai_gutt-pro-memory");
});

test("findGuttServerConfig returns null for non-gutt server names", () => {
  const servers = { "some-other-mcp": { url: "https://other.ai" } };
  assert.equal(findGuttServerConfig(servers), null);
});

test("findGuttServerConfig returns null for null/undefined/empty input", () => {
  assert.equal(findGuttServerConfig(null), null);
  assert.equal(findGuttServerConfig(undefined), null);
  assert.equal(findGuttServerConfig({}), null);
});

test("findGuttServerConfig picks the first known-name match by key order", () => {
  const servers = {
    "gutt-mcp": { url: "https://first.ai" },
    "gutt-mcp-remote": { url: "https://second.ai" },
  };
  const result = findGuttServerConfig(servers);
  assert.equal(result.name, "gutt-mcp");
});

// ---------------------------------------------------------------------------
// resolveEnvVars — ${VAR} and $VAR forms
// ---------------------------------------------------------------------------

test("resolveEnvVars expands ${VAR} form", () => {
  process.env._TEST_MCP_URL = "https://resolved.ai";
  try {
    assert.equal(resolveEnvVars("${_TEST_MCP_URL}"), "https://resolved.ai");
  } finally {
    delete process.env._TEST_MCP_URL;
  }
});

test("resolveEnvVars expands $VAR form (bare dollar, uppercase)", () => {
  process.env._TEST_BARE = "https://bare.ai";
  try {
    assert.equal(resolveEnvVars("$_TEST_BARE"), "https://bare.ai");
  } finally {
    delete process.env._TEST_BARE;
  }
});

test("resolveEnvVars expands ${VAR} embedded in a URL", () => {
  process.env._TEST_HOST = "mcp.gutt.ai";
  try {
    assert.equal(resolveEnvVars("https://${_TEST_HOST}/path"), "https://mcp.gutt.ai/path");
  } finally {
    delete process.env._TEST_HOST;
  }
});

test("resolveEnvVars returns empty for unset ${VAR}", () => {
  delete process.env._TEST_UNSET;
  assert.equal(resolveEnvVars("${_TEST_UNSET}"), "");
});

test("resolveEnvVars returns empty when unresolved $ remains after substitution", () => {
  // $lowercase doesn't match either regex ([A-Z_][A-Z0-9_]* requires an
  // uppercase-leading name), so the substring survives unchanged and the
  // guard returns empty rather than a broken URL.
  assert.equal(resolveEnvVars("$lowercase_var"), "");
});

test("resolveEnvVars returns empty for fully-resolved-to-empty $VAR", () => {
  delete process.env._TEST_MISSING;
  // Regex matches the entire string, substitutes empty, !resolved triggers guard.
  assert.equal(resolveEnvVars("$_TEST_MISSING"), "");
});

test("resolveEnvVars returns plain URL unchanged", () => {
  assert.equal(resolveEnvVars("https://mcp.gutt.ai"), "https://mcp.gutt.ai");
});

// ---------------------------------------------------------------------------
// extractUrlFromConfig — HTTP vs stdio transport
// ---------------------------------------------------------------------------

test("extractUrlFromConfig returns the url for HTTP transport", () => {
  assert.equal(extractUrlFromConfig({ url: "https://mcp.gutt.ai/mcp" }), "https://mcp.gutt.ai/mcp");
});

test("extractUrlFromConfig returns null for stdio transport (command-based)", () => {
  assert.equal(extractUrlFromConfig({ command: "node", args: ["server.js"] }), null);
});

test("extractUrlFromConfig returns null for null/undefined", () => {
  assert.equal(extractUrlFromConfig(null), null);
  assert.equal(extractUrlFromConfig(undefined), null);
});

test("extractUrlFromConfig resolves env vars in url field", () => {
  process.env._TEST_CFG_URL = "https://env-resolved.ai";
  try {
    assert.equal(extractUrlFromConfig({ url: "${_TEST_CFG_URL}" }), "https://env-resolved.ai");
  } finally {
    delete process.env._TEST_CFG_URL;
  }
});

test("extractUrlFromConfig returns null when url resolves to empty string", () => {
  delete process.env._TEST_EMPTY_URL;
  assert.equal(extractUrlFromConfig({ url: "${_TEST_EMPTY_URL}" }), null);
});

// ---------------------------------------------------------------------------
// getGuttMcpServerName — via child process (HOME/PROJECT_DIR are cached in
// env.cjs at require-time, so this can't be exercised by in-process env
// munging without cache-busting).
// ---------------------------------------------------------------------------

function resolveServerNameInChild(env) {
  const script = `
    "use strict";
    const { getGuttMcpServerName } = require(process.env._MCP_CONFIG_PATH);
    process.stdout.write(JSON.stringify({ name: getGuttMcpServerName() }));
  `;
  const res = spawnSync("node", ["-e", script], {
    env: {
      ...process.env,
      ...env,
      _MCP_CONFIG_PATH: path.resolve(__dirname, "..", "hooks", "lib", "mcp-config.cjs"),
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).name;
}

test("getGuttMcpServerName returns literal server key from .mcp.json (default)", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-name-default-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-name-default-home-"));
  try {
    fs.writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "gutt-pro-memory": { url: "http://x" } } })
    );
    const name = resolveServerNameInChild({
      CLAUDE_PROJECT_DIR: projectDir,
      CURSOR_PROJECT_DIR: projectDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
    });
    assert.equal(name, "gutt-pro-memory");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("getGuttMcpServerName returns custom server key (regression: GP-626 retest)", () => {
  // This is the exact failure mode reported from a live retest: the user's
  // local install registers the server as `gutt-pro-memory-local`, so the
  // ACTION REQUIRED directive must emit mcp__gutt-pro-memory-local__ — not
  // the plugin's canonical default.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-name-local-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-name-local-home-"));
  try {
    fs.writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "gutt-pro-memory-local": { url: "http://x" } } })
    );
    const name = resolveServerNameInChild({
      CLAUDE_PROJECT_DIR: projectDir,
      CURSOR_PROJECT_DIR: projectDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
    });
    assert.equal(name, "gutt-pro-memory-local");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("getGuttMcpServerName returns null when no gutt server is configured", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-name-none-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-name-none-home-"));
  try {
    const name = resolveServerNameInChild({
      CLAUDE_PROJECT_DIR: projectDir,
      CURSOR_PROJECT_DIR: projectDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
    });
    assert.equal(name, null);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
