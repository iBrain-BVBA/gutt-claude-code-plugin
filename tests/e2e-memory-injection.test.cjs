#!/usr/bin/env node
/**
 * E2E Test: Deterministic Memory Injection for Subagents (GP-454)
 *
 * Run this test AFTER restarting Claude Code to verify the full flow.
 *
 * Usage: node tests/e2e-memory-injection.test.cjs
 */

let failures = 0;

function fail(msg) {
  console.log(`  ✗ ${msg}`);
  failures++;
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

console.log("=== GP-454 E2E Test: Deterministic Memory Injection ===\n");

// Test 1: Cache module loads correctly
console.log("Test 1: Cache module loads...");
try {
  const cache = require("../hooks/lib/memory-cache.cjs");
  pass("memory-cache.cjs loads successfully");
  pass(`Exports: ${Object.keys(cache).join(", ")}`);
} catch (e) {
  fail(`Failed: ${e.message}`);
  process.exit(1);
}

// Test 2: SubagentStart hook loads correctly
console.log("\nTest 2: SubagentStart hook loads...");
try {
  require("child_process").execSync("node --check hooks/subagent-start-memory.cjs", {
    stdio: "pipe",
  });
  pass("subagent-start-memory.cjs syntax OK");
} catch (e) {
  fail(`Syntax error: ${e.message}`);
  process.exit(1);
}

// Test 3: Cache population
console.log("\nTest 3: Cache population...");
const {
  updateMemoryCache,
  getMemoryCache,
  clearMemoryCache,
  hasCachedContent,
  formatMemoryContext,
} = require("../hooks/lib/memory-cache.cjs");

clearMemoryCache();
pass("Cache cleared");

const testLessons = [
  { summary: "Test lesson 1", guidance: "Test guidance 1", outcome: "positive" },
  { summary: "Test lesson 2", guidance: "Test guidance 2", outcome: "negative" },
];
updateMemoryCache("lessons", testLessons);

const testFacts = [
  { fact: "Test fact 1", name: "Entity1" },
  { fact: "Test fact 2", name: "Entity2" },
];
updateMemoryCache("facts", testFacts);

const cached = getMemoryCache();
if (cached.lessons.length === 2 && cached.facts.length === 2) {
  pass("Cache populated with 2 lessons and 2 facts");
} else {
  fail(`Cache mismatch: ${cached.lessons.length} lessons, ${cached.facts.length} facts`);
}

// Test 4: hasCachedContent
console.log("\nTest 4: hasCachedContent...");
if (hasCachedContent()) {
  pass("hasCachedContent() returns true");
} else {
  fail("hasCachedContent() returns false");
}

// Test 5: formatMemoryContext
console.log("\nTest 5: formatMemoryContext...");
const formatted = formatMemoryContext();
if (
  formatted &&
  formatted.includes("[GUTT Organizational Memory]") &&
  formatted.includes("Test lesson 1")
) {
  pass("formatMemoryContext() generates correct output");
  console.log("  Preview:");
  console.log(
    formatted
      .split("\n")
      .slice(0, 8)
      .map((l) => "    " + l)
      .join("\n")
  );
} else {
  fail("formatMemoryContext() output incorrect");
}

// Test 6: SubagentStart hook output simulation
console.log("\nTest 6: SubagentStart hook output simulation...");
const { execSync } = require("child_process");
try {
  const output = execSync(
    'echo {"agent_type": "test-agent"} | node hooks/subagent-start-memory.cjs',
    {
      encoding: "utf8",
      cwd: process.cwd(),
    }
  );
  const parsed = JSON.parse(output);
  if (
    parsed.hookSpecificOutput?.hookEventName === "SubagentStart" &&
    parsed.hookSpecificOutput?.additionalContext?.includes("[GUTT Organizational Memory]")
  ) {
    pass("Hook outputs correct JSON structure");
    pass("additionalContext contains memory");
  } else {
    fail("Hook output structure incorrect");
    console.log("  Output:", output.substring(0, 200));
  }
} catch (e) {
  fail(`Hook execution failed: ${e.message}`);
}

// Cleanup
clearMemoryCache();

console.log("\n=== E2E Test Complete ===");

if (failures > 0) {
  console.log(`\n❌ ${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\n✅ All tests passed");
}

console.log("\nTo complete full E2E testing:");
console.log("1. Restart Claude Code to load new hooks");
console.log("2. Call: mcp__gutt-mcp-remote__fetch_lessons_learned(query: 'test')");
console.log("3. Check cache: cat .claude/hooks/.state/gutt-memory-cache.json");
console.log("4. Spawn subagent and verify it receives GUTT memory context");
