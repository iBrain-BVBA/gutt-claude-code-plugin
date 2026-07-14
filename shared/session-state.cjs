#!/usr/bin/env node
/**
 * GUTT Session State Utility
 * Shared state management for statusline and hooks
 */

const crypto = require("crypto");
const { statePath, readJson, writeJson } = require("./plugin-state.cjs");

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

const DEFAULT_STATE = {
  sessionId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  connectionStatus: "unknown",
  memoryQueries: 0,
  lessonsCaptured: 0,
  significantOps: 0, // GP-530: tracks Edit/Write/Task ops for periodic capture
  lastCapturePromptAt: null, // GP-530: ISO timestamp of last capture prompt injection
  lastUpdated: new Date().toISOString(),
  ticker: {
    items: [], // FIFO queue, max 5 items with createdAt timestamps
  },
};

function getState() {
  return readJson(getStatePath(), { ...DEFAULT_STATE });
}

function updateState(updater) {
  const state = getState();
  const newState = updater(state);
  newState.lastUpdated = new Date().toISOString();
  writeJson(getStatePath(), newState);
  return newState;
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

module.exports = {
  init,
  sanitizeSessionId,
  getState,
  updateState,
  incrementMemoryQueries,
  incrementLessonsCaptured,
  incrementSignificantOps,
  recordCapturePrompt,
  setConnectionStatus,
  addTickerItem,
  resetCounters,
  getStatePath,
  DEFAULT_STATE,
};
