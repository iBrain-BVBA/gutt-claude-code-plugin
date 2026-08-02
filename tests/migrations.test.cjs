#!/usr/bin/env node
/**
 * The 2.x cleanup migration (GP-895).
 *
 * This is the only code in the plugin that deletes a key out of a file in the
 * user's home directory, so most of what is below is about what it must *refuse*
 * to touch. A migration that over-deletes is worse than one that never runs: the
 * damage it is cleaning up costs someone a broken status line, while a wrong
 * deletion costs them a config they wrote themselves.
 *
 * Everything runs against a synthetic HOME and a synthetic ${CLAUDE_PLUGIN_DATA}
 * in a temp dir. Nothing here can see the developer's own ~/.claude.
 *
 * Run: node --test tests/migrations.test.cjs
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MIGRATIONS = path.join(__dirname, "..", "gutt-core", "hooks", "lib", "migrations.cjs");
const SESSION_START = path.join(__dirname, "..", "gutt-core", "hooks", "session-start.cjs");

let sandbox;
let claudeDir;
let dataDir;
let settingsFile;
let migrations;

/** A statusLine command shaped exactly like the one 2.x wrote. */
function pluginStatusLine(target) {
  return { type: "command", command: `node "${target}"` };
}

/** The plugin-owned path 2.x pointed statusLine at, under the sandbox. */
function deadTarget() {
  return path.join(sandbox, "cache", "plugin_01ABC", "hooks", "statusline.cjs");
}

function writeSettings(obj) {
  fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2));
}

function readSettings() {
  return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
}

/** Run the migration against the sandbox. */
function run(now = 1_700_000_000_000) {
  return migrations.runMigrations({ claudeDir, settingsFile, now });
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-migrations-"));
  claudeDir = path.join(sandbox, ".claude");
  dataDir = path.join(sandbox, "data");
  settingsFile = path.join(claudeDir, "settings.json");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // statePath() reads this live, so it must be set before the module is used —
  // but the module caches nothing, so a fresh require per test is only about
  // keeping tests independent.
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  delete require.cache[require.resolve(MIGRATIONS)];
  migrations = require(MIGRATIONS);
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("the dead-statusLine predicate", () => {
  it("recognises the 2.x statusLine when its target is gone", () => {
    assert.equal(
      migrations.isDeadPluginStatusLine(`node "${deadTarget()}"`),
      true,
      "the exact shape 2.x wrote must be recognised, or the migration is a no-op"
    );
  });

  // The decisive condition. Someone whose status line still works must keep it,
  // even though this plugin is the one that installed it.
  it("leaves a plugin statusLine alone while its target still exists", () => {
    const live = path.join(sandbox, "cache", "plugin_01ABC", "hooks", "statusline.cjs");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, "// a working status line\n");
    assert.equal(migrations.isDeadPluginStatusLine(`node "${live}"`), false);
  });

  // Someone else's broken status line is their business. This is the case that
  // turns a cleanup into data loss, so it gets several shapes.
  it("never claims a status line this plugin did not write", () => {
    const foreign = [
      'node "/Users/me/bin/my-statusline.cjs"', // right idea, not our filename
      'node "/Users/me/plugins/other/hooks/prompt.cjs"', // plugin path, wrong file
      "starship prompt", // not node at all
      'python3 "/Users/me/plugins/statusline.py"', // not a .cjs
      "", // absent
    ];
    for (const command of foreign) {
      assert.equal(
        migrations.isDeadPluginStatusLine(command),
        false,
        `must not claim ownership of: ${command || "(empty)"}`
      );
    }
  });

  it("survives a statusLine that is not a string", () => {
    for (const command of [undefined, null, 42, {}, []]) {
      assert.equal(migrations.isDeadPluginStatusLine(command), false);
    }
  });

  // A bare (unquoted) command is the older 2.x spelling.
  it("finds the target in an unquoted command", () => {
    assert.equal(migrations.statusLineTarget(`node ${deadTarget()}`), deadTarget());
  });
});

