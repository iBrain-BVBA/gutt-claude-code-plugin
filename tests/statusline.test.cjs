#!/usr/bin/env node
/**
 * The statusline: what it renders, and how it reaches a user at all (GP-867).
 *
 * Two halves, and the second is the one with teeth. Rendering is pure — feed it a
 * payload and a state file, read the line back. Delivery writes a file in the
 * user's home directory, which this plugin is otherwise forbidden to touch, so most
 * of those tests are about what it must *refuse* to do.
 *
 * Everything runs against a synthetic ${CLAUDE_PLUGIN_DATA} and a synthetic
 * settings.json in a temp dir. Nothing here can see the developer's own ~/.claude —
 * `installEntry` and friends take an explicit `settingsFile` precisely so that a
 * test can never be one bug away from rewriting the machine it runs on.
 *
 * Run: node --test tests/statusline.test.cjs
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STATUSLINE = path.join(ROOT, "gutt-core", "hooks", "statusline.cjs");
const INSTALL_LIB = path.join(ROOT, "gutt-core", "hooks", "lib", "statusline-install.cjs");
const HOOKS_JSON = path.join(ROOT, "gutt-core", "hooks", "hooks.json");

let sandbox;
let dataDir;
let settingsFile;
let install;

/**
 * Render the HUD in a child process.
 *
 * A child rather than an in-process call: the renderer is a stdin-driven script,
 * and the state and config modules cache what they read. Re-requiring them between
 * cases would test the cache rather than the renderer.
 *
 * @param {Object} [payload] the stdin JSON Claude Code would send
 * @param {Object} [opts]
 * @param {string} [opts.raw] literal stdin, overriding `payload`
 * @param {string} [opts.columns] COLUMNS for this run
 * @returns {string} the rendered line
 */
