#!/usr/bin/env node
/**
 * E2E Test: Plan Feedback Detection (GP-455)
 *
 * Tests the plan feedback detection feature in stop-lessons.cjs hook.
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

console.log("=== GP-455 E2E Test: Plan Feedback Detection ===\n");

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

// Helper: Write mock transcript
function writeTranscript(tmpDir, entries) {
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(transcriptPath, lines + "\n");
  return transcriptPath;
}

// Helper: Write mock session state
function writeSessionState(stateDir, sessionId, state) {
  // getState() reads from hardcoded "gutt-session.json" path
  const statePath = path.join(stateDir, "gutt-session.json");
  fs.writeFileSync(statePath, JSON.stringify(state));
}

// Helper: Run hook and parse output
function runHook(tmpDir, sessionId, transcriptPath) {
  const hookPath = path.join(__dirname, "..", "hooks", "stop-lessons.cjs");
  const inputJson = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
  });

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
  } catch {
    // Hook exited 0 (allowed stop) - no JSON output
    return { decision: "allow" };
  }
}

// Test 1: Plan rejection
console.log("Test 1: Plan rejection (negative outcome)...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-reject";

  // Write session state
  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 1,
    lessonsCaptured: 0,
  });

  // Write transcript with plan + rejection
  const transcript = [
    {
      type: "user_message",
      content: "plan a new authentication system",
    },
    {
      type: "tool_use",
      name: "Task",
      input: {
        subagent_type: "oh-my-claudecode:planner",
        model: "opus",
        prompt: "Create plan for authentication system",
      },
    },
    {
      type: "tool_result",
      content: "Plan: Use JWT tokens with Redis...",
    },
    {
      type: "user_message",
      content: "no, wrong approach. we need OAuth2 instead",
    },
  ];
  const transcriptPath = writeTranscript(tmpDir, transcript);

  const result = runHook(tmpDir, sessionId, transcriptPath);

  if (result.decision === "block") {
    pass("Hook blocks stop (plan rejection detected)");

    if (result.reason.includes("🟠")) {
      pass("Reason includes orange warning emoji");
    } else {
      fail("Reason missing orange emoji");
    }

    if (result.reason.includes("mcp__gutt-mcp-remote__add_memory")) {
      pass("Reason includes exact MCP tool call");
    } else {
      fail("Reason missing MCP tool call");
    }

    if (result.reason.toLowerCase().includes("negative")) {
      pass("Outcome marked as negative");
    } else {
      fail("Outcome not marked as negative");
    }
  } else {
    fail(`Expected block, got ${result.decision}`);
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 2: Plan modification
console.log("\nTest 2: Plan modification (positive outcome)...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-modify";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 1,
    lessonsCaptured: 0,
  });

  const transcript = [
    {
      type: "user_message",
      content: "plan the database schema",
    },
    {
      type: "tool_use",
      name: "Task",
      input: {
        subagent_type: "oh-my-claudecode:planner",
        model: "opus",
        prompt: "Plan database schema",
      },
    },
    {
      type: "tool_result",
      content: "Plan: Use PostgreSQL with...",
    },
    {
      type: "user_message",
      content: "good but change the users table to include email_verified",
    },
  ];
  const transcriptPath = writeTranscript(tmpDir, transcript);

  const result = runHook(tmpDir, sessionId, transcriptPath);

  if (result.decision === "block") {
    pass("Hook blocks stop (plan modification detected)");

    if (result.reason.includes("🟠")) {
      pass("Reason includes orange warning emoji");
    } else {
      fail("Reason missing orange emoji");
    }

    if (result.reason.includes("mcp__gutt-mcp-remote__add_memory")) {
      pass("Reason includes exact MCP tool call");
    } else {
      fail("Reason missing MCP tool call");
    }

    if (result.reason.toLowerCase().includes("positive")) {
      pass("Outcome marked as positive");
    } else {
      fail("Outcome not marked as positive");
    }
  } else {
    fail(`Expected block, got ${result.decision}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 3: No plan context
console.log("\nTest 3: No plan context (regular behavior)...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-noplan";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 1,
    lessonsCaptured: 0,
  });

  const transcript = [
    {
      type: "user_message",
      content: "implement a feature",
    },
    {
      type: "tool_use",
      name: "Task",
      input: {
        subagent_type: "oh-my-claudecode:executor",
        model: "sonnet",
        prompt: "Implement feature",
      },
    },
    {
      type: "tool_result",
      content: "Feature implemented",
    },
  ];
  const transcriptPath = writeTranscript(tmpDir, transcript);

  const result = runHook(tmpDir, sessionId, transcriptPath);

  if (result.decision === "block") {
    pass("Hook blocks for regular session capture");

    // Should NOT have plan-specific prompt
    if (!result.reason.toLowerCase().includes("plan")) {
      pass("Reason does not mention plan (uses regular session capture)");
    } else {
      fail("Reason incorrectly mentions plan");
    }
  } else {
    fail(`Expected block for significant session, got ${result.decision}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 4: Plan approved
console.log("\nTest 4: Plan approved (skip capture)...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-approved";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 1,
    lessonsCaptured: 0,
  });

  const transcript = [
    {
      type: "user_message",
      content: "plan the API endpoints",
    },
    {
      type: "tool_use",
      name: "Task",
      input: {
        subagent_type: "oh-my-claudecode:planner",
        model: "opus",
        prompt: "Plan API endpoints",
      },
    },
    {
      type: "tool_result",
      content: "Plan: RESTful endpoints...",
    },
    {
      type: "user_message",
      content: "looks good, proceed",
    },
  ];
  const transcriptPath = writeTranscript(tmpDir, transcript);

  const result = runHook(tmpDir, sessionId, transcriptPath);

  // Should still block for regular session capture, but NOT for plan feedback
  // Check for plan-specific phrases (not just the word "plan" which may appear in goal)
  const isPlanSpecificPrompt =
    result.reason?.includes("Plan was REJECTED") ||
    result.reason?.includes("Plan was MODIFIED") ||
    result.reason?.includes("Plan Lesson:");

  if (result.decision === "block") {
    if (!isPlanSpecificPrompt) {
      pass("Plan approval skipped, falls through to regular session capture");
    } else {
      fail("Plan approval should not trigger plan-specific prompt");
    }
  } else {
    pass("Plan approval allows continuation to regular logic");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 5: State prevents duplicates
console.log("\nTest 5: State file prevents duplicate prompts...");
{
  const { tmpDir, stateDir } = createTempEnv();
  const sessionId = "test-duplicate";

  writeSessionState(stateDir, sessionId, {
    startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    memoryQueries: 1,
    lessonsCaptured: 0,
  });

  // Create plan feedback state file (simulating already prompted)
  const planStateFile = path.join(stateDir, `${sessionId}.plan-feedback-prompted`);
  fs.writeFileSync(planStateFile, "");

  const transcript = [
    {
      type: "user_message",
      content: "plan something",
    },
    {
      type: "tool_use",
      name: "Task",
      input: {
        subagent_type: "oh-my-claudecode:planner",
        model: "opus",
        prompt: "Plan",
      },
    },
    {
      type: "user_message",
      content: "no, wrong approach",
    },
  ];
  const transcriptPath = writeTranscript(tmpDir, transcript);

  const result = runHook(tmpDir, sessionId, transcriptPath);

  // Should skip plan feedback prompt due to state file
  if (result.decision === "block") {
    if (!result.reason.toLowerCase().includes("plan feedback")) {
      pass("State file prevents duplicate plan feedback prompt");
    } else {
      fail("Duplicate prompt despite state file");
    }
  } else {
    pass("State file correctly prevents duplicate blocking");
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

console.log("\nNote: This test verifies plan feedback detection logic.");
console.log("For full integration testing:");
console.log("1. Restart Claude Code");
console.log("2. Run /plan skill and reject with 'no, wrong approach'");
console.log("3. Verify 🟠 prompt appears with exact MCP tool call");