describe("running the migration", () => {
  it("removes the dead statusLine and records that it ran", () => {
    writeSettings({ model: "opus", statusLine: pluginStatusLine(deadTarget()) });

    const result = run();

    assert.equal(result.ran, true);
    assert.equal(result.from, 0);
    assert.equal(result.to, migrations.MIGRATIONS_VERSION);
    assert.equal(readSettings().statusLine, undefined, "the dead key must be gone");
    assert.equal(readSettings().model, "opus", "unrelated settings must survive");

    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(config[migrations.VERSION_KEY], migrations.MIGRATIONS_VERSION);
  });

  it("backs the original settings.json up verbatim before rewriting it", () => {
    const original = { model: "opus", statusLine: pluginStatusLine(deadTarget()) };
    writeSettings(original);
    const before = fs.readFileSync(settingsFile, "utf8");

    run(1_700_000_000_000);

    const backupDir = path.join(dataDir, "migrations");
    const backups = fs.readdirSync(backupDir);
    assert.equal(backups.length, 1, `expected one backup, got ${backups.join(", ")}`);
    const backup = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), "utf8"));
    assert.equal(
      backup.original,
      before,
      "the backup must be the original bytes, not a re-serialised object"
    );
    assert.equal(backup.settingsFile, settingsFile);
  });

  it("is a no-op the second time, and does not re-backup", () => {
    writeSettings({ statusLine: pluginStatusLine(deadTarget()) });
    run();
    const backupsAfterFirst = fs.readdirSync(path.join(dataDir, "migrations")).length;

    // Plant the damage again. A second run must not act on it: the version is
    // recorded, and re-running would fight a user who deliberately restored it.
    writeSettings({ statusLine: pluginStatusLine(deadTarget()) });
    const second = run(1_700_000_999_999);

    assert.equal(second.ran, false);
    assert.equal(second.from, migrations.MIGRATIONS_VERSION);
    assert.deepEqual(second.actions, []);
    assert.ok(readSettings().statusLine, "a re-planted statusLine must be left alone");
    assert.equal(
      fs.readdirSync(path.join(dataDir, "migrations")).length,
      backupsAfterFirst,
      "a no-op run must not write another backup"
    );
  });

  it("removes the 2.x orphans in both locations", () => {
    fs.writeFileSync(path.join(dataDir, "memory-cache.json"), "{}");
    fs.writeFileSync(path.join(dataDir, "seed-registry.json"), "{}");
    fs.writeFileSync(path.join(claudeDir, ".gutt-statusline-configured"), "v2");

    const result = run();

    assert.equal(fs.existsSync(path.join(dataDir, "memory-cache.json")), false);
    assert.equal(fs.existsSync(path.join(dataDir, "seed-registry.json")), false);
    assert.equal(fs.existsSync(path.join(claudeDir, ".gutt-statusline-configured")), false);
    assert.equal(result.actions.length, 3, `unexpected actions: ${result.actions.join(" | ")}`);
  });

  // The live R37 artifacts sit in the same directory as the orphans. Deleting one
  // of these would drop the user's own config or the only diagnostic record of what
  // the hooks did.
  it("never touches the live state artifacts", () => {
    // Nothing in the migration writes hook-invocations.log, so it must come back
    // byte-for-byte. hook-errors.log is asserted on separately below: it is the
    // file debugLog appends to, so demanding equality here would quietly also
    // assert "the migration never logs", which is not a property we want to hold.
    const untouched = "2026-07-28T10:00:00.000Z [UserPromptSubmit] Prompt: hi\n";
    const errors = "2026-07-28T10:00:00.000Z [plugin-state] trim failed\n";
    fs.writeFileSync(path.join(dataDir, "hook-invocations.log"), untouched);
    fs.writeFileSync(path.join(dataDir, "hook-errors.log"), errors);
    fs.mkdirSync(path.join(dataDir, "sessions"));
    fs.writeFileSync(path.join(dataDir, "sessions", "abc.json"), '{"rev":1}');
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ enabled: false }));

    run();

    assert.equal(
      fs.readFileSync(path.join(dataDir, "hook-invocations.log"), "utf8"),
      untouched,
      "hook-invocations.log was modified"
    );
    // Preserved, not necessarily unchanged — a diagnostic appended mid-migration is
    // legitimate; losing the entries that were already there is not.
    assert.ok(
      fs.readFileSync(path.join(dataDir, "hook-errors.log"), "utf8").startsWith(errors),
      "hook-errors.log lost the entries it had before the migration ran"
    );
    assert.equal(fs.existsSync(path.join(dataDir, "sessions", "abc.json")), true);
    // config.json is rewritten to record the version — but only that key.
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(
      config.enabled,
      false,
      "the migration must not clobber config keys it does not own"
    );
    assert.equal(config[migrations.VERSION_KEY], migrations.MIGRATIONS_VERSION);
  });

  // 2.x keyed some state by session id, so a machine accumulates one file per
  // session it ever ran. An exact-name list matches the unsuffixed sibling and
  // silently leaves the rest — reporting success having cleaned one file of a dozen.
  // Found by listing a real dirty directory, not by reading the code.
  it("removes per-session leftovers an exact-name list cannot reach", () => {
    const perSession = [
      "gutt-session-b727e2aa-1ddd-4eff-b5d7-08e8ec722723.json",
      "gutt-session-fba350fc-40d5-44ad-9fd1-a612b76515ac.json",
      "gutt-routing-session.json",
    ];
    for (const name of perSession) {
      fs.writeFileSync(path.join(dataDir, name), "{}");
      fs.writeFileSync(path.join(claudeDir, name), "{}");
    }

    run();

    for (const name of perSession) {
      assert.equal(fs.existsSync(path.join(dataDir, name)), false, `data dir kept ${name}`);
      assert.equal(fs.existsSync(path.join(claudeDir, name)), false, `~/.claude kept ${name}`);
    }
  });

  // The pattern must be anchored at both ends. Unanchored it would reach a live
  // `sessions/` record, someone else's file that merely contains the substring, or a
  // backup of the very settings.json this migration just wrote.
  it("matches per-session leftovers without over-reaching", () => {
    for (const name of [
      "gutt-session-abc.json",
      "gutt-routing-session.json",
      "gutt-routing-old.log",
    ]) {
      assert.equal(migrations.matchesOrphanPattern(name), true, `should match ${name}`);
    }
    for (const name of [
      "config.json",
      "hook-invocations.log",
      "settings-backup-1700000000000.json",
      "not-gutt-session-abc.json", // prefix must be anchored
      "gutt-session-abc.json.bak", // suffix must be anchored
      "gutt-session.json", // the exact-name list owns this one
      "sessions",
    ]) {
      assert.equal(migrations.matchesOrphanPattern(name), false, `must not match ${name}`);
    }
  });

  // An unprefixed leftover in ~/.claude cannot be attributed to this plugin —
  // ~/.claude is shared with Claude Code itself and every other plugin.
  it("leaves unattributable files in ~/.claude alone", () => {
    const foreign = path.join(claudeDir, "memory-cache.json");
    fs.writeFileSync(foreign, '{"someone":"else"}');
    run();
    assert.equal(fs.existsSync(foreign), true);
  });

  it("refuses to rewrite a settings.json it could not parse", () => {
    const broken = '{ "statusLine": { "command": "node oops.cjs" ';
    fs.writeFileSync(settingsFile, broken);

    const result = run();

    assert.equal(
      fs.readFileSync(settingsFile, "utf8"),
      broken,
      "a syntax error must not become data loss"
    );
    assert.equal(result.ran, true, "the version is still recorded — the orphan sweep did happen");
    assert.deepEqual(result.actions, []);
  });

  it("runs cleanly with no settings.json at all", () => {
    const result = run();
    assert.equal(result.ran, true);
    assert.deepEqual(result.actions, []);
    assert.equal(fs.existsSync(settingsFile), false, "must not create a settings file");
  });

  // The fail-safe the whole state layer is built on: no data dir means no writes.
  // Without this, a --plugin-dir dev session would delete from the real ~/.claude
  // and have nowhere to record that it did, so it would do it again every session.
  it("does nothing at all when CLAUDE_PLUGIN_DATA is unset", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    writeSettings({ statusLine: pluginStatusLine(deadTarget()) });
    fs.writeFileSync(path.join(claudeDir, ".gutt-statusline-configured"), "v2");

    const result = run();

    assert.equal(result.ran, false);
    assert.ok(readSettings().statusLine, "settings.json must be untouched with nowhere to record");
    assert.equal(fs.existsSync(path.join(claudeDir, ".gutt-statusline-configured")), true);
  });

  it("always reports what it deliberately did not cover", () => {
    const result = run();
    assert.ok(
      result.notCovered.length >= 3,
      "a report with no exclusions reads as a claim to have cleaned everything"
    );
  });
});