function render(payload = {}, { raw, columns } = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  if (columns === undefined) {
    delete env.COLUMNS;
  } else {
    env.COLUMNS = String(columns);
  }
  const result = spawnSync(process.execPath, [STATUSLINE], {
    input: raw !== undefined ? raw : JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, `statusline exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Write the session record the renderer reads. */
function writeState(state) {
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const record = { sessionId: "s1", ...state };
  // The glyph will not trust a `connectionStatus` without knowing when it was
  // observed, so default that to "just now". Cases actually about ageing pass
  // `connectionObservedAt` themselves; every other case stays about its own subject.
  if (record.connectionStatus !== undefined && record.connectionObservedAt === undefined) {
    record.connectionObservedAt = new Date().toISOString();
  }
  fs.writeFileSync(path.join(dir, "s1.json"), JSON.stringify(record));
}

/** An ISO timestamp `minutes` in the past. */
function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

/** Write the runtime config the renderer reads. */
function writeRuntimeConfig(config) {
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
}

function writeSettings(obj) {
  fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2));
}

function readSettings() {
  return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
}

/** The standard payload: a connected-looking session with a model and a cost. */
const PAYLOAD = {
  session_id: "s1",
  model: { display_name: "Opus 5" },
  cost: { total_cost_usd: 1.24 },
  context_window: { used_percentage: 38 },
};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-statusline-"));
  dataDir = path.join(sandbox, "data");
  settingsFile = path.join(sandbox, "settings.json");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  delete require.cache[require.resolve(INSTALL_LIB)];
  install = require(INSTALL_LIB);
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("the HUD reports connection state", () => {
  it("shows green only once a real call has come back", () => {
    // Green is earned by an observed round trip, never by a settings-file read: a
    // hook cannot open a socket, so configuration was the strongest claim the old
    // probe could make while rendering a light everyone reads as "connected".
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.match(render(PAYLOAD), /\[gutt 🟢 on/);
  });

  it("stays neutral before anything has been observed, rather than guessing", () => {
    // No state file at all. That is not a failure and must not look like one.
    const line = render(PAYLOAD);
    assert.match(line, /\[gutt ⚪ on/);
    assert.doesNotMatch(line, /!/);
  });

  it("stays neutral when configured but never yet exercised", () => {
    // Configured is not connected. Showing red at someone whose setup is fine is
    // worse than saying nothing.
    writeState({ mcpConfigured: true });
    const line = render(PAYLOAD);
    assert.match(line, /⚪/);
    assert.doesNotMatch(line, /!/);
  });

  it("shows amber and says `auth` when a call came back unauthenticated", () => {
    // The one connection state the user can act on, so it gets a word and not just
    // a colour.
    writeState({ connectionStatus: "auth", mcpConfigured: true });
    const line = render(PAYLOAD);
    assert.match(line, /🟡/);
    assert.match(line, /\bauth\b/);
  });

  it("shows red when a call failed for some other reason", () => {
    writeState({ connectionStatus: "error", mcpConfigured: true });
    const line = render(PAYLOAD);
    assert.match(line, /🔴/);
    assert.doesNotMatch(line, /\bauth\b/);
  });

  it("stops trusting an observation once it goes stale", () => {
    // The disconnect case: when a server drops, its tools leave the tool list, so
    // nothing calls them and nothing observes anything ever again. Without ageing,
    // a success from an hour ago would still be rendering green now.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      connectionObservedAt: minutesAgo(30),
    });
    assert.match(render(PAYLOAD), /⚪/);
  });

  it("keeps trusting a recent one", () => {
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      connectionObservedAt: minutesAgo(2),
    });
    assert.match(render(PAYLOAD), /🟢/);
  });

  it("believes the tool list over a recent successful call", () => {
    // The signals disagree exactly when it matters most: the server dropped a
    // moment after a call that worked. A remembered success says nothing about a
    // server whose tools are no longer there, however recent it is.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      connectionObservedAt: minutesAgo(1),
      mcpToolsAvailable: "pending",
    });
    const line = render(PAYLOAD);
    assert.match(line, /🟡/);
    assert.match(line, /\bauth\b/);
  });

  it("shows red when a configured server's tools are gone and nothing is pending", () => {
    writeState({ connectionStatus: "ok", mcpConfigured: true, mcpToolsAvailable: "absent" });
    assert.match(render(PAYLOAD), /🔴/);
  });

  it("does not call it a disconnection when no server was ever configured", () => {
    // Absent tools are unremarkable with nothing configured — `!` is the signal
    // there, and red would be telling the user something broke that never existed.
    writeState({ mcpConfigured: false, mcpToolsAvailable: "absent" });
    const line = render(PAYLOAD);
    assert.match(line, /⚪/);
    assert.match(line, /!/);
  });

  it("lets a reconnect restore the glyph the drop took away", () => {
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      connectionObservedAt: minutesAgo(1),
      mcpToolsAvailable: "available",
    });
    const line = render(PAYLOAD);
    assert.match(line, /🟢/);
    assert.doesNotMatch(line, /\bauth\b/);
  });

  it("drops the auth marker along with the stale glyph", () => {
    // A half-hour-old auth failure is not current news; keeping the word while
    // dropping the colour would tell the user to go and re-authenticate on no
    // evidence.
    writeState({ connectionStatus: "auth", connectionObservedAt: minutesAgo(30) });
    const line = render(PAYLOAD);
    assert.match(line, /⚪/);
    assert.doesNotMatch(line, /\bauth\b/);
  });
});

describe("the false configuration warning (the GP-867 regression)", () => {
  it("does not warn when the group is resolved from MCP auth", () => {
    // The bug: `isConfigured()` asked whether a group_id was set *locally*, but the
    // normal path resolves it from MCP auth and leaves it empty — so a correctly
    // configured session rendered `[gutt⚪!]` and was told it was broken.
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.doesNotMatch(render(PAYLOAD), /!/);
  });

  it("warns only when the probe reports the server genuinely absent", () => {
    writeState({ connectionStatus: "unknown", mcpConfigured: false });
    assert.match(render(PAYLOAD), /!/);
  });

  it("does not warn while the answer is still unknown", () => {
    // `mcpConfigured` undefined is not the same as false, and must not warn.
    writeState({ connectionStatus: "unknown" });
    assert.doesNotMatch(render(PAYLOAD), /!/);
  });
});

describe("the HUD reports suppression unambiguously", () => {
  beforeEach(() => writeState({ connectionStatus: "ok", mcpConfigured: true }));

  it("says `on` when nothing is suppressing recall", () => {
    assert.match(render(PAYLOAD), /\[gutt 🟢 on\]/);
  });

  it("says `off` for a durable disable, which nothing else reports", () => {
    writeRuntimeConfig({ enabled: false });
    assert.match(render(PAYLOAD), /\[gutt 🟢 off\]/);
  });

  it("shows a snooze with the time it lapses, so no command is needed to ask", () => {
    const until = new Date(Date.now() + 45 * 60_000);
    writeRuntimeConfig({ enabled: true, snoozeUntil: until.toISOString() });
    const hh = String(until.getHours()).padStart(2, "0");
    const mm = String(until.getMinutes()).padStart(2, "0");
    assert.match(render(PAYLOAD), new RegExp(`zzz→${hh}:${mm}`));
  });

  it("shows a bare `zzz` for a session snooze, which has no deadline to show", () => {
    writeRuntimeConfig({ enabled: true, snoozeSessionId: "s1" });
    const line = render(PAYLOAD);
    assert.match(line, /zzz/);
    assert.doesNotMatch(line, /zzz→/);
  });

  it("ignores a snooze belonging to another session", () => {
    writeRuntimeConfig({ enabled: true, snoozeSessionId: "someone-else" });
    assert.match(render(PAYLOAD), /\[gutt 🟢 on\]/);
  });

  it("distinguishes off from snoozed, because the recovery differs", () => {
    writeRuntimeConfig({ enabled: false, snoozeSessionId: "s1" });
    // A snooze lapses on its own; a durable off waits for /gutt-pro:on. When both
    // are set the durable one is what the user has to act on.
    assert.match(render(PAYLOAD), /off/);
  });
});

describe("the HUD reports capture mode", () => {
  beforeEach(() => writeState({ connectionStatus: "ok", mcpConfigured: true }));

  it("names hitl, which changes what happens at the end of every turn", () => {
    writeRuntimeConfig({ enabled: true, mode: "hitl" });
    assert.match(render(PAYLOAD), /hitl/);
  });

  it("stays quiet about auto, which is what the user already expects", () => {
    writeRuntimeConfig({ enabled: true, mode: "auto" });
    assert.doesNotMatch(render(PAYLOAD), /auto/);
  });
});

describe("metrics never render as a permanent zero", () => {
  // The 2.x `mem:`/`lessons:` counters were removed because the hooks feeding them
  // were deleted and they froze at zero. Every segment here is absent-or-real.

  it("omits recall recency until something has actually been recalled", () => {
    writeState({ connectionStatus: "ok", mcpConfigured: true, turnsSinceSearch: null });
    assert.doesNotMatch(render(PAYLOAD), /↺/);
  });

  it("shows a zero that means something: a recall just happened", () => {
    writeState({ connectionStatus: "ok", mcpConfigured: true, turnsSinceSearch: 0 });
    assert.match(render(PAYLOAD), /↺0/);
  });

  it("counts turns since the last recall", () => {
    writeState({ connectionStatus: "ok", mcpConfigured: true, turnsSinceSearch: 3 });
    assert.match(render(PAYLOAD), /↺3/);
  });

  it("never shows context window usage, however the payload reports it", () => {
    // Dropped from the HUD by choice: Claude Code shows it already, and the bar is
    // for gutt state. The payload still carries it, so this pins the omission
    // rather than leaving it to be reintroduced as an obvious freebie.
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.doesNotMatch(render(PAYLOAD), /ctx/);
    assert.doesNotMatch(render({ ...PAYLOAD, context_window: { used_percentage: 91 } }), /91/);
  });
});

describe("the HUD degrades rather than wrapping", () => {
  beforeEach(() =>
    writeState({ connectionStatus: "ok", mcpConfigured: true, turnsSinceSearch: 3 })
  );

  it("shows everything when the width is unknown", () => {
    // Guessing narrow would hide information from someone with a wide terminal.
    assert.match(render(PAYLOAD), /↺/);
  });

  it("shows everything on a wide terminal", () => {
    assert.match(render(PAYLOAD, { columns: 120 }), /↺/);
  });

  it("drops recall as the terminal narrows", () => {
    assert.match(render(PAYLOAD, { columns: 80 }), /↺/);
    assert.doesNotMatch(render(PAYLOAD, { columns: 52 }), /↺/);
  });

  it("never drops the state segment, however narrow", () => {
    // Connection and suppression are the whole point of the HUD; if only one thing
    // fits it is this.
    assert.match(render(PAYLOAD, { columns: 20 }), /\[gutt 🟢 on\]/);
  });
});

describe("the HUD degrades rather than vanishing", () => {
  it("still renders a state segment on unparseable stdin", () => {
    assert.match(render({}, { raw: "not json at all" }), /\[gutt/);
  });

  it("still renders on empty stdin", () => {
    assert.match(render({}, { raw: "" }), /\[gutt/);
  });

  it("tolerates a byte-order mark, which some shells prepend", () => {
    assert.match(render({}, { raw: `\uFEFF${JSON.stringify(PAYLOAD)}` }), /\| \[Opus 5\]/);
  });

  it("renders the model and cost Claude Code supplies", () => {
    assert.match(render(PAYLOAD), /\| \[Opus 5\] ~\$1\.24/);
  });

  it("omits the model segment when the payload carries neither model nor cost", () => {
    assert.doesNotMatch(render({ session_id: "s1" }), /\|/);
  });
});

describe("the inert manifest key", () => {
  it("is gone from hooks.json and stays gone", () => {
    // A plugin's settings.json supports only `agent` and `subagentStatusLine`, so a
    // top-level statusLine here was never registered and never ran. Shipping a key
    // the platform ignores tells every future reader it works.
    const manifest = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
    assert.equal(manifest.statusLine, undefined);
  });
});

describe("the shim is what makes an upgrade invisible", () => {
  it("points at the renderer in the current plugin root", () => {
    const result = install.refreshShim();
    assert.equal(result.written, true);
    const shim = fs.readFileSync(result.path, "utf8");
    assert.match(shim, /^require\(/m);
    assert.ok(shim.includes(JSON.stringify(result.target)));
  });

  it("lives at a stable path, not a versioned one", () => {
    // The whole mechanism: settings.json names this path once and never again.
    assert.equal(install.shimPath(), path.join(dataDir, "statusline.cjs"));
  });

  it("does not rewrite when nothing moved", () => {
    install.refreshShim();
    assert.equal(install.refreshShim().written, false);
  });

  it("repoints itself when the plugin root moves, without touching settings", () => {
    install.installEntry({ settingsFile });
    const before = readSettings().statusLine.command;

    const newRoot = path.join(sandbox, "v-next");
    fs.mkdirSync(path.join(newRoot, "hooks"), { recursive: true });
    const previous = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = newRoot;
    try {
      delete require.cache[require.resolve(INSTALL_LIB)];
      const moved = require(INSTALL_LIB);
      const result = moved.refreshShim();
      assert.equal(result.written, true);
      assert.ok(fs.readFileSync(result.path, "utf8").includes(newRoot));
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = previous;
      }
    }

    // The point of the indirection: the user's file did not change.
    assert.equal(readSettings().statusLine.command, before);
  });

  it("renders real state when launched with no plugin environment at all", () => {
    // The production invocation, which every other test in this file misses: a
    // status line is a command in the user's settings.json, not a hook, so Claude
    // Code launches it without CLAUDE_PLUGIN_DATA. If the shim does not supply it,
    // every state read returns null and the HUD shows a permanent unknown glyph
    // with no session behind it — indistinguishable from a down server.
    writeState({ connectionStatus: "ok", mcpConfigured: true, turnsSinceSearch: 3 });
    const { path: shim } = install.refreshShim();

    const bare = { ...process.env };
    delete bare.CLAUDE_PLUGIN_DATA;
    delete bare.CLAUDE_PLUGIN_ROOT;
    delete bare.COLUMNS;

    const result = spawnSync(process.execPath, [shim], {
      input: JSON.stringify(PAYLOAD),
      encoding: "utf8",
      env: bare,
    });
    assert.equal(result.status, 0, `shim exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /🟢/, "should find the session record through the shim");
    assert.match(result.stdout, /↺3/, "should read session counters, not just defaults");
  });

  it("lets a plugin environment that is already set win", () => {
    // Defensive: if a future platform does set the variable for status lines, its
    // answer is better than the shim's guess and must not be clobbered.
    const { path: shim } = install.refreshShim();
    assert.match(
      fs.readFileSync(shim, "utf8"),
      /process\.env\.CLAUDE_PLUGIN_DATA = process\.env\.CLAUDE_PLUGIN_DATA \|\| __dirname;/
    );
  });

  it("writes a shim that survives a Windows-shaped path", () => {
    // JSON.stringify rather than hand-quoting: a raw C:\Users\... path in a template
    // literal is a string full of escape sequences.
    const quoted = install.shimContents("C:\\Users\\dev\\plugin\\hooks\\statusline.cjs");
    assert.ok(quoted.includes("C:\\\\Users\\\\dev"));
  });
});

