#!/usr/bin/env node
/**
 * One-time cleanup of what 2.x left on disk (GP-895).
 *
 * The 3.0 rebuild stopped writing outside `${CLAUDE_PLUGIN_DATA}` — but that only
 * fixes *future* writes. Anyone who ran a 2.x version still carries the artifacts
 * it left behind, and upgrading cannot clear them precisely because 3.0 has no
 * reason to look at those paths any more. Stopping the write and cleaning up what
 * was already written are two separate jobs; only the first one shows up in a diff.
 *
 * Every path below is one this repo's own history proves a retired hook wrote.
 * That list took two attempts, and the second correction is the instructive one:
 *
 *  - The first draft guessed names from what the retired hooks *did*, which
 *    invented a `~/.claude/hud/` nothing ever wrote.
 *  - The second draft over-corrected. It searched
 *    `git rev-list --all -- gutt-core/hooks shared | head -60`, concluded
 *    `gutt-analytics.json` was also invented, and dropped it. Both halves of that
 *    search were too narrow: `head -60` cut the history off, and before the GP-852
 *    restructure the hooks lived at the repo *root*, so `gutt-core/hooks` did not
 *    exist in the revisions that mattered. The file appears in 63 commits and was
 *    being actively written by an installed 2.x on the machine at the time.
 *
 * The list is now what `git rev-list --all` over `'*.cjs'` supports, cross-checked
 * against files found on disk. A negative result from a scoped search is not
 * evidence of absence — which cost more here than the original guess did, because
 * it was stated as a certainty.
 *
 * WHY THIS MODULE MAY WRITE `~/.claude/settings.json`
 *
 * `tests/check-state-location.cjs` bans that write, and its comment says the ban
 * became absolute when GP-863 deleted `sessionstart-setup.cjs`. This re-opens a
 * deliberately narrow exemption, listed in that guard's allowlist with a reason
 * rather than sneaking past it:
 *
 *  - it only ever REMOVES a key a previous version of this plugin wrote,
 *  - only when the file that key points at is already gone, so the entry is
 *    provably dead rather than a config someone is relying on,
 *  - at most once per machine, gated on a version recorded in config.json,
 *  - after copying the whole original file into the plugin's own data dir.
 *
 * The steady-state ban is untouched: nothing here ever *adds* to settings.json.
 *
 * Paths are injectable so tests drive the real logic against a synthetic HOME
 * instead of the developer's own machine.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { statePath, readJson, writeJson, remove, withLock } = require("./plugin-state.cjs");
const { debugLog } = require("./debug.cjs");

/**
 * Version of the migration SET, deliberately not the plugin's version.
 *
 * A monotonic integer compared with `>=`. The retired setup hook's marker
 * mechanism got this wrong twice — first an existence check that never re-ran on
 * upgrade, then a semver comparison. An integer cannot be misordered. Bump it when
 * adding a step.
 */
const MIGRATIONS_VERSION = 1;

/** Where the recorded version lives inside the R37 config artifact. */
const VERSION_KEY = "migrationsVersion";

/**
 * Caches 2.x wrote into the plugin data dir, which nothing in 3.0 reads. Relative
 * to `${CLAUDE_PLUGIN_DATA}`. The `gutt-` prefixed spellings are from an earlier
 * era that shared a directory; both spellings shipped, so both are cleaned.
 *
 * Deliberately excludes `config.json`, `sessions/`, and `capture-queue.jsonl` —
 * those are the live R37 artifacts.
 */
const ORPHANED_STATE = [
  "memory-cache.json",
  "seed-registry.json",
  "gutt-memory-cache.json",
  "gutt-seed-registry.json",
  "gutt-session.json",
  "gutt-analytics.json",
  "gutt-routing-session.json",
  "gutt-routing.log",
];

/**
 * Leftovers in the user's `~/.claude`, relative to that directory.
 *
 * Every entry carries a `gutt` prefix. That is the whole selection rule for this
 * list: `~/.claude` is shared with Claude Code itself and with other plugins, so
 * an unprefixed name — even one 2.x used, like `memory-cache.json` — is not
 * provably ours and stays put.
 */
