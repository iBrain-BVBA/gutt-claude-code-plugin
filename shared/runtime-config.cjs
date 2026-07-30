#!/usr/bin/env node
/**
 * GUTT runtime config — `${CLAUDE_PLUGIN_DATA}/config.json` (GP-863, R37 artifact 1/3).
 *
 * Durable, user-facing preferences: on/off, mode, snooze, and the per-project
 * decisions under `projects`. Per the S3.1 state contract this file has a single
 * writer — the config command surface (GP-866) — with two carve-outs. GP-863 owns
 * the first: the session lifecycle expires a lapsed snooze at SessionStart and drops
 * a session-scoped snooze at SessionEnd. GP-922 owns the second: the built-in-memory
 * migration decision, recorded once per project. GP-866 extends this with the
 * command-driven setters.
 *
 * Shape note (GP-922): every key but `projects` is **machine-global**, and that was
 * the whole shape until now. A machine-wide "declined" would silence a repo where
 * migration is wanted, and a machine-wide "migrated" would skip a repo that still
 * holds a full local store — so the migration decision cannot live at the top level.
 * `projects` is the first per-project key space here; see `PROJECTS_KEY` for how it
 * is keyed and why. `migrations.cjs` was not the vehicle: it gates work "at most
 * once per machine" on `migrationsVersion`, which is exactly the wrong granularity.
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
  /**
   * Per-project state, keyed by `PROJECTS_KEY` (GP-922). Everything above is
   * machine-global; this is not. Absent until something is actually recorded — a
   * machine that has never been offered a migration has no `projects` key at all.
   */
  projects: {},
};

/** The per-project key space. */
const PROJECTS_KEY = "projects";

/**
 * Keys this module is allowed to mutate.
 *
 * The whitelist grows here rather than being quietly widened: GP-863 shipped it as
 * the two snooze keys alone, and GP-922 adds the per-project space. Anything not
 * listed belongs to GP-866's command surface and must not be touched from a hook.
 */
const SNOOZE_KEYS = ["snoozeUntil", "snoozeSessionId"];
const OWNED_KEYS = [...SNOOZE_KEYS, PROJECTS_KEY];

/**
 * Recorded answers to the built-in-memory migration offer (GP-922).
 *
 * `later` is deliberately not terminal — it records that the user was asked and
 * deferred, which lets the skill phrase a second approach differently, but it does
 * not settle the question. Only `migrated` and `declined` do.
 */
const MIGRATION_STATES = ["migrated", "declined", "later"];
const SETTLED_MIGRATION_STATES = ["migrated", "declined"];

/** @returns {string|null} */
function configPath() {
  return statePath("config.json");
}

/**
 * Config as consumers should see it: stored values over documented defaults.
 * Never writes, so a session that only reads config leaves no file behind.
 * @returns {{enabled: boolean, mode: string, snoozeUntil: string|null, snoozeSessionId: string|null, projects: Object}}
 */
function readConfig() {
  const stored = readJson(configPath(), null) || {};
  return {
    ...DEFAULTS,
    ...stored,
    // Rebuilt per call. `DEFAULTS` is a module-level literal, so spreading it hands
    // every caller the *same* `projects` object — one caller mutating what looks
    // like its own copy would change what every later read returns. Same hazard
    // session-state avoids by building its default record per call.
    [PROJECTS_KEY]: { ...(stored[PROJECTS_KEY] || {}) },
  };
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

// ---------------------------------------------------------------------------
// Built-in memory migration, per project (GP-922)
// ---------------------------------------------------------------------------

/**
 * The recorded answer to the migration offer for one project, or null when nothing
 * has been recorded — including when a stored value is not one this version knows,
 * which is treated as "unrecorded" rather than trusted blindly.
 *
 * @param {string|null} projectKey - from `builtin-memory.projectKey()`
 * @returns {"migrated"|"declined"|"later"|null}
 */
function readMigrationState(projectKey) {
  if (!projectKey) {
    return null;
  }
  const status = readRawConfig()?.[PROJECTS_KEY]?.[projectKey]?.memoryMigration?.status;
  return MIGRATION_STATES.includes(status) ? status : null;
}

/**
 * Is the migration question settled for this project — i.e. must the offer stay
 * silent? True for `migrated` and `declined`; false for `later` and for no record.
 *
 * This is the **primary** gate on the offer. The structural marker exclusion in
 * `builtin-memory.listFacts()` is the second, and is not redundant with it: this
 * record lives under `${CLAUDE_PLUGIN_DATA}` and is therefore machine-local, while
 * the store it describes is not.
 *
 * @param {string|null} projectKey
 * @returns {boolean}
 */
function isMigrationSettled(projectKey) {
  return SETTLED_MIGRATION_STATES.includes(readMigrationState(projectKey));
}

/**
 * Record the answer for one project. Rejects an unknown status rather than storing
 * it — a typo must not silently become a permanent `declined`.
 *
 * @param {string|null} projectKey
 * @param {"migrated"|"declined"|"later"} status
 * @param {number} [now]
 * @returns {boolean} true if written
 */
function setMigrationState(projectKey, status, now = Date.now()) {
  if (!projectKey || !MIGRATION_STATES.includes(status)) {
    return false;
  }
  return updateConfig((config) => {
    const next = config || {};
    const stored = next[PROJECTS_KEY];
    // Only reuse the stored value when it is actually an object. A corrupt or
    // hand-edited scalar here would otherwise throw inside the lock, and a throw
    // inside the lock is a lock left held.
    const projects = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    projects[projectKey] = {
      ...projects[projectKey],
      memoryMigration: { status, at: new Date(now).toISOString() },
    };
    next[PROJECTS_KEY] = projects;
    return next;
  });
}

module.exports = {
  DEFAULTS,
  PROJECTS_KEY,
  OWNED_KEYS,
  MIGRATION_STATES,
  configPath,
  readConfig,
  readRawConfig,
  isSnoozed,
  setSnooze,
  clearExpiredSnooze,
  clearSessionSnooze,
  // GP-922 built-in memory migration
  readMigrationState,
  isMigrationSettled,
  setMigrationState,
};
