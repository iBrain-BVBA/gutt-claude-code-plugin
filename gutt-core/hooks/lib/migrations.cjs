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

const {
  stateRoot,
  statePath,
  readJson,
  writeJson,
  remove,
  withLock,
} = require("./plugin-state.cjs");
const { debugLog } = require("./debug.cjs");

/**
 * Version of the migration SET, deliberately not the plugin's version.
 *
 * A monotonic integer compared with `>=`. The retired setup hook's marker
 * mechanism got this wrong twice — first an existence check that never re-ran on
 * upgrade, then a semver comparison. An integer cannot be misordered. Bump it when
 * adding a step.
 *
 * 2 (GP-931): report the data directory the rename orphaned. Steps are gated
 * individually on `from` — see `runMigrations`. Before that gate existed, bumping
 * this re-ran every earlier step, which for step 1 means deleting a `statusLine`
 * key again; the rename had already forced that re-run by resetting the recorded
 * version to 0 in a fresh directory.
 */
const MIGRATIONS_VERSION = 2;

/** Where the recorded version lives inside the R37 config artifact. */
const VERSION_KEY = "migrationsVersion";

/**
 * Caches 2.x wrote into the plugin data dir, which nothing in 3.0 reads. Relative
 * to `${CLAUDE_PLUGIN_DATA}`. The `gutt-` prefixed spellings are from an earlier
 * era that shared a directory; both spellings shipped, so both are cleaned.
 *
 * Deliberately excludes `config.json` and `sessions/` — those are the live R37
 * artifacts.
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
 * The plugin's `name` before GP-931, and the current one.
 *
 * Claude Code derives `${CLAUDE_PLUGIN_DATA}` from the plugin's `name`, so the
 * rename moved the whole data directory and left the old one in place, full and
 * unreferenced. `<dataRoot>/<name>-<marketplace>` is the layout, which is why the
 * legacy sibling is found by swapping the *prefix* of our own basename rather than
 * by guessing a marketplace.
 *
 * The current name is duplicated from `plugin.json` here rather than read from it:
 * this runs on the SessionStart path, and a manifest read to recover a constant
 * that changes once in the plugin's lifetime is the wrong trade. A test asserts
 * the two agree.
 */
const LEGACY_PLUGIN_NAME = "gutt-claude-code-plugin";
const PLUGIN_NAME = "gutt-pro";

/**
 * State in the orphaned directory worth naming, and the verb that re-applies it.
 *
 * Only preferences the user *set* are listed. `migrationsVersion` and `sessions/`
 * orphan too, but re-deriving them costs nothing and naming them would bury the
 * two that matter. `enabled` leads because its loss is the one that silently
 * *reverses* a user's intent: recall they turned off comes back on, and the HUD
 * marker that would have shown it reads the new directory.
 */
const LEGACY_SETTINGS = [
  {
    key: "enabled",
    describe: (v) =>
      v === false
        ? "recall was turned off durably — it is ON again here; re-apply with /gutt-pro:disable"
        : null,
  },
  {
    key: "mode",
    describe: (v) => (v ? `capture mode was "${v}" — re-apply with /gutt-pro:mode ${v}` : null),
  },
];

/**
 * Basenames a `statusLine` command may point at for it to be considered ours.
 * Someone else's status line is none of our business, however broken it is.
 */
const OUR_STATUSLINE_FILES = ["statusline.cjs", "gutt-statusline.cjs"];

/**
 * The path fragment that attributes an installed file to *this* plugin.
 *
 * It used to be one of four — `plugin_`, `local-agent-mode-sessions`, `gutt`,
 * `plugins` — OR'd together, and the last of those gave the whole set away.
 * Claude Code puts every plugin's persistent data under
 * `~/.claude/plugins/data/<id>/`, so `plugins` is in the path of *every*
 * plugin's directory, not just ours. On a real machine that made
 * `~/.claude/plugins/data/context7-claude-plugins-official/statusline.cjs` read
 * as ours — and this module's one promise is that it never touches a status line
 * it did not write.
 *
 * A marker used for attribution must not name the container every candidate
 * shares. What is left is the one fragment that says *whose*: this plugin has
 * carried `gutt` in its identity since 2.x, so its cache directory, its data
 * directory, and the marketplace it ships from all contain it, while another
 * vendor's plugin does not. Compared case-insensitively — the fragment is
 * matched against a path the user's filesystem chose the case of, not one we
 * wrote.
 */
