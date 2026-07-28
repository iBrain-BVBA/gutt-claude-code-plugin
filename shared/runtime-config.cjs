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
 *
 * Concurrency: unlike `sessions/<id>.json`, this file is **global** — every
 * concurrent Claude Code session on the machine shares it, and SessionStart and
 * SessionEnd both write it. Every mutation therefore runs under the same write
 * lock the session state uses; an unguarded read-then-write here loses updates
 * exactly the way it did there (see plugin-state.updateJson).
 */
"use strict";

const { statePath, readJson, writeJson, withLock } = require("./plugin-state.cjs");

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
 * Read-modify-write `config.json` under the write lock.
 *
 * `mutate` receives the stored config (or null when the file does not exist)
 * and returns the object to persist, or null to write nothing. Returning null
 * matters: a session that merely checks for a lapsed snooze must not create a
 * config file, and must not rewrite one it did not change.
 *
 * @param {(config: Object|null) => Object|null} mutate
 * @returns {boolean} true if a write landed
 */
function updateConfig(mutate) {
  const file = configPath();
  if (!file) {
    return false;
  }
  return (
    withLock(file, () => {
      // Re-read inside the lock: the pre-check that got us here ran unlocked and
      // may already be stale.
      const next = mutate(readJson(file, null));
      return next ? writeJson(file, next) : false;
    }) || false
  );
}

/**
 * Strip the snooze keys from a config object.
 * @param {Object|null} config
 * @returns {Object|null} the mutated config, or null when no snooze was set
 */
function withoutSnooze(config) {
  if (!config || !SNOOZE_KEYS.some((k) => config[k] !== undefined && config[k] !== null)) {
    return null;
  }
  for (const key of SNOOZE_KEYS) {
    delete config[key];
  }
  return config;
}

/**
 * Persist a snooze. The primitive behind GP-866's `/gutt off` — GP-863 ships it
 * so the lifecycle it clears is expressible (and testable) in one place.
 * @param {{untilMs?: number|null, sessionId?: string|null}} [opts]
 * @returns {boolean} true if written
 */
function setSnooze({ untilMs = null, sessionId = null } = {}) {
  return updateConfig((config) => {
    const next = config || {};
    next.snoozeUntil = Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null;
    next.snoozeSessionId = sessionId;
    return next;
  });
}

/**
 * SessionStart TTL step: clear a snooze whose deadline has passed. A
 * session-scoped snooze with no deadline is left alone — SessionEnd owns it.
 * @param {number} [now]
 * @returns {boolean} true if an expired snooze was cleared
 */
function clearExpiredSnooze(now = Date.now()) {
  // Unlocked pre-check. No snooze at all is overwhelmingly the common case, and
  // this runs on every SessionStart — taking the lock to discover there is
  // nothing to do would be pure cost on a path with a 50ms budget (R25).
  if (!readRawConfig()?.snoozeUntil) {
    return false;
  }
  return updateConfig((config) => {
    if (!config?.snoozeUntil) {
      return null;
    }
    const until = Date.parse(config.snoozeUntil);
    // An unparseable deadline can never expire on its own — treat it as stale.
    if (Number.isFinite(until) && until > now) {
      return null;
    }
    return withoutSnooze(config);
  });
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
  if (readRawConfig()?.snoozeSessionId !== sessionId) {
    return false;
  }
  return updateConfig((config) =>
    config?.snoozeSessionId === sessionId ? withoutSnooze(config) : null
  );
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
