#!/usr/bin/env node
/**
 * GUTT runtime config — `${CLAUDE_PLUGIN_DATA}/config.json` (GP-863, R37 artifact 1/3).
 *
 * Durable, user-facing preferences: on/off, mode, snooze, and the per-project
 * decisions under `projects`. Per the S3.1 state contract the config command
 * surface is the only writer a *user* drives, with two carve-outs the lifecycle
 * drives on its own. GP-863 owns the first: a lapsed snooze is expired at
 * SessionStart and a session-scoped snooze dropped at SessionEnd. GP-922 owns the
 * second: the built-in-memory migration decision, recorded once per project.
 *
 * GP-866 landed the command-driven setters here rather than in the command layer,
 * which is why `enabled` and `mode` are now writable from this module: the surface
 * is a UserPromptSubmit hook, so "must not be written from a hook" would have
 * forbidden the feature. What that older rule was protecting is still enforced —
 * every mutator below touches only the keys it names, so the SessionStart sweep
 * cannot clobber a preference and `/gutt-pro:on` cannot clobber a migration record.
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

const {
  statePath,
  readJson,
  readJsonOrUnreadable,
  UNREADABLE,
  writeJson,
  withLock,
} = require("./plugin-state.cjs");
const { debugLog } = require("./debug.cjs");

/**
 * The documented shape of `config.json`. Every key here has both a reader and a
 * writer as of GP-866; before it, `enabled` and `mode` were declared and used by
 * nobody, so a hand-written `{"enabled": false}` silently did nothing.
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
 * the two snooze keys alone, GP-922 added the per-project space, and GP-866 adds
 * the two preference keys with the setters that write them. Anything not listed —
 * `migrationsVersion`, notably — belongs to another module and must not be touched
 * from here.
 *
 * The list is a statement about this module, not about any single call: no mutator
 * writes all of it. `PREFERENCE_KEYS` and `SNOOZE_KEYS` are what the individual
 * writers are scoped to, and keeping them separate is what stops the SessionStart
 * sweep from touching a preference.
 */
const SNOOZE_KEYS = ["snoozeUntil", "snoozeSessionId"];
const PREFERENCE_KEYS = ["enabled", "mode"];
const OWNED_KEYS = [...PREFERENCE_KEYS, ...SNOOZE_KEYS, PROJECTS_KEY];

/**
 * The capture modes `/gutt-pro:mode` accepts. Exported because E4 (GP-874) reads the
 * same list — two copies would drift, and the failure would be a mode this module
 * happily writes and E4 does not recognise.
 */
const MODES = ["auto", "hitl"];

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
 * `readRawConfig` with "no file yet" and "file is unreadable" told apart.
 *
 * `/gutt-pro:config` needs the distinction and nothing else does: its whole job is to
 * explain the stored state, so rendering built-in defaults for a file that failed to
 * parse reports values it never read — under a header that says it read them. Every
 * other caller wants a value and is right to take the defaults.
 *
 * @returns {{state: "absent"|"ok"|"unreadable", raw: Object|null}}
 */
function readRawConfigState() {
  const value = readJsonOrUnreadable(configPath());
  if (value === UNREADABLE) {
    return { state: "unreadable", raw: null };
  }
  return value ? { state: "ok", raw: value } : { state: "absent", raw: null };
}

/**
 * Does a snooze apply, given a config already read? Split out of `isSnoozed` so
 * `isSuppressed` can answer both halves of the question from **one** read — this
 * is on the UserPromptSubmit path with a 50ms budget (R25), and two `readConfig()`
 * calls to answer one question is the cost that made honouring `enabled` look
 * expensive in the first place.
 * @param {{snoozeUntil: string|null, snoozeSessionId: string|null}} config
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {boolean}
 */
