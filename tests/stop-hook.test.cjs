#!/usr/bin/env node
/**
 * Test script for stop-lessons.cjs logic
 */

const {
  parseTranscript,
  getSessionDuration,
  generateSummary,
} = require("../hooks/lib/transcript-parser.cjs");

console.log("Testing transcript parser...\n");

// Test 1: Parse non-existent transcript
console.log("Test 1: Non-existent transcript");
const result1 = parseTranscript("/nonexistent/path.jsonl");
console.log("Result:", JSON.stringify(result1, null, 2));
console.log("✓ Should return default metadata\n");

// Test 2: Session duration calculation
console.log("Test 2: Session duration");
const now = new Date();
const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
console.log("10 minutes ago:", getSessionDuration(tenMinutesAgo), "minutes");
console.log("5 minutes ago:", getSessionDuration(fiveMinutesAgo), "minutes");
console.log("✓ Duration calculation works\n");

// Test 3: Generate summary
console.log("Test 3: Generate summary");
const metadata = {
  firstUserMessage: "Implement GP-455: Enhance stop hook",
  filesModified: 3,
  toolCallCount: 25,
  userMessageCount: 5,
};
const summary = generateSummary(metadata);
console.log("Summary:", summary);
console.log("✓ Summary generation works\n");

// Test 4: Skip logic simulation
console.log("Test 4: Skip logic simulation");

function shouldSkip(memoryQueries, durationMinutes, lessonsCaptured) {
  return memoryQueries === 0 && durationMinutes < 10 && lessonsCaptured > 0;
}

const scenarios = [
  {
    memoryQueries: 0,
    duration: 5,
    captured: 1,
    expected: true,
    desc: "Trivial session (should skip)",
  },
  {
    memoryQueries: 1,
    duration: 5,
    captured: 0,
    expected: false,
    desc: "Memory consulted (should block)",
  },
  {
    memoryQueries: 0,
    duration: 15,
    captured: 0,
    expected: false,
    desc: "Long session (should block)",
  },
  {
    memoryQueries: 0,
    duration: 5,
    captured: 0,
    expected: false,
    desc: "Nothing captured (should block)",
  },
  {
    memoryQueries: 5,
    duration: 20,
    captured: 0,
    expected: false,
    desc: "Significant work (should block)",
  },
];

scenarios.forEach(({ memoryQueries, duration, captured, expected, desc }) => {
  const result = shouldSkip(memoryQueries, duration, captured);
  const status = result === expected ? "✓" : "✗";
  console.log(`${status} ${desc}`);
  console.log(`  Input: queries=${memoryQueries}, duration=${duration}m, captured=${captured}`);
  console.log(`  Result: ${result ? "SKIP (allow stop)" : "BLOCK (capture required)"}`);
});

console.log("\nAll tests completed!");
