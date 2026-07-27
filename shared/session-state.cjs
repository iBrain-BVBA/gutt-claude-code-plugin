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
 * @param {string} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  return (sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
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
 * A fresh session record. Built per call — a shared literal would hand every
 * getState() fallback the same nested `ticker` object, so one addTickerItem on a
 * missing state file would leak items into every later read in the process.
 * @returns {Object}
 */
function defaultState() {
  return {
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    connectionStatus: "unknown",
    memoryQueries: 0,
    lessonsCaptured: 0,
    significantOps: 0, // GP-530: tracks Edit/Write/Task ops for periodic capture
    lastCapturePromptAt: null, // GP-530: ISO timestamp of last capture prompt injection
    lastUpdated: new Date().toISOString(),
    // Monotonic write counter — the compare-and-swap token in applyUpdate().
    rev: 0,
    // GP-863 session lifecycle. `source` is the SessionStart matcher that last
    // (re)started this session; the two flags are produced here and consumed by
    // the UserPromptSubmit command guard (GP-864).
    source: null,
    firstPromptPending: false,
    compacted: false,
    // Replaces the pre-3.0 `<session_id>.lessons-prompted` marker file (R37
    // "prefer JSON over markers").
    lessonsPromptedAt: null,
    endedAt: null,
    endReason: null,
    ticker: {
      items: [], // FIFO queue, max 5 items with createdAt timestamps
    },
  };
}

function getState() {
  return readJson(getStatePath(), defaultState());
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
  return updateJson(
    getStatePath(),
    (current) => {
      const newState = updater(current);
      newState.rev = (current?.rev || 0) + 1;
      newState.lastUpdated = new Date().toISOString();
      return newState;
    },
    defaultState()
  );
}

function updateState(updater) {
  return applyUpdate(updater).state;
}

function incrementMemoryQueries() {
  return updateState((state) => {
    state.memoryQueries = (state.memoryQueries || 0) + 1;
    return state;
  });
}

function incrementLessonsCaptured() {
  return updateState((state) => {
    state.lessonsCaptured = (state.lessonsCaptured || 0) + 1;
    return state;
  });
}

function setConnectionStatus(status) {
  return updateState((state) => {
    state.connectionStatus = status;
    return state;
  });
}

function addTickerItem(item) {
  return updateState((state) => {
    if (!state.ticker) {
      state.ticker = { items: [] };
    }
    // Add timestamp
    item.createdAt = Date.now();
    state.ticker.items.push(item);
    // FIFO: keep max 5 items
    if (state.ticker.items.length > 5) {
      state.ticker.items.shift();
    }
    return state;
  });
}

function resetCounters() {
  return updateState((state) => {
    state.memoryQueries = 0;
    state.lessonsCaptured = 0;
    state.significantOps = 0;
    state.lastCapturePromptAt = null;
    state.connectionStatus = "unknown";
    state.lastReset = new Date().toISOString();
    return state;
  });
}

/**
 * GP-530: Increment significant operations counter for periodic capture
 * Tracks Edit, Write, and Task tool uses to determine when to prompt for lesson capture
 */
function incrementSignificantOps() {
  return updateState((state) => {
    state.significantOps = (state.significantOps || 0) + 1;
    return state;
  });
}

/**
 * GP-530: Reset significant ops counter and record capture prompt timestamp
 * Called after a periodic capture prompt is injected
 */
function recordCapturePrompt() {
  return updateState((state) => {
    state.significantOps = 0;
    state.lastCapturePromptAt = new Date().toISOString();
    return state;
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle (GP-863) — SessionStart/SessionEnd own everything below.
// ---------------------------------------------------------------------------

/**
 * Record a SessionStart. `compact` is the only mid-session source, so it alone
 * sets `compacted`; every other source (startup, resume, clear, fork, and any
 * matcher Claude Code adds later) is a session (re)start and arms
 * `firstPromptPending`. Only `clear` zeroes the counters — a resumed or
 * compacted session is the same run and keeps its tally.
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
    // Fresh context either way — the Stop lesson prompt is due again.
    state.lessonsPromptedAt = null;
    if (source === "clear") {
      state.memoryQueries = 0;
      state.lessonsCaptured = 0;
      state.significantOps = 0;
      state.lastCapturePromptAt = null;
    }
    return state;
  });
}

/**
 * Record a SessionEnd. The file is finalized rather than deleted so the
 * statusline and the next SessionStart can still read the last known state; the
 * 24h sweep reclaims it.
 * @param {string} [reason] - SessionEnd reason from the hook payload
 * @returns {Object} the persisted state
 */
function finalizeSession(reason) {
  return updateState((state) => {
    state.endedAt = new Date().toISOString();
    state.endReason = reason || "other";
    state.firstPromptPending = false;
    state.compacted = false;
    return state;
  });
}

/**
 * Read-and-clear a lifecycle flag. Writes only when the flag was set, so the
 * common case on the UserPromptSubmit guard's hot path is one read (R25).
 * @param {string} flag
 * @returns {boolean} whether the flag was set
 */
function consumeFlag(flag) {
  if (!getState()[flag]) {
    return false;
  }
  updateState((state) => {
    state[flag] = false;
    return state;
  });
  return true;
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

/** @returns {boolean} whether this session already saw a lesson-capture prompt */
function wasLessonsPrompted() {
  return Boolean(getState().lessonsPromptedAt);
}

/**
 * Mark the lesson-capture prompt as shown. Returns false when the write did not
 * land, so the caller can fail open rather than re-prompt forever.
 * @returns {boolean} true if persisted
 */
function markLessonsPrompted() {
  return applyUpdate((state) => {
    state.lessonsPromptedAt = new Date().toISOString();
    return state;
  }).written;
}

/**
 * Re-arm the lesson-capture prompt (called on each new user prompt).
 * @returns {boolean} true if a prompt record was cleared
 */
function clearLessonsPrompted() {
  if (!getState().lessonsPromptedAt) {
    return false;
  }
  updateState((state) => {
    state.lessonsPromptedAt = null;
    return state;
  });
  return true;
}

module.exports = {
  init,
  sanitizeSessionId,
  getState,
  updateState,
  applyUpdate,
  incrementMemoryQueries,
  incrementLessonsCaptured,
  incrementSignificantOps,
  recordCapturePrompt,
  setConnectionStatus,
  addTickerItem,
  resetCounters,
  getStatePath,
  defaultState,
  // GP-863 session lifecycle
  beginSession,
  finalizeSession,
  consumeFirstPromptPending,
  consumeCompacted,
  wasLessonsPrompted,
  markLessonsPrompted,
  clearLessonsPrompted,
};