function snoozeApplies({ snoozeUntil, snoozeSessionId }, sessionId, now) {
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
 * True when a snooze is in force for `sessionId` at `now`. A session-scoped
 * snooze only applies to its own session; an expired `snoozeUntil` never applies.
 *
 * Kept as its own export even though the router now calls `isSuppressed`: it is
 * the snooze half on its own, which is what `/gutt-pro:config` reports and what the
 * lifecycle tests assert about.
 * @param {string|null} [sessionId]
 * @param {number} [now]
 * @returns {boolean}
 */
function isSnoozed(sessionId = null, now = Date.now()) {
  return snoozeApplies(readConfig(), sessionId, now);
}

/**
 * True when the plugin must stay silent — either turned off durably (`/gutt-pro:disable`)
 * or snoozed. This is the router's gate; `isSnoozed` alone was, and it left
 * `enabled` in the documented schema with nothing reading it.
 *
 * `enabled` is compared with a strict `=== false` so an unrecognised stored value
 * reads as on, matching how `readMigrationState` refuses to trust a status it does
 * not know. A hand-edited `"enabled": "no"` therefore does **not** silence the
 * plugin — and `/gutt-pro:config` prints the raw value so the mistake is visible
 * rather than quietly ineffective.
 *
 * Why off-ness is `enabled` and not an unbounded snooze: an unbounded snooze is
 * not representable. `setSnooze({})` writes both keys null, and `snoozeApplies`
 * then returns `Boolean(null)` — false. There is no "snoozed forever" state.
 * @param {string|null} [sessionId]
 * @param {number} [now]
 * @returns {boolean}
 */
function isSuppressed(sessionId = null, now = Date.now()) {
  const config = readConfig();
  return config.enabled === false || snoozeApplies(config, sessionId, now);
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
    // Logged for symmetry with the UNREADABLE refusal below, even though this is
    // the one branch whose log cannot land: `debug.cjs` resolves hook-errors.log
    // from the same missing CLAUDE_PLUGIN_DATA, so this call is a no-op by
    // construction. Kept because a bare `return false` on a write path is the
    // pattern this module is otherwise scrupulous about, and because the call
    // starts working the moment the directory does. The user-facing half of this
    // case is `writeFailed()`, which says there is no log rather than naming one.
    debugLog("runtime-config", "no plugin data dir; config write skipped");
    return false;
  }
  return (
    withLock(file, () => {
      // Re-read inside the lock: the pre-check that got us here ran unlocked and
      // may already be stale.
      const stored = readJsonOrUnreadable(file);
      // A corrupt or unreadable file must not be treated as a fresh one. Every
      // mutator below collapses a null to `{}` and returns it, so proceeding here
      // would write a config built from the one key the caller owns and silently
      // drop the rest — `projects` (a per-project migration answer), `mode`, and
      // `migrationsVersion` among them. Refusing turns a silent data loss into a
      // failed write the command surface already knows how to report.
      if (stored === UNREADABLE) {
        debugLog("runtime-config", `refusing to overwrite unreadable ${file}`);
        return false;
      }
      const next = mutate(stored);
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
 * Persist a snooze. The primitive behind GP-866's `/gutt-pro:off` — GP-863 ships it
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
// Command-driven setters (GP-866) — the writers behind `/gutt-pro:on|off|disable|mode`
// ---------------------------------------------------------------------------

/**
 * What `/gutt-pro:on` clears. Deliberately **not** `mode`: capture mode is a separate
 * axis from on/off, and silently resetting a user's `hitl` choice because they
 * un-snoozed recall would be a surprise.
 */
const RESTORE_KEYS = ["enabled", ...SNOOZE_KEYS];

/**
 * Turn recall off durably (`/gutt-pro:disable`), or clear that flag.
 *
 * `true` is stored as the *absence* of the key rather than as `enabled: true`, so
 * "on" has exactly one representation — the same delete-the-key style
 * `withoutSnooze` uses. Passing `true` when the key is already absent writes
 * nothing, so a no-op never creates a config file.
 * @param {boolean} enabled
 * @returns {boolean} true if a write landed
 */
function setEnabled(enabled) {
  return updateConfig((config) => {
    const next = config || {};
    if (enabled === false) {
      next.enabled = false;
      return next;
    }
    if (next.enabled === undefined) {
      return null;
    }
    delete next.enabled;
    return next;
  });
}

/**
 * Set the capture mode (`/gutt-pro:mode auto|hitl`).
 *
 * Rejects a mode this version does not know rather than storing it, the same way
 * `setMigrationState` refuses an unknown status: a typo must not become a stored
 * value that E4 later fails to recognise.
 * @param {string} mode
 * @returns {boolean} true if a write landed
 */
function setMode(mode) {
  if (!MODES.includes(mode)) {
    return false;
  }
  return updateConfig((config) => {
    const next = config || {};
    next.mode = mode;
    return next;
  });
}

/**
 * `/gutt-pro:on`: clear a durable off and any snooze, in one locked transaction.
 *
 * Writes nothing when nothing was suppressed — so `/gutt-pro:on` on a clean machine
 * leaves no config file behind, and the command can honestly report "was already
 * on" rather than claiming a change.
 *
 * A session-scoped snooze set by a *different* session is cleared too. `config.json`
 * is machine-global, so `/gutt-pro:on` is a machine-global statement; the alternative
 * leaves a foreign key in the file that `/gutt-pro:config` then has to explain.
 *
 * Do not route `clearExpiredSnooze`/`clearSessionSnooze` through this. They use
 * `withoutSnooze` precisely because the lifecycle must never touch `enabled` —
 * `tests/session-lifecycle.test.cjs` and `tests/e2e/hook-routing.e2e.cjs` both
 * assert a preference survives a sweep.
 * @returns {boolean} true if a write landed
 */
function restore() {
  return updateConfig((config) => {
    if (!config) {
      return null;
    }
    // Two different tests, deliberately. Whether there is anything to *clear* is
    // about meaning — only a non-null value suppresses anything — but once we are
    // writing, every restore key present is removed, null ones included. Otherwise
    // `setSnooze({sessionId})`'s explicit `snoozeUntil: null` would survive every
    // `/gutt-pro:on` and sit in the file forever, since nothing null is worth clearing
    // on its own.
    const suppressing = RESTORE_KEYS.some(
      (key) => config[key] !== undefined && config[key] !== null
    );
    if (!suppressing) {
      return null;
    }
    for (const key of RESTORE_KEYS) {
      delete config[key];
    }
    return config;
  });
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
  PREFERENCE_KEYS,
  MODES,
  MIGRATION_STATES,
  configPath,
  readConfig,
  readRawConfig,
  readRawConfigState,
  isSnoozed,
  isSuppressed,
  setSnooze,
  clearExpiredSnooze,
  clearSessionSnooze,
  // GP-866 config command setters
  setEnabled,
  setMode,
  restore,
  // GP-922 built-in memory migration
  readMigrationState,
  isMigrationSettled,
  setMigrationState,
};
