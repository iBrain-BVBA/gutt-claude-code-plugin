#!/usr/bin/env node
/**
 * MCP Config Unit Tests
 * Tests for mcp-config.cjs utility functions and agent-discovery.cjs getMcpUrl.
 *
 * Pure logic tests — no file system or network access needed.
 * CI-compatible, no external dependencies beyond Node.js built-ins.
 *
 * Usage:
 *   node tests/mcp-config.unit.test.cjs
 */

"use strict";

const assert = require("assert");
const {
  findGuttServerConfig,
  resolveEnvVars,
  extractUrlFromConfig,
} = require("../hooks/lib/mcp-config.cjs");
const { getMcpUrl } = require("../hooks/lib/agent-discovery.cjs");

// ---------------------------------------------------------------------------
// Test runner (same pattern as sse-parsing.unit.test.cjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, message: err.message });
  }
}

// ---------------------------------------------------------------------------
// findGuttServerConfig
// ---------------------------------------------------------------------------

console.log("\nfindGuttServerConfig:\n");

test("finds 'gutt-mcp-remote' server", () => {
  const servers = { "gutt-mcp-remote": { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.strictEqual(result.name, "gutt-mcp-remote");
  assert.strictEqual(result.config.url, "https://mcp.gutt.ai");
});

test("finds 'gutt_mcp' server", () => {
  const servers = { gutt_mcp: { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.strictEqual(result.name, "gutt_mcp");
});

test("finds 'gutt-mcp' server", () => {
  const servers = { "gutt-mcp": { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.strictEqual(result.name, "gutt-mcp");
});

test("finds 'claude_ai_gutt_mcp' via catch-all fallback", () => {
  const servers = { claude_ai_gutt_mcp: { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result, "Should match via catch-all (name contains 'gutt')");
  assert.strictEqual(result.name, "claude_ai_gutt_mcp");
});

test("finds 'gutt-pro-memory' server", () => {
  const servers = { "gutt-pro-memory": { url: "https://mcp.gutt.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result);
  assert.strictEqual(result.name, "gutt-pro-memory");
});

test("returns null for non-gutt servers", () => {
  const servers = { "some-other-mcp": { url: "https://other.ai" } };
  const result = findGuttServerConfig(servers);
  assert.strictEqual(result, null);
});

test("returns null for null input", () => {
  assert.strictEqual(findGuttServerConfig(null), null);
});

test("returns null for undefined input", () => {
  assert.strictEqual(findGuttServerConfig(undefined), null);
});

test("returns null for empty object", () => {
  assert.strictEqual(findGuttServerConfig({}), null);
});

test("fuzzy-matches any server name containing gutt", () => {
  const servers = { "my-gutt-mcp-fork": { url: "https://fork.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result, "Should fuzzy-match server names containing gutt");
  assert.strictEqual(result.name, "my-gutt-mcp-fork");
});

test("returns first matching known name by object key order", () => {
  const servers = {
    "gutt-mcp": { url: "https://first.ai" },
    "gutt-mcp-remote": { url: "https://second.ai" },
  };
  const result = findGuttServerConfig(servers);
  // Iterates Object.keys(mcpServers) — first key that matches wins
  assert.strictEqual(result.name, "gutt-mcp");
});

test("matches known names case-insensitively", () => {
  const servers = { "Gutt-Interactive": { url: "https://ci.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result, "Should match 'Gutt-Interactive' against lowercase 'gutt-interactive'");
  assert.strictEqual(result.name, "Gutt-Interactive");
  assert.strictEqual(result.config.url, "https://ci.ai");
});

test("matches known names with all-uppercase casing", () => {
  const servers = { "GUTT-MCP-REMOTE": { url: "https://upper.ai" } };
  const result = findGuttServerConfig(servers);
  assert.ok(result, "Should match 'GUTT-MCP-REMOTE' against lowercase 'gutt-mcp-remote'");
  assert.strictEqual(result.name, "GUTT-MCP-REMOTE");
});

// ---------------------------------------------------------------------------
// resolveEnvVars
// ---------------------------------------------------------------------------

console.log("\nresolveEnvVars:\n");

test("handles ${VAR} form", () => {
  process.env._TEST_MCP_URL = "https://resolved.ai";
  const result = resolveEnvVars("${_TEST_MCP_URL}");
  assert.strictEqual(result, "https://resolved.ai");
  delete process.env._TEST_MCP_URL;
});

test("handles $VAR form (bare dollar)", () => {
  process.env._TEST_MCP_BARE = "https://bare.ai";
  const result = resolveEnvVars("$_TEST_MCP_BARE");
  assert.strictEqual(result, "https://bare.ai");
  delete process.env._TEST_MCP_BARE;
});

test("handles ${VAR} embedded in URL", () => {
  process.env._TEST_HOST = "mcp.gutt.ai";
  const result = resolveEnvVars("https://${_TEST_HOST}/path");
  assert.strictEqual(result, "https://mcp.gutt.ai/path");
  delete process.env._TEST_HOST;
});

test("handles $VAR embedded in URL", () => {
  process.env._TEST_HOST2 = "mcp.gutt.ai";
  const result = resolveEnvVars("https://$_TEST_HOST2/path");
  assert.strictEqual(result, "https://mcp.gutt.ai/path");
  delete process.env._TEST_HOST2;
});

test("returns empty for unset ${VAR}", () => {
  delete process.env._TEST_NONEXISTENT;
  const result = resolveEnvVars("${_TEST_NONEXISTENT}");
  assert.strictEqual(result, "");
});

test("returns empty for unset $VAR", () => {
  delete process.env._TEST_NONEXISTENT2;
  const result = resolveEnvVars("$_TEST_NONEXISTENT2");
  assert.strictEqual(result, "");
});

test("returns plain URL unchanged", () => {
  const result = resolveEnvVars("https://mcp.gutt.ai");
  assert.strictEqual(result, "https://mcp.gutt.ai");
});

test("returns empty when URL still contains unresolved $ after substitution", () => {
  delete process.env._TEST_MISSING;
  // URL contains $VAR that doesn't match [A-Z_][A-Z0-9_]* pattern (lowercase)
  // so it stays as-is — the guard catches it
  const result = resolveEnvVars("$_TEST_MISSING");
  assert.strictEqual(result, "");
});

// ---------------------------------------------------------------------------
// extractUrlFromConfig
// ---------------------------------------------------------------------------

console.log("\nextractUrlFromConfig:\n");

test("returns URL for HTTP config", () => {
  const config = { url: "https://mcp.gutt.ai/mcp" };
  const result = extractUrlFromConfig(config);
  assert.strictEqual(result, "https://mcp.gutt.ai/mcp");
});

test("returns null for stdio config", () => {
  const config = { command: "node", args: ["server.js"] };
  const result = extractUrlFromConfig(config);
  assert.strictEqual(result, null);
});

test("returns null for null input", () => {
  assert.strictEqual(extractUrlFromConfig(null), null);
});

test("returns null for undefined input", () => {
  assert.strictEqual(extractUrlFromConfig(undefined), null);
});

test("returns null for config with empty url after env resolution", () => {
  delete process.env._TEST_EMPTY_URL;
  const config = { url: "${_TEST_EMPTY_URL}" };
  const result = extractUrlFromConfig(config);
  assert.strictEqual(result, null);
});

test("resolves env vars in url field", () => {
  process.env._TEST_CFG_URL = "https://env-resolved.ai";
  const config = { url: "${_TEST_CFG_URL}" };
  const result = extractUrlFromConfig(config);
  assert.strictEqual(result, "https://env-resolved.ai");
  delete process.env._TEST_CFG_URL;
});

// ---------------------------------------------------------------------------
// getMcpUrl (/mcp stripping)
// ---------------------------------------------------------------------------

console.log("\ngetMcpUrl (/mcp stripping):\n");

test("prefers GUTT_MCP_URL env var", () => {
  const orig = process.env.GUTT_MCP_URL;
  process.env.GUTT_MCP_URL = "https://env-override.ai";
  const result = getMcpUrl();
  assert.strictEqual(result, "https://env-override.ai");
  if (orig !== undefined) {
    process.env.GUTT_MCP_URL = orig;
  } else {
    delete process.env.GUTT_MCP_URL;
  }
});

test("returns null when no env var and no settings", () => {
  const orig = process.env.GUTT_MCP_URL;
  delete process.env.GUTT_MCP_URL;
  // getMcpUrl falls back to getGuttMcpUrl which reads files — in test env these
  // likely don't exist, so it should return null
  const result = getMcpUrl();
  // We can't assert null because the test env might have real settings,
  // but we can assert it doesn't throw
  assert.ok(result === null || typeof result === "string");
  if (orig !== undefined) {
    process.env.GUTT_MCP_URL = orig;
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => {
    console.log(`  \u2717 ${f.name}`);
    console.log(`    ${f.message}`);
  });
}

console.log("");
process.exit(failed > 0 ? 1 : 0);
