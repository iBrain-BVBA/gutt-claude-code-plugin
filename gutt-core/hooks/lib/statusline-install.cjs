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
 *   1. Nothing here writes the user's settings unless they asked for it.
 *      `/gutt-pro:statusline` is the only thing that calls `installEntry` to add a
 *      key that was not there before; the one automatic caller is `reassertEntry`,
 *      which restores a key the user already consented to and does nothing without
 *      that consent on file. GP-863 deleted the 2.x hook that configured settings
 *      behind the user's back and that stays deleted.
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
const { statusLineTarget, OUR_STATUSLINE_FILES, isOurPluginDir } = require("./migrations.cjs");
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
    `var TARGET = ${JSON.stringify(target)};`,
    "// A status line is not a hook, so it is launched without the plugin",
    "// environment. This directory is the plugin data dir, so it is also the value",
    "// the renderer needs in order to find any session state at all.",
    "process.env.CLAUDE_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || __dirname;",
    "// Guarded because this file outlives what it points at: uninstalling the plugin",
    "// deletes the renderer. An unguarded require then throws, node exits non-zero,",
    "// and the user gets a module-not-found stack trace where their status bar used",
    "// to be, several times a second, from a plugin that may no longer be installed.",
    "//",
    "// But that is only one of the failures that lands here, and the other one is a",
    "// bug rather than a tidy uninstall: a renderer that is present and does not",
    "// load — a half-finished update, a transitive require gone missing, or a",
    "// checkout that mangled the file, which is how 3.0.0 shipped dead on Windows.",
    "// Silence is the right report for the first and is how the second went a whole",
    "// release without being noticed, so they are told apart by whether the file is",
    "// actually there.",
    "try {",
    "  require(TARGET);",
    "} catch (err) {",
    '  var fs = require("fs");',
    "  try {",
    "    fs.appendFileSync(",
    '      require("path").join(__dirname, "hook-errors.log"),',
    '      new Date().toISOString() + " [statusline-shim] " + ((err && err.stack) || err) + "\\n"',
    "    );",
    "  } catch (ignored) {}",
    "  try {",
    "    if (fs.existsSync(TARGET)) {",
    '      console.log("[gutt \\u26a0 statusline failed to load]");',
    "    }",
    "  } catch (ignored) {}",
    "  // Always zero. A non-zero exit here buys nothing — nobody reads it — and costs",
    "  // an error the user cannot act on, repeated on every refresh.",
    "  process.exitCode = 0;",
    "}",
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
 * Three outcomes, not two. `written: false` used to mean both "already correct"
 * and "the write failed", and `installEntry` disambiguated them with an existence
 * check — which a *stale* shim passes exactly as readily as a current one. So an
 * upgrade whose data-dir write failed reported "already installed" over a shim
 * still pointing into the previous version's directory, and the HUD was dead
 * behind a success message. The caller cannot recover a distinction the callee
 * threw away, so the callee keeps it.
 *
 * @returns {{status: "written"|"current"|"failed"|"no-data-dir", path: string|null, target: string}}
 */
function refreshShim() {
  const shim = shimPath();
  const target = rendererPath();
  if (!shim) {
    // No data dir — local dev and some test contexts. Every state write no-ops
    // here rather than falling back to somewhere it does not belong (R37).
    return { status: "no-data-dir", path: null, target };
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
    return { status: "current", path: shim, target };
  }
  return { status: atomicWrite(shim, desired) ? "written" : "failed", path: shim, target };
}

/**
 * The path a shim already on disk will require, read out of the shim itself.
 *
 * The generated body writes the target through `JSON.stringify`, so reading it back
 * with `JSON.parse` round-trips exactly — including the backslashes in a Windows
 * path, which is the case a hand-rolled unquote would get wrong.
 *
 * **Deliberately looser than the one spelling this version writes.** The point of
 * reading the shim at all is to learn about shims *this* version did not write —
 * that is the whole failing case — so anchoring on the exact current formatting
 * defeats the purpose. A first pass at this matched only `^var TARGET = "…";$`, and a
 * shim in any earlier or hand-edited spelling then parsed as "no target", which
 * `shimResolves` reported as a missing renderer while the thing was rendering
 * perfectly. So: any declaration keyword, either quote style, optional indent and
 * semicolon, and the bare `require("…")` form the first generated shim used.
 *
 * @param {string} body contents of an existing shim
 * @returns {string|null} the required path, or null if no target could be read
 */
