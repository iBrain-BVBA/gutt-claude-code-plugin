/**
 * How the HUD reaches a user at all (GP-867).
 *
 * A plugin cannot ship a working status line. Upstream supports only the `agent`
 * and `subagentStatusLine` keys in a plugin's settings.json, so the top-level
 * `statusLine` this plugin used to carry in hooks.json was inert — never
 * registered, never invoked. The key lives in the *user's* settings.json or
 * nowhere.
 *
 * Naming the renderer directly from there does not work either. `CLAUDE_PLUGIN_ROOT`
 * is version-scoped, so an absolute path written today points into a directory that
 * an upgrade replaces; the HUD then dies silently, which is exactly the stale-
 * statusLine failure migrations.cjs exists to clean up after.
 *
 * So: one level of indirection, which is what every open-source status line does
 * (ccstatusline resolves through `npx`, others through a fixed path in ~/.claude).
 * Settings point at a stable path under ${CLAUDE_PLUGIN_DATA} — documented as
 * surviving plugin updates, and removed on uninstall so it cannot outlive us — and
 * that file is a one-line `require` of the current plugin root, rewritten whenever
 * the root moves. Upgrades become invisible: the user's settings.json is written
 * once and never again.
 *
 * Two rules govern the settings write, and they are the whole reason this is a
 * separate module rather than a few lines in a hook:
 *
 *   1. Nothing here runs unless the user asked for it. `/gutt-pro:statusline` is the
 *      only thing that calls `installEntry`. GP-863 deleted the 2.x hook that
 *      configured settings behind the user's back and that stays deleted.
 *   2. Removal only ever touches a status line this plugin wrote, decided by the
 *      predicate migrations.cjs already owns. Someone else's status line is none of
 *      our business.
 *
 * `reassertEntry` is the exception that proves rule 1 and needs its own defence.
 * Claude Code partially rewrites settings.json mid-session and drops keys it is not
 * currently serialising — `statusLine` among them (anthropics/claude-code#62486,
 * closed as not planned). Without a repair the HUD vanishes at random and reads as
 * our bug. So the *consent* is persisted, and a session restores only what a user
 * already said yes to. Restoring a setting someone asked for is not the same as
 * adding one they did not.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { statePath, atomicWrite, writeJson } = require("./plugin-state.cjs");
const { statusLineTarget, OUR_STATUSLINE_FILES, PLUGIN_PATH_MARKERS } = require("./migrations.cjs");
const { debugLog } = require("./debug.cjs");

/** Basename of the shim, and of the renderer it forwards to. */
const SHIM_NAME = "statusline.cjs";

/**
 * Kept in step with what `installEntry` writes, and read back by `entryPresent`.
 *
 * `refreshInterval` is not cosmetic. The connectivity probe is an `async: true`
 * SessionStart hook, so it lands *after* the first render — with event-driven
 * updates alone the HUD can sit on a stale ⚪ until the user happens to do
 * something. Ten seconds is what ccstatusline settled on and is well clear of the
 * 300ms debounce.
 */
const REFRESH_INTERVAL_SECONDS = 10;

/**
 * Where the renderer actually lives this version. Mirrors config.cjs's resolution
 * so a `--plugin-dir` checkout and an installed copy agree.
 * @returns {string}
 */
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "../..");
}

/** The stable path the user's settings point at, or null with no data dir. */
function shimPath() {
  return statePath(SHIM_NAME);
}

/** The versioned renderer the shim forwards to. */
function rendererPath() {
  return path.join(pluginRoot(), "hooks", SHIM_NAME);
}

/**
 * The user's settings file. Overridable so tests never touch a real home
 * directory — the same seam migrations.cjs uses.
 * @param {string} [settingsFile]
 * @returns {string}
 */
