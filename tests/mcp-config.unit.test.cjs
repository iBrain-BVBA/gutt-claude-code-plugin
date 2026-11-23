#!/usr/bin/env node
/**
 * MCP Config Unit Tests
 * Tests for mcp-config.cjs utility functions.
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
  resolveUserConfig,
  extractUrlFromConfig,
  shadowWarning,
  normalizeUrl,
} = require("../gutt-core/hooks/lib/mcp-config.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CORE_ROOT = path.resolve(__dirname, "..", "gutt-core");

// ---------------------------------------------------------------------------
// Test runner (minimal hand-rolled harness, no framework)
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
// Plugin-shipped server: ${user_config.mcp_url} and ${VAR:-default}
// ---------------------------------------------------------------------------

console.log("\nplugin MCP server (userConfig):\n");

test("${VAR:-default} uses the env var when set", () => {
  process.env._TEST_DEFAULTED = "https://from-env.ai/mcp";
  assert.strictEqual(
    resolveEnvVars("${_TEST_DEFAULTED:-https://fallback/mcp}"),
    "https://from-env.ai/mcp"
  );
  delete process.env._TEST_DEFAULTED;
});

test("${VAR:-default} falls back to the default when unset", () => {
  assert.strictEqual(
    resolveEnvVars("${_TEST_UNSET_X:-https://fallback/mcp}"),
    "https://fallback/mcp"
  );
});

test("${user_config.mcp_url} prefers CLAUDE_PLUGIN_OPTION_MCP_URL", () => {
  process.env.CLAUDE_PLUGIN_OPTION_MCP_URL = "https://org.example/mcp";
  assert.strictEqual(
    resolveEnvVars("${user_config.mcp_url}", CORE_ROOT),
    "https://org.example/mcp"
  );
  delete process.env.CLAUDE_PLUGIN_OPTION_MCP_URL;
});

test("${user_config.mcp_url} falls back to the manifest default (stage)", () => {
  delete process.env.CLAUDE_PLUGIN_OPTION_MCP_URL;
  assert.strictEqual(
    resolveEnvVars("${user_config.mcp_url}", CORE_ROOT),
    "https://mcp.stage.gutt.pro/mcp"
  );
});

test("${user_config.*} with no plugin root and no env resolves to empty", () => {
  assert.strictEqual(resolveUserConfig("mcp_url", null), "");
  assert.strictEqual(resolveEnvVars("${user_config.mcp_url}", null), "");
});

test("unknown userConfig key resolves to empty", () => {
  assert.strictEqual(resolveUserConfig("no_such_key", CORE_ROOT), "");
});

test("shipped .mcp.json declares an http gutt server bound to userConfig.mcp_url", () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(CORE_ROOT, ".mcp.json"), "utf8"));
  const found = findGuttServerConfig(mcp.mcpServers);
  assert.ok(found, "no gutt server in gutt-core/.mcp.json");
  // Claude Code skips a remote entry that has a url but no type
  assert.strictEqual(found.config.type, "http");
  assert.strictEqual(found.config.url, "${user_config.mcp_url}");
});

test("every ${user_config.KEY} in .mcp.json is declared in plugin.json", () => {
  const raw = fs.readFileSync(path.join(CORE_ROOT, ".mcp.json"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(CORE_ROOT, ".claude-plugin", "plugin.json"), "utf8")
  );
  const keys = [...raw.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(manifest.userConfig && manifest.userConfig[key], `userConfig.${key} missing`);
    assert.ok(manifest.userConfig[key].default, `userConfig.${key} has no default`);
  }
});

test("no legacy gutt-core/mcp.json (Claude Code only loads the dotted name)", () => {
  assert.ok(!fs.existsSync(path.join(CORE_ROOT, "mcp.json")));
});

test("a substituted value is not rescanned for $NAME", () => {
  process.env.CLAUDE_PLUGIN_OPTION_MCP_URL = "https://org.example/$HOME/mcp";
  assert.strictEqual(
    resolveEnvVars("${user_config.mcp_url}", CORE_ROOT),
    "https://org.example/$HOME/mcp"
  );
  delete process.env.CLAUDE_PLUGIN_OPTION_MCP_URL;
});

// ---------------------------------------------------------------------------
// Upgrading users: `claude mcp add` registrations in ~/.claude.json
// ---------------------------------------------------------------------------

console.log("\n~/.claude.json registrations vs the plugin default:\n");

const STAGE = "https://mcp.stage.gutt.pro/mcp";
const ORG = "https://org.example/mcp";

/**
 * Run diagnoseGuttMcp() in a child whose HOME and project dir are a scratch layout and
 * whose plugin root is the real gutt-core (so the shipped .mcp.json and manifest default
 * are exercised), since env.cjs reads them once at load time.
 * @param {((project: string) => Object)|string|null} claudeJson - ~/.claude.json content
 *   (a string is written as is, to test unreadable files)
 * @param {{ pluginRoot?: null, option?: string, projectMcp?: Object, cursorMcp?: Object,
 *   cursor?: boolean }} [opts] - `pluginRoot: null` leaves CLAUDE_PLUGIN_ROOT unset, as in
 *   the Bash tool where /gutt-pro:health runs; `option` sets CLAUDE_PLUGIN_OPTION_MCP_URL
 */
