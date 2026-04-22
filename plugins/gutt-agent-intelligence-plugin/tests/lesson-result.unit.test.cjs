#!/usr/bin/env node
/**
 * lesson-result — unit tests.
 *
 * Covers the parse contract used by the PostToolUse scraper: recognized
 * shapes return an array (possibly empty); unrecognized shapes return
 * null so the scraper can preserve any prior cache.
 *
 * Run: node --test plugins/gutt-agent-intelligence-plugin/tests/lesson-result.unit.test.cjs
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseLessonsOrNull } = require("../hooks/lib/lesson-result.cjs");

// ---------------------------------------------------------------------------
// Null / malformed inputs — scraper MUST see null so it preserves cache
// ---------------------------------------------------------------------------

test("parseLessonsOrNull: null/undefined ⇒ null", () => {
  assert.equal(parseLessonsOrNull(null), null);
  assert.equal(parseLessonsOrNull(undefined), null);
});

test("parseLessonsOrNull: non-parseable string ⇒ null", () => {
  assert.equal(parseLessonsOrNull("{not valid"), null);
  assert.equal(parseLessonsOrNull("definitely not json"), null);
});

test("parseLessonsOrNull: primitive non-string ⇒ null", () => {
  assert.equal(parseLessonsOrNull(42), null);
  assert.equal(parseLessonsOrNull(true), null);
});

test("parseLessonsOrNull: unrecognized object shape ⇒ null", () => {
  assert.equal(parseLessonsOrNull({ unexpected: true }), null);
  assert.equal(parseLessonsOrNull({ result: { unexpected: true } }), null);
});

// ---------------------------------------------------------------------------
// Recognized shapes — scraper writes whatever is returned (even []).
// ---------------------------------------------------------------------------

test("parseLessonsOrNull: direct array ⇒ same array", () => {
  const arr = [{ summary: "one" }, { summary: "two" }];
  assert.deepEqual(parseLessonsOrNull(arr), arr);
});

test("parseLessonsOrNull: empty array ⇒ empty array (legitimate-empty, not malformed)", () => {
  assert.deepEqual(parseLessonsOrNull([]), []);
});

test("parseLessonsOrNull: {lessons:[...]} at top level ⇒ lessons", () => {
  assert.deepEqual(parseLessonsOrNull({ lessons: [{ summary: "L" }] }), [{ summary: "L" }]);
});

test("parseLessonsOrNull: {results:[...]} at top level ⇒ results", () => {
  assert.deepEqual(parseLessonsOrNull({ results: [{ summary: "R" }] }), [{ summary: "R" }]);
});

test("parseLessonsOrNull: {result:{lessons:[...]}} wrapper ⇒ lessons", () => {
  assert.deepEqual(parseLessonsOrNull({ result: { lessons: [{ summary: "wrapped" }] } }), [
    { summary: "wrapped" },
  ]);
});

test("parseLessonsOrNull: {result:{results:[...]}} wrapper ⇒ results", () => {
  assert.deepEqual(parseLessonsOrNull({ result: { results: [{ summary: "wrapped-r" }] } }), [
    { summary: "wrapped-r" },
  ]);
});

test("parseLessonsOrNull: result wrapper prefers inner shape over flat keys", () => {
  // If both present, result-wrapped wins — that's the shape MCP actually
  // returns through a server-to-server call.
  const val = parseLessonsOrNull({
    result: { lessons: [{ summary: "from-result" }] },
    lessons: [{ summary: "from-flat" }],
  });
  assert.deepEqual(val, [{ summary: "from-result" }]);
});

test("parseLessonsOrNull: empty lessons array from server ⇒ [] (legit overwrite)", () => {
  assert.deepEqual(parseLessonsOrNull({ result: { lessons: [] } }), []);
  assert.deepEqual(parseLessonsOrNull({ lessons: [] }), []);
});

// ---------------------------------------------------------------------------
// String input — JSON-parse then re-dispatch
// ---------------------------------------------------------------------------

test("parseLessonsOrNull: stringified object ⇒ parsed lessons", () => {
  const raw = JSON.stringify({ result: { lessons: [{ summary: "str" }] } });
  assert.deepEqual(parseLessonsOrNull(raw), [{ summary: "str" }]);
});

test("parseLessonsOrNull: stringified array ⇒ parsed array", () => {
  const raw = JSON.stringify([{ summary: "a" }]);
  assert.deepEqual(parseLessonsOrNull(raw), [{ summary: "a" }]);
});

test("parseLessonsOrNull: stringified unrecognized shape ⇒ null", () => {
  const raw = JSON.stringify({ unexpected: true });
  assert.equal(parseLessonsOrNull(raw), null);
});

// ---------------------------------------------------------------------------
// Defensive content[].text branch — in case future Claude Code stops
// stripping the MCP envelope.
// ---------------------------------------------------------------------------

test("parseLessonsOrNull: content[].text wrapping an array ⇒ array", () => {
  const raw = {
    content: [{ type: "text", text: JSON.stringify([{ summary: "ct-array" }]) }],
  };
  assert.deepEqual(parseLessonsOrNull(raw), [{ summary: "ct-array" }]);
});

test("parseLessonsOrNull: content[].text wrapping {lessons:[]} ⇒ lessons", () => {
  const raw = {
    content: [{ type: "text", text: JSON.stringify({ lessons: [{ summary: "ct-L" }] }) }],
  };
  assert.deepEqual(parseLessonsOrNull(raw), [{ summary: "ct-L" }]);
});

test("parseLessonsOrNull: content[].text with bad JSON ⇒ null (don't overwrite cache)", () => {
  const raw = { content: [{ type: "text", text: "{not valid" }] };
  assert.equal(parseLessonsOrNull(raw), null);
});

test("parseLessonsOrNull: content[].text parsing to unknown shape ⇒ null", () => {
  const raw = {
    content: [{ type: "text", text: JSON.stringify({ something: "else" }) }],
  };
  assert.equal(parseLessonsOrNull(raw), null);
});

test("parseLessonsOrNull: content[] with no text block ⇒ null", () => {
  const raw = { content: [{ type: "image", data: "..." }] };
  assert.equal(parseLessonsOrNull(raw), null);
});

test("parseLessonsOrNull: content[] wrapped in {result:...} ⇒ array", () => {
  const raw = {
    result: {
      content: [{ type: "text", text: JSON.stringify([{ summary: "nested" }]) }],
    },
  };
  assert.deepEqual(parseLessonsOrNull(raw), [{ summary: "nested" }]);
});
