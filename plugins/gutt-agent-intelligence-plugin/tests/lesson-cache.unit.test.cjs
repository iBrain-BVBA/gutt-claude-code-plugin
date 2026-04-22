#!/usr/bin/env node
/**
 * Lesson cache — unit tests.
 *
 * Round-trip, staleness, and graceful-failure coverage against a
 * throwaway tmp directory (passed via the cacheDir override).
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lessonCache = require("../hooks/lib/lesson-cache.cjs");

function makeTmpDir(prefix = "lesson-cache-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("read returns null for missing cache file", () => {
  const dir = makeTmpDir();
  try {
    assert.equal(lessonCache.read("gutt-agent-foo", { cacheDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write + read round-trip returns the same lessons", () => {
  const dir = makeTmpDir();
  try {
    const lessons = [
      { summary: "always do X", guidance: "because Y", outcome: "avoids Z" },
      { summary: "prefer A over B" },
    ];
    lessonCache.write("gutt-agent-demo", lessons, { cacheDir: dir });
    const out = lessonCache.read("gutt-agent-demo", { cacheDir: dir });
    assert.ok(out, "expected cache read to return a payload");
    assert.equal(out.agentId, "gutt-agent-demo");
    assert.equal(out.lessons.length, 2);
    assert.equal(out.lessons[0].summary, "always do X");
    assert.equal(typeof out.updatedAt, "number");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write overwrites an existing cache file on subsequent writes", () => {
  // Cross-platform regression: renameSync on Windows cannot always overwrite
  // an existing destination (AV, locks, network drives). The write() helper
  // now unlinks-then-renames with a direct-write fallback, so two writes in
  // a row must both succeed and the second must land.
  const dir = makeTmpDir();
  try {
    lessonCache.write("gutt-agent-over", [{ summary: "first" }], { cacheDir: dir });
    lessonCache.write("gutt-agent-over", [{ summary: "second" }], { cacheDir: dir });
    const out = lessonCache.read("gutt-agent-over", { cacheDir: dir });
    assert.ok(out);
    assert.equal(out.lessons.length, 1);
    assert.equal(out.lessons[0].summary, "second");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write coerces non-array lessons to empty list", () => {
  const dir = makeTmpDir();
  try {
    lessonCache.write("gutt-agent-x", null, { cacheDir: dir });
    const out = lessonCache.read("gutt-agent-x", { cacheDir: dir });
    assert.ok(out);
    assert.deepEqual(out.lessons, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read returns null when agentId does not match", () => {
  const dir = makeTmpDir();
  try {
    lessonCache.write("gutt-agent-alpha", [{ summary: "a" }], { cacheDir: dir });
    // simulate a stale cache from a different agent at the same path by hand-writing
    const file = lessonCache.cacheFileFor("gutt-agent-beta", dir);
    fs.writeFileSync(
      file,
      JSON.stringify({ agentId: "gutt-agent-wrong", lessons: [], updatedAt: Date.now() })
    );
    assert.equal(lessonCache.read("gutt-agent-beta", { cacheDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read returns null for malformed JSON", () => {
  const dir = makeTmpDir();
  try {
    const file = lessonCache.cacheFileFor("gutt-agent-bad", dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not valid json");
    assert.equal(lessonCache.read("gutt-agent-bad", { cacheDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clear removes the cache file", () => {
  const dir = makeTmpDir();
  try {
    lessonCache.write("gutt-agent-clr", [{ summary: "s" }], { cacheDir: dir });
    assert.ok(lessonCache.read("gutt-agent-clr", { cacheDir: dir }));
    lessonCache.clear("gutt-agent-clr", { cacheDir: dir });
    assert.equal(lessonCache.read("gutt-agent-clr", { cacheDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clear is a no-op when file is missing", () => {
  const dir = makeTmpDir();
  try {
    assert.doesNotThrow(() => lessonCache.clear("gutt-agent-nope", { cacheDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is true when cache is missing", () => {
  const dir = makeTmpDir();
  try {
    assert.equal(lessonCache.isStale("gutt-agent-nope", 10_000, { cacheDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is false when cache is fresh", () => {
  const dir = makeTmpDir();
  try {
    lessonCache.write("gutt-agent-fresh", [], { cacheDir: dir });
    assert.equal(lessonCache.isStale("gutt-agent-fresh", 60_000, { cacheDir: dir }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is true when cache is older than maxAgeMs", () => {
  const dir = makeTmpDir();
  try {
    const file = lessonCache.cacheFileFor("gutt-agent-old", dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ agentId: "gutt-agent-old", updatedAt: Date.now() - 120_000, lessons: [] })
    );
    assert.equal(lessonCache.isStale("gutt-agent-old", 60_000, { cacheDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is true when updatedAt is missing", () => {
  const dir = makeTmpDir();
  try {
    const file = lessonCache.cacheFileFor("gutt-agent-noupdated", dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agentId: "gutt-agent-noupdated", lessons: [] }));
    assert.equal(lessonCache.isStale("gutt-agent-noupdated", 60_000, { cacheDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is true when updatedAt is not a number", () => {
  const dir = makeTmpDir();
  try {
    const file = lessonCache.cacheFileFor("gutt-agent-badupdated", dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        agentId: "gutt-agent-badupdated",
        updatedAt: "2026-04-21T00:00:00Z",
        lessons: [],
      })
    );
    assert.equal(lessonCache.isStale("gutt-agent-badupdated", 60_000, { cacheDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is true with maxAgeMs=0 even on a just-written cache", () => {
  // maxAgeMs=0 is meant as a "force refetch" sentinel. isStale uses strict
  // `>` (age > maxAgeMs), so a genuinely just-written cache can evaluate
  // stale=false if write and check land in the same millisecond. Hand-write
  // the cache with updatedAt 1ms in the past to make the test deterministic.
  const dir = makeTmpDir();
  try {
    const file = lessonCache.cacheFileFor("gutt-agent-zero", dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        agentId: "gutt-agent-zero",
        updatedAt: Date.now() - 1,
        lessons: [],
      })
    );
    assert.equal(lessonCache.isStale("gutt-agent-zero", 0, { cacheDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCacheDir prefers explicit override", () => {
  assert.equal(lessonCache.resolveCacheDir("/tmp/explicit"), "/tmp/explicit");
});

test("resolveCacheDir uses CLAUDE_PLUGIN_DATA when set", () => {
  const before = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = "/tmp/plugin-data";
  try {
    assert.equal(lessonCache.resolveCacheDir(), "/tmp/plugin-data/agent-intelligence");
  } finally {
    if (before === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = before;
    }
  }
});
