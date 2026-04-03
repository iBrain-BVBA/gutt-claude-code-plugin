#!/usr/bin/env node
/**
 * GUTT Session State Utility
 * Shared state management for statusline and hooks
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PROJECT_STATE_DIR } = require("./env.cjs");

// Store session state in the project's IDE directory (not plugin install path)
// This ensures state is per-project and survives plugin updates
const STATE_DIR = path.join(PROJECT_STATE_DIR, "hooks", ".state");

// Per-session state file path: when init(sessionId) is called, the file name
// includes the session ID so concurrent Claude Code sessions don't corrupt
// each other's state.  Falls back to the legacy shared file when not initialised.
let _sessionId = null;

function getStatePath() {
  if (_sessionId) {
    return path.join(STATE_DIR, `gutt-session-${_sessionId}.json`);
  }
  return path.join(STATE_DIR, "gutt-session.json");
}

/**
 * Initialise per-session file path.
 * Must be called early in every hook that reads/writes session state.
 * @param {string} sessionId - The session_id from Claude Code hook input
 */
function init(sessionId) {
  if (sessionId && sessionId !== "unknown") {
    _sessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
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

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function getState() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function updateState(updater) {
  ensureDir();
  const state = getState();
  const newState = updater(state);
  newState.lastUpdated = new Date().toISOString();

  // Cross-platform safe write using temp file with replace-safe rename
  const statePath = getStatePath();
  const tempPath = statePath + ".tmp";
  const serialized = JSON.stringify(newState, null, 2);
  fs.writeFileSync(tempPath, serialized);

  try {
    // On Windows, rename cannot overwrite an existing file, so delete first if present
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
    fs.renameSync(tempPath, statePath);
  } catch {
    // Fallback: write directly to the target file if rename fails
    fs.writeFileSync(statePath, serialized);
  } finally {
    // Best-effort cleanup of any leftover temp file
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

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
