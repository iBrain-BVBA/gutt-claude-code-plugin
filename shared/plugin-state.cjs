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

/**
 * Sentinel for "the file is present but could not be read or parsed".
 *
 * `readJson` collapses absent and unreadable into one fallback. That is right for a
 * reader that only wants a value, and wrong for a read-modify-write: a mutator that
 * cannot tell them apart treats a corrupt file as a fresh one, writes a replacement
 * built from the keys it owns, and silently drops every key it does not — including
 * another module's records.
 */
const UNREADABLE = Symbol("unreadable");

/**
 * Read JSON, distinguishing absent from unreadable.
 *
 * One read rather than `existsSync` then `readFileSync`, so there is no window in
 * which the file appears then vanishes: ENOENT *is* the absent answer.
 *
 * @param {string|null} absPath
 * @returns {*} the parsed value, `null` when there is no such file, or `UNREADABLE`
 *   when the file exists but could not be read or parsed
 */
function readJsonOrUnreadable(absPath) {
  if (!absPath) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    debugLog("plugin-state", `unreadable ${absPath}: ${err.message}`);
    return UNREADABLE;
  }
}

// Monotonic per-process counter so temp names are unique even for two writes in
// the same millisecond. Writes are synchronous, so same-process calls already
// serialize and distinct PIDs disambiguate across processes — this is belt-and-
// suspenders that also survives a future async refactor.
let writeSeq = 0;

/**
 * Atomically replace a file's contents — the one atomic-write idiom for the
 * suite: unique temp name (PID + timestamp + counter) then rename *over* the
 * target. See the inline note at the rename for why it must not unlink first;
 * only Windows, which cannot always rename onto an existing file, keeps an
 * unlink fallback. No non-atomic fallback: a failed write returns false rather
 * than risk a torn file. No-op (false) when unavailable or when the path
 * escapes ${CLAUDE_PLUGIN_DATA}.
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
 * Inode from a stat call, or null when it is unavailable or meaningless.
 *
 * Windows reports ino as 0 on filesystems with no file index, which is useless
 * for identity, so callers treat null as "can't tell" and fall back to
 * path-based behavior rather than guessing.
 * @param {() => import("fs").Stats} statFn
 * @returns {number|null}
 */