function diagnoseIn(claudeJson, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-mcp-config-"));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  if (typeof claudeJson === "string") {
    fs.writeFileSync(path.join(home, ".claude.json"), claudeJson);
  } else if (claudeJson) {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify(claudeJson(project)));
  }
  if (opts.projectMcp) {
    fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify(opts.projectMcp));
  }
  if (opts.cursorMcp) {
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify(opts.cursorMcp));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project };
  for (const key of [
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PLUGIN_OPTION_MCP_URL",
    "CURSOR_PROJECT_DIR",
    "CURSOR_VERSION",
  ]) {
    delete env[key];
  }
  if (opts.pluginRoot !== null) {
    env.CLAUDE_PLUGIN_ROOT = CORE_ROOT;
  }
  if (opts.option) {
    env.CLAUDE_PLUGIN_OPTION_MCP_URL = opts.option;
  }
  if (opts.cursor) {
    env.CURSOR_PROJECT_DIR = project;
  }
  try {
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify(require(process.argv[1]).diagnoseGuttMcp()))",
        path.join(CORE_ROOT, "hooks", "lib", "mcp-config.cjs"),
      ],
      { env, cwd: project, encoding: "utf8" }
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("with no other registration the plugin's stage default is used, no warning", () => {
  const diag = diagnoseIn(null);
  assert.strictEqual(diag.url, STAGE);
  assert.strictEqual(diag.warning, null);
});

test("a user-scope registration (claude mcp add --scope user) wins over the plugin default", () => {
  const diag = diagnoseIn(() => ({
    mcpServers: { "gutt-mcp-remote": { type: "http", url: ORG } },
  }));
  assert.strictEqual(diag.url, ORG);
  assert.match(diag.warning, /claude mcp remove gutt-mcp-remote --scope user/);
  assert.ok(diag.warning.includes(STAGE), "the warning should name the plugin's endpoint");
});

test("a local-scope registration for this project wins over user scope", () => {
  const diag = diagnoseIn((project) => ({
    mcpServers: { "gutt-mcp-remote": { type: "http", url: "https://user.example/mcp" } },
    projects: { [project]: { mcpServers: { "gutt-mcp-remote": { type: "http", url: ORG } } } },
  }));
  assert.strictEqual(diag.url, ORG);
  assert.match(diag.warning, /--scope local/);
});

test("a local-scope registration for another project is ignored", () => {
  const diag = diagnoseIn(() => ({
    projects: { "/somewhere/else": { mcpServers: { "gutt-mcp-remote": { url: ORG } } } },
  }));
  assert.strictEqual(diag.url, STAGE);
});

test("a user-scope registration at the plugin's own URL raises no warning", () => {
  const diag = diagnoseIn(() => ({
    mcpServers: { "gutt-mcp-remote": { type: "http", url: STAGE } },
  }));
  assert.strictEqual(diag.url, STAGE);
  assert.strictEqual(diag.warning, null);
});

test("without CLAUDE_PLUGIN_ROOT (health's Bash context) the plugin default is still found", () => {
  const diag = diagnoseIn(null, { pluginRoot: null });
  assert.strictEqual(diag.url, STAGE);
  assert.strictEqual(diag.source, "plugin-default");
  assert.strictEqual(diag.error, null);
});

test("without CLAUDE_PLUGIN_ROOT a user-scope registration still raises the warning", () => {
  const diag = diagnoseIn(
    () => ({ mcpServers: { "gutt-mcp-remote": { type: "http", url: ORG } } }),
    { pluginRoot: null }
  );
  assert.strictEqual(diag.url, ORG);
  assert.match(diag.warning, /--scope user/);
});