function resolveSettingsFile(settingsFile) {
  return settingsFile || path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * The shim's contents for a given renderer path.
 *
 * The shim also has to *supply* ${CLAUDE_PLUGIN_DATA}, not just use a path derived
 * from it. Claude Code injects that variable into plugin hooks, and a status line
 * is not a hook — it is a command in the user's own settings.json, launched with no
 * plugin environment at all. Without this the renderer's state reads all return
 * null and the HUD sits on a permanent "unknown" glyph with no session data behind
 * it, which looks like a disconnected server rather than a missing variable.
 *
 * `__dirname` rather than a baked absolute path: the shim lives in the data dir, so
 * its own location *is* the answer, and an answer computed at run time cannot go
 * stale the way a written-in one could. Existing values win, so a future platform
 * that does set the variable is not overridden.
 *
 * `JSON.stringify` rather than quoting by hand: on Windows the path is full of
 * backslashes, and a naive template literal would emit `C:\Users\...` as a string
 * containing escape sequences.
 * @param {string} target
 * @returns {string}
 */
function shimContents(target) {
  return [
    "// Generated by gutt-pro — do not edit.",
    "// Rewritten automatically whenever the plugin updates; your edits will be lost.",
    "// The indirection exists because CLAUDE_PLUGIN_ROOT is version-scoped: this",
    "// path is stable, the one below is not.",
    "//",
    "// A status line is not a hook, so it is launched without the plugin",
    "// environment. This directory is the plugin data dir, so it is also the value",
    "// the renderer needs in order to find any session state at all.",
    "process.env.CLAUDE_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || __dirname;",
    `require(${JSON.stringify(target)});`,
    "",
  ].join("\n");
}

/**
 * The command string that goes in settings.json.
 * @param {string} shim
 * @returns {string}
 */
function shimCommand(shim) {
  return `node ${JSON.stringify(shim)}`;
}

/**
 * Point the shim at this version's renderer, writing only when it has moved.
 *
 * Called from the async SessionStart hook, so an upgrade repairs itself before the
 * user notices. The compare-first matters less for cost than for churn: this runs
 * every session and there is no reason to touch mtime on the overwhelming majority
 * where nothing changed.
 *
 * @returns {{written: boolean, path: string|null, target: string}}
 */
function refreshShim() {
  const shim = shimPath();
  const target = rendererPath();
  if (!shim) {
    // No data dir — local dev and some test contexts. Every state write no-ops
    // here rather than falling back to somewhere it does not belong (R37).
    return { written: false, path: null, target };
  }
  const desired = shimContents(target);
  let current = null;
  try {
    current = fs.readFileSync(shim, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      debugLog("statusline-install", `shim unreadable, rewriting: ${err.message}`);
    }
  }
  if (current === desired) {
    return { written: false, path: shim, target };
  }
  return { written: atomicWrite(shim, desired), path: shim, target };
}

/**
 * Read the user's settings, distinguishing "no file" from "not valid JSON".
 *
 * An unparseable settings.json is never rewritten anywhere in this module. Turning
 * a syntax error someone can fix into data loss they cannot is a far worse outcome
 * than a status line that does not appear.
 *
 * @param {string} settingsFile
 * @returns {{state: "absent"|"ok"|"unreadable", raw: string|null, settings: Object|null}}
 */
function readSettings(settingsFile) {
  let raw;
  try {
    raw = fs.readFileSync(settingsFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { state: "absent", raw: null, settings: null };
    }
    debugLog("statusline-install", `settings unreadable: ${err.message}`);
    return { state: "unreadable", raw: null, settings: null };
  }
  try {
    const settings = JSON.parse(raw);
    // A JSON scalar or array parses fine and is not something we can add a key to.
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return { state: "unreadable", raw, settings: null };
    }
    return { state: "ok", raw, settings };
  } catch (err) {
    debugLog("statusline-install", `settings is not valid JSON: ${err.message}`);
    return { state: "unreadable", raw, settings: null };
  }
}

