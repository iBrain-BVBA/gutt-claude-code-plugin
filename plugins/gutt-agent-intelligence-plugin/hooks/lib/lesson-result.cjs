#!/usr/bin/env node
/**
 * Parser for MCP fetch_lessons_learned tool_response payloads observed in
 * a PostToolUse hook context.
 *
 * Design invariant — signalling malformed-vs-empty
 * ------------------------------------------------
 * The previous `normalizeLessonsResult` returned `[]` both for "MCP replied
 * with an empty lessons list" AND for "shape unrecognized, could not parse".
 * That collapse is tolerable for a synchronous fetcher that throws on
 * upstream failure, but not for a PostToolUse scraper: the scraper MUST
 * preserve any prior cache when it cannot confidently parse, and MUST
 * overwrite with `[]` when the tool legitimately returned zero lessons.
 *
 * parseLessonsOrNull therefore returns:
 *   - `Array` (possibly empty) when the shape is recognized.
 *   - `null`  when the input is absent, unparseable, or structurally
 *             unexpected. Callers MUST NOT write to the cache in this case.
 *
 * Input shapes handled
 * --------------------
 * Observed variability across Claude Code hook payloads (see post-memory-ops.cjs):
 *   - `tool_response` arrives as a string OR as an already-parsed object.
 *   - The MCP `{content:[{type:"text", text:"..."}]}` wrapper is typically
 *     stripped by Claude Code before the hook sees it, leaving `{result:
 *     {lessons:[...]}}` or `{lessons:[...]}`. We handle the stripped-wrapper
 *     case AND keep a defensive content[].text branch in case a future
 *     Claude Code version stops stripping.
 *   - Both `{result: {...}}` and flat `{...}` top-level shapes appear.
 *   - Bare arrays may appear in legacy fixtures.
 */

"use strict";

const { debugLog } = require("./debug.cjs");

function parseLessonsOrNull(toolResponse) {
  if (toolResponse === null || toolResponse === undefined) {
    return null;
  }

  let parsed = toolResponse;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      debugLog("lesson-result", `string parse failed: ${err.message}`);
      return null;
    }
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  // Search both the result-wrapped and flat form. `.result` wins when present
  // because tool_response has historically nested meaningful payload under it.
  const candidates = [];
  if (parsed.result && typeof parsed.result === "object") {
    candidates.push(parsed.result);
  }
  candidates.push(parsed);

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (Array.isArray(candidate.lessons)) {
      return candidate.lessons;
    }
    if (Array.isArray(candidate.results)) {
      return candidate.results;
    }
    if (Array.isArray(candidate.content)) {
      const fromContent = extractFromContent(candidate.content);
      if (fromContent !== undefined) {
        return fromContent;
      }
    }
  }

  return null;
}

/**
 * Defensive path for the case where Claude Code did NOT pre-strip the
 * `content[].text` envelope. Returns:
 *   - `Array` when a text block parses into a recognizable shape
 *   - `null`  when a text block is present but unparseable/unknown
 *             (distinguished return — caller must preserve cache)
 *   - `undefined` when no text block exists in the content array (caller
 *             should continue searching other candidates)
 */
function extractFromContent(content) {
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      try {
        const inner = JSON.parse(block.text);
        if (Array.isArray(inner)) {
          return inner;
        }
        if (inner && typeof inner === "object") {
          if (Array.isArray(inner.lessons)) {
            return inner.lessons;
          }
          if (Array.isArray(inner.results)) {
            return inner.results;
          }
        }
        debugLog("lesson-result", "content[].text parsed but shape unrecognized");
        return null;
      } catch (err) {
        debugLog("lesson-result", `content[].text parse failed: ${err.message}`);
        return null;
      }
    }
  }
  return undefined;
}

module.exports = {
  parseLessonsOrNull,
};
