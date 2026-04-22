#!/usr/bin/env node
/**
 * post-lesson-scrape — integration tests.
 *
 * Spawns the hook as a child process and feeds it synthetic PostToolUse
 * payloads. Verifies the write/no-write semantics:
 *   - fetch_lessons_learned with recognized tool_response ⇒ cache written
 *   - fetch_lessons_learned with empty lessons list ⇒ cache overwritten (legit-empty)
 *   - fetch_lessons_learned with malformed response ⇒ cache preserved
 *   - fetch_lessons_learned without tool_input.agent_id ⇒ no write
 *   - register_agent ⇒ .registered-<name>.marker written
 *   - non-matching action ⇒ no side effects
 *   - malformed stdin ⇒ no crash
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "..", "hooks", "post-lesson-scrape.cjs");

function runHook(payload, env) {
  return spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

function makeCacheDir(prefix = "post-lesson-scrape-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedCache(dir, agentId, lessons) {
  const subdir = path.join(dir, "agent-intelligence");
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(
    path.join(subdir, `lessons-${agentId}.json`),
    JSON.stringify({ agentId, updatedAt: Date.now(), lessons })
  );
}

function readCache(dir, agentId) {
  const file = path.join(dir, "agent-intelligence", `lessons-${agentId}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// fetch_lessons_learned
// ---------------------------------------------------------------------------

test("fetch_lessons_learned with recognized tool_response writes cache", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-x", max_results: 10 },
        tool_response: { result: { lessons: [{ summary: "from-scrape" }] } },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0, `non-zero exit: ${res.stderr}`);
    const cached = readCache(dir, "gutt-agent-x");
    assert.ok(cached, "cache file should be written");
    assert.deepEqual(cached.lessons, [{ summary: "from-scrape" }]);
    assert.equal(cached.agentId, "gutt-agent-x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch_lessons_learned tolerates string tool_response", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-str" },
        tool_response: JSON.stringify({ result: { lessons: [{ summary: "via-string" }] } }),
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const cached = readCache(dir, "gutt-agent-str");
    assert.deepEqual(cached.lessons, [{ summary: "via-string" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch_lessons_learned falls back to tool_result field", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-oldfield" },
        // Older Claude Code used `tool_result` instead of `tool_response`.
        tool_result: { lessons: [{ summary: "legacy-field" }] },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const cached = readCache(dir, "gutt-agent-oldfield");
    assert.deepEqual(cached.lessons, [{ summary: "legacy-field" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch_lessons_learned with empty lessons overwrites cache (legit-empty)", () => {
  const dir = makeCacheDir();
  try {
    seedCache(dir, "gutt-agent-empty", [{ summary: "old" }]);
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-empty" },
        tool_response: { result: { lessons: [] } },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const cached = readCache(dir, "gutt-agent-empty");
    assert.deepEqual(cached.lessons, [], "successful empty result IS a signal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch_lessons_learned with malformed tool_response preserves cache", () => {
  const dir = makeCacheDir();
  try {
    seedCache(dir, "gutt-agent-kept", [{ summary: "preserved" }]);
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-kept" },
        tool_response: { something: "unexpected" },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const cached = readCache(dir, "gutt-agent-kept");
    assert.deepEqual(
      cached.lessons,
      [{ summary: "preserved" }],
      "malformed tool_response must not wipe cache"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch_lessons_learned without tool_input.agent_id writes nothing", () => {
  const dir = makeCacheDir();
  try {
    seedCache(dir, "gutt-agent-orig", [{ summary: "orig" }]);
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__fetch_lessons_learned",
        tool_input: {},
        tool_response: { result: { lessons: [{ summary: "would-be-lost" }] } },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const origCached = readCache(dir, "gutt-agent-orig");
    assert.deepEqual(origCached.lessons, [{ summary: "orig" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// register_agent
// ---------------------------------------------------------------------------

test("register_agent writes .registered-<name>.marker", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__register_agent",
        tool_input: { name: "gutt-agent-new", description: "x" },
        tool_response: {},
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const marker = path.join(dir, "agent-intelligence", ".registered-gutt-agent-new.marker");
    assert.ok(fs.existsSync(marker), "marker should be written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("register_agent without tool_input.name writes no marker", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__register_agent",
        tool_input: {},
        tool_response: {},
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const subdir = path.join(dir, "agent-intelligence");
    if (fs.existsSync(subdir)) {
      const markers = fs.readdirSync(subdir).filter((f) => f.startsWith(".registered-"));
      assert.equal(markers.length, 0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("register_agent with name containing path separators sanitizes before writing", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__register_agent",
        tool_input: { name: "evil/../escape" },
        tool_response: {},
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const subdir = path.join(dir, "agent-intelligence");
    const markers = fs.readdirSync(subdir).filter((f) => f.startsWith(".registered-"));
    assert.equal(markers.length, 1);
    assert.ok(!markers[0].includes("/"), "sanitized marker name must not contain /");
    assert.ok(!markers[0].includes(".."), "sanitized marker name must not contain ..");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("register_agent with error-shaped tool_response writes no marker", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__register_agent",
        tool_input: { name: "gutt-agent-fail" },
        tool_response: { isError: true, content: [{ type: "text", text: "boom" }] },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const subdir = path.join(dir, "agent-intelligence");
    if (fs.existsSync(subdir)) {
      const markers = fs.readdirSync(subdir).filter((f) => f.startsWith(".registered-"));
      assert.equal(markers.length, 0, "no marker on error tool_response");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("register_agent with missing tool_response writes no marker", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__register_agent",
        tool_input: { name: "gutt-agent-noresp" },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const subdir = path.join(dir, "agent-intelligence");
    if (fs.existsSync(subdir)) {
      const markers = fs.readdirSync(subdir).filter((f) => f.startsWith(".registered-"));
      assert.equal(markers.length, 0, "no marker when tool_response is absent");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Matcher variants + non-matching actions
// ---------------------------------------------------------------------------

test("scraper matches alternate server-name variants (split on '__' → action)", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        // gutt-mcp-remote and claude_ai_gutt-pro-memory have both appeared.
        tool_name: "mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned",
        tool_input: { agent_id: "gutt-agent-variant" },
        tool_response: { lessons: [{ summary: "alt-name" }] },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const cached = readCache(dir, "gutt-agent-variant");
    assert.deepEqual(cached.lessons, [{ summary: "alt-name" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("non-target action (e.g. add_memory) produces no side effects", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook(
      {
        tool_name: "mcp__gutt-pro-memory__add_memory",
        tool_input: { agent_id: "gutt-agent-foo", name: "ignore me" },
        tool_response: { ok: true },
      },
      { CLAUDE_PLUGIN_DATA: dir }
    );
    assert.equal(res.status, 0);
    const subdir = path.join(dir, "agent-intelligence");
    if (fs.existsSync(subdir)) {
      assert.equal(fs.readdirSync(subdir).length, 0, "no files should be written");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defensive input handling
// ---------------------------------------------------------------------------

test("malformed stdin does not crash", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook("{not json", { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty stdin does not crash", () => {
  const dir = makeCacheDir();
  try {
    const res = runHook("", { CLAUDE_PLUGIN_DATA: dir });
    assert.equal(res.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