/**
 * True when this status line is one of ours.
 *
 * Deliberately *not* migrations.cjs's `isDeadPluginStatusLine`: that one also
 * requires the target to be gone, because its job is cleaning up corpses. Here the
 * live case is the one that matters — an entry we wrote and that still works is
 * precisely what `installEntry` must recognise so it can be idempotent, and what
 * `removeEntry` is allowed to take away. The dead-target requirement stays out for
 * that reason and is not an oversight to be repaired.
 *
 * **A basename is not provenance**, and it used to be the whole test. `statusline.cjs`
 * is the obvious name for the job, so a user's own `~/.claude/statusline.cjs` — or any
 * script of that name anywhere on the machine — read as ours. Two ways that goes wrong,
 * and they are opposite: `removeEntry` deletes a status line someone else wrote, and
 * `installEntry` reports "already installed" against a file it has never touched,
 * leaving the HUD permanently absent with a success message behind it. This module's
 * one promise is that it never touches a status line it did not write, and the promise
 * needs the path to say so.
 *
 * Two ways a path can say so, in order of certainty:
 *
 *   1. **It is exactly the shim this version writes.** No inference, and it covers
 *      every entry installed by any version that used the current stable path.
 *   2. **The basename is one of ours *and* the containing directory carries a
 *      plugin-owned fragment** — the attribution `isDeadPluginStatusLine` requires,
 *      but read from the directory rather than the whole path. That difference is
 *      load-bearing: one of our own basenames is `gutt-statusline.cjs`, which contains
 *      the marker `gutt` itself, so a whole-path test passes on the filename alone and
 *      re-admits exactly the bug this predicate exists to close. Where a file *lives*
 *      is evidence about who put it there; what it is *called* is not. This clause is
 *      what still recognises a 2.x entry pointing at a path we no longer write, so an
 *      upgrade can take over from one rather than refusing to.
 *
 * Anything else is foreign, including a path that merely ends in the right name. The
 * cost is that an entry we wrote into an unmarked directory is disowned — it stops
 * being removable by `/gutt-pro:statusline off` and has to be deleted by hand. That
 * is the correct side to fail on: refusing to touch a file that might be someone's
 * costs them one manual edit, and the other error deletes their work.
 *
 * @param {*} command
 * @returns {boolean}
 */
function isOurStatusLine(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return false;
  }
  const target = statusLineTarget(command);
  if (!target || !OUR_STATUSLINE_FILES.includes(path.basename(target))) {
    return false;
  }
  const shim = shimPath();
  if (shim && path.resolve(target) === path.resolve(shim)) {
    return true;
  }
  const dir = path.dirname(target);
  return PLUGIN_PATH_MARKERS.some((marker) => dir.includes(marker));
}

/**
 * What occupies the `statusLine` slot: nothing, ours, or someone else's.
 *
 * The single place that question is answered, because it used to be answered
 * separately in three and the three did not agree. Anything present that cannot be
 * positively recognised is **foreign** — including entries carrying no usable
 * `command` at all, such as `{type: "command", command: ""}`, a bare string, or a
 * schema this version of the plugin has never seen. The promise this module makes
 * is that it never overwrites a status line someone else wrote, and unrecognised
 * has to fall on the someone-else side for that promise to hold: a shape we cannot
 * read is not evidence the slot is free.
 *
 * `null` is the one thing treated as absent, since it holds no configuration that
 * overwriting could destroy.
 *
 * @param {Object|null} settings
 * @returns {"absent"|"ours"|"foreign"}
 */
function classifyStatusLine(settings) {
  const entry = settings?.statusLine;
  if (entry === undefined || entry === null) {
    return "absent";
  }
  return isOurStatusLine(entry?.command) ? "ours" : "foreign";
}

/**
 * Whole-file backup before any rewrite, mirroring migrations.cjs.
 *
 * Backing up only the key being changed would still lose the file if the rewrite
 * went wrong, and this module rewrites a file it does not own.
 *
 * @param {string} settingsFile
 * @param {string} raw
 * @param {number} now
 * @returns {boolean} false when the backup could not be written
 */