const ORPHANED_HOME = [
  ".gutt-statusline-configured",
  "gutt-memory-cache.json",
  "gutt-seed-registry.json",
  "gutt-session.json",
  "gutt-analytics.json",
  "gutt-routing-session.json",
  "gutt-routing.log",
];

/**
 * Per-session leftovers, which an exact-name list structurally cannot reach.
 *
 * 2.x keyed some state by session id — `gutt-session-<uuid>.json` — so one machine
 * accumulates one file per session it ever ran. Found only by listing a real dirty
 * directory: the exact-name list matched the unsuffixed `gutt-session.json` sitting
 * beside them and silently left the rest, which is the failure mode where a
 * migration reports success having cleaned one file out of a dozen.
 *
 * Anchored at both ends, and still `gutt`-prefixed, so the attribution rule for a
 * shared directory holds.
 */
const ORPHANED_PATTERNS = [/^gutt-session-.+\.json$/, /^gutt-routing-.+\.(json|log)$/];

/**
 * Basenames a `statusLine` command may point at for it to be considered ours.
 * Someone else's status line is none of our business, however broken it is.
 */
const OUR_STATUSLINE_FILES = ["statusline.cjs", "gutt-statusline.cjs"];

/** Path fragments marking a statusLine command as plugin-installed, not hand-written. */
const PLUGIN_PATH_MARKERS = ["plugin_", "local-agent-mode-sessions", "gutt", "plugins"];

/**
 * What this migration deliberately leaves alone, reported next to what it did.
 * Absent an explicit list, a clean report reads as "everything was covered".
 */
const NOT_COVERED = [
  "state 2.x wrote into a project tree — that is the user's repo, not ours to delete",
  "an unprefixed 2.x cache in ~/.claude, which is shared and not provably ours",
  "the empty `gutt: {statusline: {}}` key some settings.json files carry — no reader, no attribution, and deleting an unattributable key is worse than leaving an inert one",
  "data belonging to the retired gutt-subagent-hooks-plugin, a separate install (GP-868)",
  "a statusLine whose target still exists — assumed working and intentional",
];

/**
 * Pull the script path out of a statusLine command string.
 * @param {string} command
 * @returns {string|null}
 */
function statusLineTarget(command) {
  const quoted = /["']([^"']+\.cjs)["']/.exec(command);
  return quoted ? quoted[1] : (/(\S+\.cjs)/.exec(command)?.[1] ?? null);
}

/**
 * True when this statusLine was written by a past version of this plugin AND is
 * now dead. Both halves are required: a live target means someone has something
 * that works, and we leave it alone even if we wrote it.
 * @param {*} command
 * @returns {boolean}
 */
function isDeadPluginStatusLine(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return false;
  }
  const target = statusLineTarget(command);
  if (!target || !OUR_STATUSLINE_FILES.includes(path.basename(target))) {
    return false;
  }
  if (!PLUGIN_PATH_MARKERS.some((marker) => target.includes(marker))) {
    return false;
  }
  // The decisive check: a target that still resolves is a working status line.
  return !fs.existsSync(target);
}

/**
 * Replace a file's contents without ever leaving it absent.
 *
 * Same two rules as `plugin-state.atomicWrite`, which cannot be reused here
 * because it refuses paths outside the data dir — correctly, since that refusal is
 * the point of R37. A process-unique temp name, then rename *over* the target
 * rather than unlink-then-write: hooks run in parallel, and the moment settings.json
 * is absent a concurrent reader falls back to defaults.
 * @param {string} absPath
 * @param {string} contents
 * @returns {boolean}
 */
