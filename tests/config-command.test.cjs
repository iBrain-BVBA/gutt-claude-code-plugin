#!/usr/bin/env node
/**
 * Tests for the GP-866 `/gutt` config command surface: parsing, bounds,
 * mutation scope, and the rendered text.
 *
 * The router-level cases — that row 0 sits above the suppression row, and that a
 * config turn does not burn the first-prompt flag — live in
 * `tests/session-lifecycle.test.cjs`, where the hook is actually spawned. This file
 * is the in-process half, which is where the combinatorics belong.
 *
 * Run: node --test tests/config-command.test.cjs
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const command = require("../shared/config-command.cjs");
const runtimeConfig = require("../shared/runtime-config.cjs");

const { parseCommand, configCommandResult } = command;

const SESSION = "sess-abcdef123456";
const NOW = Date.parse("2026-07-30T09:00:00.000Z");
const MINUTE = 60 * 1000;

/**
 * The `YYYY-MM-DD` a timestamp falls on **in the runner's own timezone**, which is
 * what `localStamp` renders. Hard-coding "2026-07-30" here would pass in Europe and
 * fail west of UTC-10, where 09:00Z is still the 29th — a CI flake that tells you
 * nothing about the code.
 */
function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const ORIGINAL_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;

function restoreEnv() {
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_DATA_DIR;
  }
}

// ---------------------------------------------------------------------------
// Parsing — no state, no IO
// ---------------------------------------------------------------------------

