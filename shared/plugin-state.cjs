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
 * Atomically replace a file's contents — the one atomic-write idiom for the
 * suite: unique temp name (PID + timestamp + counter) then delete-before-rename
 * (Windows can't overwrite on rename). No non-atomic fallback: a failed write
 * returns false rather than risk a torn file. No-op (false) when unavailable or
 * when the path escapes ${CLAUDE_PLUGIN_DATA}.
 * @param {string|null} absPath
 * @param {string} contents
 * @returns {boolean} true if written
 */
function atomicWrite(absPath, contents) {
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
  const tempPath = `${absPath}.tmp.${process.pid}.${Date.now()}.${writeSeq++}`;
  try {
    fs.writeFileSync(tempPath, contents);
    try {
      // POSIX rename atomically replaces the target: a concurrent reader sees
      // either the old file or the new one, never a gap. Do NOT unlink first —
      // hooks run in parallel, and the moment the path is absent a reader falls
      // back to its defaults and writes those back, wiping live state.
      fs.renameSync(tempPath, absPath);
    } catch (renameErr) {
      // Windows can't rename onto an existing file, so there it has to go. The
      // gap is unavoidable on that platform; every other platform never sees it.
      if (!["EEXIST", "EPERM", "EACCES"].includes(renameErr.code)) {
        throw renameErr;
      }
      fs.unlinkSync(absPath);
      fs.renameSync(tempPath, absPath);
    }
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
 * Atomically write JSON. No-op (false) when unavailable.
 * @param {string|null} absPath
 * @param {*} data
 * @returns {boolean} true if written
 */
function writeJson(absPath, data) {
  return atomicWrite(absPath, JSON.stringify(data, null, 2));
}

/** How long to keep trying for a lock before giving up and proceeding anyway. */
const LOCK_TIMEOUT_MS = 250;
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 5000;

/**
 * Block this process for `ms` without burning CPU. Hooks are synchronous
 * top-to-bottom, so there is no event loop to yield to.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding an exclusive lock on `absPath`.
 *
 * `open(..., "wx")` is an atomic create-if-absent on both POSIX and Windows,
 * which is the only mutual-exclusion primitive the filesystem actually gives us.
 * It is needed because read-modify-write on a shared file cannot be made safe by
 * comparing revisions: every writer can verify its own write landed and still be
 * overwritten a microsecond later by a writer that started after it.
 *
 * Fail-open by design: if the lock can't be taken within LOCK_TIMEOUT_MS, `fn`
 * runs unlocked. A hook that blocks a session is worse than a rare lost counter.
 *
 * @param {string} absPath - the file being guarded
 * @param {() => *} fn
 * @returns {*} whatever `fn` returns
 */
function withLock(absPath, fn) {
  const lockPath = `${absPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  // The lock lives beside the file it guards, so its directory has to exist
  // before the first write creates it — otherwise the very first (and most
  // contended) write of a session fails to lock and every writer races.
  ensureDir(path.dirname(lockPath));

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") {
        debugLog("plugin-state", `lock open failed for ${lockPath}: ${err.message}`);
        break; // can't lock at all — proceed unlocked
      }
      // Reclaim a lock whose holder died before releasing it.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // vanished between stat and now — race for it again
      }
      if (Date.now() >= deadline) {
        debugLog("plugin-state", `lock timeout for ${lockPath}; proceeding unlocked`);
        break;
      }
      sleepSync(2);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      } catch {
        /* best effort — a stale lock is reclaimed by the next writer */
      }
    }
  }
}

/**
 * Read-modify-write a JSON state file under an exclusive lock. The one safe way
 * to mutate state that parallel hooks share; a bare readJson/writeJson pair is
 * not, because sibling hooks on the same event run concurrently.
 * @param {string|null} absPath
 * @param {(current: *) => *} updater
 * @param {*} [fallback] - value handed to `updater` when the file is absent
 * @returns {{state: *, written: boolean}}
 */
function updateJson(absPath, updater, fallback = null) {
  if (!absPath) {
    return { state: updater(fallback), written: false };
  }
  return withLock(absPath, () => {
    const next = updater(readJson(absPath, fallback));
    return { state: next, written: writeJson(absPath, next) };
  });
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

/**
 * A line-oriented file this big is past saving: reading it to prune costs more
 * than the SessionStart budget allows, and it is only ever a queue or a
 * breadcrumb log. Discard wholesale instead of parsing it (GP-863, R25).
 */
const DISCARD_BYTES = 4 * 1024 * 1024;

/**
 * Size of a file on disk, or -1 when missing/unstattable.
 * @param {string|null} absPath
 * @returns {number}
 */
function sizeOf(absPath) {
  if (!absPath) {
    return -1;
  }
  try {
    return fs.statSync(absPath).size;
  } catch {
    return -1;
  }
}

/**
 * Drop stale entries from an append-only JSONL file (the R37 `capture-queue.jsonl`
 * shape). An entry is stale when its timestamp is older than `maxAgeMs`, when it
 * doesn't parse (an unprocessable queue item is garbage, not data), or when it
 * falls outside the newest `maxLines`. Rewrites only when something was dropped,
 * so the common no-op SessionStart costs one read.
 *
 * Concurrency: read → filter → atomic replace. A line appended between the read
 * and the rename is lost. Acceptable for a best-effort queue; the alternative is
 * a lock on the SessionStart hot path.
 *
 * @param {string|null} absPath
 * @param {{maxAgeMs?: number, maxLines?: number, timestampField?: string}} opts
 * @returns {{removed: number, discarded: boolean}}
 */
function pruneJsonl(absPath, { maxAgeMs, maxLines = Infinity, timestampField = "ts" } = {}) {
  const size = sizeOf(absPath);
  if (size < 0) {
    return { removed: 0, discarded: false };
  }
  if (size > DISCARD_BYTES) {
    debugLog("plugin-state", `discarding oversized jsonl (${size}B): ${absPath}`);
    return { removed: 0, discarded: remove(absPath) };
  }

  let lines;
  try {
    lines = fs.readFileSync(absPath, "utf8").split("\n");
  } catch (err) {
    debugLog("plugin-state", `prune read failed for ${absPath}: ${err.message}`);
    return { removed: 0, discarded: false };
  }

  const cutoff = Number.isFinite(maxAgeMs) ? Date.now() - maxAgeMs : -Infinity;
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      continue; // trailing newline, not an entry
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      removed++; // unparseable — no consumer can ever drain it
      continue;
    }
    const ts = Date.parse(entry?.[timestampField]);
    if (Number.isFinite(ts) && ts < cutoff) {
      removed++;
      continue;
    }
    kept.push(line);
  }

  // Newest-wins overflow trim, applied after the age pass so a burst of fresh
  // entries can't be held under the cap by expired ones.
  if (Number.isFinite(maxLines) && kept.length > maxLines) {
    removed += kept.length - maxLines;
    kept.splice(0, kept.length - maxLines);
  }

  if (removed === 0) {
    return { removed: 0, discarded: false };
  }
  if (kept.length === 0) {
    return { removed, discarded: remove(absPath) };
  }
  atomicWrite(absPath, `${kept.join("\n")}\n`);
  return { removed, discarded: false };
}

/**
 * Keep a breadcrumb log bounded. Under `maxBytes` this is a single stat and no
 * write. Over it, the newest `keepLines` survive; absurdly large logs are
 * dropped outright rather than read into memory.
 * @param {string|null} absPath
 * @param {{maxBytes?: number, keepLines?: number}} opts
 * @returns {{trimmed: boolean, discarded: boolean}}
 */
function trimLog(absPath, { maxBytes = 256 * 1024, keepLines = 200 } = {}) {
  const size = sizeOf(absPath);
  if (size < 0 || size <= maxBytes) {
    return { trimmed: false, discarded: false };
  }
  if (size > DISCARD_BYTES) {
    debugLog("plugin-state", `discarding oversized log (${size}B): ${absPath}`);
    return { trimmed: false, discarded: remove(absPath) };
  }
  try {
    const lines = fs.readFileSync(absPath, "utf8").split("\n").filter(Boolean);
    let out = `${lines.slice(-keepLines).join("\n")}\n`;
    if (Buffer.byteLength(out) > maxBytes) {
      // Pathological: a few enormous lines (or one with no newline at all), so
      // keeping `keepLines` of them doesn't bound anything. Fall back to a
      // byte-bounded tail and drop the partial line the cut lands in.
      // -1 leaves room for the terminating newline, so the result is ≤ maxBytes.
      out = Buffer.from(out, "utf8")
        .subarray(-(maxBytes - 1))
        .toString("utf8");
      const firstBreak = out.indexOf("\n");
      out = firstBreak >= 0 ? out.slice(firstBreak + 1) : out;
      if (!out.endsWith("\n")) {
        out += "\n";
      }
    }
    return { trimmed: atomicWrite(absPath, out), discarded: false };
  } catch (err) {
    debugLog("plugin-state", `trim failed for ${absPath}: ${err.message}`);
    return { trimmed: false, discarded: false };
  }
}

module.exports = {
  stateRoot,
  statePath,
  exists,
  readJson,
  writeJson,
  updateJson,
  withLock,
  atomicWrite,
  appendLine,
  remove,
  sweep,
  pruneJsonl,
  trimLog,
};
