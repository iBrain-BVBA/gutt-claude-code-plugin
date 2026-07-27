#!/usr/bin/env node
/**
 * GUTT runtime config — `${CLAUDE_PLUGIN_DATA}/config.json` (GP-863, R37 artifact 1/3).
 *
 * Durable, user-facing preferences: on/off, mode, and snooze. Per the S3.1 state
 * contract this file has a single writer — the config command surface (GP-866) —
 * with one carve-out that GP-863 owns: the session lifecycle expires a lapsed
 * snooze at SessionStart and drops a session-scoped snooze at SessionEnd. Those
 * are the only writes this module performs today; GP-866 extends it with the
 * command-driven setters.
 *
 * NOT the same file as `shared/config.cjs`, which reads the static, git-ignored
 * plugin/project `config.json` holding the org `group_id`. Same basename,
 * different directory, different purpose — a distinction that has bitten us
 * before, so check which one you mean before adding a key.
 *
 * Mutations read the file raw and touch only the keys they own, so this module
 * never materialises defaults it doesn't manage into a config GP-866 owns.
 */
"use strict";

const { statePath, readJson, writeJson } = require("./plugin-state.cjs");

/**
 * The documented shape of `config.json`. Read-side only: `enabled` and `mode`
 * are GP-866's to write — they are listed here so the contract is visible in
 * one place and consumers get a complete object.
 */
const DEFAULTS = {
  enabled: true,
  mode: "auto",
  /** ISO-8601 instant the snooze lapses, or null when not snoozed. */
  snoozeUntil: null,
  /** When set, the snooze belongs to that session and dies with it. */
  snoozeSessionId: null,
};

/** Keys this module is allowed to mutate. */
const SNOOZE_KEYS = ["snoozeUntil", "snoozeSessionId"];

/** @returns {string|null} */
function configPath() {
  return statePath("config.json");
}

/**
 * Config as consumers should see it: stored values over documented defaults.
 * Never writes, so a session that only reads config leaves no file behind.
 * @returns {{enabled: boolean, mode: string, snoozeUntil: string|null, snoozeSessionId: string|null}}
 */
function readConfig() {
  return { ...DEFAULTS, ...(readJson(configPath(), null) || {}) };
}

/**
 * The stored object exactly as written, or null when there is no config file.
 * Mutators use this so they can no-op instead of creating a file just to clear
 * a key that was never set.
 * @returns {Object|null}
 */
function readRawConfig() {
  return readJson(configPath(), null);
}

/**
 * True when a snooze is in force for `sessionId` at `now`. A session-scoped
 * snooze only applies to its own session; an expired `snoozeUntil` never applies.
 * @param {string|null} [sessionId]
 * @param {number} [now]
 * @returns {boolean}
 */
function isSnoozed(sessionId = null, now = Date.now()) {
  const { snoozeUntil, snoozeSessionId } = readConfig();
  if (snoozeSessionId && snoozeSessionId !== sessionId) {
    return false;
  }
  if (!snoozeUntil) {
    // A session-scoped snooze with no deadline lasts the whole session.
    return Boolean(snoozeSessionId);
  }
  const until = Date.parse(snoozeUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * Persist a snooze. The primitive behind GP-866's `/gutt off` — GP-863 ships it
 * so the lifecycle it clears is expressible (and testable) in one place.
 * @param {{untilMs?: number|null, sessionId?: string|null}} [opts]
 * @returns {boolean} true if written
 */
function setSnooze({ untilMs = null, sessionId = null } = {}) {
  const config = readRawConfig() || {};
  config.snoozeUntil = Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null;
  config.snoozeSessionId = sessionId;
  return writeJson(configPath(), config);
}

/**
 * Drop the snooze keys if any are set. Shared tail of both clear paths.
 * @param {Object|null} config
 * @returns {boolean} true if written
 */
function dropSnooze(config) {
  if (!config || !SNOOZE_KEYS.some((k) => config[k] !== undefined && config[k] !== null)) {
    return false;
  }
  for (const key of SNOOZE_KEYS) {
    delete config[key];
  }
  return writeJson(configPath(), config);
}

/**
 * SessionStart TTL step: clear a snooze whose deadline has passed. A
 * session-scoped snooze with no deadline is left alone — SessionEnd owns it.
 * @param {number} [now]
 * @returns {boolean} true if an expired snooze was cleared
 */
function clearExpiredSnooze(now = Date.now()) {
  const config = readRawConfig();
  if (!config?.snoozeUntil) {
    return false;
  }
  const until = Date.parse(config.snoozeUntil);
  // An unparseable deadline can never expire on its own — treat it as stale.
  if (Number.isFinite(until) && until > now) {
    return false;
  }
  return dropSnooze(config);
}

/**
 * SessionEnd step: clear a snooze scoped to the session that is ending. Leaves
 * a durable (unscoped) snooze in place — that one outlives the session.
 * @param {string|null} sessionId
 * @returns {boolean} true if a session-scoped snooze was cleared
 */
function clearSessionSnooze(sessionId) {
  if (!sessionId) {
    return false;
  }
  const config = readRawConfig();
  if (!config || config.snoozeSessionId !== sessionId) {
    return false;
  }
  return dropSnooze(config);
}

module.exports = {
  DEFAULTS,
  configPath,
  readConfig,
  readRawConfig,
  isSnoozed,
  setSnooze,
  clearExpiredSnooze,
  clearSessionSnooze,
};
