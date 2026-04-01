#!/usr/bin/env node
/**
 * Unit tests for memory-routing.cjs — adjustScoresFromMemory
 *
 * Usage: node tests/memory-routing.unit.test.cjs
 */

const path = require("path");

// Set env before requiring modules
process.env.CLAUDE_PROJECT_DIR = path.resolve(__dirname, "..");

const {
  adjustScoresFromMemory,
  matchesPatterns,
  POSITIVE_BOOST,
  NEGATIVE_PENALTY,
  NEGATIVE_OUTCOME_PATTERNS,
  POSITIVE_OUTCOME_PATTERNS,
} = require("../hooks/lib/memory-routing.cjs");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

function assertClose(actual, expected, msg, epsilon = 0.001) {
  assert(Math.abs(actual - expected) < epsilon, `${msg} (got ${actual}, expected ${expected})`);
}

console.log("=== memory-routing.cjs unit tests ===\n");

// --- matchesPatterns ---
console.log("matchesPatterns:");
assert(
  matchesPatterns("Task failed due to timeout", NEGATIVE_OUTCOME_PATTERNS),
  "detects 'failed'"
);
assert(
  matchesPatterns("Successfully resolved the issue", POSITIVE_OUTCOME_PATTERNS),
  "detects 'resolved'"
);
assert(
  !matchesPatterns("No relevant keywords here", NEGATIVE_OUTCOME_PATTERNS),
  "returns false for no match"
);
assert(!matchesPatterns(null, NEGATIVE_OUTCOME_PATTERNS), "handles null input");
assert(!matchesPatterns("", POSITIVE_OUTCOME_PATTERNS), "handles empty string");
assert(!matchesPatterns(42, POSITIVE_OUTCOME_PATTERNS), "handles non-string input");

// --- adjustScoresFromMemory: edge cases ---
console.log("\nadjustScoresFromMemory edge cases:");
assert(Array.isArray(adjustScoresFromMemory([], {})), "returns array for empty agents");
assert(adjustScoresFromMemory(null, {}).length === 0, "returns empty array for null agents");

const agents = [
  { name: "cfo-analyst", score: 0.8, summary: "Financial analysis" },
  { name: "bug-investigator", score: 0.6, summary: "Bug hunting" },
];

const same = adjustScoresFromMemory(agents, null);
assert(same === agents, "returns original array when memoryCache is null");

const same2 = adjustScoresFromMemory(agents, {});
assert(same2 === agents, "returns original array when memoryCache has no lessons or facts");

const same3 = adjustScoresFromMemory(agents, { lessons: [], facts: [] });
assert(same3 === agents, "returns original array when lessons and facts are empty");

// --- adjustScoresFromMemory: positive lesson boost ---
console.log("\nadjustScoresFromMemory positive boost:");
{
  const memoryCache = {
    lessons: [
      {
        summary: "cfo-analyst successfully handled budget queries",
        outcome: "Completed and approved by finance team",
      },
    ],
    facts: [],
  };
  const result = adjustScoresFromMemory(agents, memoryCache);
  assertClose(
    result.find((a) => a.name === "cfo-analyst").score,
    0.8 + POSITIVE_BOOST,
    "cfo-analyst boosted"
  );
  assertClose(
    result.find((a) => a.name === "bug-investigator").score,
    0.6,
    "bug-investigator unchanged"
  );
}

// --- adjustScoresFromMemory: negative lesson penalty ---
console.log("\nadjustScoresFromMemory negative penalty:");
{
  const memoryCache = {
    lessons: [
      {
        summary: "bug-investigator produced wrong diagnosis last time",
        outcome: "Incorrect root cause, had to be reverted",
      },
    ],
    facts: [],
  };
  const result = adjustScoresFromMemory(agents, memoryCache);
  assertClose(
    result.find((a) => a.name === "bug-investigator").score,
    0.6 - NEGATIVE_PENALTY,
    "bug-investigator penalized"
  );
  assertClose(result.find((a) => a.name === "cfo-analyst").score, 0.8, "cfo-analyst unchanged");
}

// --- adjustScoresFromMemory: facts give mild boost ---
console.log("\nadjustScoresFromMemory facts boost:");
{
  const memoryCache = {
    lessons: [],
    facts: [{ fact: "cfo-analyst is the go-to agent for revenue questions", name: "cfo-analyst" }],
  };
  const result = adjustScoresFromMemory(agents, memoryCache);
  const cfo = result.find((a) => a.name === "cfo-analyst");
  // Facts boost = POSITIVE_BOOST * 0.5 per mention (fact text + name both mention it = 2 hits)
  assert(cfo.score > 0.8, `cfo-analyst gets mild fact boost (${cfo.score})`);
}

// --- adjustScoresFromMemory: score clamping ---
console.log("\nadjustScoresFromMemory score clamping:");
{
  const highAgent = [{ name: "top-agent", score: 0.98, summary: "Almost max" }];
  const memoryCache = {
    lessons: [
      { summary: "top-agent shipped the feature successfully", outcome: "Success, approved" },
      { summary: "top-agent resolved the critical bug", outcome: "Fixed and completed" },
    ],
    facts: [],
  };
  const result = adjustScoresFromMemory(highAgent, memoryCache);
  assert(result[0].score <= 1.0, `score clamped to max 1.0 (got ${result[0].score})`);
}

{
  const lowAgent = [{ name: "bad-agent", score: 0.05, summary: "Very low" }];
  const memoryCache = {
    lessons: [{ summary: "bad-agent broke the build", outcome: "Error and rollback required" }],
    facts: [],
  };
  const result = adjustScoresFromMemory(lowAgent, memoryCache);
  assert(result[0].score >= 0, `score clamped to min 0 (got ${result[0].score})`);
}

// --- adjustScoresFromMemory: re-sorting ---
console.log("\nadjustScoresFromMemory re-sorting:");
{
  const agentList = [
    { name: "agent-a", score: 0.7, summary: "A" },
    { name: "agent-b", score: 0.5, summary: "B" },
  ];
  const memoryCache = {
    lessons: [
      { summary: "agent-b resolved the issue perfectly", outcome: "Success, shipped" },
      { summary: "agent-a produced an error", outcome: "Failed and reverted" },
    ],
    facts: [],
  };
  const result = adjustScoresFromMemory(agentList, memoryCache);
  assert(
    result[0].name === "agent-b" || result[0].score >= result[1].score,
    "results sorted by score descending"
  );
}

// --- adjustScoresFromMemory: does not mutate original ---
console.log("\nadjustScoresFromMemory immutability:");
{
  const original = [{ name: "cfo-analyst", score: 0.8, summary: "Test" }];
  const originalScore = original[0].score;
  const memoryCache = {
    lessons: [{ summary: "cfo-analyst failed", outcome: "Error occurred" }],
    facts: [],
  };
  adjustScoresFromMemory(original, memoryCache);
  assert(original[0].score === originalScore, "original array not mutated");
}

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
