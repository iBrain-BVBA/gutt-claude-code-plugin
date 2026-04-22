#!/usr/bin/env node
/**
 * Grounding formatter — unit tests.
 *
 * Verifies banner content, 3-tool mention, lesson rendering, and the
 * 3-branch dispatch inside renderSubagentGrounding.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  renderSessionGrounding,
  renderSubagentGrounding,
  renderLesson,
  preview,
} = require("../hooks/lib/grounding-formatter.cjs");

// ---------------------------------------------------------------------------
// renderLesson — summary-shape resilience
// ---------------------------------------------------------------------------

test("renderLesson handles object-shaped summary via .text", () => {
  // Guards against a future fetch_lessons_learned schema that returns
  // `summary: { text, embedding }` instead of a plain string.
  const bullet = renderLesson({ summary: { text: "wrapped summary text" } });
  assert.match(bullet, /wrapped summary text/);
});

test("renderLesson falls back to name when summary is a non-string without .text", () => {
  const bullet = renderLesson({ summary: { embedding: [0.1] }, name: "fallback-name" });
  assert.match(bullet, /fallback-name/);
});

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

test("preview passes short strings through unchanged", () => {
  assert.equal(preview("hello"), "hello");
});

test("preview collapses whitespace runs", () => {
  assert.equal(preview("a   b\n\nc"), "a b c");
});

test("preview truncates with an ellipsis above max", () => {
  const long = "x".repeat(300);
  const out = preview(long, 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith("…"));
});

test("preview handles non-string input", () => {
  assert.equal(preview(undefined), "");
  assert.equal(preview(null), "");
});

// ---------------------------------------------------------------------------
// renderLesson
// ---------------------------------------------------------------------------

test("renderLesson includes summary, guidance, and outcome when present", () => {
  const out = renderLesson({
    summary: "always commit atomically",
    guidance: "one concern per commit",
    outcome: "bisect becomes painless",
  });
  assert.match(out, /always commit atomically/);
  assert.match(out, /one concern per commit/);
  assert.match(out, /bisect becomes painless/);
  assert.ok(out.startsWith("- "));
});

test("renderLesson falls back to name when summary missing", () => {
  const out = renderLesson({ name: "Fallback Name" });
  assert.match(out, /Fallback Name/);
});

test("renderLesson works with only a summary", () => {
  const out = renderLesson({ summary: "keep it short" });
  assert.equal(out, "- keep it short");
});

test("renderLesson returns null when neither summary nor name is usable", () => {
  // Guards against emitting a meaningless "- lesson" bullet when the MCP
  // server returns a malformed record. Callers must filter out nulls.
  assert.equal(renderLesson({}), null);
  assert.equal(renderLesson({ summary: "", name: "" }), null);
  assert.equal(renderLesson({ summary: { embedding: [0.1] } }), null);
});

test("renderLesson returns null for null/undefined/scalar records without throwing", () => {
  // Property access on null/undefined would throw and kill the downstream
  // .map(renderLesson) in renderSessionGrounding. Scalars don't throw but
  // still can't produce a bullet, so they must also be filtered here.
  assert.equal(renderLesson(null), null);
  assert.equal(renderLesson(undefined), null);
  assert.equal(renderLesson("just a string"), null);
  assert.equal(renderLesson(42), null);
});

test("renderSessionGrounding tolerates null and scalar records in the lessons array", () => {
  const out = renderSessionGrounding({
    agentId: "gutt-agent-demo",
    lessons: [null, "bogus", 0, { summary: "real lesson" }, undefined],
  });
  assert.match(out, /real lesson/);
});

test("renderSessionGrounding drops malformed records rather than rendering placeholders", () => {
  const out = renderSessionGrounding({
    agentId: "gutt-agent-demo",
    lessons: [{ summary: "real lesson" }, {}, { summary: "" }],
  });
  assert.match(out, /real lesson/);
  assert.doesNotMatch(out, /- lesson\b/);
});

// ---------------------------------------------------------------------------
// renderSessionGrounding
// ---------------------------------------------------------------------------

test("renderSessionGrounding includes agent id in banner", () => {
  const out = renderSessionGrounding({
    agentId: "gutt-agent-demo",
    lessons: [],
  });
  assert.match(out, /agent "gutt-agent-demo"/);
});

test("renderSessionGrounding references all three memory tools", () => {
  const out = renderSessionGrounding({
    agentId: "gutt-agent-demo",
    lessons: [],
  });
  assert.match(out, /add_memory/);
  assert.match(out, /fetch_lessons_learned/);
  assert.match(out, /search_memory_nodes/);
});

test("renderSessionGrounding marks search_memory_nodes agent_id as optional", () => {
  const out = renderSessionGrounding({
    agentId: "gutt-agent-demo",
    lessons: [],
  });
  assert.match(out, /search_memory_nodes.+optional/i);
});

test("renderSessionGrounding renders all lessons up to maxLessons", () => {
  const lessons = Array.from({ length: 5 }, (_, i) => ({ summary: `lesson ${i}` }));
  const out = renderSessionGrounding({
    agentId: "gutt-agent-demo",
    lessons,
    maxLessons: 3,
  });
  assert.match(out, /lesson 0/);
  assert.match(out, /lesson 1/);
  assert.match(out, /lesson 2/);
  assert.ok(!out.includes("lesson 3"), "lesson 3 should be excluded");
});

test("renderSessionGrounding handles empty lessons gracefully", () => {
  const out = renderSessionGrounding({ agentId: "gutt-agent-demo" });
  assert.match(out, /No accumulated lessons/);
});

test("renderSessionGrounding has opening and closing sentinels", () => {
  const out = renderSessionGrounding({ agentId: "gutt-agent-demo", lessons: [] });
  assert.match(out, /^\[GUTT Agent Grounding\]/);
  assert.match(out, /\[End GUTT Agent Grounding\]$/);
});

// ---------------------------------------------------------------------------
// renderSubagentGrounding — 3-branch dispatch
// ---------------------------------------------------------------------------

test("subagent memory-keeper receives parent's agent_id as proxy", () => {
  const out = renderSubagentGrounding({
    subagentType: "memory-keeper",
    parentAgentId: "gutt-agent-parent",
  });
  assert.match(out, /memory-keeper/);
  assert.match(out, /agent_id="gutt-agent-parent"/);
  assert.match(out, /Lessons bind to the learner/);
});

test("subagent gutt-pro-memory is told agent_id is optional", () => {
  const out = renderSubagentGrounding({
    subagentType: "gutt-pro-memory",
    parentAgentId: "gutt-agent-parent",
  });
  assert.match(out, /gutt-pro-memory/);
  assert.match(out, /OPTIONAL/);
  assert.match(out, /search_memory_nodes/);
});

test("default subagent uses its own subagent_type as agent_id", () => {
  const out = renderSubagentGrounding({
    subagentType: "plugin-dev",
    parentAgentId: "gutt-agent-parent",
  });
  assert.match(out, /plugin-dev/);
  assert.match(out, /agent_id="plugin-dev"/);
  assert.ok(!out.includes("gutt-agent-parent"), "default branch must not leak parent id");
});

test("default subagent instructs all three tools", () => {
  const out = renderSubagentGrounding({
    subagentType: "bug-investigator",
    parentAgentId: "gutt-agent-parent",
  });
  assert.match(out, /add_memory/);
  assert.match(out, /fetch_lessons_learned/);
  assert.match(out, /search_memory_nodes/);
});

test("subagent template has opening and closing sentinels", () => {
  const out = renderSubagentGrounding({
    subagentType: "pr-reviewer",
    parentAgentId: "gutt-agent-parent",
  });
  assert.match(out, /^\[GUTT Agent Binding/);
  assert.match(out, /\[End GUTT Agent Binding\]$/);
});
