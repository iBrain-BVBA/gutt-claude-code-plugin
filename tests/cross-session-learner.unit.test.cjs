#!/usr/bin/env node
/**
 * Unit tests for cross-session-learner.cjs — recordSessionMetrics and generateInsights
 *
 * Usage: node tests/cross-session-learner.unit.test.cjs
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Create isolated temp environment
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-xsession-test-"));
const stateDir = path.join(tmpDir, ".claude", "hooks", ".state");
fs.mkdirSync(stateDir, { recursive: true });

// Set env before requiring modules
process.env.CLAUDE_PROJECT_DIR = tmpDir;

// Now require the module (it reads env at require time via env.cjs)
const {
  recordSessionMetrics,
  generateInsights,
  loadAnalytics,
  ANALYTICS_PATH,
} = require("../hooks/lib/cross-session-learner.cjs");

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

function cleanup() {
  try {
    if (fs.existsSync(ANALYTICS_PATH)) {
      fs.unlinkSync(ANALYTICS_PATH);
    }
  } catch {
    // ignore
  }
}

console.log("=== cross-session-learner.cjs unit tests ===\n");

// --- loadAnalytics: defaults ---
console.log("loadAnalytics defaults:");
cleanup();
{
  const analytics = loadAnalytics();
  assert(analytics.totalSessions === 0, "totalSessions defaults to 0");
  assert(analytics.totalMemoryQueries === 0, "totalMemoryQueries defaults to 0");
  assert(analytics.totalLessonsCaptured === 0, "totalLessonsCaptured defaults to 0");
  assert(typeof analytics.agentDelegations === "object", "agentDelegations is object");
  assert(typeof analytics.hookFirings === "object", "hookFirings is object");
}

// --- recordSessionMetrics: basic recording ---
console.log("\nrecordSessionMetrics basic:");
cleanup();
{
  const result = recordSessionMetrics({ memoryQueries: 5, lessonsCaptured: 2 });
  assert(result.totalSessions === 1, "increments totalSessions to 1");
  assert(result.totalMemoryQueries === 5, "accumulates memoryQueries");
  assert(result.totalLessonsCaptured === 2, "accumulates lessonsCaptured");
  assert(result.lastSessionAt !== null, "sets lastSessionAt");
}

// --- recordSessionMetrics: accumulation across sessions ---
console.log("\nrecordSessionMetrics accumulation:");
{
  const result2 = recordSessionMetrics({ memoryQueries: 3, lessonsCaptured: 1 });
  assert(result2.totalSessions === 2, "increments to 2 sessions");
  assert(result2.totalMemoryQueries === 8, "accumulates to 8 queries");
  assert(result2.totalLessonsCaptured === 3, "accumulates to 3 lessons");
}

// --- recordSessionMetrics: handles null/invalid input ---
console.log("\nrecordSessionMetrics edge cases:");
cleanup();
{
  const result = recordSessionMetrics(null);
  assert(result.totalSessions === 0, "null input does not increment sessions");

  const result2 = recordSessionMetrics({});
  assert(result2.totalSessions === 1, "empty object still increments session count");
  assert(result2.totalMemoryQueries === 0, "missing fields treated as 0");
}

// --- generateInsights: insufficient data ---
console.log("\ngenerateInsights insufficient data:");
cleanup();
{
  const insights = generateInsights({
    totalSessions: 5,
    totalMemoryQueries: 10,
    totalLessonsCaptured: 3,
    agentDelegations: {},
    hookFirings: {},
  });
  assert(insights.length === 0, "returns empty for < 10 sessions");
}

// --- generateInsights: with sufficient data ---
console.log("\ngenerateInsights with data:");
{
  const analytics = {
    totalSessions: 20,
    totalMemoryQueries: 60,
    totalLessonsCaptured: 10,
    agentDelegations: {
      "cfo-analyst": 15,
      "bug-investigator": 5,
      "doc-writer": 2,
    },
    hookFirings: {
      "session-start": 20,
      "stop-lessons": 18,
      "post-tool-lint": 45,
    },
  };
  const insights = generateInsights(analytics);

  assert(insights.length > 0, "produces insights for 20 sessions");

  const avgQueriesInsight = insights.find((i) => i.includes("Average memory queries"));
  assert(avgQueriesInsight !== undefined, "includes average queries insight");
  assert(avgQueriesInsight.includes("3.0"), "average queries = 60/20 = 3.0");

  const avgLessonsInsight = insights.find((i) => i.includes("Average lessons captured"));
  assert(avgLessonsInsight !== undefined, "includes average lessons insight");

  const topAgentInsight = insights.find((i) => i.includes("Most used agent"));
  assert(topAgentInsight !== undefined, "includes most used agent insight");
  assert(topAgentInsight.includes("cfo-analyst"), "most used agent is cfo-analyst");

  const leastAgentInsight = insights.find((i) => i.includes("Least used agent"));
  assert(leastAgentInsight !== undefined, "includes least used agent insight (3+ agents)");
  assert(leastAgentInsight.includes("doc-writer"), "least used agent is doc-writer");

  const topHookInsight = insights.find((i) => i.includes("Most active hook"));
  assert(topHookInsight !== undefined, "includes most active hook insight");
  assert(topHookInsight.includes("post-tool-lint"), "most active hook is post-tool-lint");
}

// --- generateInsights: no memory usage warning ---
console.log("\ngenerateInsights no-memory warning:");
{
  const analytics = {
    totalSessions: 15,
    totalMemoryQueries: 0,
    totalLessonsCaptured: 0,
    agentDelegations: {},
    hookFirings: {},
  };
  const insights = generateInsights(analytics);
  const noMemoryInsight = insights.find((i) => i.includes("No memory queries"));
  assert(noMemoryInsight !== undefined, "warns about zero memory queries");
}

// --- generateInsights: exactly 10 sessions threshold ---
console.log("\ngenerateInsights threshold boundary:");
{
  const analytics = {
    totalSessions: 10,
    totalMemoryQueries: 30,
    totalLessonsCaptured: 5,
    agentDelegations: { "test-agent": 10 },
    hookFirings: { "test-hook": 20 },
  };
  const insights = generateInsights(analytics);
  assert(insights.length > 0, "produces insights at exactly 10 sessions");
}

// --- Cleanup ---
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup errors
}

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
