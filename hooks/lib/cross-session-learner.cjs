#!/usr/bin/env node
/**
 * Cross-Session Learning Module
 *
 * Tracks cumulative analytics across sessions to surface insights
 * about plugin usage patterns over time.
 *
 * Analytics file: <project>/.claude/hooks/.state/gutt-analytics.json
 * (or .cursor/hooks/.state/ for Cursor)
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_STATE_DIR } = require("./env.cjs");
const { debugLog } = require("./debug.cjs");

const STATE_DIR = path.join(PROJECT_STATE_DIR, "hooks", ".state");
const ANALYTICS_PATH = path.join(STATE_DIR, "gutt-analytics.json");

const DEFAULT_ANALYTICS = {
  totalSessions: 0,
  totalMemoryQueries: 0,
  totalLessonsCaptured: 0,
  agentDelegations: {},
  hookFirings: {},
  lastSessionAt: null,
};

/**
 * Load analytics from disk, returning defaults if missing or corrupt.
 * @returns {Object} Analytics data
 */
function loadAnalytics() {
  try {
    if (!fs.existsSync(ANALYTICS_PATH)) {
      return { ...DEFAULT_ANALYTICS };
    }
    const data = JSON.parse(fs.readFileSync(ANALYTICS_PATH, "utf8"));
    // Ensure all fields exist (forward-compat)
    return {
      ...DEFAULT_ANALYTICS,
      ...data,
      agentDelegations: data.agentDelegations || {},
      hookFirings: data.hookFirings || {},
    };
  } catch (err) {
    debugLog("cross-session-learner", `Failed to load analytics: ${err.message}`);
    return { ...DEFAULT_ANALYTICS };
  }
}

/**
 * Save analytics to disk.
 * @param {Object} analytics - Analytics data to persist
 */
function saveAnalytics(analytics) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(analytics, null, 2));
  } catch (err) {
    debugLog("cross-session-learner", `Failed to save analytics: ${err.message}`);
  }
}

/**
 * Record metrics from the ending/previous session into cumulative analytics.
 * Called from session-start.cjs to flush the previous session's data before clearing.
 *
 * @param {Object} sessionState - The session state object from session-state.cjs
 * @param {number} [sessionState.memoryQueries] - Memory queries from the session
 * @param {number} [sessionState.lessonsCaptured] - Lessons captured in the session
 * @returns {Object} Updated analytics
 */
function recordSessionMetrics(sessionState) {
  if (!sessionState || typeof sessionState !== "object") {
    return loadAnalytics();
  }

  const analytics = loadAnalytics();

  analytics.totalSessions += 1;
  analytics.totalMemoryQueries += sessionState.memoryQueries || 0;
  analytics.totalLessonsCaptured += sessionState.lessonsCaptured || 0;
  analytics.lastSessionAt = new Date().toISOString();

  saveAnalytics(analytics);
  return analytics;
}

/**
 * Record an agent delegation event.
 * @param {string} agentType - The agent type that was delegated to
 */
function recordAgentDelegation(agentType) {
  if (!agentType) {
    return;
  }
  const analytics = loadAnalytics();
  const key = agentType.toLowerCase();
  analytics.agentDelegations[key] = (analytics.agentDelegations[key] || 0) + 1;
  saveAnalytics(analytics);
}

/**
 * Record a hook firing event.
 * @param {string} hookName - The hook that fired
 */
function recordHookFiring(hookName) {
  if (!hookName) {
    return;
  }
  const analytics = loadAnalytics();
  analytics.hookFirings[hookName] = (analytics.hookFirings[hookName] || 0) + 1;
  saveAnalytics(analytics);
}

/**
 * Generate text insights from cumulative analytics.
 * Only produces insights once enough data has been collected (>= 10 sessions).
 *
 * @param {Object} [analyticsOverride] - Optional analytics to use (for testing)
 * @returns {string[]} Array of insight strings, empty if insufficient data
 */
function generateInsights(analyticsOverride) {
  const analytics = analyticsOverride || loadAnalytics();
  const insights = [];

  if (analytics.totalSessions < 10) {
    return insights;
  }

  // Average memory queries per session
  const avgQueries = (analytics.totalMemoryQueries / analytics.totalSessions).toFixed(1);
  insights.push(`Average memory queries per session: ${avgQueries}`);

  // Average lessons per session
  const avgLessons = (analytics.totalLessonsCaptured / analytics.totalSessions).toFixed(1);
  insights.push(`Average lessons captured per session: ${avgLessons}`);

  // Most used agent
  const delegations = analytics.agentDelegations;
  if (Object.keys(delegations).length > 0) {
    const sorted = Object.entries(delegations).sort((a, b) => b[1] - a[1]);
    const [topAgent, topCount] = sorted[0];
    insights.push(`Most used agent: ${topAgent} (${topCount} delegations)`);

    // Least used agent (if more than 2 agents)
    if (sorted.length > 2) {
      const [leastAgent, leastCount] = sorted[sorted.length - 1];
      insights.push(`Least used agent: ${leastAgent} (${leastCount} delegations)`);
    }
  }

  // Most fired hook
  const firings = analytics.hookFirings;
  if (Object.keys(firings).length > 0) {
    const sorted = Object.entries(firings).sort((a, b) => b[1] - a[1]);
    const [topHook, topCount] = sorted[0];
    insights.push(`Most active hook: ${topHook} (${topCount} firings)`);
  }

  // Sessions with no memory usage
  if (analytics.totalMemoryQueries === 0) {
    insights.push("No memory queries across all sessions — consider using gutt memory search");
  }

  return insights;
}

module.exports = {
  recordSessionMetrics,
  recordAgentDelegation,
  recordHookFiring,
  generateInsights,
  loadAnalytics,
  ANALYTICS_PATH,
};

// Allow direct execution for testing
if (require.main === module) {
  const analytics = loadAnalytics();
  console.log("Current analytics:", JSON.stringify(analytics, null, 2));
  const insights = generateInsights(analytics);
  if (insights.length > 0) {
    console.log("\nInsights:");
    insights.forEach((i) => console.log(`  - ${i}`));
  } else {
    console.log(`\nNot enough data for insights yet (${analytics.totalSessions}/10 sessions)`);
  }
}
