#!/usr/bin/env node
/**
 * GUTT Memory Cache Utility
 * Session-scoped cache for memory results to enable deterministic injection into subagents
 *
 * Flow:
 * 1. PostToolUse[mcp__gutt] caches memory results from MCP calls (via post-memory-ops.cjs in main plugin)
 * 2. PreToolUse on Task stores search query
 * 3. SubagentStart injects cached results directly into subagent context
 */

const { statePath, readJson, writeJson } = require("./plugin-state.cjs");

// Global memory cache under ${CLAUDE_PLUGIN_DATA} (R37, GP-855). Still one shared
// file today; migrating it to per-session is GP-863's job (D3 in the GP-862 ADR).
function cachePath() {
  return statePath("memory-cache.json");
}

const DEFAULT_CACHE = {
  updatedAt: null,
  lessons: [], // Array of { summary, guidance, outcome }
  facts: [], // Array of { fact, name }
  queries: [], // Recent search queries
  lastSearchQuery: null, // Query set by PreToolUse for SubagentStart to use
  lastAgentName: null, // Agent name set by PreToolUse for SubagentStart seed lookup
  resolvedGroupId: null, // group_id resolved by orchestrator process for SubagentStart to use
};

const MAX_LESSONS = 10;
const MAX_FACTS = 10;
const MAX_QUERIES = 5;

/**
 * Get the current memory cache
 * @returns {object} The cached memory data
 */
function getMemoryCache() {
  return readJson(cachePath(), { ...DEFAULT_CACHE });
}

/**
 * Update the memory cache with new results
 * @param {string} type - 'lessons' or 'facts'
 * @param {Array} results - Array of results to cache
 */
function updateMemoryCache(type, results) {
  const cache = getMemoryCache();

  if (type === "lessons" && Array.isArray(results)) {
    // Merge new lessons, keeping most recent
    const existingIds = new Set(cache.lessons.map((l) => l.summary));
    const newLessons = results.filter((l) => !existingIds.has(l.summary));
    cache.lessons = [...newLessons, ...cache.lessons].slice(0, MAX_LESSONS);
  } else if (type === "facts" && Array.isArray(results)) {
    // Merge new facts, keeping most recent
    const existingIds = new Set(cache.facts.map((f) => f.fact));
    const newFacts = results.filter((f) => !existingIds.has(f.fact));
    cache.facts = [...newFacts, ...cache.facts].slice(0, MAX_FACTS);
  }

  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  return cache;
}

/**
 * Add a search query to the cache history
 * @param {string} query - The search query
 */
function addQueryToCache(query) {
  if (!query) {
    return;
  }

  const cache = getMemoryCache();

  // Add to queries list (avoid duplicates)
  if (!cache.queries.includes(query)) {
    cache.queries = [query, ...cache.queries].slice(0, MAX_QUERIES);
  }

  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  return cache;
}

/**
 * Set the last search query (for SubagentStart to use)
 * @param {string} query - The search query extracted from task prompt
 */
function setLastSearchQuery(query) {
  const cache = getMemoryCache();
  cache.lastSearchQuery = query;
  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  return cache;
}

/**
 * Get the last search query
 * @returns {string|null} The last search query
 */
function getLastSearchQuery() {
  const cache = getMemoryCache();
  return cache.lastSearchQuery;
}

/**
 * Set the last agent name (for SubagentStart seed lookup)
 * PreToolUse[Task] stores this from tool_input.name
 *
 * KNOWN LIMITATION: This is a global singleton. When multiple subagents are
 * dispatched in parallel, later PreToolUse calls overwrite earlier values.
 * This is acceptable because:
 * 1. The PRIMARY lookup path is agent_type (from SubagentStart payload), which is race-free
 * 2. lastAgentName is a FALLBACK for when agent_type doesn't match a seed
 * 3. In practice, parallel dispatches are rare for seed-aware agents
 *
 * @param {string} name - The agent name from Task tool input
 */
function setLastAgentName(name) {
  const cache = getMemoryCache();
  cache.lastAgentName = name;
  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  return cache;
}

/**
 * Get the last agent name
 * @returns {string|null} The agent name set by PreToolUse
 */
function getLastAgentName() {
  const cache = getMemoryCache();
  return cache.lastAgentName;
}

/**
 * Store the resolved group_id so SubagentStart can use it
 * Called by PreToolUse where the orchestrator has access to config.json
 * @param {string} groupId - The resolved group_id
 */
function setResolvedGroupId(groupId) {
  const cache = getMemoryCache();
  cache.resolvedGroupId = groupId;
  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  return cache;
}

/**
 * Get the resolved group_id from cache
 * @returns {string|null} The group_id stored by PreToolUse
 */
function getResolvedGroupId() {
  const cache = getMemoryCache();
  return cache.resolvedGroupId;
}

/**
 * Clear the memory cache (call on session start)
 */
function clearMemoryCache() {
  writeCache({ ...DEFAULT_CACHE });
}

/**
 * Get the age of the cache in milliseconds
 * @returns {number|null} Age in ms, or null if no cache
 */
function getCacheAge() {
  const cache = getMemoryCache();
  if (!cache.updatedAt) {
    return null;
  }

  const updatedAt = new Date(cache.updatedAt).getTime();
  return Date.now() - updatedAt;
}

/**
 * Check if cache has meaningful content
 * @returns {boolean} True if cache has lessons or facts
 */
function hasCachedContent() {
  const cache = getMemoryCache();
  return cache.lessons.length > 0 || cache.facts.length > 0;
}

/**
 * Format cached memory for injection into subagent context
 * @returns {string} Formatted memory context
 */
function formatMemoryContext() {
  const cache = getMemoryCache();

  if (!hasCachedContent()) {
    return null;
  }

  const parts = ["[GUTT Organizational Memory]"];

  if (cache.lessons.length > 0) {
    parts.push("\n**Lessons Learned:**");
    cache.lessons.slice(0, 5).forEach((lesson, i) => {
      const outcome = lesson.outcome ? ` (${lesson.outcome})` : "";
      parts.push(`${i + 1}. ${lesson.summary}${outcome}`);
      if (lesson.guidance) {
        parts.push(`   Guidance: ${lesson.guidance}`);
      }
    });
  }

  if (cache.facts.length > 0) {
    parts.push("\n**Relevant Facts:**");
    cache.facts.slice(0, 5).forEach((fact, i) => {
      const name = fact.name ? `[${fact.name}] ` : "";
      parts.push(`${i + 1}. ${name}${fact.fact}`);
    });
  }

  parts.push("\n[End GUTT Memory]");

  return parts.join("\n");
}

/**
 * Write cache to disk (atomic, via the shared state helper).
 * @param {object} cache - The cache object to write
 */
function writeCache(cache) {
  writeJson(cachePath(), cache);
}

module.exports = {
  getMemoryCache,
  updateMemoryCache,
  addQueryToCache,
  setLastSearchQuery,
  getLastSearchQuery,
  setLastAgentName,
  getLastAgentName,
  setResolvedGroupId,
  getResolvedGroupId,
  clearMemoryCache,
  getCacheAge,
  hasCachedContent,
  formatMemoryContext,
  DEFAULT_CACHE,
};