function replaceFile(absPath, contents) {
  const tmp = `${absPath}.gutt-migrate.${process.pid}`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.renameSync(tmp, absPath);
    return true;
  } catch (err) {
    debugLog("migrations", `failed to rewrite ${absPath}: ${err.message}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}

/**
 * Step 1: drop a dead plugin-written `statusLine` from the user's settings.
 * @param {string} settingsFile
 * @param {number} now
 * @returns {string[]} actions taken
 */
function cleanStatusLine(settingsFile, now) {
  let raw;
  let settings;
  try {
    raw = fs.readFileSync(settingsFile, "utf8");
    settings = JSON.parse(raw);
  } catch (err) {
    // A missing settings.json is the normal case on a fresh machine. An
    // unparseable one is never rewritten — that would turn a syntax error someone
    // can fix into data loss they cannot.
    if (err.code !== "ENOENT") {
      debugLog("migrations", `settings.json unreadable, leaving it alone: ${err.message}`);
    }
    return [];
  }

  const command = settings?.statusLine?.command;
  if (!isDeadPluginStatusLine(command)) {
    return [];
  }

  // The whole original file, verbatim, before touching anything. Backing up only
  // the removed key would still lose the file if the rewrite went wrong.
  const backup = statePath("migrations", `settings-backup-${now}.json`);
  if (
    backup &&
    !writeJson(backup, { migratedAt: new Date(now).toISOString(), settingsFile, original: raw })
  ) {
    debugLog("migrations", "could not write the settings backup; leaving settings.json alone");
    return [];
  }

  const target = statusLineTarget(command);
  delete settings.statusLine;
  // Two-space, matching what Claude Code itself writes. The rewrite reformats the
  // file; the verbatim backup above is what makes that acceptable.
  if (!replaceFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)) {
    return [];
  }
  return [`removed a dead statusLine from ${settingsFile} (its target ${target} no longer exists)`];
}

/**
 * Step 2: delete the 2.x files nothing in 3.0 reads.
 * @param {string} claudeDir
 * @returns {string[]} actions taken
 */
/** True when a directory entry is a per-session 2.x leftover. */
function matchesOrphanPattern(name) {
  return ORPHANED_PATTERNS.some((re) => re.test(name));
}

/**
 * Names in `dir` matching one of the per-session patterns. Returns [] rather than
 * throwing for a missing or unreadable directory — a machine with no such directory
 * simply has nothing to clean.
 * @param {string} dir
 * @returns {string[]}
 */
function patternMatchesIn(dir) {
  try {
    return fs.readdirSync(dir).filter(matchesOrphanPattern);
  } catch (err) {
    if (err.code !== "ENOENT") {
      debugLog("migrations", `could not list ${dir}: ${err.message}`);
    }
    return [];
  }
}

function cleanOrphans(claudeDir) {
  const actions = [];
  const dataDir = statePath();

  const exactState = dataDir ? [...ORPHANED_STATE, ...patternMatchesIn(dataDir)] : [];
  for (const name of exactState) {
    if (remove(statePath(name))) {
      actions.push(`removed orphaned ${name} from the plugin data dir`);
    }
  }

  for (const name of [...ORPHANED_HOME, ...patternMatchesIn(claudeDir)]) {
    const file = path.join(claudeDir, name);
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        actions.push(`removed 2.x leftover ~/.claude/${name}`);
      }
    } catch (err) {
      debugLog("migrations", `could not remove ${file}: ${err.message}`);
    }
  }

  return actions;
}

/**
 * The version recorded on this machine, or 0 when nothing is recorded.
 *
 * A non-numeric value reads as 0 rather than throwing. That matters for real
 * upgrades: the retired marker mechanism stored a semver *string*, and
 * `Number("1.0.0")` is NaN — treating that as "already at 1" would skip the
 * cleanup on exactly the machines that need it.
 * @param {string|null} configFile
 * @returns {number}
 */
function recordedVersion(configFile) {
  return Number(readJson(configFile, null)?.[VERSION_KEY]) || 0;
}

/**
 * Cheap gate: is there migration work outstanding on this machine?
 *
 * This is what SessionStart calls on every single session, so it is one small
 * JSON read and an integer compare — no `existsSync` walk, no settings parse. The
 * decision to run lives with the caller (the lifecycle hook) rather than inside
 * `runMigrations`, so the hot path never enters the migration code at all.
 *
 * Returns false when there is no data dir: with nowhere to record that we ran, a
 * migration would repeat every session, and repeatedly deleting from someone's
 * home directory is worse than never doing it.
 * @returns {boolean}
 */
function needsMigration() {
  const configFile = statePath("config.json");
  return Boolean(configFile) && recordedVersion(configFile) < MIGRATIONS_VERSION;
}

/**
 * Run every migration step once. Safe to call unconditionally — it re-checks the
 * gate — but callers should use `needsMigration()` first so the common path stays
 * a single read.
 *
 * Concurrency: the work happens under the config lock, and the version is
 * re-checked *inside* it. The lock alone would not be enough — it serialises two
 * sessions' writes without deciding which one should do the work, so both would
 * run the steps and the second would find nothing to do only by luck.
 *
 * @param {Object} [opts]
 * @param {string} [opts.claudeDir] - the user's ~/.claude
 * @param {string} [opts.settingsFile]
 * @param {number} [opts.now]
 * @returns {{ran: boolean, from: number, to: number, actions: string[], notCovered: string[]}}
 */
function runMigrations(opts = {}) {
  const claudeDir = opts.claudeDir || path.join(os.homedir(), ".claude");
  const settingsFile = opts.settingsFile || path.join(claudeDir, "settings.json");
  const now = opts.now || Date.now();

  const configFile = statePath("config.json");
  const noop = (from) => ({
    ran: false,
    from,
    to: MIGRATIONS_VERSION,
    actions: [],
    notCovered: NOT_COVERED,
  });

  if (!configFile) {
    return noop(MIGRATIONS_VERSION);
  }

  const recorded = recordedVersion(configFile);
  if (recorded >= MIGRATIONS_VERSION) {
    return noop(recorded);
  }

  let result = noop(recorded);
  withLock(configFile, () => {
    const config = readJson(configFile, null) || {};
    const from = Number(config[VERSION_KEY]) || 0;
    if (from >= MIGRATIONS_VERSION) {
      result = noop(from);
      return;
    }

    const actions = [...cleanStatusLine(settingsFile, now), ...cleanOrphans(claudeDir)];

    // Touch only our own key. `enabled`/`mode` belong to the config commands and
    // the snooze keys to the session lifecycle; materialising defaults for those
    // here would clobber a surface this module does not own.
    config[VERSION_KEY] = MIGRATIONS_VERSION;
    writeJson(configFile, config);

    result = { ran: true, from, to: MIGRATIONS_VERSION, actions, notCovered: NOT_COVERED };
  });

  return result;
}

/**
 * The note the user sees on the one session that migrates, or null when there is
 * nothing to say.
 *
 * A plugin that silently edits a file in someone's home directory is
 * indistinguishable from a plugin that has a bug, so the session that does it says
 * exactly what it did — and what it left alone, since a clean report otherwise
 * reads as a claim to have cleaned everything.
 * @param {{ran: boolean, actions: string[], notCovered: string[]}|undefined} result
 * @returns {string|null}
 */
function describeMigration(result) {
  if (!result?.ran || result.actions.length === 0) {
    return null;
  }
  return [
    "🧹 gutt cleaned up leftovers from an earlier version:",
    ...result.actions.map((a) => `   • ${a}`),
    `   ${result.notCovered.length} categories were left alone deliberately — see docs/runtime-state-convention.md.`,
  ].join("\n");
}

/**
 * Run the migration and print its report. The single call SessionStart makes once
 * its gate says there is work — kept here so the hook stays a router and the words
 * the migration says about itself live with the code that decides what it did.
 * @param {Object} [opts] - forwarded to runMigrations (tests inject paths)
 * @returns {{ran: boolean, from: number, to: number, actions: string[], notCovered: string[]}}
 */
function announceMigration(opts = {}) {
  const result = runMigrations(opts);
  const note = describeMigration(result);
  if (note) {
    console.log(note); // eslint-disable-line no-console
  }
  return result;
}

module.exports = {
  MIGRATIONS_VERSION,
  VERSION_KEY,
  NOT_COVERED,
  ORPHANED_STATE,
  ORPHANED_HOME,
  ORPHANED_PATTERNS,
  matchesOrphanPattern,
  isDeadPluginStatusLine,
  statusLineTarget,
  needsMigration,
  runMigrations,
  describeMigration,
  announceMigration,
};
