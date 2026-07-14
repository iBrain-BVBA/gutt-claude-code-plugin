#!/usr/bin/env node
/**
 * GUTT runtime-state location + safe IO (GP-855, R37).
 *
 * R37: ALL plugin runtime state lives under ${CLAUDE_PLUGIN_DATA} — never the
 * project/repo tree. This module is the single sanctioned writer; every hook and
 * lib routes reads/writes/cleanup through here so state can't leak elsewhere
 * (enforced by tests/check-state-location.cjs).
 *
 * Fail-safe: when ${CLAUDE_PLUGIN_DATA} is unset (e.g. local --plugin-dir dev or
 * some test contexts) there is NO fallback to the project tree — path helpers
 * return null and every write is a no-op. State is simply unavailable, never
 * misplaced. See docs/runtime-state-convention.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { debugLog } = require("./debug.cjs");

/**
 * Root of this plugin's private data dir, or null when unset. Read live (not
 * cached at module load) so late-set env (tests) and the fail-safe both work.
 * @returns {string|null}
 */
function stateRoot() {
  return process.env.CLAUDE_PLUGIN_DATA || null;
}

/**
 * Absolute path for a state file under the data dir, or null when unavailable.
 * Callers MUST null-check — a null path makes every write below a safe no-op.
 * @param {...string} segments
 * @returns {string|null}
 */
function statePath(...segments) {
  const root = stateRoot();
  return root ? path.join(root, ...segments) : null;
}

/**
 * True when `absPath` resolves inside the plugin data dir. Guards the writers so a
 * hand-built path (os.tmpdir, the project tree, a repo-relative path) can't escape
 * ${CLAUDE_PLUGIN_DATA} even when it bypasses statePath() (R37, GP-855). This is the
 * choke-point enforcement of AC3's named checks — the CI guard stops code from
 * bypassing this lib; this stops the lib itself from being handed a bad path.
 * @param {string} absPath
 * @returns {boolean}
 */
function isUnderRoot(absPath) {
  const root = stateRoot();
  if (!root) {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absPath);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/**
 * null-safe existence check.
 * @param {string|null} absPath
 * @returns {boolean}
 */
function exists(absPath) {
  return Boolean(absPath) && fs.existsSync(absPath);
}

/**
 * Create a directory (recursive). Returns false on failure.
 * @param {string} dir
 * @returns {boolean}
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    debugLog("plugin-state", `mkdir failed for ${dir}: ${err.message}`);
    return false;
  }
}

/**
 * Read + parse JSON. Returns `fallback` when state is unavailable, the file is
 * missing, or it can't be parsed. Unexpected read errors are logged (a missing
 * file — ENOENT — is expected on first run and stays quiet).
 * @param {string|null} absPath
 * @param {*} [fallback=null]
 * @returns {*}
 */
function readJson(absPath, fallback = null) {
  if (!absPath) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      debugLog("plugin-state", `read failed for ${absPath}: ${err.message}`);
    }
    return fallback;
  }
}

// Monotonic per-process counter so temp names are unique even for two writes in
// the same millisecond. Writes are synchronous, so same-process calls already
// serialize and distinct PIDs disambiguate across processes — this is belt-and-
// suspenders that also survives a future async refactor.
let writeSeq = 0;

/**
 * Atomically write JSON — the one atomic-write idiom for the suite: unique temp
 * name (PID + timestamp + counter) then delete-before-rename (Windows can't
 * overwrite on rename). No non-atomic fallback: a failed write returns false
 * rather than risk a torn file. No-op (false) when unavailable.
 * @param {string|null} absPath
 * @param {*} data
 * @returns {boolean} true if written
 */
function writeJson(absPath, data) {
  if (!absPath) {
    return false;
  }
  if (!isUnderRoot(absPath)) {
    debugLog("plugin-state", `refusing write outside plugin data dir: ${absPath}`);
    return false;
  }
  if (!ensureDir(path.dirname(absPath))) {
    return false;
  }
  const serialized = JSON.stringify(data, null, 2);
  const tempPath = `${absPath}.tmp.${process.pid}.${Date.now()}.${writeSeq++}`;
  try {
    fs.writeFileSync(tempPath, serialized);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
    fs.renameSync(tempPath, absPath);
    return true;
  } catch (err) {
    debugLog("plugin-state", `atomic write failed for ${absPath}: ${err.message}`);
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore cleanup error */
      }
    }
    return false;
  }
}

/**
 * Append one line (newline added). No-op (false) when unavailable.
 * @param {string|null} absPath
 * @param {string} line
 * @returns {boolean}
 */
function appendLine(absPath, line) {
  if (!absPath) {
    return false;
  }
  if (!isUnderRoot(absPath)) {
    debugLog("plugin-state", `refusing write outside plugin data dir: ${absPath}`);
    return false;
  }
  if (!ensureDir(path.dirname(absPath))) {
    return false;
  }
  try {
    fs.appendFileSync(absPath, `${line}\n`);
    return true;
  } catch (err) {
    debugLog("plugin-state", `append failed for ${absPath}: ${err.message}`);
    return false;
  }
}

/**
 * Delete a state file if present. No-op when unavailable/missing.
 * @param {string|null} absPath
 * @returns {boolean} true if a file was removed
 */
function remove(absPath) {
  if (!exists(absPath)) {
    return false;
  }
  try {
    fs.unlinkSync(absPath);
    return true;
  } catch (err) {
    debugLog("plugin-state", `remove failed for ${absPath}: ${err.message}`);
    return false;
  }
}

/**
 * Delete files in `dir` older than `maxAgeMs`. `match(name)` selects eligible
 * files (default: all). Safe no-op when unavailable/missing. The R37 SessionStart
 * TTL sweep — generalizes the old one-off session-start cleanup.
 * @param {string|null} dir
 * @param {{maxAgeMs: number, match?: (name: string) => boolean}} opts
 * @returns {number} count removed
 */
function sweep(dir, { maxAgeMs, match = () => true } = {}) {
  if (!dir || !Number.isFinite(maxAgeMs) || !fs.existsSync(dir)) {
    return 0;
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    debugLog("plugin-state", `sweep readdir failed for ${dir}: ${err.message}`);
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!match(name)) {
      continue;
    }
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {
      /* skip files we can't stat/delete */
    }
  }
  return removed;
}

module.exports = {
  stateRoot,
  statePath,
  exists,
  readJson,
  writeJson,
  appendLine,
  remove,
  sweep,
};
