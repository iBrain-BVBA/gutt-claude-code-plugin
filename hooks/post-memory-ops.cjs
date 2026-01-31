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
    const toolResult = data.tool_result || {};

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
    } else if (toolName === "mcp__gutt-mcp-remote__fetch_lessons_learned") {
      setConnectionStatus("ok");
      incrementMemoryQueries();
      const query = toolInput.query || "lessons";
      const result = extractFirstResult(toolResult);
      addTickerItem({
        icon: "📥",
        text: `Fetched "${truncate(query, 15)}" → "${truncate(result, 15)}"`,
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