function backupSettings(settingsFile, raw, now) {
  const backup = statePath("migrations", `settings-backup-${now}.json`);
  if (!backup) {
    // No data dir means nowhere safe to put the original, so nothing is rewritten.
    return false;
  }
  return writeJson(backup, {
    backedUpAt: new Date(now).toISOString(),
    reason: "statusline",
    settingsFile,
    original: raw,
  });
}

/**
 * Replace settings.json without ever leaving it absent.
 *
 * plugin-state's `atomicWrite` cannot be used: it refuses paths outside the data
 * dir, correctly, since that refusal is the point of R37. So this mirrors its rules
 * rather than calling it — process-unique temp name, then rename *over* the target
 * rather than unlink-then-write, because hooks run in parallel and the moment
 * settings.json is missing a concurrent reader falls back to defaults and can write
 * those back. Windows is the exception, and it is `atomicWrite`'s exception too:
 * there a rename onto an existing file can fail outright, so the target has to go
 * first and the gap is unavoidable. Skipping that fallback here would not preserve
 * the file, it would just fail the write on one platform.
 *
 * @param {string} absPath
 * @param {Object} settings
 * @returns {boolean}
 */
function writeSettings(absPath, settings) {
  const tmp = `${absPath}.gutt-statusline.${process.pid}`;
  try {
    // Two-space, matching what Claude Code itself writes. The rewrite reformats the
    // file; the verbatim backup is what makes that acceptable.
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(tmp, absPath);
    } catch (renameErr) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(renameErr.code)) {
        throw renameErr;
      }
      fs.unlinkSync(absPath);
      fs.renameSync(tmp, absPath);
    }
    return true;
  } catch (err) {
    debugLog("statusline-install", `failed to rewrite ${absPath}: ${err.message}`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}

/**
 * Is our status line currently in the user's settings?
 *
 * The question `reassertEntry` asks every session, so it stays a single read and
 * reports "cannot tell" rather than guessing. An unreadable file must not be
 * treated as absent: that would have a session rewrite a file it failed to parse.
 *
 * @param {string} [settingsFile]
 * @returns {{present: boolean, known: boolean, foreign: boolean}}
 */
function entryPresent(settingsFile) {
  const { state, settings } = readSettings(resolveSettingsFile(settingsFile));
  if (state === "unreadable") {
    return { present: false, known: false, foreign: false };
  }
  const kind = classifyStatusLine(settings);
  return { present: kind === "ours", known: true, foreign: kind === "foreign" };
}

/**
 * Put the HUD in the user's settings. Only ever called from the explicit command.
 *
 * Refuses rather than overwrites when someone else's status line is already there.
 * A user with a customised HUD losing it to a plugin command would be a far worse
 * bug than the one this fixes, and the alternative — chaining to it — is the 2.x
 * `passthroughCommand` design that fork-bombed machines and was deleted for it.
 *
 * @param {Object} [opts]
 * @param {string} [opts.settingsFile]
 * @param {number} [opts.now]
 * @returns {{ok: boolean, status: string, detail?: string, command?: string}}
 */
function installEntry({ settingsFile, now = Date.now() } = {}) {
  const target = resolveSettingsFile(settingsFile);
  const { written, path: shim } = refreshShim();
  if (!shim) {
    return {
      ok: false,
      status: "no-data-dir",
      detail: "CLAUDE_PLUGIN_DATA is unset, so there is no stable path to point at.",
    };
  }
  if (!written) {
    // Not an error: unchanged content is the common case. Only a genuinely absent
    // shim is fatal, and that is what this checks.
    try {
      fs.accessSync(shim);
    } catch {
      return { ok: false, status: "shim-failed", detail: `could not write ${shim}` };
    }
  }

  const command = shimCommand(shim);
  const { state, raw, settings } = readSettings(target);
  if (state === "unreadable") {
    return {
      ok: false,
      status: "settings-unreadable",
      detail: `${target} is not valid JSON — fix it first; nothing was changed.`,
    };
  }

  if (classifyStatusLine(settings) === "foreign") {
    return {
      ok: false,
      status: "foreign",
      detail: `${target} already has a status line that is not ours; leaving it alone.`,
      command,
    };
  }

  const next = { ...(settings || {}) };
  if (
    next.statusLine?.command === command &&
    next.statusLine?.refreshInterval === REFRESH_INTERVAL_SECONDS
  ) {
    return { ok: true, status: "already-installed", command };
  }

  if (raw !== null && !backupSettings(target, raw, now)) {
    return {
      ok: false,
      status: "backup-failed",
      detail: "could not write a backup of settings.json, so it was left alone.",
    };
  }

  next.statusLine = {
    type: "command",
    command,
    padding: 0,
    refreshInterval: REFRESH_INTERVAL_SECONDS,
  };
  if (!writeSettings(target, next)) {
    return { ok: false, status: "write-failed", detail: `could not write ${target}` };
  }
  return { ok: true, status: raw === null ? "created" : "installed", command };
}

/**
 * Take the HUD back out. Removes only a status line this plugin wrote.
 *
 * @param {Object} [opts]
 * @param {string} [opts.settingsFile]
 * @param {number} [opts.now]
 * @returns {{ok: boolean, status: string, detail?: string}}
 */
function removeEntry({ settingsFile, now = Date.now() } = {}) {
  const target = resolveSettingsFile(settingsFile);
  const { state, raw, settings } = readSettings(target);
  if (state === "absent") {
    return { ok: true, status: "not-installed" };
  }
  if (state === "unreadable") {
    return {
      ok: false,
      status: "settings-unreadable",
      detail: `${target} is not valid JSON — fix it first; nothing was changed.`,
    };
  }

  const kind = classifyStatusLine(settings);
  if (kind === "absent") {
    return { ok: true, status: "not-installed" };
  }
  if (kind === "foreign") {
    return {
      ok: false,
      status: "foreign",
      detail: `the status line in ${target} was not written by this plugin; leaving it alone.`,
    };
  }

  if (!backupSettings(target, raw, now)) {
    return {
      ok: false,
      status: "backup-failed",
      detail: "could not write a backup of settings.json, so it was left alone.",
    };
  }

  const next = { ...settings };
  delete next.statusLine;
  if (!writeSettings(target, next)) {
    return { ok: false, status: "write-failed", detail: `could not write ${target}` };
  }
  return { ok: true, status: "removed" };
}

/**
 * Put back a status line the user consented to and the platform removed.
 *
 * The narrow repair for anthropics/claude-code#62486. Every guard here is load
 * bearing: no consent means no write, an entry already present means no write, and
 * a foreign or unparseable settings.json means no write. Only the exact case of
 * "they said yes and it is gone" does anything.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.consented] whether the user ever ran the install command
 * @param {string} [opts.settingsFile]
 * @param {number} [opts.now]
 * @returns {{restored: boolean, status: string}}
 */
function reassertEntry({ consented, settingsFile, now = Date.now() } = {}) {
  if (!consented) {
    return { restored: false, status: "no-consent" };
  }
  const { present, known, foreign } = entryPresent(settingsFile);
  if (!known) {
    return { restored: false, status: "settings-unreadable" };
  }
  if (present) {
    return { restored: false, status: "present" };
  }
  if (foreign) {
    // They replaced ours with their own since consenting. That is a newer choice
    // than the consent flag and it wins.
    return { restored: false, status: "foreign" };
  }
  const result = installEntry({ settingsFile, now });
  return { restored: result.ok, status: result.ok ? "restored" : result.status };
}

module.exports = {
  REFRESH_INTERVAL_SECONDS,
  SHIM_NAME,
  shimPath,
  rendererPath,
  shimContents,
  shimCommand,
  isOurStatusLine,
  classifyStatusLine,
  refreshShim,
  entryPresent,
  installEntry,
  removeEntry,
  reassertEntry,
};
