#!/usr/bin/env node
/**
 * Tests for shared/plugin-state.cjs — the R37 runtime-state helper (GP-855).
 *
 * Run: node --test tests/plugin-state.test.cjs
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const state = require("../shared/plugin-state.cjs");

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
function restoreEnv() {
  if (ORIGINAL === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  }
}

// ---------------------------------------------------------------------------
// Fail-safe: ${CLAUDE_PLUGIN_DATA} unset → no path, no writes, never the repo tree
// ---------------------------------------------------------------------------

describe("plugin-state: fail-safe when CLAUDE_PLUGIN_DATA is unset", () => {
  before(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
  });
  after(restoreEnv);

  it("stateRoot() and statePath() are null", () => {
    assert.equal(state.stateRoot(), null);
    assert.equal(state.statePath("sessions", "a.json"), null);
  });

  it("every write is a no-op and reads return the fallback", () => {
    const p = state.statePath("x.json");
    assert.equal(state.writeJson(p, { a: 1 }), false);
    assert.equal(state.appendLine(state.statePath("x.log"), "hi"), false);
    assert.equal(state.remove(p), false);
    assert.equal(state.exists(p), false);
    assert.deepEqual(state.readJson(p, { fallback: true }), { fallback: true });
    assert.equal(state.sweep(state.statePath("sessions"), { maxAgeMs: 1 }), 0);
  });
});

// ---------------------------------------------------------------------------
// Under a real (temp) ${CLAUDE_PLUGIN_DATA}
// ---------------------------------------------------------------------------

describe("plugin-state: under a real CLAUDE_PLUGIN_DATA", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-ps-test-"));
    process.env.CLAUDE_PLUGIN_DATA = dir;
  });

  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("statePath joins under the data dir", () => {
    assert.equal(state.statePath("sessions", "a.json"), path.join(dir, "sessions", "a.json"));
  });

  it("writeJson + readJson round-trip, creating parent dirs", () => {
    const p = state.statePath("sessions", "s1.json");
    assert.equal(state.writeJson(p, { hello: "world" }), true);
    assert.deepEqual(state.readJson(p, null), { hello: "world" });
  });

  it("writeJson is atomic and leaves no temp files behind", () => {
    const p = state.statePath("cache.json");
    state.writeJson(p, { n: 1 });
    state.writeJson(p, { n: 2 }); // overwrite existing
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(state.readJson(p), { n: 2 });
  });

  it("readJson returns the fallback on missing or corrupt files", () => {
    assert.equal(state.readJson(state.statePath("missing.json"), null), null);
    const bad = state.statePath("bad.json");
    fs.writeFileSync(bad, "{ not json");
    assert.deepEqual(state.readJson(bad, { ok: false }), { ok: false });
  });

  it("appendLine appends newline-terminated lines", () => {
    const log = state.statePath("x.log");
    state.appendLine(log, "one");
    state.appendLine(log, "two");
    assert.equal(fs.readFileSync(log, "utf8"), "one\ntwo\n");
  });

  it("remove deletes an existing file, no-ops otherwise", () => {
    const p = state.statePath("del.json");
    state.writeJson(p, {});
    assert.equal(state.remove(p), true);
    assert.equal(state.exists(p), false);
    assert.equal(state.remove(p), false);
  });

  it("sweep removes matching files older than maxAgeMs, keeps the rest", () => {
    const sdir = state.statePath("sweep");
    const oldFile = path.join(sdir, "old.json");
    const freshFile = path.join(sdir, "fresh.json");
    const otherType = path.join(sdir, "keep.txt");
    state.writeJson(oldFile, {});
    state.writeJson(freshFile, {});
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(otherType, "x");

    // Backdate oldFile by 48h
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);

    const removed = state.sweep(sdir, {
      maxAgeMs: 24 * 60 * 60 * 1000,
      match: (f) => f.endsWith(".json"),
    });

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(oldFile), false, "old .json removed");
    assert.equal(fs.existsSync(freshFile), true, "fresh .json kept");
    assert.equal(fs.existsSync(otherType), true, "non-matching file kept");
  });
});