/**
 * `needsMigration()` is the only thing SessionStart calls on the common path, so
 * it is the piece whose failure is silent in both directions: stuck false means
 * the cleanup never happens on any machine, and stuck true means every session
 * enters the migration code for nothing.
 *
 * These exist because mutation testing found them missing — `needsMigration`
 * hardcoded to `true` left the whole suite green, since `runMigrations` re-checks
 * the version itself and covered for it.
 */
describe("the cheap gate SessionStart calls", () => {
  function recordVersion(v) {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ [migrations.VERSION_KEY]: v })
    );
  }

  it("is true on a machine with nothing recorded", () => {
    assert.equal(migrations.needsMigration(), true);
  });

  it("is true when the recorded version is behind", () => {
    recordVersion(migrations.MIGRATIONS_VERSION - 1);
    assert.equal(migrations.needsMigration(), true);
  });

  it("is true when the recorded version is a stale semver string", () => {
    recordVersion("1.0.0");
    assert.equal(migrations.needsMigration(), true, "NaN must not read as up-to-date");
  });

  it("is false once the current version is recorded", () => {
    recordVersion(migrations.MIGRATIONS_VERSION);
    assert.equal(migrations.needsMigration(), false);
  });

  it("is false when the recorded version is ahead", () => {
    recordVersion(migrations.MIGRATIONS_VERSION + 3);
    assert.equal(migrations.needsMigration(), false);
  });

  // Without a data dir there is nowhere to record having run, so a true here means
  // every session would re-delete from the real home directory.
  it("is false when there is no data dir to record into", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    assert.equal(migrations.needsMigration(), false);
  });

  // The two halves must agree. If the gate stayed true after a successful run, the
  // hot path would pay for the migration module on every session forever.
  it("closes after a run — the gate and the recorder agree", () => {
    writeSettings({ statusLine: pluginStatusLine(deadTarget()) });
    assert.equal(migrations.needsMigration(), true);
    run();
    assert.equal(migrations.needsMigration(), false);
  });
});