const GUTT_PATH_MARKER = "gutt";

/**
 * Is this the directory of a file this plugin put there?
 *
 * **The directory, never the whole path.** One of our own basenames is
 * `gutt-statusline.cjs`, which contains the marker in its own filename, so a
 * whole-path test passes on the name alone and admits any directory at all —
 * re-opening the "a script that merely shares the name" bug by the back door.
 * Where a file lives is evidence about who put it there; what it is called is
 * not.
 *
 * @param {string} target absolute path to the file being attributed
 * @returns {boolean}
 */
function isOurPluginDir(target) {
  return path.dirname(target).toLowerCase().includes(GUTT_PATH_MARKER);
}

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
  if (!isOurPluginDir(target)) {
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
 * The data directory the GP-931 rename orphaned, or null when there isn't one.
 *
 * `<dataRoot>/gutt-pro-<marketplace>` is ours; `<dataRoot>/gutt-claude-code-plugin-<marketplace>`
 * is what the same install used before the rename. Derived from our own basename
 * so it works for any marketplace id, including a local one.
 *
 * @param {string|null} [ourRoot] - defaults to ${CLAUDE_PLUGIN_DATA}
 * @returns {string|null}
 */
function legacyStateDir(ourRoot = stateRoot()) {
  if (!ourRoot) {
    return null;
  }
  const base = path.basename(ourRoot);
  if (!base.startsWith(PLUGIN_NAME)) {
    return null;
  }
  const legacy = path.join(
    path.dirname(ourRoot),
    LEGACY_PLUGIN_NAME + base.slice(PLUGIN_NAME.length)
  );
  return fs.existsSync(legacy) ? legacy : null;
}

/**
 * Report what the rename left behind. Read-only, by design (GP-931 D4).
 *
 * D4 accepted the state reset knowingly, so this does not undo it: copying a
 * config across would resurrect settings the user has had no chance to review, and
 * the two directories can both be live if someone runs both plugins. What D4 did
 * not accept is the reset being *silent* — a user who turned recall off finds it
 * back on with nothing to explain why, and the one indicator that would have shown
 * it (the HUD's ` off`) reads the new directory too.
 *
 * The memory backup is called out separately and in bytes because it is the sole
 * surviving copy of a migrated user's local notes, and a plain `/plugin uninstall`
 * of the old plugin destroys it.
 *
 * @param {string|null} [ourRoot]
 * @returns {string[]} notices, empty when there is nothing to report
 */
function findOrphanedPluginData(ourRoot = stateRoot()) {
  const legacy = legacyStateDir(ourRoot);
  if (!legacy) {
    return [];
  }
  const notices = [];
  const old = readJson(path.join(legacy, "config.json"), null);

  for (const { key, describe } of LEGACY_SETTINGS) {
    const line = old && key in old ? describe(old[key]) : null;
    if (line) {
      notices.push(line);
    }
  }

  const projects = Object.keys(old?.projects || {}).length;
  if (projects) {
    notices.push(
      `${plural(projects, "project")} had a recorded answer to the memory-migration offer — ` +
        "you may be asked again"
    );
  }

  const backups = listBackups(path.join(legacy, "migrations"));
  if (backups.bytes) {
    notices.push(
      `${plural(backups.count, "memory backup")} (${formatBytes(backups.bytes)}) is still there ` +
        "and may be the only copy — uninstall the old plugin with --keep-data, or copy it out first"
    );
  }

  if (notices.length === 0) {
    return [];
  }
  return [`gutt's settings did not carry over from ${legacy}:`, ...notices];
}

/**
 * Total size of the built-in-memory backups in a legacy `migrations/` dir.
 * @param {string} dir
 * @returns {{count: number, bytes: number}}
 */
function listBackups(dir) {
  let count = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      count += 1;
      bytes += fs.statSync(path.join(dir, name)).size;
    }
  } catch {
    /* no migrations dir, or unreadable — nothing to report */
  }
  return { count, bytes };
}