describe("installing the HUD", () => {
  it("adds the statusLine key and reports it", () => {
    writeSettings({ model: "opus" });
    const result = install.installEntry({ settingsFile });
    assert.equal(result.ok, true);
    assert.equal(result.status, "installed");
    assert.equal(readSettings().statusLine.type, "command");
  });

  it("points settings at the stable shim, never at the versioned renderer", () => {
    writeSettings({});
    install.installEntry({ settingsFile });
    const command = readSettings().statusLine.command;
    assert.ok(command.includes(install.shimPath()));
    assert.ok(!command.includes(install.rendererPath()));
  });

  it("sets a refresh interval, because the probe lands after the first render", () => {
    writeSettings({});
    install.installEntry({ settingsFile });
    assert.equal(readSettings().statusLine.refreshInterval, install.REFRESH_INTERVAL_SECONDS);
  });

  it("preserves every other setting", () => {
    writeSettings({ model: "opus", permissions: { allow: ["Bash(ls:*)"] } });
    install.installEntry({ settingsFile });
    const after = readSettings();
    assert.equal(after.model, "opus");
    assert.deepEqual(after.permissions.allow, ["Bash(ls:*)"]);
  });

  it("creates the file when there is none", () => {
    const result = install.installEntry({ settingsFile });
    assert.equal(result.status, "created");
    assert.ok(readSettings().statusLine);
  });

  it("is idempotent", () => {
    writeSettings({});
    install.installEntry({ settingsFile });
    const again = install.installEntry({ settingsFile });
    assert.equal(again.ok, true);
    assert.equal(again.status, "already-installed");
  });

  it("backs the original up before rewriting it", () => {
    writeSettings({ model: "opus" });
    install.installEntry({ settingsFile, now: 1_700_000_000_000 });
    const backup = path.join(dataDir, "migrations", "settings-backup-1700000000000.json");
    assert.ok(fs.existsSync(backup));
    // The whole file verbatim: backing up only the changed key would still lose
    // the file if the rewrite went wrong.
    assert.match(JSON.parse(fs.readFileSync(backup, "utf8")).original, /"model": "opus"/);
  });
});