describe("the report", () => {
  it("says nothing when nothing was done", () => {
    assert.equal(migrations.describeMigration({ ran: false, actions: [], notCovered: [] }), null);
    assert.equal(migrations.describeMigration({ ran: true, actions: [], notCovered: [] }), null);
    assert.equal(migrations.describeMigration(undefined), null, "a guarded throw must not print");
  });

  // A report that lists only successes reads as a claim to have cleaned
  // everything, which is the thing this migration must not imply.
  it("names both what it did and that it left things alone", () => {
    const note = migrations.describeMigration({
      ran: true,
      actions: ["removed a dead statusLine"],
      notCovered: ["a", "b", "c"],
    });
    assert.match(note, /removed a dead statusLine/);
    assert.match(note, /3 categories were left alone/);
  });
});

/**
 * The user's requirement: SessionStart decides whether to migrate. Asserting the
 * module works proves nothing about that — the hook has to actually consult the
 * gate and act on it, and a wiring mistake there is invisible to every test above.
 *
 * Spawned with HOME pointed at the sandbox, so `os.homedir()` inside the hook
 * resolves there and this can never touch the developer's own ~/.claude.
 */
describe("SessionStart drives the migration", () => {
  function startSession() {
    return spawnSync("node", [SESSION_START], {
      input: JSON.stringify({ session_id: "mig-test", source: "startup" }),
      encoding: "utf8",
      // USERPROFILE as well as HOME, and this is a containment boundary rather than a
      // portability nicety: `os.homedir()` ignores HOME on Windows and reads USERPROFILE,
      // so HOME alone left the spawned hook pointed at the *developer's real* ~/.claude.
      // It ran the migration there — observed deleting a real `.gutt-statusline-configured`
      // — and then this test read the untouched sandbox and reported the hook had not run.
      // The visible symptom was a failing assertion; the actual one was a test suite
      // editing the home directory of whoever ran it.
      env: {
        ...process.env,
        HOME: sandbox,
        USERPROFILE: sandbox,
        CLAUDE_PLUGIN_DATA: dataDir,
      },
    });
  }

  beforeEach(() => {
    // os.homedir() → $HOME → sandbox, so the hook's default claudeDir is here.
    claudeDir = path.join(sandbox, ".claude");
    settingsFile = path.join(claudeDir, "settings.json");
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  it("migrates on the first session and reports it", () => {
    writeSettings({ model: "opus", statusLine: pluginStatusLine(deadTarget()) });
    fs.writeFileSync(path.join(claudeDir, ".gutt-statusline-configured"), "v2");

    const r = startSession();

    assert.equal(r.status, 0, `hook must never fail a session: ${r.stderr}`);
    assert.equal(readSettings().statusLine, undefined, "the hook did not run the migration");
    assert.equal(readSettings().model, "opus");
    assert.equal(fs.existsSync(path.join(claudeDir, ".gutt-statusline-configured")), false);
    assert.match(r.stdout, /cleaned up leftovers/, "a home-directory edit must be announced");
    assert.match(r.stdout, /left alone deliberately/);
  });

  it("says nothing and changes nothing on the second session", () => {
    writeSettings({ statusLine: pluginStatusLine(deadTarget()) });
    startSession();

    writeSettings({ statusLine: pluginStatusLine(deadTarget()) });
    const before = fs.readFileSync(settingsFile, "utf8");
    const r = startSession();

    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), before, "settings must be byte-identical");
    assert.doesNotMatch(r.stdout, /cleaned up leftovers/, "a no-op session must stay quiet");
  });

  // The overwhelmingly common case: a machine that never ran 2.x. It must be
  // silent and must not create anything in the home directory.
  it("is silent on a machine with no 2.x damage", () => {
    const r = startSession();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /cleaned up leftovers/);
    assert.equal(fs.existsSync(settingsFile), false);
  });
});