test("project .mcp.json wins over user scope (Claude Code: local, project, user)", () => {
  const diag = diagnoseIn(
    () => ({
      mcpServers: { "gutt-mcp-remote": { type: "http", url: "https://user.example/mcp" } },
    }),
    { projectMcp: { mcpServers: { "gutt-mcp-remote": { type: "http", url: ORG } } } }
  );
  assert.strictEqual(diag.url, ORG);
  assert.match(diag.warning, /remove it from .*\.mcp\.json/);
  assert.ok(!/--scope user/.test(diag.warning), "the overridden user entry does not run");
});

test("the mcp_url option is the plugin's URL, with no warning", () => {
  const diag = diagnoseIn(null, { option: ORG });
  assert.strictEqual(diag.url, ORG);
  assert.strictEqual(diag.source, "plugin-option");
  assert.strictEqual(diag.warning, null);
});

test("a leftover user-scope entry at the option's URL raises no warning", () => {
  const diag = diagnoseIn(
    () => ({ mcpServers: { "gutt-mcp-remote": { type: "http", url: ORG } } }),
    { option: ORG }
  );
  assert.strictEqual(diag.warning, null);
});

test("a trailing slash or host case difference is the same endpoint", () => {
  const diag = diagnoseIn(() => ({
    mcpServers: { "gutt-mcp-remote": { type: "http", url: "https://MCP.stage.gutt.pro/mcp/" } },
  }));
  assert.strictEqual(diag.warning, null);
});

test("a local entry at the plugin URL does not hide a differently named user entry", () => {
  const diag = diagnoseIn((project) => ({
    mcpServers: { "gutt-pro-memory": { type: "http", url: ORG } },
    projects: { [project]: { mcpServers: { "gutt-mcp-remote": { type: "http", url: STAGE } } } },
  }));
  assert.match(diag.warning, /claude mcp remove gutt-pro-memory --scope user/);
});

test("an unreadable ~/.claude.json falls back to the plugin default and says so", () => {
  const diag = diagnoseIn("{bad");
  assert.strictEqual(diag.url, STAGE);
  assert.strictEqual(diag.error, null);
  assert.match(diag.warning, /could not read .*\.claude\.json/);
});

test("odd ~/.claude.json shapes (no project servers, null mcpServers) are not errors", () => {
  const diag = diagnoseIn((project) => ({ projects: { [project]: {} }, mcpServers: null }));
  assert.strictEqual(diag.url, STAGE);
  assert.strictEqual(diag.error, null);
  assert.strictEqual(diag.warning, null);
});

test("under Claude Code, ~/.cursor/mcp.json is ignored", () => {
  const diag = diagnoseIn(null, {
    cursorMcp: { mcpServers: { "gutt-mcp-remote": { url: ORG } } },
  });
  assert.strictEqual(diag.url, STAGE);
  assert.strictEqual(diag.warning, null);
});

test("under Cursor, ~/.claude.json is ignored and ~/.cursor/mcp.json is used", () => {
  const diag = diagnoseIn(
    () => ({
      mcpServers: { "gutt-mcp-remote": { type: "http", url: "https://user.example/mcp" } },
    }),
    {
      cursor: true,
      pluginRoot: null,
      cursorMcp: { mcpServers: { "gutt-mcp-remote": { url: ORG } } },
    }
  );
  assert.strictEqual(diag.url, ORG);
  assert.strictEqual(diag.warning, null);
});

test("normalizeUrl ignores host case and a trailing slash", () => {
  assert.strictEqual(
    normalizeUrl("https://MCP.Example/mcp/"),
    normalizeUrl("https://mcp.example/mcp")
  );
  assert.notStrictEqual(
    normalizeUrl("https://a.example/mcp"),
    normalizeUrl("https://b.example/mcp")
  );
});

test("shadowWarning points at the file when the scope has no remove command", () => {
  const warning = shadowWarning(
    { url: ORG, name: "gutt-mcp-remote", source: "/p/.mcp.json", scope: "project" },
    STAGE
  );
  assert.match(warning, /remove it from \/p\/\.mcp\.json/);
  assert.strictEqual(
    shadowWarning({ url: STAGE, name: null, source: "plugin", scope: "plugin" }, STAGE),
    null
  );
  assert.strictEqual(
    shadowWarning({ url: ORG, name: "g", source: "x", scope: "user" }, null),
    null
  );
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