function statIno(statFn) {
  try {
    const { ino } = statFn();
    return typeof ino === "number" && ino > 0 ? ino : null;
  } catch {
    return null;
  }
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
  // A lock outside the data root would be created (along with its parents) by
  // the ensureDir below even though the write it guards is going to no-op. Same
  // containment rule as atomicWrite/appendLine — refuse, and run unlocked.
  if (!isUnderRoot(absPath)) {
    debugLog("plugin-state", `refusing to lock outside the data root: ${absPath}`);
    return fn();
  }

  const lockPath = `${absPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  // The lock lives beside the file it guards, so its directory has to exist
  // before the first write creates it — otherwise the very first (and most
  // contended) write of a session fails to lock and every writer races.
  ensureDir(path.dirname(lockPath));

  // The deadline governs the loop itself, and every failure path falls through
  // to the sleep. Both matter: an early `continue` that skips them turns a lock
  // that cannot be removed — a directory or dangling symlink left at lockPath,
  // EACCES on the data dir, a Windows delete-pending handle — into an
  // unbreakable hot loop. That is the session-blocking hang this function's
  // fail-open exists to prevent, so it must not be reachable from inside it.
  while (fd === null && Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") {
        debugLog("plugin-state", `lock open failed for ${lockPath}: ${err.message}`);
        break; // can't lock at all — proceed unlocked
      }
      // Reclaim a lock whose holder died before releasing it.
      //
      // lstat, not stat: stat follows a symlink, so a *dangling* one at the lock
      // path throws ENOENT on every pass and is read as "it vanished" — the lock
      // is never reclaimed and every future call pays the full timeout forever.
      // rmSync likewise handles a directory left at the path, which unlink
      // cannot. Neither shape should exist, but both are permanent once they do.
      try {
        if (Date.now() - fs.lstatSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      } catch (reclaimErr) {
        // ENOENT just means it vanished under us and the next attempt wins it.
        // Anything else means we will never remove it — say so once and let the
        // deadline end this rather than retrying forever.
        if (reclaimErr.code !== "ENOENT") {
          debugLog("plugin-state", `lock reclaim failed for ${lockPath}: ${reclaimErr.message}`);
        }
      }
      sleepSync(2);
    }
  }

  if (fd === null) {
    debugLog("plugin-state", `proceeding unlocked: ${lockPath}`);
  }

  // Which inode we actually hold. Releasing by path alone is wrong once the
  // stale reclaim above exists: if this holder stalls past LOCK_STALE_MS (a
  // laptop suspend, heavy swap, an fsync stall on a network HOME), another
  // writer legitimately reclaims the lock and creates its own. Unlinking by
  // path would then delete *that* writer's lock and let a third in alongside
  // it — reintroducing the lost update this whole mechanism exists to stop.
  // Comparing inodes narrows the window from seconds to microseconds; where
  // the platform gives no usable inode it degrades to releasing by path.
  const heldIno = fd === null ? null : statIno(() => fs.fstatSync(fd));

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        // Identify *before* closing. An open fd pins the inode, so while it is
        // held no other file can be allocated the same one and a match here is
        // proof the file at lockPath is still ours. Closing first would release
        // the inode for reuse, and a reclaiming writer's lock could be handed
        // the very number we recorded — an ABA that reads as "still mine" and
        // deletes their lock, which is the bug this check exists to prevent.
        // lstat needs no handle, so the reorder is safe on Windows too.
        const currentIno = statIno(() => fs.lstatSync(lockPath));
        fs.closeSync(fd);
        if (heldIno === null || currentIno === null || currentIno === heldIno) {
          fs.unlinkSync(lockPath);
        } else {
          debugLog("plugin-state", `not releasing a reclaimed lock: ${lockPath}`);
        }
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
      // lstat + rmSync, matching withLock's reclaim: stat follows symlinks, so a
      // dangling one throws ENOENT and gets skipped forever, and unlink cannot
      // remove a directory. This sweep is the backstop for exactly those shapes
      // — an orphaned lock nothing will ever contend for again — so it has to be
      // able to remove what it is here to remove.
      if (now - fs.lstatSync(p).mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* skip files we can't stat/delete */
    }
  }
  return removed;
}

/**
 * Reading a line-oriented file bigger than this to prune it costs more than the
 * SessionStart budget allows (GP-863, R25), so past this size only the tail is
 * read and the rest is dropped unread.
 *
 * Dropped, not deleted. These files are the user's un-drained captures and the
 * plugin's only diagnostic log; unlinking one throws away every entry including
 * the newest, and for `hook-errors.log` it also throws away the note saying it
 * happened. Keeping the tail bounds the work just as well and normally loses
 * only the oldest data.
 *
 * The exception is a file with no line structure at all in its tail — a single
 * multi-megabyte "line". `pruneJsonl` still removes that one, because for a
 * queue of JSON entries an unparseable blob is garbage by the same rule that
 * drops any other unparseable line, and keeping it would mean re-reading it on
 * every SessionStart forever.
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
 * Cut `text` down to at most `maxBytes` UTF-8 bytes, starting at a line
 * boundary where one is available and always ending in exactly one newline.
 *
 * Both traps this avoids shipped as bugs in earlier revisions, so it does the
 * work in one place rather than as guards bolted onto a slice:
 *
 *  - Dropping the leading partial line *unconditionally* empties the result
 *    whenever the window holds no other newline — which is exactly the case
 *    when one line is longer than `maxBytes`. That replaced whole logs with a
 *    single "\n" while still reporting a successful trim.
 *  - Slicing raw bytes and decoding afterwards turns a split multi-byte
 *    character into U+FFFD, which re-encodes to *more* bytes than it replaced,
 *    so the result comes back over the bound. A log that stays over its bound
 *    is re-read and rewritten on every SessionStart, forever, on a path with a
 *    50ms budget.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string} at most `maxBytes` bytes, newline-terminated
 */
function boundToBytes(text, maxBytes) {
  const budget = Math.max(1, maxBytes - 1); // room for the terminating newline
  // Strip any replacement characters the cut invented at the front; each stood
  // for a byte we already counted, so removing them can only shorten the result.
  let out = Buffer.from(text, "utf8")
    .subarray(-budget)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
  const firstBreak = out.indexOf("\n");
  const rest = firstBreak >= 0 ? out.slice(firstBreak + 1) : "";
  // Prefer a clean line start, but never at the cost of emptying the result.
  if (rest.trim() !== "") {
    out = rest;
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * Read at most the last `bytes` of a file without loading the whole thing.
 * The first line is dropped when the file was truncated, since a tail read
 * almost always lands mid-line.
 * @param {string} absPath
 * @param {number} bytes
 * @returns {{text: string, truncated: boolean}}
 */
function readTail(absPath, bytes) {
  const fd = fs.openSync(absPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const truncated = length < size;
    let text = buf.toString("utf8");
    if (truncated) {
      const nl = text.indexOf("\n");
      // Only drop the partial line if something survives it. A tail with no
      // newline until its very end — a corrupt or sparse file, or one enormous
      // line — would otherwise discard the whole read, turning "some data" into
      // "none", which is exactly the outcome reading the tail exists to avoid.
      const rest = nl === -1 ? "" : text.slice(nl + 1);
      if (rest.trim() !== "") {
        text = rest;
      }
    }
    return { text, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keep a breadcrumb log bounded. Under `maxBytes` this is a single stat and no
 * write. Over it, the newest `keepLines` survive; past `DISCARD_BYTES` only the
 * file's tail is read and the rest is dropped unread — the log itself is never
 * deleted.
 * @param {string|null} absPath
 * @param {{maxBytes?: number, keepLines?: number}} opts
 * @returns {{trimmed: boolean, discarded: boolean}}
 */
function trimLog(absPath, { maxBytes = 256 * 1024, keepLines = 200 } = {}) {
  const size = sizeOf(absPath);
  if (size < 0 || size <= maxBytes) {
    return { trimmed: false, discarded: false };
  }
  try {
    // Past the cap, read only the tail rather than unlinking. Deleting the file
    // takes the newest entries with it, and for hook-errors.log the note saying
    // it happened is written *into the file being deleted* — the log erasing
    // exactly the evidence someone would need.
    let discarded = false;
    let text;
    if (size > DISCARD_BYTES) {
      const tail = readTail(absPath, DISCARD_BYTES);
      discarded = tail.truncated;
      text = tail.text;
      debugLog(
        "plugin-state",
        `oversized log (${size}B), keeping the last ${DISCARD_BYTES}B: ${absPath}`
      );
    } else {
      text = fs.readFileSync(absPath, "utf8");
    }
    const lines = text.split("\n").filter(Boolean);
    let out = `${lines.slice(-keepLines).join("\n")}\n`;
    if (Buffer.byteLength(out) > maxBytes) {
      // Pathological: a few enormous lines (or one with no newline at all), so
      // keeping `keepLines` of them doesn't bound anything.
      out = boundToBytes(out, maxBytes);
    }
    return { trimmed: atomicWrite(absPath, out), discarded };
  } catch (err) {
    debugLog("plugin-state", `trim failed for ${absPath}: ${err.message}`);
    return { trimmed: false, discarded: false };
  }
}

/**
 * Bound a JSONL queue: drop entries older than `maxAgeMs`, entries that don't
 * parse at all, and — after those are gone — everything but the newest
 * `maxLines`.
 *
 * Age comes from each entry's own timestamp, never the file's mtime. The queue is
 * append-only, so its mtime is the age of the *newest* entry and says nothing
 * about the oldest; using it would expire a busy queue wholesale and never expire
 * an idle one. An entry carrying no parseable timestamp is **kept**: expiry is for
 * entries proven old, and a queue entry is somebody's un-drained capture rather
 * than a log line, so the default has to be to keep it.
 *
 * Rewrites only when something was actually dropped, so the steady-state cost on
 * the SessionStart path is one read and no write (R25).
 *
 * @param {string|null} absPath
 * @param {{maxAgeMs?: number, maxLines?: number}} opts
 * @returns {{pruned: boolean, kept: number, expired: number, malformed: number, overflow: number}}
 */
function pruneJsonl(absPath, { maxAgeMs = Infinity, maxLines = Infinity } = {}) {
  const untouched = { pruned: false, kept: 0, expired: 0, malformed: 0, overflow: 0 };
  const size = sizeOf(absPath);
  if (size <= 0) {
    return untouched; // missing, unstattable, or empty — nothing to bound
  }
  try {
    let text;
    let discarded = false;
    if (size > DISCARD_BYTES) {
      // Same bound as trimLog, for the same reason: reading a runaway file whole
      // would blow the SessionStart budget. The tail survives, the rest doesn't.
      const tail = readTail(absPath, DISCARD_BYTES);
      text = tail.text;
      discarded = tail.truncated;
      debugLog(
        "plugin-state",
        `oversized queue (${size}B), keeping the last ${DISCARD_BYTES}B: ${absPath}`
      );
    } else {
      text = fs.readFileSync(absPath, "utf8");
    }

    const now = Date.now();
    let expired = 0;
    let malformed = 0;
    const live = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") {
        continue; // blank lines aren't entries, and aren't worth counting as damage
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      // Date.parse returns NaN for a missing or unparseable stamp, and every
      // comparison against NaN is false — so such an entry falls through to
      // live[] rather than being expired. That is the intended default.
      const at = Date.parse(entry?.at ?? entry?.timestamp ?? entry?.createdAt ?? "");
      if (now - at > maxAgeMs) {
        expired++;
        continue;
      }
      live.push(line);
    }

    const overflow = Math.max(0, live.length - maxLines);
    const kept = live.slice(overflow); // newest maxLines survive
    // `discarded` counts too: the tail read already threw content away, so the
    // file on disk no longer matches what we parsed and has to be rewritten.
    if (!discarded && expired === 0 && malformed === 0 && overflow === 0) {
      return { ...untouched, kept: kept.length };
    }
    const out = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    return { pruned: atomicWrite(absPath, out), kept: kept.length, expired, malformed, overflow };
  } catch (err) {
    debugLog("plugin-state", `prune failed for ${absPath}: ${err.message}`);
    return untouched;
  }
}

module.exports = {
  stateRoot,
  statePath,
  exists,
  readJson,
  readJsonOrUnreadable,
  UNREADABLE,
  writeJson,
  updateJson,
  withLock,
  appendLine,
  remove,
  sweep,
  trimLog,
  pruneJsonl,
};