/**
 * Step 2 (GP-931): report the data directory the rename orphaned.
 *
 * Read-only on purpose. D4 accepted the state reset knowingly, so the fix is not to
 * undo it — copying settings across would resurrect choices the user has not seen —
 * but to stop it being silent. These tests pin both halves: that it reports, and
 * that it never touches either directory.
 */
describe("the orphaned data directory (GP-931)", () => {
  /** Build the `<name>-<marketplace>` pair the platform lays out. */
  function renamedPair() {
    const root = path.join(sandbox, "plugins", "data");
    const ours = path.join(root, "gutt-pro-gutt-plugins");
    const legacy = path.join(root, "gutt-claude-code-plugin-gutt-plugins");
    fs.mkdirSync(ours, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    return { ours, legacy };
  }

  it("finds the pre-rename sibling from our own basename", () => {
    const { ours, legacy } = renamedPair();
    assert.equal(migrations.legacyStateDir(ours), legacy);
  });

  it("finds nothing when there is no sibling, no root, or an unfamiliar layout", () => {
    const { ours, legacy } = renamedPair();
    fs.rmSync(legacy, { recursive: true, force: true });
    assert.equal(migrations.legacyStateDir(ours), null, "no sibling on disk");
    assert.equal(migrations.legacyStateDir(null), null, "no data dir at all");
    assert.equal(
      migrations.legacyStateDir(path.join(sandbox, "somewhere-else")),
      null,
      "a root that is not ours must not be guessed at"
    );
  });

  it("names each orphaned setting and the verb that re-applies it", () => {
    const { ours, legacy } = renamedPair();
    fs.writeFileSync(
      path.join(legacy, "config.json"),
      JSON.stringify({
        enabled: false,
        mode: "hitl",
        projects: { "-Users-me-repo": { memoryMigration: { status: "declined" } } },
      })
    );
    fs.mkdirSync(path.join(legacy, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "migrations", "builtin-memory-1.json"), "x".repeat(2048));

    const notices = migrations.findOrphanedPluginData(ours);
    const text = notices.join("\n");

    assert.match(text, /did not carry over/);
    // The one that silently reverses intent: recall they turned off is back on.
    assert.match(text, /recall was turned off durably — it is ON again here/);
    assert.match(text, /\/gutt-pro:disable/);
    assert.match(text, /capture mode was "hitl".*\/gutt-pro:mode hitl/);
    assert.match(text, /1 project had a recorded answer/);
    assert.match(text, /1 memory backup \(2 KB\).*only copy/);
    assert.match(text, /--keep-data/);
  });

  it("says nothing about settings that were never set", () => {
    const { ours, legacy } = renamedPair();
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ enabled: true }));
    assert.deepEqual(
      migrations.findOrphanedPluginData(ours),
      [],
      "an enabled:true and nothing else is not a loss worth a warning"
    );
  });

  it("reports an empty legacy dir as nothing to say", () => {
    const { ours } = renamedPair();
    assert.deepEqual(migrations.findOrphanedPluginData(ours), []);
  });

  it("never writes to or deletes from either directory", () => {
    const { ours, legacy } = renamedPair();
    const config = JSON.stringify({ enabled: false, mode: "hitl" });
    fs.writeFileSync(path.join(legacy, "config.json"), config);

    assert.ok(migrations.findOrphanedPluginData(ours).length, "precondition: it reported");

    assert.equal(
      fs.readFileSync(path.join(legacy, "config.json"), "utf8"),
      config,
      "the old config must be left byte-identical"
    );
    assert.deepEqual(fs.readdirSync(ours), [], "and nothing may be copied into the new dir");
  });

  it("is reported by runMigrations and rendered as found, not as cleaned", () => {
    const { ours, legacy } = renamedPair();
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ enabled: false }));

    const result = migrations.runMigrations({ claudeDir, settingsFile, stateRoot: ours });
    assert.ok(result.notices.length, "the step ran");

    const note = migrations.describeMigration(result);
    assert.match(note, /did not carry over/);
    assert.match(note, /Nothing was moved or deleted/);
    assert.doesNotMatch(note, /cleaned up leftovers/, "found is not the same claim as cleaned");
  });

  it("runs once — a machine already at version 2 does not report again", () => {
    const { ours, legacy } = renamedPair();
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ enabled: false }));
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ [migrations.VERSION_KEY]: migrations.MIGRATIONS_VERSION })
    );

    const result = migrations.runMigrations({ claudeDir, settingsFile, stateRoot: ours });
    assert.equal(result.ran, false);
    assert.deepEqual(result.notices, []);
  });
});

