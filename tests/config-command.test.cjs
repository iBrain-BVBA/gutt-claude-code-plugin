#!/usr/bin/env node
/**
 * Tests for the `/gutt-pro:*` config command surface: parsing, bounds, mutation
 * scope, and the rendered text (GP-866, GP-931).
 *
 * The router-level cases — that row 0 sits above the suppression row, and that a
 * config turn does not burn the first-prompt flag — live in
 * `tests/session-lifecycle.test.cjs`, where the hook is actually spawned. This file
 * is the in-process half, which is where the combinatorics belong.
 *
 * Two GP-931 reversals get their own sections, because both are the kind of change
 * that passes every old test while doing the opposite of what it says: the legacy
 * spellings must now parse to `null` (D2), and `off` is the session-scoped verb while
 * `disable` is the durable one (D3).
 *
 * Run: node --test tests/config-command.test.cjs
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const command = require("../gutt-core/hooks/lib/config-command.cjs");
const runtimeConfig = require("../gutt-core/hooks/lib/runtime-config.cjs");

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
  it("accepts both spellings of every verb that has two", () => {
    // The namespaced form is the one the `/` menu inserts, and therefore the one most
    // users will produce. A parser that only handled the bare form would make the
    // default path a silent no-op.
    for (const verb of command.VERBS) {
      assert.equal(parseCommand(`/gutt-pro:${verb}`).verb, verb, `/gutt-pro:${verb}`);
      if (!command.NAMESPACED_ONLY.has(verb)) {
        assert.equal(parseCommand(`/${verb}`).verb, verb, `/${verb}`);
      }
    }
    assert.deepEqual(parseCommand("/gutt-pro:off 30"), {
      verb: "off",
      arg: "30",
      typed: "/gutt-pro:off 30",
      bare: false,
    });
    assert.deepEqual(parseCommand("/off 30"), {
      verb: "off",
      arg: "30",
      typed: "/off 30",
      bare: true,
    });
  });

  it("flags which spelling was used, so the caller can attribute a bare match", () => {
    // A bare match cannot prove the prompt was addressed to us — `off`, `on`, `mode`
    // and `disable` are names another plugin can own. `bare` is what lets the outcome
    // say so instead of writing silently.
    for (const verb of command.VERBS) {
      if (!command.NAMESPACED_ONLY.has(verb)) {
        assert.equal(parseCommand(`/${verb}`).bare, true, `/${verb}`);
      }
      assert.equal(parseCommand(`/gutt-pro:${verb}`).bare, false, `/gutt-pro:${verb}`);
    }
    assert.equal(parseCommand("/off 1 2").bare, true, "carried on a bad-tail parse too");
    assert.equal(parseCommand("/gutt-pro:off 1 2").bare, false);
  });

  it("refuses the bare spelling of a verb that writes outside the plugin", () => {
    // `/statusline` is a Claude Code built-in. This parser reads prompt text and cannot
    // see which command the platform routed, so a bare match here would install the HUD
    // into ~/.claude/settings.json off a prompt aimed at the built-in. The other bare
    // verbs get away with announcing themselves afterwards because /gutt-pro:on undoes
    // them; this one writes a file the plugin may otherwise not touch, and being asked
    // on purpose is the whole reason the verb exists rather than a hook doing it.
    assert.equal(parseCommand("/statusline"), null);
    assert.equal(parseCommand("/statusline off"), null);
    assert.equal(parseCommand("/statusline status"), null);
    assert.equal(parseCommand("  /STATUSLINE  "), null, "case and padding do not sneak past");
    assert.equal(parseCommand("/statusline off please"), null, "nor does a bad tail");

    // Refused, not merely unattributed: null is what keeps the hook silent, so the
    // built-in answers alone and nothing of gutt's runs.
    assert.equal(command.configCommandResult("/statusline"), null);
  });

  it("still accepts the namespaced spelling of that verb", () => {
    // The guard must not have taken the documented path with it.
    assert.deepEqual(parseCommand("/gutt-pro:statusline"), {
      verb: "statusline",
      arg: null,
      typed: "/gutt-pro:statusline",
      bare: false,
    });
    assert.equal(parseCommand("/gutt-pro:statusline off").arg, "off");
    assert.equal(parseCommand("/gutt-pro:statusline status").arg, "status");
  });

  it("names every namespaced-only verb in VERBS", () => {
    // A typo in the set would be a silently inert guard — the verb would keep taking
    // its bare form and nothing would fail.
    for (const verb of command.NAMESPACED_ONLY) {
      assert.ok(command.VERBS.includes(verb), `${verb} is not a verb`);
    }
  });

  it("is insensitive to case and to surrounding whitespace", () => {
    assert.equal(parseCommand("  /GUTT-PRO:OFF 30  ").verb, "off");
    assert.equal(parseCommand("/gutt-pro:off    30").arg, "30");
    assert.equal(parseCommand("/Gutt-Pro:Mode Hitl").verb, "mode");
    assert.equal(parseCommand("/Gutt-Pro:Mode Hitl").arg, "Hitl", "the arg keeps its case");
  });

  it("returns null for anything not addressed to it", () => {
    for (const text of [
      "implement GP-931",
      "please run /gutt-pro:off",
      "/gutt-prooff",
      "/gutt-pro:memory-search find something",
      "/gutt-pro:health",
      "/gutt-pro",
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
    // `/gutt-pro:off 30 and fix the tests` must not snooze. Silence would be worse:
    // the user believes they snoozed and nothing happened.
    const parsed = parseCommand("/gutt-pro:off 30 and fix the tests");
    assert.equal(parsed.verb, null, "a second argument is always wrong");
    assert.equal(parsed.typed, "/gutt-pro:off 30 and fix the tests");
  });

  it("reports an unknown verb by ignoring it, since it is another command", () => {
    // Unlike a bad *tail*, an unknown head word is not addressed to us at all — it is
    // some other plugin's command, or prose. Reporting on it would put a "did not
    // recognise" note under every unrelated slash command in the session.
    assert.equal(parseCommand("/gutt-pro:bogus"), null);
    assert.equal(parseCommand("/bogus"), null);
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
// GP-931 D2 — the hard cut on the legacy spellings
// ---------------------------------------------------------------------------

describe("config command: the legacy spellings are inert (GP-931 D2)", () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-cc-legacy-"));
    process.env.CLAUDE_PLUGIN_DATA = dir;
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Not aliases and not deprecation warnings: ordinary prompt text. An alias would be
  // actively worse than silence here, because D3 reversed what `off` means — the old
  // spelling would do something other than what the user who learned 3.0 expects.
  const LEGACY = [
    "/gutt",
    "/gutt config",
    "/gutt on",
    "/gutt off",
    "/gutt off 30",
    "/gutt off session",
    "/gutt mode hitl",
    "/gutt:off",
    "/gutt:off 30",
    "/gutt:mode auto",
    "/gutt-claude-code-plugin:gutt",
    "/gutt-claude-code-plugin:gutt off 30",
    "/gutt-claude-code-plugin:gutt:off 30",
  ];

  it("parses every 3.0 spelling to null", () => {
    for (const text of LEGACY) {
      assert.equal(parseCommand(text), null, `must be inert: ${text}`);
    }
  });

  it("emits nothing and writes nothing for them", () => {
    for (const text of LEGACY) {
      assert.equal(configCommandResult(text, SESSION, NOW), null, text);
    }
    assert.equal(
      fs.existsSync(path.join(dir, "config.json")),
      false,
      "an inert spelling must not touch config.json"
    );
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

  // --- D3: off is the session verb, disable is the durable one ---------------

  it("/gutt-pro:off with no argument scopes the snooze to this session", () => {
    // The reversal. In 3.0 a bare `off` was durable; the cheap, reversible action is
    // what the short word gets now.
    assert.match(run("/gutt-pro:off"), /rest of this session/);
    const raw = stored();
    assert.equal(raw.snoozeSessionId, SESSION);
    assert.equal(raw.snoozeUntil, null, "no deadline — SessionEnd owns it");
    assert.equal("enabled" in raw, false, "a session off never touches the durable flag");
    assert.equal(runtimeConfig.isSuppressed(SESSION, NOW), true);
    assert.equal(
      runtimeConfig.isSuppressed("another-session", NOW),
      false,
      "and it does not suppress a different session"
    );
  });

  it("a bare verb mutates, and says which command it ran", () => {
    // Bare forms match on prompt text alone, which cannot tell us the prompt was
    // addressed to us: another plugin owning `/off` would route there while this
    // still writes. The write is not prevented, so it has to be visible.
    const text = run("/off");
    assert.match(text, /read the bare command in this prompt as \/gutt-pro:off/);
    assert.match(text, /rest of this session/, "and the outcome still follows the attribution");
    assert.equal(stored().snoozeSessionId, SESSION);
  });

  it("the namespaced form carries no attribution line", () => {
    const text = run("/gutt-pro:off");
    assert.doesNotMatch(text, /read the bare command/, "unambiguous — the note would be noise");
  });

  it("a namespaced foreign command is never claimed", () => {
    // `/other:off` yields the verb `other:off`, which is not in VERBS. Only the
    // *bare* spelling can collide.
    for (const foreign of [
      "/otherplugin:off",
      "/otherplugin:disable 30",
      "/some-plugin:mode auto",
    ]) {
      assert.equal(parseCommand(foreign), null, foreign);
      assert.equal(run(foreign), null, foreign);
      assert.equal(stored(), null, `${foreign} must write nothing`);
    }
  });

  it("/gutt-pro:off session is the same command as bare off", () => {
    assert.match(run("/gutt-pro:off session"), /rest of this session/);
    const explicit = stored();
    fs.rmSync(path.join(dir, "config.json"), { force: true });
    run("/gutt-pro:off");
    assert.deepEqual(stored(), explicit, "the explicit spelling must not differ");
  });

  it("/gutt-pro:disable writes a durable off and nothing else", () => {
    assert.match(run("/gutt-pro:disable"), /off until \/gutt-pro:on/);
    assert.match(run("/gutt-pro:disable"), /survives restarts/);
    assert.deepEqual(stored(), { enabled: false });
    assert.equal(runtimeConfig.isSuppressed(SESSION, NOW), true);
    // Durable means durable: it is not scoped to the session that set it.
    assert.equal(runtimeConfig.isSuppressed("another-session", NOW), true);
  });

  it("/gutt-pro:on takes no argument and says so rather than dropping it", () => {
    // `on` was the one argument-less verb with no guard. `/gutt-pro:on 30` is a
    // plausible typo now that `off` is the verb taking a deadline, and silently
    // discarding the 30 reports a restore the user reads as a 30-minute one.
    run("/gutt-pro:disable");
    const text = run("/gutt-pro:on 30");
    assert.match(text, /takes no argument/);
    assert.match(text, /Nothing was changed\./);
    assert.deepEqual(stored(), { enabled: false }, "the durable off must survive a rejected on");
  });

  it("/gutt-pro:on reports a write failure on an unreadable config, not 'already on'", () => {
    // readRawConfig collapses absent and unreadable into null, which made the
    // "nothing changed" short-circuit fire before restore() ever ran — the one verb
    // that answered a broken file with reassurance.
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    const text = run("/gutt-pro:on");
    assert.match(text, /could not save that/);
    assert.doesNotMatch(text, /already on/);
    assert.equal(
      fs.readFileSync(path.join(dir, "config.json"), "utf8"),
      "{ not json",
      "and it must not overwrite the file it could not parse"
    );
  });

  it("/gutt-pro:disable takes no argument and says so rather than silencing durably", () => {
    // A user typing `/gutt-pro:disable 30` wants a deadline. Accepting it as a bare
    // disable would leave a permanent silence behind a success message.
    for (const bad of ["/gutt-pro:disable 30", "/gutt-pro:disable session"]) {
      const text = run(bad);
      assert.match(text, /takes no argument/, bad);
      assert.match(text, /Nothing was changed\./, bad);
      assert.equal(stored(), null, `${bad} must write nothing`);
    }
  });

  it("/gutt-pro:off <minutes> writes a deadline and nothing else", () => {
    assert.match(run("/gutt-pro:off 30"), /next 30 minutes/);
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

  it("refuses to scope a snooze when no session id reached the hook", () => {
    // Writing `snoozeSessionId: "unknown"` would create a snooze no session matches
    // and that `clearSessionSnooze` could never reclaim — silent and permanent. Both
    // spellings of the session verb have to refuse, bare included.
    for (const id of [null, "unknown", ""]) {
      for (const text of ["/gutt-pro:off", "/gutt-pro:off session"]) {
        assert.match(run(text, id), /no session id/, `${text} with id ${JSON.stringify(id)}`);
        assert.equal(stored(), null, "nothing written");
      }
    }
  });

  it("each form touches only its own keys", () => {
    run("/gutt-pro:disable");
    run("/gutt-pro:off 30");
    const raw = stored();
    assert.equal(raw.enabled, false, "a snooze does not clear a durable off");
    assert.ok(raw.snoozeUntil);
  });

  it("/gutt-pro:on clears both kinds of off in one go", () => {
    run("/gutt-pro:disable");
    run("/gutt-pro:off 30");
    const text = run("/gutt-pro:on");
    assert.match(text, /back on/);
    assert.match(text, /the off set by \/gutt-pro:disable/);
    assert.match(text, /30 minutes left/);
    assert.deepEqual(stored(), {}, "no suppression keys, and no lingering nulls");
  });

  it("/gutt-pro:on clears a session off as well as a durable one", () => {
    run("/gutt-pro:off");
    assert.match(run("/gutt-pro:on"), /session-scoped snooze/);
    assert.deepEqual(stored(), {});
    assert.equal(runtimeConfig.isSuppressed(SESSION, NOW), false);
  });

  it("/gutt-pro:on leaves the capture mode alone", () => {
    run("/gutt-pro:mode hitl");
    run("/gutt-pro:disable");
    run("/gutt-pro:on");
    assert.deepEqual(stored(), { mode: "hitl" }, "on/off is a separate axis from capture mode");
  });

  it("/gutt-pro:on clears a snooze another session set, and says which", () => {
    // config.json is machine-global, so `/gutt-pro:on` is a machine-global statement.
    // Leaving a foreign key behind would make `/gutt-pro:config` explain a snooze the
    // user just tried to cancel.
    run("/gutt-pro:off", "other-session-9999");
    const text = run("/gutt-pro:on");
    assert.match(text, /session-scoped snooze \(other-se…\)/);
    assert.deepEqual(stored(), {});
  });

  it("/gutt-pro:on writes nothing when nothing was suppressed", () => {
    assert.match(run("/gutt-pro:on"), /already on; nothing changed/);
    assert.equal(stored(), null, "a read-only /gutt-pro:on must not create a config file");
  });

  it("/gutt-pro:mode accepts the known modes and rejects the rest", () => {
    assert.match(run("/gutt-pro:mode hitl"), /now hitl, was auto/);
    assert.deepEqual(stored(), { mode: "hitl" });
    assert.match(run("/gutt-pro:mode hitl"), /is hitl, unchanged/);
    assert.match(run("/gutt-pro:mode auto"), /now auto, was hitl/);

    for (const bad of ["/gutt-pro:mode", "/gutt-pro:mode manual", "/gutt-pro:mode HITLL"]) {
      assert.match(run(bad), /did not change the capture mode/, bad);
    }
    assert.deepEqual(stored(), { mode: "auto" }, "a rejected mode leaves the stored one alone");
  });

  it("rejects an out-of-range minute count rather than clamping it", () => {
    // Clamping silently does something other than what was typed. The upper bound
    // is the point: `/gutt-pro:off 300000` would otherwise be a seven-month silence.
    for (const bad of ["0", "-5", "30.5", "abc", "10081", "300000", "1e3", "0x1e", "+30"]) {
      const text = run(`/gutt-pro:off ${bad}`);
      assert.match(text, /not a number of minutes between 1 and 10080/, `/gutt-pro:off ${bad}`);
      assert.equal(stored(), null, `/gutt-pro:off ${bad} must write nothing`);
    }
  });

  it("accepts the bounds themselves", () => {
    assert.match(run(`/gutt-pro:off ${command.MIN_MINUTES}`), /next 1 minute,/);
    run("/gutt-pro:on");
    assert.match(run(`/gutt-pro:off ${command.MAX_MINUTES}`), /next 10080 minutes/);
  });

  it("names the typed text back on an unrecognised form, and changes nothing", () => {
    for (const bad of [
      "/gutt-pro:config now",
      "/gutt-pro:off 30 and fix the tests",
      "/gutt-pro:disable please",
    ]) {
      const text = run(bad);
      assert.match(text, /Nothing was changed\./, bad);
      assert.match(
        text,
        /\/gutt-pro:config, \/gutt-pro:on, \/gutt-pro:off/,
        "the reply lists the forms"
      );
      assert.equal(stored(), null, bad);
    }
  });

  it("works through the bare spelling too", () => {
    // Whether the platform routes a bare verb to us is recorded in
    // docs/plugin-platform-reference.md §8; the parser accepting it is this file's
    // business either way, because a bare form that parsed to nothing would be a
    // silent no-op rather than a visible error.
    assert.match(run("/disable"), /off until \/gutt-pro:on/);
    assert.deepEqual(stored(), { enabled: false });
    assert.match(run("/on"), /back on/);
    assert.deepEqual(stored(), {});
  });

  it("serialises concurrent writers from separate processes", () => {
    // Two commands, two processes, one machine-global file. The lock in
    // updateConfig is what stops the second read-modify-write from losing the first.
    const script = (text) =>
      `require("${path.join(__dirname, "..", "gutt-core", "hooks", "lib", "config-command.cjs").replace(/\\/g, "\\\\")}")` +
      `.configCommandResult(${JSON.stringify(text)}, "p", Date.now())`;
    const runs = ["/gutt-pro:disable", "/gutt-pro:mode hitl"].map((text) =>
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
    return configCommandResult("/gutt-pro:config", sessionId, now);
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

  // GP-931 D3 made this load-bearing rather than nice-to-have: `off` and `disable`
  // both print "suppressed", and a user who learned 3.0's durable `off` cannot
  // otherwise tell whether recall comes back on its own.
  it("names the scope of whatever suppression is in force", () => {
    plant({ enabled: false });
    assert.match(render(), /set by \/gutt-pro:disable, so it holds until \/gutt-pro:on/);
    assert.match(render(), /restarts do not clear it/);

    plant({ snoozeSessionId: SESSION });
    assert.match(render(), /set by \/gutt-pro:off for this session/);
    assert.match(render(), /clears when this session ends/);

    plant({ snoozeUntil: new Date(NOW + 10 * MINUTE).toISOString() });
    assert.match(render(), /set by \/gutt-pro:off for 10 minutes/);
    assert.match(render(), /clears on its own after that/);
  });

  it("names the durable scope when both a disable and a snooze are set", () => {
    // A durable off outlives any snooze layered under it, so that is the honest
    // answer to "when does this end".
    plant({ enabled: false, snoozeUntil: new Date(NOW + 10 * MINUTE).toISOString() });
    assert.match(render(), /set by \/gutt-pro:disable/);
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
    // `/gutt-pro:config` is the command someone runs *because* their config looks
    // wrong; a TypeError from the renderer would be the one failure mode it must not
    // have.
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
      assert.match(configCommandResult("/gutt-pro:off 30", SESSION, NOW), /could not save that/);
      assert.match(configCommandResult("/gutt-pro:mode hitl", SESSION, NOW), /could not save that/);
      assert.match(configCommandResult("/gutt-pro:disable", SESSION, NOW), /could not save that/);
      assert.match(configCommandResult("/gutt-pro:off", SESSION, NOW), /could not save that/);
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = dir;
    }
  });

  it("carries no nag phrasing — factual statements only (GP-868)", () => {
    plant({ enabled: false, mode: "hitl", snoozeUntil: new Date(NOW + MINUTE).toISOString() });
    const texts = [
      render(),
      configCommandResult("/gutt-pro:on", SESSION, NOW),
      configCommandResult("/gutt-pro:disable", SESSION, NOW),
      configCommandResult("/gutt-pro:off", SESSION, NOW),
      configCommandResult("/gutt-pro:config now", SESSION, NOW),
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

  it("lists every verb in the forms line", () => {
    // The forms line is the only in-product documentation of the surface, and a verb
    // missing from it is a verb users never learn exists.
    const text = render();
    for (const verb of command.VERBS) {
      assert.match(text, new RegExp(`/gutt-pro:${verb}`), `the forms line omits ${verb}`);
    }
  });
});