describe("config command: parsing", () => {
  it("accepts all three spellings of every subcommand", () => {
    // The namespaced form is the one the `/` menu inserts, and therefore the one
    // most users will produce. A parser that only handled the hand-typed forms
    // would make the default path a silent no-op.
    for (const head of ["/gutt", "/gutt-claude-code-plugin:gutt"]) {
      assert.deepEqual(parseCommand(`${head} off 30`), {
        sub: "off",
        arg: "30",
        typed: `${head} off 30`,
      });
    }
    assert.deepEqual(parseCommand("/gutt:off 30"), {
      sub: "off",
      arg: "30",
      typed: "/gutt:off 30",
    });
    assert.equal(parseCommand("/gutt-claude-code-plugin:gutt:off 30").sub, "off");
  });

  it("treats a bare /gutt as /gutt config", () => {
    assert.deepEqual(parseCommand("/gutt"), { sub: "config", arg: null, typed: "/gutt" });
    assert.equal(parseCommand("/gutt-claude-code-plugin:gutt").sub, "config");
  });

  it("is insensitive to case and to surrounding whitespace", () => {
    assert.equal(parseCommand("  /GUTT OFF 30  ").sub, "off");
    assert.equal(parseCommand("/gutt   off    30").arg, "30");
    assert.equal(parseCommand("/Gutt:Mode Hitl").sub, "mode");
  });

  it("returns null for anything not addressed to it", () => {
    for (const text of [
      "implement GP-866",
      "please run /gutt off",
      "/guttoff",
      "/gutt-claude-code-plugin:memory-search find something",
      "/gutt-claude-code-plugin:health",
      "/memory-search",
      "",
      "   ",
    ]) {
      assert.equal(parseCommand(text), null, `must ignore: ${JSON.stringify(text)}`);
    }
  });

  it("survives a prompt that is not a string", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      assert.equal(parseCommand(value), null);
      assert.equal(configCommandResult(value, SESSION, NOW), null);
    }
  });

  it("reports a trailing tail rather than mutating on a partial match", () => {
    // `/gutt off 30 and fix the tests` must not snooze. Silence would be worse:
    // the user believes they snoozed and nothing happened.
    const parsed = parseCommand("/gutt off 30 and fix the tests");
    assert.equal(parsed.sub, null, "a third word is always wrong");
    assert.equal(parsed.typed, "/gutt off 30 and fix the tests");
  });

  it("reports an unknown subcommand rather than ignoring it", () => {
    assert.equal(parseCommand("/gutt bogus").sub, null);
    assert.equal(parseCommand("/gutt:bogus").sub, null);
  });

  it("does no file IO on the negative path", () => {
    // The parser runs on every prompt on a 50ms budget (R25). A regression that
    // reached for config.json before deciding the prompt was irrelevant would be
    // invisible in behaviour and expensive in aggregate — so assert the absence of
    // the file, which is the only externally visible trace a read-or-write leaves.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cc-noio-"));
    process.env.CLAUDE_PLUGIN_DATA = dir;
    try {
      for (let i = 0; i < 1000; i += 1) {
        assert.equal(configCommandResult(`ordinary prompt number ${i}`, SESSION, NOW), null);
      }
      assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
    } finally {
      restoreEnv();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe("config command: mutations", () => {
  let dir;

  /** The stored config, or null when no file exists. */
  function stored() {
    const file = path.join(dir, "config.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }

  function run(text, sessionId = SESSION, now = NOW) {
    return configCommandResult(text, sessionId, now);
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cc-data-"));
    process.env.CLAUDE_PLUGIN_DATA = dir;
  });
  beforeEach(() => {
    fs.rmSync(path.join(dir, "config.json"), { force: true });
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("/gutt off writes a durable off and nothing else", () => {
    assert.match(run("/gutt off"), /off until \/gutt on/);
    assert.deepEqual(stored(), { enabled: false });
    assert.equal(runtimeConfig.isSuppressed(SESSION, NOW), true);
  });

  it("/gutt off <minutes> writes a deadline and nothing else", () => {
    assert.match(run("/gutt off 30"), /next 30 minutes/);
    const raw = stored();
    assert.equal(Date.parse(raw.snoozeUntil), NOW + 30 * MINUTE);
    assert.equal(raw.snoozeSessionId, null, "a minute snooze is not session-scoped");
    assert.equal("enabled" in raw, false, "a snooze does not touch the durable flag");
    assert.equal(runtimeConfig.isSuppressed(SESSION, NOW), true);
    assert.equal(
      runtimeConfig.isSuppressed(SESSION, NOW + 31 * MINUTE),
      false,
      "and it lapses on its own"
    );
  });

  it("/gutt off session scopes the snooze to this session", () => {
    assert.match(run("/gutt off session"), /rest of this session/);
    const raw = stored();
    assert.equal(raw.snoozeSessionId, SESSION);
    assert.equal(raw.snoozeUntil, null, "no deadline — SessionEnd owns it");
    assert.equal(runtimeConfig.isSuppressed(SESSION, NOW), true);
    assert.equal(
      runtimeConfig.isSuppressed("another-session", NOW),
      false,
      "and it does not suppress a different session"
    );
  });

  it("refuses to scope a snooze when no session id reached the hook", () => {
    // Writing `snoozeSessionId: "unknown"` would create a snooze no session matches
    // and that `clearSessionSnooze` could never reclaim — silent and permanent.
    for (const id of [null, "unknown", ""]) {
      assert.match(run("/gutt off session", id), /no session id/);
      assert.equal(stored(), null, "nothing written");
    }
  });

  it("/gutt off does not re-enable, and a snooze does not clear a durable off", () => {
    run("/gutt off");
    run("/gutt off 30");
    const raw = stored();
    assert.equal(raw.enabled, false, "each form touches only its own keys");
    assert.ok(raw.snoozeUntil);
  });

  it("/gutt on clears every suppression key in one go", () => {
    run("/gutt off");
    run("/gutt off 30");
    const text = run("/gutt on");
    assert.match(text, /back on/);
    assert.match(text, /the off set by \/gutt off/);
    assert.match(text, /30 minutes left/);
    assert.deepEqual(stored(), {}, "no suppression keys, and no lingering nulls");
  });

  it("/gutt on leaves the capture mode alone", () => {
    run("/gutt mode hitl");
    run("/gutt off");
    run("/gutt on");
    assert.deepEqual(stored(), { mode: "hitl" }, "on/off is a separate axis from capture mode");
  });

  it("/gutt on clears a snooze another session set, and says which", () => {
    // config.json is machine-global, so `/gutt on` is a machine-global statement.
    // Leaving a foreign key behind would make `/gutt config` explain a snooze the
    // user just tried to cancel.
    run("/gutt off session", "other-session-9999");
    const text = run("/gutt on");
    assert.match(text, /session-scoped snooze \(other-se…\)/);
    assert.deepEqual(stored(), {});
  });

  it("/gutt on writes nothing when nothing was suppressed", () => {
    assert.match(run("/gutt on"), /already on; nothing changed/);
    assert.equal(stored(), null, "a read-only /gutt on must not create a config file");
  });

  it("/gutt mode accepts the known modes and rejects the rest", () => {
    assert.match(run("/gutt mode hitl"), /now hitl, was auto/);
    assert.deepEqual(stored(), { mode: "hitl" });
    assert.match(run("/gutt mode hitl"), /is hitl, unchanged/);
    assert.match(run("/gutt mode auto"), /now auto, was hitl/);

    for (const bad of ["/gutt mode", "/gutt mode manual", "/gutt mode HITLL"]) {
      assert.match(run(bad), /did not change the capture mode/, bad);
    }
    assert.deepEqual(stored(), { mode: "auto" }, "a rejected mode leaves the stored one alone");
  });

  it("rejects an out-of-range minute count rather than clamping it", () => {
    // Clamping silently does something other than what was typed. The upper bound
    // is the point: `/gutt off 300000` would otherwise be a seven-month silence.
    for (const bad of ["0", "-5", "30.5", "abc", "10081", "300000", "1e3", "0x1e", "+30"]) {
      const text = run(`/gutt off ${bad}`);
      assert.match(text, /not a number of minutes between 1 and 10080/, `/gutt off ${bad}`);
      assert.equal(stored(), null, `/gutt off ${bad} must write nothing`);
    }
  });

  it("accepts the bounds themselves", () => {
    assert.match(run(`/gutt off ${command.MIN_MINUTES}`), /next 1 minute,/);
    run("/gutt on");
    assert.match(run(`/gutt off ${command.MAX_MINUTES}`), /next 10080 minutes/);
  });

  it("names the typed text back on an unrecognised form, and changes nothing", () => {
    for (const bad of ["/gutt bogus", "/gutt config now", "/gutt off 30 and fix the tests"]) {
      const text = run(bad);
      assert.match(text, /Nothing was changed\./, bad);
      assert.match(text, /\/gutt config, \/gutt on, \/gutt off/, "the reply lists the forms");
      assert.equal(stored(), null, bad);
    }
  });

  it("serialises concurrent writers from separate processes", () => {
    // Two commands, two processes, one machine-global file. The lock in
    // updateConfig is what stops the second read-modify-write from losing the first.
    const script = (text) =>
      `require("${path.join(__dirname, "..", "shared", "config-command.cjs").replace(/\\/g, "\\\\")}")` +
      `.configCommandResult(${JSON.stringify(text)}, "p", Date.now())`;
    const runs = ["/gutt off", "/gutt mode hitl"].map((text) =>
      execFileSync(process.execPath, ["-e", script(text)], {
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
        encoding: "utf8",
      })
    );
    assert.equal(runs.length, 2);
    const raw = stored();
    assert.equal(raw.enabled, false, "both writes survived");
    assert.equal(raw.mode, "hitl");
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("config command: rendering", () => {
  let dir;

  function plant(config) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  }

  function render(sessionId = SESSION, now = NOW) {
    return configCommandResult("/gutt config", sessionId, now);
  }

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cc-render-"));
    process.env.CLAUDE_PLUGIN_DATA = dir;
  });
  beforeEach(() => {
    fs.rmSync(path.join(dir, "config.json"), { force: true });
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the file it read, so the user can go look", () => {
    assert.match(render(), new RegExp(path.join(dir, "config.json").replace(/\\/g, "\\\\")));
  });

  it("reports the defaults when nothing is stored", () => {
    const text = render();
    assert.match(text, /enabled: true/);
    assert.match(text, /mode: auto/);
    assert.match(text, /snooze: none/);
    assert.match(text, /in force right now: active/);
  });

  it("reports a durable off", () => {
    plant({ enabled: false });
    const text = render();
    assert.match(text, /enabled: false/);
    assert.match(text, /in force right now: suppressed/);
  });

  it("prints an unreadable enabled value raw, and reads it as on", () => {
    // `isSuppressed` compares with a strict `=== false`, so this hand-edit does
    // nothing. Printing it is what stops the user assuming it worked.
    plant({ enabled: "no" });
    const text = render();
    assert.match(text, /enabled: "no"/);
    assert.match(text, /reads as true/);
    assert.match(text, /in force right now: active/);
  });

  it("names an unknown mode without claiming anything about behaviour", () => {
    plant({ mode: "manual" });
    const text = render();
    assert.match(text, /mode: "manual"/);
    assert.match(text, /the known modes are auto and hitl/);
  });

  it("distinguishes every snooze state", () => {
    plant({ snoozeUntil: new Date(NOW + 24 * MINUTE).toISOString() });
    assert.match(
      render(),
      new RegExp(
        `snooze: in force for 24 minutes more, until ${localDate(NOW + 24 * MINUTE)} \\d\\d:\\d\\d`
      )
    );
    assert.match(render(), /survives a restart/);

    plant({ snoozeSessionId: SESSION });
    assert.match(render(), /rest of this session/);

    plant({ snoozeSessionId: "other-session-9999" });
    assert.match(render(), /set by another session \(other-se…\)/);
    assert.match(render(), /in force right now: active/, "another session's snooze is not ours");

    plant({ snoozeUntil: new Date(NOW - MINUTE).toISOString() });
    assert.match(render(), /lapsed at /);

    plant({ snoozeUntil: "not-a-date" });
    assert.match(render(), /unreadable deadline \("not-a-date"\)/);
    assert.match(render(), /treated as lapsed/);
  });

  it("renders a non-string session id instead of throwing on it", () => {
    // `config.json` is hand-editable, so the id is not guaranteed to be a string.
    // `/gutt config` is the command someone runs *because* their config looks wrong;
    // a TypeError from the renderer would be the one failure mode it must not have.
    for (const corrupt of [12345, true, { id: "x" }, ["x"]]) {
      plant({ snoozeSessionId: corrupt });
      const text = render();
      assert.match(text, /snooze: set by another session/);
      assert.match(text, /in force right now: active/, "a corrupt id is never ours");
    }
  });

  it("leaves the non-preference keys out of the block", () => {
    // `projects` and `migrationsVersion` share the file but are not preferences.
    // Listing them would bury the four keys a user can act on.
    plant({ migrationsVersion: 3, projects: { "some-project": { memoryMigration: {} } } });
    const text = render();
    assert.doesNotMatch(text, /migrationsVersion|projects|memoryMigration/);
  });

  it("says plainly when there is no plugin data directory", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    try {
      assert.match(render(), /unavailable: this session has no plugin data directory/);
      assert.match(render(), /built-in defaults are in force/);
      // And a mutation must report the failure rather than claim success — every
      // write is a silent no-op without the directory.
      assert.match(configCommandResult("/gutt off 30", SESSION, NOW), /could not save that/);
      assert.match(configCommandResult("/gutt mode hitl", SESSION, NOW), /could not save that/);
      assert.match(configCommandResult("/gutt off", SESSION, NOW), /could not save that/);
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = dir;
    }
  });

  it("carries no nag phrasing — factual statements only (GP-868)", () => {
    plant({ enabled: false, mode: "hitl", snoozeUntil: new Date(NOW + MINUTE).toISOString() });
    const texts = [
      render(),
      configCommandResult("/gutt on", SESSION, NOW),
      configCommandResult("/gutt off", SESSION, NOW),
      configCommandResult("/gutt bogus", SESSION, NOW),
    ];
    for (const text of texts) {
      assert.doesNotMatch(text, /MANDATORY|YOU MUST|you MUST|NEVER skip|CRITICAL violation/, text);
    }
  });

  it("tells the user that off silences the capture judge too", () => {
    // This assertion used to require the opposite sentence, because the Stop handler was a
    // prompt hook that read no config. GP-866 converted it, `stop-capture.cjs` returns on
    // `isSuppressed` before spawning anything, and the old wording became false in the same
    // change that made it wrong — while this test kept it alive, so correcting the prose
    // reddened the build. Asserting the *current* truth is what stops that recurring: the
    // guard now defends accuracy instead of pinning a stale claim.
    const text = render();
    assert.match(text, /capture judge does not run|capture judge runs/);
    assert.doesNotMatch(
      text,
      /does not silence the end-of-turn capture prompt/,
      "the pre-conversion claim is false since GP-866"
    );
  });

  it("does not claim that mode is inert", () => {
    // Same failure class as above, one line up: `mode` was written and read by nobody until
    // stop-capture.cjs began reading it and stop-judge.cjs began appending HITL_TAIL.
    for (const mode of ["auto", "hitl"]) {
      plant({ mode });
      const text = render();
      assert.doesNotMatch(text, /no behaviour reads this key yet/, `mode: ${mode}`);
      assert.match(text, new RegExp(`mode: ${mode} — \\w`), "the mode line must state an effect");
    }
  });
});