describe("the version gate", () => {
  // The two ways the retired marker mechanism got this wrong: an existence check
  // (never re-ran) and a semver comparison (fiddly). An integer compared with >=
  // must run when the recorded value is lower and skip when it is equal or higher.
  it("runs again when the recorded version is behind", () => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ [migrations.VERSION_KEY]: migrations.MIGRATIONS_VERSION - 1 })
    );

    const result = run();

    assert.equal(result.ran, true);
    assert.equal(result.from, migrations.MIGRATIONS_VERSION - 1);
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(
      config[migrations.VERSION_KEY],
      migrations.MIGRATIONS_VERSION,
      "and it records the new version"
    );
  });

  it("does not re-run an earlier step when a later one is added", () => {
    // The whole reason steps are gated individually. Step 1 deletes from
    // ~/.claude/settings.json, and the module header promises that happens at most
    // once per machine; collective gating made that true only until the next bump.
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ [migrations.VERSION_KEY]: 1 })
    );
    fs.writeFileSync(path.join(dataDir, "memory-cache.json"), "{}");
    writeSettings({ statusLine: { command: `node "${deadTarget()}"` } });

    const result = run();

    assert.equal(result.ran, true, "the version still advances");
    assert.deepEqual(result.actions, [], "but step 1 must not fire a second time");
    assert.equal(
      fs.existsSync(path.join(dataDir, "memory-cache.json")),
      true,
      "the 2.x cleanup is done; re-running it is not idempotent for settings.json"
    );
    assert.ok(readSettings().statusLine, "and a dead statusLine is not deleted twice");
  });

  it("skips when the recorded version is ahead (a downgrade must not re-migrate)", () => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ [migrations.VERSION_KEY]: migrations.MIGRATIONS_VERSION + 5 })
    );
    fs.writeFileSync(path.join(dataDir, "memory-cache.json"), "{}");

    const result = run();

    assert.equal(result.ran, false);
    assert.equal(fs.existsSync(path.join(dataDir, "memory-cache.json")), true);
  });

  it("treats a non-numeric recorded version as never-migrated", () => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ [migrations.VERSION_KEY]: "1.0.0" })
    );
    const result = run();
    assert.equal(result.ran, true, 'a stale semver string must not read as ">= 1"');
    assert.equal(result.from, 0);
  });
});
