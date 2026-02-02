#!/usr/bin/env node
/**
 * GUTT Post-Memory Operations Hook
 * Tracks all memory MCP tool calls for statusline stats and ticker
 * Consolidates: add_memory, search_memory_facts, fetch_lessons_learned
 */

const {
  incrementLessonsCaptured,
  incrementMemoryQueries,
  addTickerItem,
  setConnectionStatus,
} = require("./lib/session-state.cjs");
const { updateMemoryCache, addQueryToCache } = require("./lib/memory-cache.cjs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || "";
    const toolInput = data.tool_input || {};
    const toolResult = data.tool_response || data.tool_result || {};

    if (toolName === "mcp__gutt-mcp-remote__add_memory") {
      setConnectionStatus("ok");
      incrementLessonsCaptured();
      const name = toolInput.name || "memory";
      addTickerItem({
        icon: "📤",
        text: `Created "${truncate(name, 25)}"`,
      });
    } else if (toolName === "mcp__gutt-mcp-remote__search_memory_facts") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const query = toolInput.query || "query";
      const result = extractFirstResult(toolResult);
      addTickerItem({
        icon: "📥",
        text: `Fetched "${truncate(query, 15)}" → "${truncate(result, 15)}"`,
      });

      // Cache the facts for subagent injection
      const facts = extractFacts(toolResult);
      if (facts.length > 0) {
        updateMemoryCache("facts", facts);
        addQueryToCache(query);
      }
    } else if (toolName === "mcp__gutt-mcp-remote__fetch_lessons_learned") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const query = toolInput.query || "lessons";
      const result = extractFirstResult(toolResult);
      addTickerItem({
        icon: "📥",
        text: `Fetched "${truncate(query, 15)}" → "${truncate(result, 15)}"`,
      });

      // Cache the lessons for subagent injection
      const lessons = extractLessons(toolResult);
      if (lessons.length > 0) {
        updateMemoryCache("lessons", lessons);
        addQueryToCache(query);
      }
    } else if (toolName === "mcp__gutt-mcp-remote__search_memory_nodes") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const query = toolInput.query || "nodes";
      const result = extractFirstResult(toolResult);
      addTickerItem({
        icon: "📥",
        text: `Fetched "${truncate(query, 15)}" → "${truncate(result, 15)}"`,
      });
    } else if (toolName === "mcp__gutt-mcp-remote__get_user_preferences") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const contextType = toolInput.context_type || "general";
      addTickerItem({
        icon: "⚙️",
        text: `Fetched preferences (${truncate(contextType, 15)})`,
      });
    } else if (toolName === "mcp__gutt-mcp-remote__get_episodes") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const lastN = toolInput.last_n || 10;
      addTickerItem({
        icon: "📜",
        text: `Fetched last ${lastN} episodes`,
      });
    } else if (toolName === "mcp__gutt-mcp-remote__get_episode") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const uuid = toolInput.episode_uuid || "unknown";
      addTickerItem({
        icon: "📜",
        text: `Fetched episode ${truncate(uuid, 12)}`,
      });
    } else if (toolName === "mcp__gutt-mcp-remote__get_entity_edge") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const uuid = toolInput.uuid || "unknown";
      addTickerItem({
        icon: "🔗",
        text: `Fetched edge ${truncate(uuid, 12)}`,
      });
    }
  } catch {
    // Silent exit
  }
  process.exit(0);
});

function truncate(str, max) {
  if (!str) {
    return "...";
  }
  return str.length > max ? str.substring(0, max - 1) + "…" : str;
}

function extractFirstResult(result) {
  try {
    // Handle various result structures
    if (typeof result === "string") {
      const parsed = JSON.parse(result);
      if (parsed.result?.facts?.[0]?.fact) {
        return parsed.result.facts[0].fact;
      }
      if (parsed.result?.lessons?.[0]?.lesson) {
        return parsed.result.lessons[0].lesson;
      }
      if (parsed.result?.message) {
        return parsed.result.message;
      }
    }
    if (result?.result?.facts?.[0]?.fact) {
      return result.result.facts[0].fact;
    }
    if (result?.result?.lessons?.[0]?.lesson) {
      return result.result.lessons[0].lesson;
    }
  } catch {
    // Silent - return default
  }
  return "found";
}

/**
 * Extract facts array from tool result for caching
 * @param {object|string} result - The tool result
 * @returns {Array} Array of fact objects { fact, name }
 */
function extractFacts(result) {
  try {
    let parsed = result;
    if (typeof result === "string") {
      parsed = JSON.parse(result);
    }

    const facts = parsed?.result?.facts || parsed?.facts || [];
    return facts
      .map((f) => ({
        fact: f.fact || f.content || String(f),
        name: f.name || f.entity_name || null,
      }))
      .filter((f) => f.fact);
  } catch {
    return [];
  }
}

/**
 * Extract lessons array from tool result for caching
 * @param {object|string} result - The tool result
 * @returns {Array} Array of lesson objects { summary, guidance, outcome }
 */
function extractLessons(result) {
  try {
    let parsed = result;
    if (typeof result === "string") {
      parsed = JSON.parse(result);
    }

    const lessons = parsed?.result?.lessons || parsed?.lessons || [];
    return lessons
      .map((l) => ({
        summary: l.lesson || l.summary || l.content || String(l),
        guidance: l.guidance || l.recommendation || null,
        outcome: l.outcome || null,
      }))
      .filter((l) => l.summary);
  } catch {
    return [];
  }
}