describe("what installing must refuse to do", () => {
  it("never overwrites a status line someone else wrote", () => {
    // Losing a customised HUD to a plugin command would be worse than the bug this
    // fixes. Chaining to it is the 2.x passthrough design that fork-bombed machines.
    writeSettings({ statusLine: { type: "command", command: "npx -y ccstatusline@latest" } });
    const result = install.installEntry({ settingsFile });
    assert.equal(result.ok, false);
    assert.equal(result.status, "foreign");
    assert.equal(readSettings().statusLine.command, "npx -y ccstatusline@latest");
  });

  it("never overwrites a status line it cannot make sense of", () => {
    // A shape with no usable command is still a shape somebody chose. Reading it as
    // an empty slot would overwrite the one case where we have least idea what we
    // are destroying.
    for (const statusLine of [
      { type: "command", command: "" },
      { type: "command" },
      { type: "something-this-version-has-never-seen", script: "~/mine.sh" },
      "npx -y ccstatusline@latest",
    ]) {
      writeSettings({ statusLine });
      const result = install.installEntry({ settingsFile });
      assert.equal(result.ok, false, `should refuse ${JSON.stringify(statusLine)}`);
      assert.equal(result.status, "foreign");
      assert.deepEqual(readSettings().statusLine, statusLine);
    }
  });

  it("still installs over a null status line, which holds nothing to lose", () => {
    writeSettings({ statusLine: null, model: "opus" });
    const result = install.installEntry({ settingsFile });
    assert.equal(result.ok, true);
    assert.ok(install.isOurStatusLine(readSettings().statusLine.command));
    assert.equal(readSettings().model, "opus");
  });

  it("never rewrites a settings file it could not parse", () => {
    // Turning a syntax error someone can fix into data loss they cannot is worse
    // than a status line that does not appear.
    fs.writeFileSync(settingsFile, "{ definitely not json");
    const result = install.installEntry({ settingsFile });
    assert.equal(result.ok, false);
    assert.equal(result.status, "settings-unreadable");
    assert.equal(fs.readFileSync(settingsFile, "utf8"), "{ definitely not json");
  });

  it("refuses when there is no data dir to put a stable path in", () => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete require.cache[require.resolve(INSTALL_LIB)];
    const homeless = require(INSTALL_LIB);
    const result = homeless.installEntry({ settingsFile });
    assert.equal(result.ok, false);
    assert.equal(result.status, "no-data-dir");
    assert.ok(!fs.existsSync(settingsFile));
  });
});