/** @param {number} n @param {string} word @returns {string} */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** @param {number} bytes @returns {string} */
function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
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
 * Steps are gated individually on `from`, not just collectively on the version
 * compare above. Without that, adding step 2 would re-run step 1 on every machine
 * already at 1 — and step 1 deletes a key from `~/.claude/settings.json`, which the
 * module header promises happens "at most once per machine". Collective gating made
 * that promise true only until the next bump.
 *
 * @param {Object} [opts]
 * @param {string} [opts.claudeDir] - the user's ~/.claude
 * @param {string} [opts.settingsFile]
 * @param {string} [opts.stateRoot] - our data dir, for the step-2 orphan probe
 * @param {number} [opts.now]
 * @returns {{ran: boolean, from: number, to: number, actions: string[], notices: string[], notCovered: string[]}}
 */
function runMigrations(opts = {}) {
  const claudeDir = opts.claudeDir || path.join(os.homedir(), ".claude");
  const settingsFile = opts.settingsFile || path.join(claudeDir, "settings.json");
  const ourRoot = opts.stateRoot || stateRoot();
  const now = opts.now || Date.now();

  const configFile = statePath("config.json");
  const noop = (from) => ({
    ran: false,
    from,
    to: MIGRATIONS_VERSION,
    actions: [],
    notices: [],
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

    // Step 1 (2.x cleanup) — deletes. Step 2 (GP-931 orphan report) — read-only.
    const actions =
      from < 1 ? [...cleanStatusLine(settingsFile, now), ...cleanOrphans(claudeDir)] : [];
    const notices = from < 2 ? findOrphanedPluginData(ourRoot) : [];

    // Touch only our own key. `enabled`/`mode` belong to the config commands and
    // the snooze keys to the session lifecycle; materialising defaults for those
    // here would clobber a surface this module does not own.
    config[VERSION_KEY] = MIGRATIONS_VERSION;
    writeJson(configFile, config);

    result = {
      ran: true,
      from,
      to: MIGRATIONS_VERSION,
      actions,
      notices,
      notCovered: NOT_COVERED,
    };
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
 *
 * `actions` and `notices` are kept apart because they are different claims:
 * actions are things this code *did*, notices are things it *found* and left
 * alone. Folding the rename report into "cleaned up leftovers" would say the
 * opposite of what happened — nothing was cleaned, and the whole point is that the
 * old directory is still sitting there with the user's only memory backup in it.
 * @param {{ran: boolean, actions: string[], notices?: string[], notCovered: string[]}|undefined} result
 * @returns {string|null}
 */
function describeMigration(result) {
  if (!result?.ran) {
    return null;
  }
  const blocks = [];
  if (result.actions.length) {
    blocks.push(
      [
        "🧹 gutt cleaned up leftovers from an earlier version:",
        ...result.actions.map((a) => `   • ${a}`),
        `   ${result.notCovered.length} categories were left alone deliberately — see docs/runtime-state-convention.md.`,
      ].join("\n")
    );
  }
  const [heading, ...notices] = result.notices || [];
  if (heading) {
    blocks.push(
      [
        `⚠ ${heading}`,
        ...notices.map((n) => `   • ${n}`),
        "   Nothing was moved or deleted. See docs/migration-3.0.md.",
      ].join("\n")
    );
  }
  return blocks.length ? blocks.join("\n\n") : null;
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
  LEGACY_PLUGIN_NAME,
  PLUGIN_NAME,
  legacyStateDir,
  findOrphanedPluginData,
  matchesOrphanPattern,
  isDeadPluginStatusLine,
  statusLineTarget,
  OUR_STATUSLINE_FILES,
  GUTT_PATH_MARKER,
  isOurPluginDir,
  needsMigration,
  runMigrations,
  describeMigration,
  announceMigration,
};
