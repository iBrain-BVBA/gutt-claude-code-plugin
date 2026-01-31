#!/usr/bin/env node
/**
 * GUTT Session State Utility
 * Shared state management for statusline and hooks
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = path.join(__dirname, '.state');
const STATE_PATH = path.join(STATE_DIR, 'gutt-session.json');

const DEFAULT_STATE = {
  sessionId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  connectionStatus: 'unknown',
  memoryQueries: 0,
  lessonsCaptured: 0,
  lastUpdated: new Date().toISOString()
};

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function getState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function updateState(updater) {
  ensureDir();
  const state = getState();
  const newState = updater(state);
  newState.lastUpdated = new Date().toISOString();

  // Atomic write
  const tempPath = STATE_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(newState, null, 2));
  fs.renameSync(tempPath, STATE_PATH);

  return newState;
}

function incrementMemoryQueries() {
  return updateState(state => {
    state.memoryQueries = (state.memoryQueries || 0) + 1;
    return state;
  });
}

function incrementLessonsCaptured() {
  return updateState(state => {
    state.lessonsCaptured = (state.lessonsCaptured || 0) + 1;
    return state;
  });
}

function setConnectionStatus(status) {
  return updateState(state => {
    state.connectionStatus = status;
    return state;
  });
}

module.exports = {
  getState,
  updateState,
  incrementMemoryQueries,
  incrementLessonsCaptured,
  setConnectionStatus,
  STATE_PATH,
  DEFAULT_STATE
};