describe("removing the HUD", () => {
  it("takes ours away and leaves everything else", () => {
    writeSettings({ model: "opus" });
    install.installEntry({ settingsFile });
    const result = install.removeEntry({ settingsFile });
    assert.equal(result.ok, true);
    assert.equal(result.status, "removed");
    const after = readSettings();
    assert.equal(after.statusLine, undefined);
    assert.equal(after.model, "opus");
  });

  it("never claims a status line this plugin did not write", () => {
    writeSettings({ statusLine: { type: "command", command: "~/.claude/my-own.sh" } });
    const result = install.removeEntry({ settingsFile });
    assert.equal(result.ok, false);
    assert.equal(result.status, "foreign");
    assert.equal(readSettings().statusLine.command, "~/.claude/my-own.sh");
  });

  it("leaves alone a status line it cannot make sense of", () => {
    // Same predicate as install, so the two cannot drift apart: unrecognised means
    // someone else's, and removal reports that rather than shrugging it off as
    // nothing-to-do.
    writeSettings({ statusLine: { type: "command", command: "" } });
    const result = install.removeEntry({ settingsFile });
    assert.equal(result.ok, false);
    assert.equal(result.status, "foreign");
    assert.deepEqual(readSettings().statusLine, { type: "command", command: "" });
  });

  it("is idempotent, and quiet when there was nothing to remove", () => {
    writeSettings({ model: "opus" });
    assert.equal(install.removeEntry({ settingsFile }).status, "not-installed");
  });

  it("succeeds when there is no settings file at all", () => {
    assert.equal(install.removeEntry({ settingsFile }).ok, true);
  });
});

