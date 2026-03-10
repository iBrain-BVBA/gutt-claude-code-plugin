#!/usr/bin/env node
/**
 * SSE Multi-Event Parsing Unit Tests
 * Tests the SSE parsing logic used by callMcpTool in agent-discovery.cjs.
 *
 * Regression tests for the bug where ALL data: lines were joined into one
 * string before JSON.parse, breaking multi-event SSE streams.
 * The fix takes only the LAST data: event.
 *
 * Runs without live MCP — pure parsing logic tests.
 * CI-compatible, no external dependencies beyond Node.js built-ins.
 *
 * Usage:
 *   node tests/routing/sse-parsing.unit.test.cjs
 */

"use strict";

const assert = require("assert");
const { parseSseResponse: _parseSseRaw } = require("../../hooks/lib/agent-discovery.cjs");

// ---------------------------------------------------------------------------
// Test runner (same pattern as router.unit.test.cjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The imported parseSseResponse returns a raw JSON string.
// Wrap it so existing tests that expect parsed objects keep working.
const parseSseResponse = (data) => JSON.parse(_parseSseRaw(data));

console.log("\nSSE Multi-Event Parsing Tests\n");

// ── Single SSE event ────────────────────────────────────────────────────────

console.log("Single SSE event:");

test("single data: line parses correctly", () => {
  const data = 'data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.jsonrpc, "2.0");
  assert.strictEqual(parsed.id, 1);
  assert.deepStrictEqual(parsed.result.content, []);
});

test("single data: line with text content parses correctly", () => {
  const data =
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello world"}]}}\n\n';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.result.content[0].type, "text");
  assert.strictEqual(parsed.result.content[0].text, "hello world");
});

// ── Multi-event SSE stream (regression) ─────────────────────────────────────

console.log("\nMulti-event SSE stream (regression):");

test("multi-event stream takes LAST event only", () => {
  const data =
    'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"processing"}}\n\n' +
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}\n\n';
  const parsed = parseSseResponse(data);
  // Must get the LAST event (the result), not the first (the notification)
  assert.strictEqual(parsed.id, 1);
  assert.ok(parsed.result, "Should have result property from last event");
  assert.strictEqual(parsed.result.content[0].text, "hello");
  // Must NOT have method property from first event
  assert.strictEqual(parsed.method, undefined, "Should not contain first event's method");
});

test("multi-event with three events takes the last one", () => {
  const data =
    'data: {"jsonrpc":"2.0","method":"notifications/initialized"}\n\n' +
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}\n\n' +
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"done"}]}}\n\n';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.id, 1);
  assert.strictEqual(parsed.result.content[0].text, "done");
  assert.strictEqual(parsed.method, undefined);
});

test("multi-event where first is invalid JSON-RPC result but last is valid", () => {
  // First event: notification (no id, no result)
  // Last event: proper JSON-RPC result
  const data =
    'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"warning","data":"rate limited"}}\n\n' +
    'data: {"jsonrpc":"2.0","id":42,"result":{"content":[{"type":"text","text":"agent response"}]}}\n\n';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.id, 42);
  assert.ok(parsed.result, "Last event should have result");
  assert.strictEqual(parsed.result.content[0].text, "agent response");
  // Verify we did NOT get notification fields
  assert.strictEqual(parsed.method, undefined);
  assert.strictEqual(parsed.params, undefined);
});

// ── Plain JSON (non-SSE) ────────────────────────────────────────────────────

console.log("\nPlain JSON (non-SSE):");

test("plain JSON object passes through unchanged", () => {
  const data = '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.jsonrpc, "2.0");
  assert.strictEqual(parsed.id, 1);
  assert.deepStrictEqual(parsed.result.content, []);
});

test("plain JSON with nested content passes through", () => {
  const data =
    '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"from plain json"}]}}';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.result.content[0].text, "from plain json");
});

// ── Edge cases ──────────────────────────────────────────────────────────────

console.log("\nEdge cases:");

test("data: line with extra whitespace after prefix", () => {
  const data = 'data:   {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.id, 1);
  assert.deepStrictEqual(parsed.result.content, []);
});

test("SSE with blank lines between events", () => {
  const data =
    'data: {"jsonrpc":"2.0","method":"notifications/init"}\n\n\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}\n\n';
  const parsed = parseSseResponse(data);
  assert.strictEqual(parsed.id, 1);
  assert.strictEqual(parsed.result.content[0].text, "ok");
});

test("throws on invalid JSON in data: line", () => {
  const data = "data: not-valid-json\n\n";
  assert.throws(() => parseSseResponse(data), /Unexpected token/, "Should throw JSON parse error");
});

test("throws on empty data: line", () => {
  const data = "data:\n\n";
  assert.throws(
    () => parseSseResponse(data),
    /no parseable data/,
    "Should throw when data: line is empty"
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => {
    console.log(`  \u2717 ${f.name}`);
    console.log(`    ${f.message}`);
  });
}

console.log("");
process.exit(failed > 0 ? 1 : 0);
