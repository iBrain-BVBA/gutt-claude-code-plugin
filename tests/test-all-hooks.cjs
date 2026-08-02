#!/usr/bin/env node
/**
 * Smoke test for every hook this marketplace ships.
 *
 * Usage: node tests/test-all-hooks.cjs
 *
 * The hook list is **derived from each plugin's hooks.json**, not hardcoded.
 * The previous version enumerated twelve hooks by hand, which made it the single
 * point that turned any hook rename or deletion into a red build, and let a hook
 * added to hooks.json ship with no smoke coverage at all. Discovery keeps the two
 * in sync by construction.
 *
 * Zero-dep and CommonJS on purpose: CI runs this on the oldest Node an end user
 * is likely to have (see the hook-runtime-compat job), where `npm ci` has not run.
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const projectDir = path.resolve(__dirname, "..");

/**
 * Plugins to scan. Missing entries are skipped rather than failed — plugins come
 * and go, and this file should not need editing when one does.
 */
const PLUGIN_DIRS = ["gutt-core"];

/**
 * Hooks are spawned with a throwaway CLAUDE_PLUGIN_DATA so their writes actually
 * land somewhere. Without it every state write silently no-ops and this suite
 * degrades to asserting "the process exits 0" — which is precisely what the
 * Node-18 compat job was doing before.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-hook-smoke-"));

const results = { passed: [], failed: [], warnings: [], skipped: [] };

/**
 * Representative stdin for each event. Anything not listed here still gets a
 * session_id, which is the one field every hook touches before its guard.
 */
function inputFor(event) {
  const sessionId = `test-session-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const transcript = path.join(dataDir, "transcript.jsonl");
  switch (event) {
    case "SessionStart":
      return { session_id: sessionId, source: "startup" };
    case "SessionEnd":
      return { session_id: sessionId, reason: "clear" };
    case "UserPromptSubmit":
      return { session_id: sessionId, prompt: "Implement an authentication system" };
    case "Stop":
    case "SubagentStop":
      return { session_id: sessionId, transcript_path: transcript, agent_type: "general-purpose" };
    case "PreToolUse":
      return {
        session_id: sessionId,
        tool_name: "Task",
        tool_input: { subagent_type: "general-purpose", prompt: "Design the auth system" },
      };
    case "PostToolUse":
      return {
        session_id: sessionId,
        tool_name: "Edit",
        tool_input: { file_path: path.join(dataDir, "nonexistent.py") },
        tool_response: "ok",
      };
    case "SubagentStart":
      return { session_id: sessionId, agent_type: "general-purpose", agent_id: "test-123" };
    case "statusLine":
      return {
        session_id: sessionId,
        model: { display_name: "claude-opus" },
        cost: { total_cost_usd: 0.05 },
      };
    default:
      return { session_id: sessionId };
  }
}

/**
 * Pull the script path out of a hook `command`. Entries look like
 * `node "${CLAUDE_PLUGIN_ROOT}/hooks/foo.cjs"`; the placeholder is resolved
 * against the plugin being scanned.
 * @returns {string|null} absolute path, or null when the command is not a
 *   plain node invocation we can locate
 */
function resolveScript(command, pluginRoot) {
  const match = /\$\{CLAUDE_PLUGIN_ROOT\}([^"']+)/.exec(String(command || ""));
  return match ? path.join(pluginRoot, match[1]) : null;
}

/** @returns {Array<{label: string, event: string, script: string}>} every command hook shipped */
function discoverHooks() {
  const found = [];
  for (const rel of PLUGIN_DIRS) {
    const pluginRoot = path.join(projectDir, rel);
    const manifestPath = path.join(pluginRoot, "hooks", "hooks.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      results.failed.push(`${rel}/hooks/hooks.json: unparseable (${err.message})`);
      continue;
    }

    const consider = (event, handler) => {
      // Prompt, agent, http and mcp_tool handlers have no script to spawn. They
      // are still real hooks; they are just not this suite's business.
      if (!handler || handler.type !== "command") {
        results.skipped.push(`${rel} ${event} (type: ${handler && handler.type})`);
        return;
      }
      const script = resolveScript(handler.command, pluginRoot);
      if (!script) {
        results.warnings.push(`${rel} ${event}: could not resolve script from command`);
        return;
      }
      if (!fs.existsSync(script)) {
        results.failed.push(`${rel} ${event}: ${path.relative(projectDir, script)} does not exist`);
        return;
      }
      found.push({ label: `${rel} · ${event} · ${path.basename(script)}`, event, script });
    };

    for (const [event, groups] of Object.entries(manifest.hooks || {})) {
      for (const group of groups || []) {
        for (const handler of group.hooks || []) {
          consider(event, handler);
        }
      }
    }
    if (manifest.statusLine) {
      consider("statusLine", manifest.statusLine);
    }
  }
  return found;
}

/**
 * Spawn one hook with JSON on stdin and record the outcome. A hook must exit 0
 * or 2 — 2 is the documented "block" signal and is legitimate for Stop.
 */
function runHook({ label, event, script }) {
  console.log(`\n🧪 ${label}`);
  const tempFile = path.join(dataDir, `input-${process.hrtime.bigint()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(inputFor(event)));
  try {
    const catCmd = os.platform() === "win32" ? "type" : "cat";
    const output = execSync(`${catCmd} "${tempFile}" | node "${script}"`, {
      encoding: "utf8",
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_DATA: dataDir,
      },
      shell: true,
      timeout: 10000,
    });
    results.passed.push(label);
    console.log(`   ✅ exit 0`);
    if (output && output.trim()) {
      console.log(`   Output: ${output.trim().slice(0, 100)}${output.length > 100 ? "…" : ""}`);
    }
    return true;
  } catch (err) {
    // Exit 2 is "block", a documented outcome rather than a crash.
    if (err.status === 2) {
      results.passed.push(label);
      console.log(`   ✅ exit 2 (block — documented)`);
      return true;
    }
    results.failed.push(`${label}: ${err.message}`);
    console.log(`   ❌ ${err.message}`);
    if (err.stderr) {
      console.log(`   Stderr: ${String(err.stderr).slice(0, 200)}`);
    }
    return false;
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      /* ignore */
    }
  }
}

