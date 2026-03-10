#!/usr/bin/env node
/**
 * Integration test: user-prompt-submit.cjs routing pipeline
 * Tests all decision types without a live MCP server.
 * GUTT_MCP_URL is left unset so agent-discovery falls back to seed registry (score 0.5).
 * We use a fake settings file to pass the isGuttMcpConfigured() guard.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const SETTINGS_DIR = path.join(PLUGIN_ROOT, ".claude");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

// ---------------------------------------------------------------------------
// Setup: inject fake gutt-mcp-remote config so the guard passes
// ---------------------------------------------------------------------------
let originalSettings = null;
try {
  originalSettings = fs.readFileSync(SETTINGS_PATH, "utf8");
} catch {
  // File didn't exist
}

if (!fs.existsSync(SETTINGS_DIR)) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}
// Merge gutt-mcp-remote into existing settings (if any)
let settings = {};
try {
  settings = JSON.parse(originalSettings || "{}");
} catch {
  /* ignore parse errors in test setup */
}
settings.mcpServers = settings.mcpServers || {};
settings.mcpServers["gutt-mcp-remote"] = { url: "http://fake-for-test" };
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function runHook(payload) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: PLUGIN_ROOT,
    // No GUTT_MCP_URL → agent-discovery uses seed registry fallback (all score 0.5)
  };
  delete env.GUTT_MCP_URL;

  return execSync(`node "${path.join(PLUGIN_ROOT, "hooks", "user-prompt-submit.cjs")}"`, {
    input: JSON.stringify(payload),
    env,
    timeout: 8000,
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const tests = [
  {
    // "branch" removed from devops keywords (T6 fix) — git rebase correctly passthroughs
    label: "passthrough: git rebase (no domain signals)",
    prompt: "How do I rebase this branch onto main?",
    expectEmpty: true,
  },
  {
    // "typescript" triggers frontend domain signal — routes to fe-developer, not passthrough
    label: "routing: TypeScript error (frontend domain signal)",
    prompt: "Fix the TypeScript error on line 42",
    expectContains: "GUTT ROUTING",
  },
  {
    label: "passthrough: empty prompt",
    prompt: "",
    expectEmpty: true,
  },
  {
    label: "routing: finance domain signal",
    prompt: "What is our current runway and burn rate?",
    expectContains: "GUTT ROUTING",
  },
  {
    label: "routing: POAB entity reference",
    prompt: "Prep for the POAB meeting with Erwin tomorrow",
    expectContains: "GUTT ROUTING",
  },
  {
    label: "routing: investor domain",
    prompt: "Help me prepare the investor pitch deck for the board",
    expectContains: "GUTT ROUTING",
  },
  {
    label: "routing: sales domain",
    prompt: "What deals are in our pipeline this quarter?",
    expectContains: "GUTT ROUTING",
  },
];

// ---------------------------------------------------------------------------
// Run and report
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

for (const t of tests) {
  try {
    const out = runHook({ prompt: t.prompt });
    const trimmed = out.trim();

    if (t.expectEmpty) {
      if (trimmed === "") {
        console.log(`  PASS  ${t.label}`);
        passed++;
      } else {
        console.log(`  FAIL  ${t.label}`);
        console.log(`        Expected empty output, got: ${trimmed.substring(0, 80)}`);
        failed++;
      }
    } else if (t.expectContains) {
      if (trimmed.includes(t.expectContains)) {
        const firstLine = trimmed.split("\n")[0];
        console.log(`  PASS  ${t.label}`);
        console.log(`        ${firstLine}`);
        passed++;
      } else {
        console.log(`  FAIL  ${t.label}`);
        console.log(`        Expected "${t.expectContains}", got: ${trimmed.substring(0, 120)}`);
        failed++;
      }
    }
  } catch (err) {
    console.log(`  FAIL  ${t.label}`);
    console.log(`        ${err.message.split("\n")[0]}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Restore original settings
// ---------------------------------------------------------------------------
if (originalSettings !== null) {
  fs.writeFileSync(SETTINGS_PATH, originalSettings);
} else {
  // We created the file — remove the key we added, or delete if now empty
  try {
    const restored = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    delete restored.mcpServers["gutt-mcp-remote"];
    if (Object.keys(restored.mcpServers).length === 0) {
      delete restored.mcpServers;
    }
    if (Object.keys(restored).length === 0) {
      fs.unlinkSync(SETTINGS_PATH);
    } else {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(restored, null, 2));
    }
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
