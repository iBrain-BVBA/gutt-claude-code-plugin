#!/usr/bin/env node
/**
 * E2E Test: stop-lessons.cjs — block-once lesson capture
 *
 * Tests the simplified stop hook: blocks first stop, allows subsequent stops.
 *
 * Usage: node tests/stop-plan-feedback.e2e.test.cjs
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

let failures = 0;

function fail(msg) {
  console.log(`  ✗ ${msg}`);
  failures++;
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

console.log("=== E2E Test: stop-lessons.cjs block-once ===\n");

// Helper: Create temp directory with mock Claude setup
function createTempEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-test-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");
  const stateDir = path.join(hooksDir, ".state");

  fs.mkdirSync(stateDir, { recursive: true });

  // Mock settings.json with gutt-mcp-remote configured
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcpServers: {
        "gutt-mcp-remote": {
          command: "npx",
          args: ["-y", "gutt-mcp-remote"],
        },
      },
    })
  );

  return { tmpDir, claudeDir, hooksDir, stateDir };
}

// Helper: Write mock session state
function writeSessionState(stateDir, sessionId, state) {
  const statePath = path.join(stateDir, `gutt-session-${sessionId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(state));
}

// Helper: Run hook and parse output
function runHook(tmpDir, sessionId) {
  const hookPath = path.join(__dirname, "..", "hooks", "stop-lessons.cjs");
  const inputJson = JSON.stringify({ session_id: sessionId });

  try {
    const output = execSync(`node "${hookPath}"`, {
      input: inputJson,
      encoding: "utf8",
      cwd: tmpDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
    });
    if (!output.trim()) {
      return { decision: "allow" };
    }
    return JSON.parse(output.trim());
  } catch (e) {
    if (e.status === 0 || e.status === null) {
      return { decision: "allow" };
    }
    fail(`Hook execution failed: ${e.stderr || e.message}`);
    return { decision: "error" };
  }
}

// Test 1: First stop blocks
console.log("Test 1: First stop blocks with lesson capture prompt...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-first-stop";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 5,
    lessonsCaptured: 0,
    significantOps: 8,
  });

  const result = runHook(tmpDir, sessionId);

  if (result.decision === "block") {
    pass("First stop is blocked");

    if (result.reason.includes("memory-keeper")) {
      pass("Reason mentions memory-keeper agent");
    } else {
      fail("Reason missing memory-keeper reference");
    }

    if (result.reason.includes("5 memory queries")) {
      pass("Reason includes memory query count from session state");
    } else {
      fail("Reason missing session state stats");
    }

    if (result.reason.includes("you will not be blocked again")) {
      pass("Reason tells user they won't be blocked again");
    } else {
      fail("Missing 'not blocked again' message");
    }
  } else {
    fail(`Expected block, got ${result.decision}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 2: Second stop allows through
console.log("\nTest 2: Second stop allows through...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-second-stop";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 1,
    lessonsCaptured: 0,
  });

  // First stop
  const result1 = runHook(tmpDir, sessionId);
  if (result1.decision !== "block") {
    fail("First stop should block");
  }

  // Second stop
  const result2 = runHook(tmpDir, sessionId);
  if (result2.decision === "allow") {
    pass("Second stop is allowed through");
  } else {
    fail(`Second stop should allow, got ${result2.decision}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 3: No MCP configured — allows stop immediately
// NOTE: This test is best-effort. If the gutt plugin is installed globally
// (e.g. in ~/.claude/plugins/), isGuttMcpConfigured() returns true even
// without a project-level settings.json. We accept either outcome.
console.log("\nTest 3: No MCP configured — allows stop (best-effort)...");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-test-"));
  const claudeDir = path.join(tmpDir, ".claude");
  const stateDir = path.join(claudeDir, "hooks", ".state");
  fs.mkdirSync(stateDir, { recursive: true });

  const sessionId = "test-no-mcp";

  const result = runHook(tmpDir, sessionId);
  if (result.decision === "allow") {
    pass("Stop allowed when MCP not configured");
  } else if (result.decision === "block") {
    pass("MCP detected via global plugin install — block is correct");
  } else {
    fail(`Unexpected decision: ${result.decision}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 4: Session state stats appear in reason
console.log("\nTest 4: Session state stats in reason...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-stats";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    memoryQueries: 13,
    lessonsCaptured: 2,
    significantOps: 15,
  });

  const result = runHook(tmpDir, sessionId);

  if (result.decision === "block") {
    if (result.reason.includes("13 memory queries")) {
      pass("Memory queries count shown");
    } else {
      fail("Missing memory queries count");
    }

    if (result.reason.includes("15 significant ops")) {
      pass("Significant ops count shown");
    } else {
      fail("Missing significant ops count");
    }

    if (result.reason.includes("2 lessons captured")) {
      pass("Lessons captured count shown");
    } else {
      fail("Missing lessons captured count");
    }
  } else {
    fail(`Expected block, got ${result.decision}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\n=== E2E Test Complete ===");

if (failures > 0) {
  console.log(`\n❌ ${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\n✅ All tests passed");
}
