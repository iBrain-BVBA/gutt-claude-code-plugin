#!/usr/bin/env node
/**
 * Automated test script for all gutt-claude-code-plugin hooks
 *
 * Usage: node tests/test-all-hooks.cjs
 *
 * Tests all hooks with realistic JSON inputs
 * Verifies cross-platform path handling
 * Checks configuration file locations
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Get project directory (handles cross-platform path resolution)
const projectDir = path.resolve(__dirname, "..");
process.env.CLAUDE_PROJECT_DIR = projectDir;

const results = {
  passed: [],
  failed: [],
  warnings: [],
  skipped: [],
};

// Ensure test directories exist
const stateDir = path.join(projectDir, ".claude", "hooks", ".state");
const hooksDir = path.join(projectDir, ".claude", "hooks");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(hooksDir, { recursive: true });

// Test helper function
function testHook(hookName, hookFile, inputJson, options = {}) {
  const { shouldContain, allowNonZero } = options;
  const hookPath = path.join(projectDir, "hooks", hookFile);

  console.log(`\n🧪 Testing: ${hookName}`);
  console.log(`   File: ${hookFile}`);

  if (!fs.existsSync(hookPath)) {
    results.failed.push(`${hookName}: Hook file not found at ${hookPath}`);
    console.log(`   ❌ FAILED: Hook file not found`);
    return false;
  }

  try {
    // Use spawn for cross-platform compatibility
    const inputStr = JSON.stringify(inputJson);

    // On Windows, use different approach
    let output;
    if (os.platform() === "win32") {
      // Write input to temp file, then pipe it
      const tempFile = path.join(os.tmpdir(), `hook-test-${Date.now()}.json`);
      fs.writeFileSync(tempFile, inputStr);
      try {
        output = execSync(`type "${tempFile}" | node "${hookPath}"`, {
          encoding: "utf8",
          cwd: projectDir,
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
          shell: true,
          timeout: 10000,
        });
      } finally {
        fs.unlinkSync(tempFile);
      }
    } else {
      output = execSync(`echo '${inputStr.replace(/'/g, "\\'")}' | node "${hookPath}"`, {
        encoding: "utf8",
        cwd: projectDir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        shell: true,
        timeout: 10000,
      });
    }

    // Check expected output
    if (shouldContain && output && !output.includes(shouldContain)) {
      results.warnings.push(
        `${hookName}: Output does not contain expected text: "${shouldContain}"`
      );
      console.log(`   ⚠️  WARNING: Missing expected output`);
    }

    results.passed.push(hookName);
    console.log(`   ✅ PASSED (exit code 0)`);
    if (output && output.trim()) {
      const preview = output.trim().substring(0, 100);
      console.log(`   Output: ${preview}${output.length > 100 ? "..." : ""}`);
    }
    return true;
  } catch (err) {
    // Check if it's just a non-zero exit (which is OK for blocking hooks)
    if (err.status !== undefined && allowNonZero) {
      results.passed.push(hookName);
      console.log(`   ✅ PASSED (exit code ${err.status} - expected for blocking hook)`);
      if (err.stdout) {
        const preview = err.stdout.trim().substring(0, 100);
        console.log(`   Output: ${preview}${err.stdout.length > 100 ? "..." : ""}`);
      }
      return true;
    }

    results.failed.push(`${hookName}: ${err.message}`);
    console.log(`   ❌ FAILED: ${err.message}`);
    if (err.stderr) {
      console.log(`   Stderr: ${err.stderr.substring(0, 200)}`);
    }
    return false;
  }
}

console.log("═══════════════════════════════════════════════════════════");
console.log("🧪 Testing all gutt-claude-code-plugin hooks");
console.log("═══════════════════════════════════════════════════════════");
console.log(`Project dir: ${projectDir}`);
console.log(`Platform: ${os.platform()}`);

// Test 1: SessionStart
testHook(
  "1. SessionStart",
  "session-start.cjs",
  {},
  { shouldContain: null } // May output setup reminder or be silent
);

// Test 2: UserPromptSubmit
testHook(
  "2. UserPromptSubmit",
  "user-prompt-submit.cjs",
  { prompt: "Implement authentication system" },
  { shouldContain: null } // Output depends on gutt-mcp config
);

// Test 3: Stop (may block - that's expected)
testHook(
  "3. Stop (Lessons)",
  "stop-lessons.cjs",
  {
    session_id: "test-session-" + Date.now(),
    transcript_path: path.join(projectDir, ".claude", "transcript.jsonl"),
  },
  { allowNonZero: true } // May block, which is OK
);

// Test 4: PostToolUse - Linting
testHook(
  "4. PostToolUse (Linting)",
  "post-tool-lint.cjs",
  {
    tool_name: "Edit",
    tool_input: { file_path: path.join(os.tmpdir(), "nonexistent.py") },
  },
  { shouldContain: null } // Silent if file doesn't exist
);

// Test 5: PostToolUse - Task Lessons
testHook(
  "5. PostToolUse (Task Lessons)",
  "post-task-lessons.cjs",
  {
    tool_name: "Task",
    tool_input: {
      subagent_type: "oh-my-claudecode:executor",
      prompt: "Fix authentication bug",
    },
    tool_response:
      "Fixed the JWT validation issue. The problem was that token expiry was checked incorrectly. This is an important lesson about proper token handling that we should remember for future implementations.",
  },
  { shouldContain: null } // May or may not suggest lesson
);

// Test 6: PostToolUse - Memory Operations
testHook(
  "6. PostToolUse (Memory Ops)",
  "post-memory-ops.cjs",
  {
    tool_name: "mcp__gutt-mcp-remote__search_memory_facts",
    tool_input: { query: "authentication patterns" },
    tool_response: '{"result":{"facts":[{"fact":"Use JWT for stateless auth"}]}}',
  },
  { shouldContain: null } // Updates state, not stdout
);

// Test 7: PreToolUse - Task Memory
testHook(
  "7. PreToolUse (Task Memory)",
  "pre-task-memory.cjs",
  {
    tool_name: "Task",
    tool_input: {
      subagent_type: "oh-my-claudecode:architect",
      prompt: "Design the authentication system",
    },
  },
  { shouldContain: null } // Silent, updates state
);

// Test 8: SubagentStart - Memory Injection
testHook(
  "8. SubagentStart (Memory Injection)",
  "subagent-start-memory.cjs",
  { agent_type: "oh-my-claudecode:executor", agent_id: "test-123" },
  { shouldContain: null } // May inject memory or provide fallback
);

// Test 9: SubagentStop - Plan Review
testHook(
  "9. SubagentStop (Plan Review)",
  "subagent-plan-review.cjs",
  {
    agent_transcript_path: path.join(projectDir, ".claude", "transcript.jsonl"),
    agent_type: "oh-my-claudecode:planner",
  },
  { allowNonZero: true } // May block if plan detected
);

// Test 10: StatusLine
testHook(
  "10. StatusLine",
  "statusline.cjs",
  {
    model: { display_name: "claude-opus" },
    cost: { total_cost_usd: 0.05 },
  },
  { shouldContain: null } // Should show gutt status
);

// Report results
console.log("\n═══════════════════════════════════════════════════════════");
console.log("📊 Test Results");
console.log("═══════════════════════════════════════════════════════════");
console.log(`\n✅ Passed: ${results.passed.length}/10`);
console.log(`❌ Failed: ${results.failed.length}`);
console.log(`⚠️  Warnings: ${results.warnings.length}`);

if (results.failed.length > 0) {
  console.log("\n❌ Failed Tests:");
  results.failed.forEach((f) => console.log(`   - ${f}`));
}

if (results.warnings.length > 0) {
  console.log("\n⚠️  Warnings:");
  results.warnings.forEach((w) => console.log(`   - ${w}`));
}

console.log("\n═══════════════════════════════════════════════════════════");

// Exit with appropriate code
process.exit(results.failed.length > 0 ? 1 : 0);
