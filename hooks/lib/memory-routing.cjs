#!/usr/bin/env node
/**
 * Memory-Aware Agent Routing
 *
 * Adjusts agent scores based on historical performance data from the
 * gutt memory cache. Called after agent discovery, before routing decision.
 *
 * Pure function — no async MCP calls. Uses whatever is already cached
 * in gutt-memory-cache.json by earlier hooks.
 *
 * @module memory-routing
 */

const { debugLog } = require("./debug.cjs");

/**
 * Score boost for agents with positive track record in cached lessons.
 * Kept small to nudge without overriding graph relevance scores.
 */
const POSITIVE_BOOST = 0.1;

/**
 * Score penalty for agents associated with negative outcomes in cached lessons.
 */
const NEGATIVE_PENALTY = 0.1;

/**
 * Keywords in lesson outcomes that indicate failure.
 */
const NEGATIVE_OUTCOME_PATTERNS = [
  "fail",
  "error",
  "broke",
  "wrong",
  "incorrect",
  "reverted",
  "rollback",
];

/**
 * Keywords in lesson outcomes that indicate success.
 */
const POSITIVE_OUTCOME_PATTERNS = [
  "success",
  "resolved",
  "fixed",
  "improved",
  "approved",
  "shipped",
  "completed",
];

/**
 * Check if a lesson's outcome text matches any of the given patterns.
 * @param {string} text - Outcome or summary text
 * @param {string[]} patterns - Keyword patterns to match
 * @returns {boolean}
 */
function matchesPatterns(text, patterns) {
  if (!text || typeof text !== "string") {
    return false;
  }
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Adjusts agent scores based on historical performance from memory graph.
 * Called after agent discovery, before routing decision.
 *
 * @param {Array<{name: string, score: number, summary: string}>} agents
 *   Agent matches from discovery (MCP or seed fallback).
 * @param {object} memoryCache
 *   Cached memory data from getMemoryCache(). Expected shape:
 *   { lessons: Array<{summary, guidance, outcome}>, facts: Array<{fact, name}> }
 * @returns {Array<{name: string, score: number, summary: string}>}
 *   New array with adjusted scores, sorted by score descending.
 *   Original array is not mutated.
 */
function adjustScoresFromMemory(agents, memoryCache) {
  if (!agents || agents.length === 0) {
    return agents || [];
  }

  if (!memoryCache || (!Array.isArray(memoryCache.lessons) && !Array.isArray(memoryCache.facts))) {
    return agents;
  }

  const lessons = memoryCache.lessons || [];
  const facts = memoryCache.facts || [];

  // If cache is empty, nothing to adjust
  if (lessons.length === 0 && facts.length === 0) {
    return agents;
  }

  // Build a map of agent name → score adjustment
  const adjustments = {};

  // Scan lessons for agent name mentions
  for (const lesson of lessons) {
    const text = [lesson.summary, lesson.guidance, lesson.outcome].filter(Boolean).join(" ");
    const textLower = text.toLowerCase();

    for (const agent of agents) {
      const nameLower = agent.name.toLowerCase();
      if (!textLower.includes(nameLower)) {
        continue;
      }

      if (!adjustments[agent.name]) {
        adjustments[agent.name] = 0;
      }

      const outcomeText = lesson.outcome || lesson.summary || "";
      if (matchesPatterns(outcomeText, NEGATIVE_OUTCOME_PATTERNS)) {
        adjustments[agent.name] -= NEGATIVE_PENALTY;
        debugLog("memory-routing", `Negative adjustment for ${agent.name}: "${outcomeText}"`);
      } else if (matchesPatterns(outcomeText, POSITIVE_OUTCOME_PATTERNS)) {
        adjustments[agent.name] += POSITIVE_BOOST;
        debugLog("memory-routing", `Positive adjustment for ${agent.name}: "${outcomeText}"`);
      }
    }
  }

  // Scan facts for agent-related mentions (e.g. "[cfo-analyst] handles budget queries")
  for (const fact of facts) {
    const factText = [fact.fact, fact.name].filter(Boolean).join(" ").toLowerCase();

    for (const agent of agents) {
      const nameLower = agent.name.toLowerCase();
      if (!factText.includes(nameLower)) {
        continue;
      }

      // Facts mentioning an agent are a mild positive signal (agent is known to the org)
      if (!adjustments[agent.name]) {
        adjustments[agent.name] = 0;
      }
      adjustments[agent.name] += POSITIVE_BOOST * 0.5;
    }
  }

  // Apply adjustments, clamping scores to [0, 1]
  const adjusted = agents.map((agent) => {
    const delta = adjustments[agent.name] || 0;
    if (delta === 0) {
      return agent;
    }

    const newScore = Math.max(0, Math.min(1, agent.score + delta));
    return { ...agent, score: newScore };
  });

  // Re-sort by score descending
  adjusted.sort((a, b) => b.score - a.score);

  return adjusted;
}

module.exports = {
  adjustScoresFromMemory,
  // Exported for testing
  matchesPatterns,
  POSITIVE_BOOST,
  NEGATIVE_PENALTY,
  NEGATIVE_OUTCOME_PATTERNS,
  POSITIVE_OUTCOME_PATTERNS,
};
