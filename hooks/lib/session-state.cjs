#!/usr/bin/env node
/**
 * GUTT Session State Utility
 * Shared state management for statusline and hooks
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Store session state in the project's .claude directory (not plugin install path)
// This ensures state is per-project and survives plugin updates
const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_ROOT, ".claude", "hooks", ".state");
const STATE_PATH = path.join(STATE_DIR, "gutt-session.json");

const DEFAULT_STATE = {
  sessionId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  connectionStatus: "unknown",
  memoryQueries: 0,
  lessonsCaptured: 0,
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
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
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
  const tempPath = STATE_PATH + ".tmp";
  const serialized = JSON.stringify(newState, null, 2);
  fs.writeFileSync(tempPath, serialized);

  try {
    // On Windows, rename cannot overwrite an existing file, so delete first if present
    if (fs.existsSync(STATE_PATH)) {
      fs.unlinkSync(STATE_PATH);
    }
    fs.renameSync(tempPath, STATE_PATH);
  } catch {
    // Fallback: write directly to the target file if rename fails
    fs.writeFileSync(STATE_PATH, serialized);
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
    state.connectionStatus = "unknown";
    state.lastReset = new Date().toISOString();
    return state;
  });
}

module.exports = {
  getState,
  updateState,
  incrementMemoryQueries,
  incrementLessonsCaptured,
  setConnectionStatus,
  addTickerItem,
  resetCounters,
  STATE_PATH,
  DEFAULT_STATE,
};