console.log("═══════════════════════════════════════════════════════════");
console.log("🧪 Hook smoke tests (discovered from hooks.json)");
console.log("═══════════════════════════════════════════════════════════");
console.log(`Project dir: ${projectDir}`);
console.log(`Plugin data: ${dataDir}`);
console.log(`Node:        ${process.version}`);
console.log(`Platform:    ${os.platform()}`);

const hooks = discoverHooks();
console.log(`Discovered:  ${hooks.length} command hook(s)`);

// An empty run means discovery broke, not that everything passed. Without this
// a botched refactor of hooks.json would report a clean sweep of zero tests.
if (hooks.length === 0) {
  results.failed.push("no hooks discovered — hooks.json parsing or PLUGIN_DIRS is wrong");
}

for (const hook of hooks) {
  runHook(hook);
}

const totalTests = results.passed.length + results.failed.length;
console.log("\n═══════════════════════════════════════════════════════════");
console.log("📊 Test Results");
console.log("═══════════════════════════════════════════════════════════");
console.log(`\n✅ Passed: ${results.passed.length}/${totalTests}`);
console.log(`❌ Failed: ${results.failed.length}`);
console.log(`⚠️  Warnings: ${results.warnings.length}`);
console.log(`⏭️  Skipped (non-command): ${results.skipped.length}`);

if (results.failed.length > 0) {
  console.log("\n❌ Failed:");
  results.failed.forEach((f) => console.log(`   - ${f}`));
}
if (results.warnings.length > 0) {
  console.log("\n⚠️  Warnings:");
  results.warnings.forEach((w) => console.log(`   - ${w}`));
}
if (results.skipped.length > 0) {
  console.log("\n⏭️  Skipped:");
  results.skipped.forEach((s) => console.log(`   - ${s}`));
}

console.log("\n═══════════════════════════════════════════════════════════");

try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  /* best effort */
}

process.exit(results.failed.length > 0 ? 1 : 0);