function shimTarget(body) {
  const patterns = [
    /^\s*(?:var|let|const)\s+TARGET\s*=\s*(".*?"|'.*?')\s*;?\s*$/m,
    /^\s*require\(\s*(".*?"|'.*?')\s*\)\s*;?\s*$/m,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) {
      continue;
    }
    // Single quotes are not JSON, so they are normalised before parsing rather than
    // unquoted by hand — the escapes inside still have to be read as JS reads them.
    const literal = match[1].startsWith("'")
      ? JSON.stringify(match[1].slice(1, -1).replace(/\\'/g, "'"))
      : match[1];
    try {
      const target = JSON.parse(literal);
      if (typeof target === "string" && target !== "") {
        return target;
      }
    } catch {
      // Try the next shape rather than giving up: an unparseable match here is not
      // evidence that the other spelling is absent.
    }
  }
  return null;
}

/**
 * Does the installed HUD actually resolve, end to end?
 *
 * The question `/gutt-pro:statusline status` has to be able to answer, and could
 * not: it read settings.json and stopped there, so the command a user runs to
 * diagnose a blank status bar was structurally unable to see the cause. Both links
 * can break independently — the shim is deleted when the plugin is uninstalled, and
 * the renderer moves under it on every update.
 *
 * **The renderer is the one the shim names, not the one this process would write.**
 * Checking `rendererPath()` answers a question nobody asked: it is
 * `${CLAUDE_PLUGIN_ROOT}/hooks/statusline.cjs`, which is this very file's neighbour,
 * so it is present in essentially every circumstance where there is a command around
 * to ask — including the one circumstance that matters, a shim left pointing into a
 * previous version's directory after a failed update. That is the exact defect this
 * function was added for, and reading the wrong path made it report "installed" over
 * a blank bar. So the shim is opened and its target is followed.
 *
 * `current` is the third answer, and it is what distinguishes "stale but working"
 * from "stale and dead": a shim can point at a real renderer from an older version
 * that will happily run, which is not broken but is not what an upgrade intended.
 *
 * **`renderer` is `null` when the shim could not be read, not `false`.** "The file it
 * names is gone" and "I could not work out what it names" have different remedies and
 * must not collapse: reported as a missing renderer, the second sends someone to fix
 * a bar that is rendering. The caller has to handle three values.
 *
 * @returns {{shim: boolean, current: boolean, renderer: boolean|null}}
 */
function shimResolves() {
  const shim = shimPath();
  const missing = { shim: false, current: false, renderer: false };
  if (!shim) {
    return missing;
  }
  let body;
  try {
    body = fs.readFileSync(shim, "utf8");
  } catch {
    // Absent, or there and unreadable. Either way nothing starts from it, which is
    // the answer the caller needs; the distinction has no different remedy.
    return missing;
  }
  const target = shimTarget(body);
  return {
    shim: true,
    current: body === shimContents(rendererPath()),
    renderer: target === null ? null : fs.existsSync(target),
  };
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
 *   2. **The basename is one of ours *and* the containing directory names this
 *      plugin** — `isOurPluginDir`, read from the directory rather than the whole
 *      path. That difference is load-bearing: one of our own basenames is
 *      `gutt-statusline.cjs`, which contains the marker `gutt` itself, so a
 *      whole-path test passes on the filename alone and re-admits exactly the bug
 *      this predicate exists to close. Where a file *lives* is evidence about who
 *      put it there; what it is *called* is not. This clause is what still
 *      recognises a 2.x entry pointing at a path we no longer write, so an upgrade
 *      can take over from one rather than refusing to.
 *
 *      The directory must name *this* plugin, not merely look plugin-installed.
 *      The marker set used to include the bare fragment `plugins`, which every
 *      plugin's data directory carries — so another vendor's status line under
 *      `~/.claude/plugins/data/` was classified as ours, and `removeEntry` would
 *      delete it. The name is matched as a whole path segment rather than as a
 *      substring, so a directory that merely happens to spell `gutt` inside a
 *      longer word does not confer ownership either. See `GUTT_PATH_SEGMENT`.
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
  return isOurPluginDir(target);
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
 * Returns the path rather than a bare boolean so a failure downstream can *name*
 * the copy. A message that says only "could not write settings.json" reads as a
 * no-op; if the original was lost, the one thing the user needs is where the
 * copy is.
 *
 * @param {string} settingsFile
 * @param {string} raw
 * @param {number} now
 * @returns {string|null} the backup's path, or null when it could not be written
 */
function backupSettings(settingsFile, raw, now) {
  // Namespaced, because this module *prunes* what it writes and the 2.x migration
  // writes its own settings backup into the same directory. Under a shared name the
  // prune below cannot tell the two apart, and since this path runs about once per
  // session on the platforms the repair exists for, the migration's one-shot copy —
  // taken before it rewrote settings.json, and the only copy of that file from
  // before the upgrade — was evicted within five sessions by newer copies of a
  // different thing.
  const backup = statePath("migrations", `settings-backup-statusline-${now}.json`);
  if (!backup) {
    // No data dir means nowhere safe to put the original, so nothing is rewritten.
    return null;
  }
  const written = writeJson(backup, {
    backedUpAt: new Date(now).toISOString(),
    reason: "statusline",
    settingsFile,
    original: raw,
  });
  if (!written) {
    return null;
  }
  pruneBackups(backup);
  return backup;
}

/** How many settings backups to keep. */
const KEEP_BACKUPS = 5;

/**
 * Drop all but the newest few settings backups.
 *
 * These accumulate on a path nothing else sweeps. `migrations/` is deliberately
 * exempt from the session sweep — it holds the migrate-memory backup, which may be
 * the only copy of a user's notes — and `reassertEntry` reaches `installEntry` on
 * every session where the platform dropped the `statusLine` key, which is the whole
 * premise of that repair existing. So without this it is one file per session
 * forever, each a verbatim copy of `settings.json` including whatever is in its
 * `env` block. That also quietly inflates the directory size `findOrphanedPluginData`
 * reports to the user as recoverable memory.
 *
 * Newest kept rather than oldest: the useful copy is the one from just before the
 * change someone is trying to undo.
 *
 * **Only this module's own backups.** The pattern is anchored on the `statusline-`
 * infix `backupSettings` writes, so the 2.x migration's copy — same directory, same
 * `settings-backup-` prefix, and possibly the only surviving image of settings.json
 * from before the upgrade — is not in the candidate set at all. A sweep that deletes
 * user data has to be able to name what it owns.
 *
 * Each removal is logged for the same reason: this is the one place in the module
 * that deletes something the user might want, and `rmSync(..., {force: true})` is
 * silent about what it took.
 *
 * @param {string} justWritten kept regardless, in case the sort cannot see it
 */
function pruneBackups(justWritten) {
  const dir = path.dirname(justWritten);
  try {
    // Sorted on the timestamp as a *number*. Real epoch-ms is 13 digits and will be
    // until 2286, so a lexicographic sort happens to agree with a numeric one — which
    // is exactly the kind of accident that holds until the first caller passes a small
    // `now`, at which point "10" sorts before "2" and the sweep keeps the oldest files
    // and deletes the newest. The whole point of a fixed-width coincidence is that
    // nothing tells you when it stops holding.
    const stamp = (name) => Number(/(\d+)\.json$/.exec(name)[1]);
    const backups = fs
      .readdirSync(dir)
      .filter((name) => /^settings-backup-statusline-\d+\.json$/.test(name))
      .sort((a, b) => stamp(a) - stamp(b));
    for (const name of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
      const doomed = path.join(dir, name);
      if (doomed !== justWritten) {
        fs.rmSync(doomed, { force: true });
        debugLog("statusline-install", `pruned old settings backup ${doomed}`);
      }
    }
  } catch (err) {
    // Housekeeping. A backup that could not be pruned is not a reason to fail the
    // write it was taken for.
    debugLog("statusline-install", `could not prune settings backups: ${err.message}`);
  }
}

/**
 * The message for a write that failed, which may or may not have lost the original.
 *
 * Split out because both callers need it and because the losing case must not be
 * describable in the same sentence as the harmless one — "nothing was changed" is
 * true of one and dangerously false of the other.
 *
 * @param {string} target
 * @param {{ok: boolean, orphan?: string}} result
 * @param {string|null} backup
 * @returns {{ok: false, status: string, detail: string}}
 */
function writeFailure(target, result, backup) {
  if (!result.orphan) {
    return {
      ok: false,
      status: "write-failed",
      detail: `could not write ${target}; it is unchanged.`,
    };
  }
  const where = backup ? ` A verbatim copy of the original is at ${backup}.` : "";
  return {
    ok: false,
    status: "settings-lost",
    detail:
      `${target} could not be written and could not be put back — it is missing. ` +
      `The replacement, which contains your settings, is at ${result.orphan}; ` +
      `rename it to ${target}.${where}`,
  };
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
 * **The cleanup must know how far the fallback got.** Deleting the temp file on
 * any failure is right up until the target has been unlinked — past that point
 * the temp file is the only copy of the user's settings that still exists, and
 * removing it turns a failed write into total data loss. The sequence that gets
 * there is not exotic: it is the same handle contention the fallback exists for,
 * held a moment longer. So the cleanup is conditional, and when the original is
 * gone the temp file is deliberately left on disk and its path is handed back so
 * the caller can name it. A stray file the user can rename is a far better
 * outcome than a settings.json they have to rebuild.
 *
 * @param {string} absPath
 * @param {Object} settings
 * @returns {{ok: boolean, orphan?: string}} `orphan` names the surviving
 *   replacement when the original could not be put back
 */
function writeSettings(absPath, settings) {
  const tmp = `${absPath}.gutt-statusline.${process.pid}`;
  // Set the moment the target stops existing, so the catch below can tell a write
  // that failed harmlessly from one that failed after the point of no return.
  let targetRemoved = false;
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
      targetRemoved = true;
      fs.renameSync(tmp, absPath);
    }
    return { ok: true };
  } catch (err) {
    debugLog("statusline-install", `failed to rewrite ${absPath}: ${err.message}`);
    if (targetRemoved) {
      debugLog(
        "statusline-install",
        `${absPath} could not be restored; replacement left at ${tmp}`
      );
      return { ok: false, orphan: tmp };
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    return { ok: false };
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
  const shimResult = refreshShim();
  const shim = shimResult.path;
  if (!shim) {
    return {
      ok: false,
      status: "no-data-dir",
      detail: "CLAUDE_PLUGIN_DATA is unset, so there is no stable path to point at.",
    };
  }
  if (shimResult.status === "failed") {
    // Reported rather than inferred from the file existing: a stale shim from an
    // earlier version exists too, and pointing settings at one is how a dead HUD
    // ends up behind a success message.
    return {
      ok: false,
      status: "shim-failed",
      detail: `could not write ${shim}, so the HUD would not have started. Nothing was changed.`,
    };
  }
  if (shimResult.status === "current" && !fs.existsSync(shim)) {
    return { ok: false, status: "shim-failed", detail: `${shim} is missing.` };
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

  let backup = null;
  if (raw !== null) {
    backup = backupSettings(target, raw, now);
    if (!backup) {
      return {
        ok: false,
        status: "backup-failed",
        detail: "could not write a backup of settings.json, so it was left alone.",
      };
    }
  }

  next.statusLine = {
    type: "command",
    command,
    padding: 0,
    refreshInterval: REFRESH_INTERVAL_SECONDS,
  };
  const write = writeSettings(target, next);
  if (!write.ok) {
    return writeFailure(target, write, backup);
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

  const backup = backupSettings(target, raw, now);
  if (!backup) {
    return {
      ok: false,
      status: "backup-failed",
      detail: "could not write a backup of settings.json, so it was left alone.",
    };
  }

  const next = { ...settings };
  delete next.statusLine;
  const write = writeSettings(target, next);
  if (!write.ok) {
    return writeFailure(target, write, backup);
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
 * The failure `detail` is carried out rather than discarded. This is the one caller
 * of `installEntry` that runs with nobody watching, so it is also the one that can
 * reach the whole-file loss path unattended — and `status` alone is an internal
 * token. Told only `settings-lost`, the user is left with a word, while the sentence
 * naming where their settings actually are stays in a variable that goes out of
 * scope.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.consented] whether the user ever ran the install command
 * @param {string} [opts.settingsFile]
 * @param {number} [opts.now]
 * @returns {{restored: boolean, status: string, detail?: string}}
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
  if (result.ok) {
    return { restored: true, status: "restored" };
  }
  return { restored: false, status: result.status, detail: result.detail };
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
  shimResolves,
  // Exported for tests. The rename sequence that produces an orphan needs a
  // platform-specific failure to reach (that is what the Windows CI smoke run is
  // for), but the message it produces is the part a user depends on, and it is pure.
  writeFailure,
  entryPresent,
  installEntry,
  removeEntry,
  reassertEntry,
};