describe("restoring a HUD the platform dropped (anthropics/claude-code#62486)", () => {
  /** Claude Code rewrites settings.json and drops keys it is not serialising. */
  function platformDropsTheKey() {
    const settings = readSettings();
    delete settings.statusLine;
    writeSettings(settings);
  }

  it("restores it when the user had consented", () => {
    writeSettings({ model: "opus" });
    install.installEntry({ settingsFile });
    platformDropsTheKey();

    const result = install.reassertEntry({ consented: true, settingsFile });
    assert.equal(result.restored, true);
    assert.ok(readSettings().statusLine);
  });

  it("does nothing at all without consent", () => {
    // The load-bearing guard. Without it this is a hook configuring the user's
    // settings unasked, which is exactly what GP-863 deleted.
    writeSettings({ model: "opus" });
    const result = install.reassertEntry({ consented: false, settingsFile });
    assert.equal(result.restored, false);
    assert.equal(result.status, "no-consent");
    assert.equal(readSettings().statusLine, undefined);
  });

  it("does nothing when the entry is already there", () => {
    writeSettings({});
    install.installEntry({ settingsFile });
    assert.equal(install.reassertEntry({ consented: true, settingsFile }).status, "present");
  });

  it("stands down when the user has since installed their own", () => {
    // A newer choice than the stored consent, and it wins.
    writeSettings({ statusLine: { type: "command", command: "npx -y ccstatusline@latest" } });
    const result = install.reassertEntry({ consented: true, settingsFile });
    assert.equal(result.restored, false);
    assert.equal(result.status, "foreign");
    assert.equal(readSettings().statusLine.command, "npx -y ccstatusline@latest");
  });

  it("stands down on a settings file it cannot parse", () => {
    fs.writeFileSync(settingsFile, "{ nope");
    const result = install.reassertEntry({ consented: true, settingsFile });
    assert.equal(result.restored, false);
    assert.equal(result.status, "settings-unreadable");
    assert.equal(fs.readFileSync(settingsFile, "utf8"), "{ nope");
  });
});

