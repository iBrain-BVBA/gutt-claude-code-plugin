#!/usr/bin/env node
/**
 * GUTT Session State Utility
 * Shared state management for statusline and hooks
 */

const crypto = require("crypto");
const { statePath, readJson, updateJson } = require("./plugin-state.cjs");

// Runtime state lives under ${CLAUDE_PLUGIN_DATA} (R37, GP-855) — never the
// project tree. Per-session files under sessions/<session_id>.json keep
// concurrent Claude Code sessions from corrupting each other's state; falls
// back to sessions/default.json when init() was never called.
let _sessionId = null;

function getStatePath() {
  return _sessionId
    ? statePath("sessions", `${_sessionId}.json`)
    : statePath("sessions", "default.json");
}

/**
 * Sanitize a session ID for safe use in file paths.
 * Strips anything that isn't alphanumeric, underscore, or hyphen.
 *
 * Coerces rather than assuming a string. The three lifecycle hooks call init()
 * outside their guard(), so a payload with a non-string `session_id` used to
 * throw here and take the whole hook down with an uncaught TypeError — exit 1,
 * against a contract that promises exit 0 no matter what arrives on stdin.
 * Claude Code always sends a string, so this is a contract hole rather than an
 * observed failure, but it is the one input every hook touches before any guard.
 *
 * @param {*} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  let raw;
  try {
    raw = String(sessionId ?? "unknown");
  } catch {
    // String() is itself fallible. `{"toString": "x"}` is ordinary JSON, and it
    // shadows Object.prototype.toString with something not callable — ToPrimitive
    // then falls through to valueOf, which returns the object, and throws
    // "Cannot convert object to primitive value". Coercing without this catch
    // leaves exactly the uncaught TypeError the coercion was added to prevent.
    raw = "unknown";
  }
  // Trailing `|| "unknown"` catches inputs that sanitize down to nothing (""),
  // which would otherwise produce a bare ".json" state file.
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

/**
 * Initialise per-session file path.
 * Must be called early in every hook that reads/writes session state.
 * @param {string} sessionId - The session_id from Claude Code hook input
 */
function init(sessionId) {
  if (sessionId && sessionId !== "unknown") {
    _sessionId = sanitizeSessionId(sessionId);
  }
}

/**
 * A fresh session record. Built per call rather than shared, so no caller can
 * mutate a literal that every later getState() fallback would then hand out.
 * @returns {Object}
 */
function defaultState() {
  return {
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    connectionStatus: "unknown",
    lastUpdated: new Date().toISOString(),
    // Monotonic write counter — the compare-and-swap token in applyUpdate().
    rev: 0,
    // GP-863 session lifecycle. `source` is the SessionStart matcher that last
    // (re)started this session; the two flags are produced here and consumed by
    // the UserPromptSubmit command guard (GP-864).
    source: null,
    firstPromptPending: false,
    compacted: false,
    endedAt: null,
    endReason: null,
  };
}

function getState() {
  // `|| defaultState()` rather than passing it as the fallback argument: JS
  // evaluates arguments eagerly, so the latter would mint a UUID and two
  // timestamps on every read for a value used only when the file is missing.
  return readJson(getStatePath(), null) || defaultState();
}

/**
 * Read-modify-write the session file, reporting whether the write landed.
 *
 * Concurrency: Claude Code runs sibling hooks on one event **in parallel**, so
 * this file is genuinely contended — the SessionStart pair (`session-start.cjs`
 * and the `async: true` `session-connectivity.cjs`) always writes it at once.
 * Confining each hook to disjoint fields is not enough on its own: an unguarded
 * read-then-write still drops the other process's update when the two interleave.
 * Observed for real — a `claude -p` session where the connectivity probe
 * demonstrably succeeded but its `connectionStatus: "ok"` never reached disk.
 *
 * Comparing revisions cannot fix this either: a writer can confirm its own write
 * landed and still be overwritten immediately afterwards by one that started
 * later. So the whole read-modify-write runs under an exclusive lock, which is
 * the only primitive that actually serialises it (see plugin-state.updateJson).
 *
 * @param {(state: Object) => Object} updater
 * @returns {{state: Object, written: boolean}}
 */
function applyUpdate(updater) {
  return updateJson(getStatePath(), (current) => {
    // Same eager-argument reason as getState(): build the default only on a miss.
    const newState = updater(current || defaultState());
    newState.rev = (current?.rev || 0) + 1;
    newState.lastUpdated = new Date().toISOString();
    return newState;
  });
}

function updateState(updater) {
  return applyUpdate(updater).state;
}