describe("the /gutt-pro:statusline command surface", () => {
  /**
   * Run a typed command in a child process against a synthetic HOME.
   *
   * A child, and a real HOME override, because this is the one path that resolves
   * the settings file itself rather than being handed one — and that resolution is
   * exactly what a test of the command surface has to cover.
   *
   * @param {string} typed
   * @returns {string} the outcome text injected alongside the command
   */
  function runCommand(typed) {
    const home = path.join(sandbox, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const cc = require(${JSON.stringify(path.join(ROOT, "gutt-core", "hooks", "lib", "config-command.cjs"))});
         const r = cc.configCommandResult(process.argv[1], "s1", Date.now());
         process.stdout.write(r == null ? "" : String(r));`,
        typed,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dataDir } }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  /** The settings file the command resolves for itself. */
  function homeSettings() {
    return path.join(sandbox, "home", ".claude", "settings.json");
  }

  it("installs, reports, and removes across a full round trip", () => {
    assert.match(runCommand("/gutt-pro:statusline status"), /not installed/);
    assert.match(runCommand("/gutt-pro:statusline"), /installed in/);
    assert.ok(fs.existsSync(homeSettings()));

    assert.match(runCommand("/gutt-pro:statusline"), /already installed/);
    assert.match(runCommand("/gutt-pro:statusline status"), /is installed/);

    assert.match(runCommand("/gutt-pro:statusline off"), /removed/);
    assert.match(runCommand("/gutt-pro:statusline status"), /not installed/);
  });

  it("records consent on install and withdraws it on removal", () => {
    // Withdrawal matters as much as the record: a stale flag would have the next
    // session helpfully reinstalling what the user just removed.
    runCommand("/gutt-pro:statusline");
    const configPath = path.join(dataDir, "config.json");
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).statusline.installed, true);

    runCommand("/gutt-pro:statusline off");
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).statusline.installed, false);
  });

  it("names the forms rather than silently ignoring an unknown argument", () => {
    const out = runCommand("/gutt-pro:statusline nonsense");
    assert.match(out, /did not recognise/);
    assert.match(out, /Nothing was changed/);
  });
});

describe("the async SessionStart hook maintains the HUD", () => {
  /** Run session-connectivity.cjs against the sandbox. */
  function runHook(home) {
    return spawnSync(
      process.execPath,
      [path.join(ROOT, "gutt-core", "hooks", "session-connectivity.cjs")],
      {
        input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }),
        encoding: "utf8",
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dataDir },
      }
    );
  }

  it("writes the shim so an upgraded plugin repairs its own entry point", () => {
    const home = path.join(sandbox, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    assert.equal(runHook(home).status, 0);
    assert.ok(fs.existsSync(path.join(dataDir, "statusline.cjs")));
  });

  it("restores an entry the platform dropped, but only with consent on file", () => {
    const home = path.join(sandbox, "home");
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ model: "opus" }, null, 2));

    // No consent yet: the hook must leave the file alone.
    assert.equal(runHook(home).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine, undefined);

    // The user asks for it, then Claude Code drops the key mid-session (#62486).
    install.installEntry({ settingsFile: settings });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ statusline: { installed: true } })
    );
    const dropped = JSON.parse(fs.readFileSync(settings, "utf8"));
    delete dropped.statusLine;
    fs.writeFileSync(settings, JSON.stringify(dropped, null, 2));

    assert.equal(runHook(home).status, 0);
    assert.ok(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine);
  });

  it("exits 0 even when the settings file is unreadable", () => {
    // A hook that throws is a hook that broke the user's session.
    const home = path.join(sandbox, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json");
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ statusline: { installed: true } })
    );
    assert.equal(runHook(home).status, 0);
  });
});

describe("recognising our own status line", () => {
  it("accepts the shapes this plugin has written", () => {
    assert.equal(install.isOurStatusLine('node "/x/y/statusline.cjs"'), true);
    // The 2.x basename, so an upgrade recognises what the old version installed.
    assert.equal(install.isOurStatusLine('node "/x/y/gutt-statusline.cjs"'), true);
  });

  it("rejects everything else", () => {
    assert.equal(install.isOurStatusLine("npx -y ccstatusline@latest"), false);
    assert.equal(install.isOurStatusLine("~/.claude/statusline.sh"), false);
    assert.equal(install.isOurStatusLine(""), false);
    assert.equal(install.isOurStatusLine(null), false);
    assert.equal(install.isOurStatusLine(undefined), false);
    assert.equal(install.isOurStatusLine(42), false);
  });

  it("classifies the slot the same way for every caller", () => {
    // install, remove and the SessionStart re-assert all ask this one function, so
    // there is no shape any of them can read differently from the others.
    const ours = { statusLine: { type: "command", command: 'node "/x/statusline.cjs"' } };
    assert.equal(install.classifyStatusLine(ours), "ours");
    assert.equal(install.classifyStatusLine({}), "absent");
    assert.equal(install.classifyStatusLine(null), "absent");
    assert.equal(install.classifyStatusLine({ statusLine: null }), "absent");
    assert.equal(install.classifyStatusLine({ statusLine: {} }), "foreign");
    assert.equal(install.classifyStatusLine({ statusLine: { command: "" } }), "foreign");
    assert.equal(install.classifyStatusLine({ statusLine: "a string" }), "foreign");
  });

  it("reports an unreadable shape as foreign to the re-assert path too", () => {
    // Otherwise #62486 repair would read the slot as free and write over it.
    writeSettings({ statusLine: { type: "command" } });
    assert.deepEqual(install.entryPresent(settingsFile), {
      present: false,
      known: true,
      foreign: true,
    });
    assert.equal(install.reassertEntry({ consented: true, settingsFile }).status, "foreign");
  });
});