// ---------------------------------------------------------------------------
// Session lifecycle (GP-863) — SessionStart/SessionEnd own everything below.
// ---------------------------------------------------------------------------

/**
 * Record a SessionStart. `compact` is the only mid-session source, so it alone
 * sets `compacted`; every other source (startup, resume, clear, fork, and any
 * matcher Claude Code adds later) is a session (re)start and arms
 * `firstPromptPending`.
 *
 * Deliberately leaves `connectionStatus` untouched: the async connectivity hook
 * runs in parallel and is its sole writer.
 *
 * @param {string} sessionId
 * @param {string} [source] - SessionStart matcher from the hook payload
 * @returns {Object} the persisted state
 */
function beginSession(sessionId, source) {
  const compacted = source === "compact";
  return updateState((state) => {
    state.sessionId = sessionId;
    state.source = source || null;
    if (compacted) {
      state.compacted = true;
    } else {
      state.startedAt = new Date().toISOString();
      state.firstPromptPending = true;
      state.endedAt = null;
      state.endReason = null;
    }
    return state;
  });
}

/**
 * Record a SessionEnd. The file is finalized rather than deleted so the
 * statusline and the next SessionStart can still read the last known state; the
 * 24h sweep reclaims it.
 *
 * Ordering guard: `/clear` fires SessionEnd and SessionStart as two separate
 * processes with no completion ordering between them, both targeting this same
 * record. If the SessionEnd lands second it stamps `endedAt` on a session that
 * is already running — the HUD reads a dead session, and `firstPromptPending`
 * is cleared before the new session's first prompt ever arrives, so the memory
 * pointer never fires. The lock in applyUpdate() serialises the two writes but
 * says nothing about which one *should* win; mutual exclusion is not ordering.
 *
 * So compare against when this process was dispatched: a `startedAt` newer than
 * that belongs to a session which began after this SessionEnd was issued, and
 * is not ours to close.
 *
 * @param {string} [reason] - SessionEnd reason from the hook payload
 * @param {number} [dispatchedAt] - epoch ms at which this SessionEnd was issued
 * @returns {Object} the persisted state
 */
function finalizeSession(reason, dispatchedAt = Date.now()) {
  return updateState((state) => {
    // Compared inside the lock, against the same read the write is based on: an
    // unlocked pre-check could pass on a record that beginSession() replaces
    // before this updater ever runs.
    //
    // A missing or corrupt `startedAt` parses to NaN and every comparison with
    // NaN is false, so it falls through and finalizes — fail-open, matching the
    // ordinary case this guard is carving an exception out of.
    if (Date.parse(state.startedAt) > dispatchedAt) {
      return state;
    }
    state.endedAt = new Date().toISOString();
    state.endReason = reason || "other";
    state.firstPromptPending = false;
    state.compacted = false;
    return state;
  });
}

/**
 * Read-and-clear a lifecycle flag. Writes only when the flag was set, so the
 * common case on the UserPromptSubmit guard's hot path is one read and no lock
 * (R25).
 * @param {string} flag
 * @param {*} [clearedValue] - what "consumed" looks like for this field
 * @returns {boolean} whether the flag was set
 */
function consumeFlag(flag, clearedValue = false) {
  // Unlocked fast path: not set means nothing to do and no lock to take.
  if (!getState()[flag]) {
    return false;
  }
  // Whether *this* caller consumed it has to be decided inside the lock. The
  // read above is unlocked, so with two hooks racing on one event — the premise
  // this whole module is built around — both would otherwise see the flag set
  // and both return true, and "true exactly once" is the entire contract.
  let consumed = false;
  applyUpdate((state) => {
    consumed = Boolean(state[flag]);
    if (consumed) {
      state[flag] = clearedValue;
    }
    return state;
  });
  return consumed;
}

/**
 * Consume `firstPromptPending` — true exactly once per session (re)start.
 * Producer: beginSession(). Consumer: the UserPromptSubmit command guard (GP-864).
 * @returns {boolean}
 */
function consumeFirstPromptPending() {
  return consumeFlag("firstPromptPending");
}

/**
 * Consume `compacted` — true exactly once after each compaction.
 * Producer: beginSession(). Consumer: the UserPromptSubmit command guard (GP-864).
 * @returns {boolean}
 */
function consumeCompacted() {
  return consumeFlag("compacted");
}

module.exports = {
  init,
  sanitizeSessionId,
  getState,
  updateState,
  applyUpdate,
  getStatePath,
  defaultState,
  // GP-863 session lifecycle
  beginSession,
  finalizeSession,
  consumeFirstPromptPending,
  consumeCompacted,
};
