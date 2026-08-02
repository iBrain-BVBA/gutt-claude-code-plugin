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
const command = require(path.join(ROOT, "gutt-core", "hooks", "lib", "config-command.cjs"));

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
 * @param {string} [opts.groupId] GUTT_GROUP_ID for this run; omitted means unset
 * @returns {string} the rendered line
 */
function render(payload = {}, { raw, columns, groupId, preload } = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  if (columns === undefined) {
    delete env.COLUMNS;
  } else {
    env.COLUMNS = String(columns);
  }
  // Always decided here, never inherited: a developer with GUTT_GROUP_ID exported
  // would otherwise see different output from CI for every group-sensitive case.
  if (groupId === undefined) {
    delete env.GUTT_GROUP_ID;
  } else {
    env.GUTT_GROUP_ID = groupId;
  }
  const result = spawnSync(
    process.execPath,
    [...(preload ? ["--require", preload] : []), STATUSLINE],
    {
      input: raw !== undefined ? raw : JSON.stringify(payload),
      encoding: "utf8",
      env,
    }
  );
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

/** Read back the session record a hook wrote. */
function readSessionState(sessionId = "s1") {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "sessions", `${sessionId}.json`), "utf8"));
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

/**
 * The standard payload Claude Code sends a status line.
 *
 * `cost` is here on purpose although nothing renders it: the platform hands it over
 * for free, which is exactly why a future reader would put it back, and the tests
 * below pin the omission against that rather than leaving it to a comment.
 */
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

  it("keeps trusting a successful call however long ago it happened", () => {
    // Observations do not age out while the tool list corroborates them. A session
    // that has not touched memory for half an hour is an ordinary session, not a
    // broken one, and reporting it as unknown put the HUD in a warning state with
    // nothing wrong and nothing for the user to do. What makes that safe is the tool
    // list, which is rewritten every prompt and outranks this — a server that has
    // actually gone is caught there.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      mcpToolsAvailable: "available",
      connectionObservedAt: minutesAgo(30),
    });
    assert.match(render(PAYLOAD), /🟢/);
  });

  it("stops trusting an old success once nothing corroborates it", () => {
    // The tool list abstains for a reason that is not rare: past the transcript scan
    // cap a long session answers "unknown" on every prompt, which overwrites any
    // stored reading. Without this the pre-drop success would then speak for the
    // server for the rest of the session, and the HUD would sit on a confident green
    // over a connection that is gone. Green is the one verdict that has to keep
    // earning itself, so it is the one that lapses.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      mcpToolsAvailable: "unknown",
      connectionObservedAt: minutesAgo(30),
    });
    assert.match(render(PAYLOAD), /⚪/);
  });

  it("keeps an uncorroborated success while it is still fresh", () => {
    // The lapse is about age, not about the absence of a reading — a call that came
    // back a minute ago is evidence whatever the tool list can or cannot say.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      mcpToolsAvailable: "unknown",
      connectionObservedAt: minutesAgo(2),
    });
    assert.match(render(PAYLOAD), /🟢/);
  });

  it("leaves a warning standing even when nothing corroborates it", () => {
    // Asymmetric on purpose. A stale warning costs one needless check; a stale green
    // costs a memory system that stopped working behind a HUD still saying it had
    // not. Withdrawing the warning would also delete the one instruction the user
    // could act on.
    writeState({
      connectionStatus: "error",
      mcpConfigured: true,
      mcpToolsAvailable: "unknown",
      connectionObservedAt: minutesAgo(90),
    });
    assert.match(render(PAYLOAD), /🔴/);
  });

  it("still reports a dropped server, however recent the last success", () => {
    // The guarantee that replaces ageing: the tool list is checked first, so removing
    // the expiry did not make a dead server render as healthy.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      connectionObservedAt: minutesAgo(1),
      mcpToolsAvailable: "absent",
    });
    const line = render(PAYLOAD);
    assert.doesNotMatch(line, /🟢/);
    assert.match(line, /🟡/);
    assert.match(line, /\bauth\b/);
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

  it("shows amber when the server offers only its sign-in affordance", () => {
    // The state a never-authenticated connector sits in, and the one no round trip
    // can report: the tools that would prove anything are the ones missing, so
    // `connectionStatus` never moves off its initial value. Before this was read from
    // the tool list, the HUD showed green for the entire session.
    writeState({ mcpConfigured: true, mcpToolsAvailable: "auth" });
    const line = render(PAYLOAD);
    assert.match(line, /🟡/);
    assert.match(line, /\bauth\b/);
  });

  it("keeps saying auth however long the sign-in has been outstanding", () => {
    // Deliberately not subject to the observation TTL. The TTL exists because a
    // remembered round trip goes stale; "the tool list currently contains only a
    // sign-in tool" is a statement about now, and it does not decay. An unauthenticated
    // server that went quiet is still unauthenticated.
    writeState({
      mcpConfigured: true,
      mcpToolsAvailable: "auth",
      connectionObservedAt: minutesAgo(90),
    });
    const line = render(PAYLOAD);
    assert.match(line, /🟡/);
    assert.match(line, /\bauth\b/);
  });

  it("never shows green while the tool list says a sign-in is outstanding", () => {
    // The rule with teeth: green means at least one gutt server is connected *now*.
    // A round trip that succeeded a minute ago is not that — it is a memory of a
    // server that has since asked to be signed in again, and the tool list is the
    // only one of the two signals describing the present.
    writeState({
      connectionStatus: "ok",
      mcpConfigured: true,
      connectionObservedAt: minutesAgo(1),
      mcpToolsAvailable: "auth",
    });
    const line = render(PAYLOAD);
    assert.doesNotMatch(line, /🟢/);
    assert.match(line, /🟡/);
  });

  it("lets a real tool arriving clear the sign-in state", () => {
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

  it("renders the sign-in notice as a trailing clause, verbatim", () => {
    // Pinned as a literal because the wording is the point: the glyph carries the
    // alarm, this carries the instruction, and it goes last so it survives narrowing
    // and reads as a sentence rather than as one more terse label.
    writeState({ mcpConfigured: true, mcpToolsAvailable: "absent" });
    const segment = render(PAYLOAD).match(/\[gutt[^\]]*\]/)[0];
    assert.equal(segment, "[gutt 🟡 on - auth needed!]");
  });

  it("keeps the sign-in clause after the group, so narrowing cannot strand it", () => {
    // The group drops at narrow widths and this never does. Were the clause pushed
    // first, a wide terminal would read "...auth needed! acme-eng" — the alert
    // stranded mid-segment with the group after it.
    writeState({ mcpConfigured: true, mcpToolsAvailable: "absent" });
    const segment = render(PAYLOAD, { groupId: "acme-eng" }).match(/\[gutt[^\]]*\]/)[0];
    assert.equal(segment, "[gutt 🟡 on acme-eng - auth needed!]");
  });

  it("keeps red for a call that came back a non-auth failure", () => {
    // Red now means only what a real round trip can establish — the server answered,
    // and answered with something signing in would not fix.
    writeState({
      connectionStatus: "error",
      mcpConfigured: true,
      mcpToolsAvailable: "available",
    });
    const line = render(PAYLOAD);
    assert.match(line, /🔴/);
    assert.doesNotMatch(line, /\bauth\b/);
  });

  it("does not call it a disconnection when no server was ever configured", () => {
    // Absent tools are unremarkable with nothing configured — `!` is the signal
    // there, and red would be telling the user something broke that never existed.
    writeState({ mcpConfigured: false, mcpToolsAvailable: "absent" });
    const line = render(PAYLOAD);
    assert.match(line, /⚪/);
    assert.match(line, /!/);
  });

  // The three spellings of "not a denial", which the render must treat alike. Only a
  // probe that ran and came back negative may suppress the sign-in prompt; a probe
  // that threw (null) and a probe that has not landed yet (undefined) may not, and
  // `!== false` is what tells the three apart. Written as `mcpConfigured` alone it is
  // a truthiness test, and both of these fall through to the branch reserved for a
  // server nobody configured — so the user whose connector genuinely needs signing in
  // gets a neutral glyph and no instruction at all.
  for (const [label, mcpConfigured] of [
    ["a probe that threw", null],
    ["a probe that has not landed", undefined],
  ]) {
    it(`still asks for sign-in after ${label}`, () => {
      writeState({ mcpConfigured, mcpToolsAvailable: "absent" });
      const segment = render(PAYLOAD).match(/\[gutt[^\]]*\]/)[0];
      assert.match(segment, /🟡/, `${label} must not be read as "nothing is configured"`);
      assert.match(segment, /auth needed!/);
    });
  }

  it("keeps the auth marker until something contradicts it", () => {
    // An outstanding sign-in does not become untrue by going unattended, so a
    // half-hour-old auth failure still reads as auth. It used to decay to neutral,
    // which quietly withdrew the one instruction the user could have acted on.
    writeState({ connectionStatus: "auth", connectionObservedAt: minutesAgo(30) });
    const line = render(PAYLOAD);
    assert.match(line, /🟡/);
    assert.match(line, /\bauth\b/);
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

  it("never shows recall recency, at any value of the counter", () => {
    // The counter is live — UserPromptSubmit gates the recall pointer on it — so this
    // is not the permanent-zero case above. It is the segment that counted correctly
    // and told the user nothing they would act on, and the state field remaining
    // populated is exactly why the omission needs pinning rather than assuming.
    for (const turnsSinceSearch of [null, 0, 3]) {
      writeState({ connectionStatus: "ok", mcpConfigured: true, turnsSinceSearch });
      assert.doesNotMatch(render(PAYLOAD), /↺/, `turnsSinceSearch: ${turnsSinceSearch}`);
    }
  });

  it("never shows session cost, however the payload reports it", () => {
    // An API price shown to someone on a subscription is a bill they will not be
    // charged. PAYLOAD still carries `cost` so this pins the omission against a
    // future reader reintroducing it as a freebie the platform already hands over.
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.doesNotMatch(render(PAYLOAD), /\$/);
    assert.doesNotMatch(render({ ...PAYLOAD, cost: { total_cost_usd: 9.99 } }), /9\.99/);
  });

  it("shows context-window usage as a whole percentage", () => {
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.match(render(PAYLOAD), /ctx 38%/);
    assert.match(render({ ...PAYLOAD, context_window: { used_percentage: 91 } }), /ctx 91%/);
  });

  it("rounds a fractional percentage rather than printing decimals", () => {
    // The bar redraws on a 300ms debounce; 38.4 and 38.6 are the same fact and the
    // difference is noise that costs width.
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.match(render({ ...PAYLOAD, context_window: { used_percentage: 38.6 } }), /ctx 39%/);
    assert.doesNotMatch(render({ ...PAYLOAD, context_window: { used_percentage: 38.6 } }), /\./);
  });

  it("shows a zero, which is a real reading on a fresh session", () => {
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.match(render({ ...PAYLOAD, context_window: { used_percentage: 0 } }), /ctx 0%/);
  });

  it("clamps a figure outside 0–100 instead of printing it", () => {
    // Out of range is a bug somewhere upstream, and rendering `ctx 4000%` reads as a
    // bug in the HUD — which is where the user would then go looking.
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    assert.match(render({ ...PAYLOAD, context_window: { used_percentage: 4000 } }), /ctx 100%/);
    assert.match(render({ ...PAYLOAD, context_window: { used_percentage: -7 } }), /ctx 0%/);
  });

  it("omits context usage rather than crashing on a malformed field", () => {
    // Same shape that took the HUD out through the cost segment. Arithmetic on this
    // payload is gated on Number.isFinite, so a bad field costs one segment, never
    // the line.
    writeState({ connectionStatus: "ok", mcpConfigured: true });
    for (const context_window of [null, "38", {}, { used_percentage: "38" }, { x: 1 }]) {
      const line = render({ ...PAYLOAD, context_window });
      assert.match(line, /\[gutt 🟢 on\]/, `context_window: ${JSON.stringify(context_window)}`);
      assert.doesNotMatch(line, /ctx/, `context_window: ${JSON.stringify(context_window)}`);
    }
  });
});

describe("the HUD degrades rather than wrapping", () => {
  beforeEach(() => writeState({ connectionStatus: "ok", mcpConfigured: true }));

  it("shows everything when the width is unknown", () => {
    // Guessing narrow would hide information from someone with a wide terminal.
    assert.equal(
      render(PAYLOAD, { groupId: "acme-eng" }),
      "[gutt 🟢 on acme-eng] | [Opus 5] ctx 38%"
    );
  });

  it("shows everything on a wide terminal", () => {
    assert.equal(
      render(PAYLOAD, { columns: 120, groupId: "acme-eng" }),
      "[gutt 🟢 on acme-eng] | [Opus 5] ctx 38%"
    );
  });

  it("drops context usage first, then the group", () => {
    // The two informational segments, least-valuable-first. Everything else either
    // reports a fault or names the fix, and none of that disappears on a narrow bar.
    assert.match(render(PAYLOAD, { columns: 80, groupId: "acme-eng" }), /ctx 38%/);
    assert.doesNotMatch(render(PAYLOAD, { columns: 52, groupId: "acme-eng" }), /ctx/);
    assert.match(render(PAYLOAD, { columns: 52, groupId: "acme-eng" }), /acme-eng/);
    assert.doesNotMatch(render(PAYLOAD, { columns: 30, groupId: "acme-eng" }), /acme-eng/);
  });

  it("truncates a long group rather than letting it take the whole bar", () => {
    // Every other case here uses an 8-character group, so the truncation branch was
    // reached by nothing: shortening the slice from 12 to 4 characters left the suite
    // green. Group ids are frequently long enough to matter.
    const long = "acme-engineering-platform-team";
    const line = render(PAYLOAD, { columns: 200, groupId: long });
    assert.doesNotMatch(line, new RegExp(long), "the full id must not be printed");
    assert.match(line, /acme-enginee\.\.\./, "the first 12 characters, then an ellipsis");
  });

  it("prints a group that fits in full", () => {
    // The boundary either side of 15 characters, so the threshold itself is pinned
    // and not just the branch.
    assert.match(render(PAYLOAD, { columns: 200, groupId: "fifteen-chars-x" }), /fifteen-chars-x/);
  });

  it("never drops the state segment, however narrow", () => {
    // Connection and suppression are the whole point of the HUD; if only one thing
    // fits it is this.
    assert.match(render(PAYLOAD, { columns: 20 }), /\[gutt 🟢 on\]/);
  });

  it("keeps the auth clause when the group has been dropped", () => {
    // The clause outranks the group by design, and a narrow terminal is exactly
    // where a user most needs to be told what to do rather than shown where.
    writeState({ mcpConfigured: true, mcpToolsAvailable: "auth" });
    assert.equal(
      render(PAYLOAD, { columns: 30, groupId: "acme-eng" }),
      "[gutt 🟡 on - auth needed!] | [Opus 5]"
    );
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

  it("renders each half of the tail without the other", () => {
    const state = { session_id: "s1" };
    assert.equal(
      render({ ...state, model: { display_name: "Opus 5" } }),
      "[gutt ⚪ on] | [Opus 5]"
    );
    assert.equal(
      render({ ...state, context_window: { used_percentage: 12 } }),
      "[gutt ⚪ on] | ctx 12%"
    );
  });

  it("omits the tail entirely when the payload reports neither", () => {
    // Cost no longer earns the separator on its own: with nothing printable after it,
    // a bare `| [unknown]` was width spent on the absence of information.
    assert.doesNotMatch(render({ session_id: "s1" }), /\|/);
    assert.doesNotMatch(render({ session_id: "s1", cost: { total_cost_usd: 1.24 } }), /\|/);
  });

  it("says it broke, rather than sitting on the glyph for 'nothing observed'", () => {
    // The outer net catches a corrupt session record, a config that will not parse,
    // and a plain bug in the renderer. Reporting all three as ⚪ made a renderer that
    // fails on every one of the hundreds of invocations in a session look exactly like
    // a quiet healthy one — and left no trace, so the file's only diagnostic surface
    // was mute about the only thing it exists to catch.
    //
    // Forced by poisoning a dependency rather than by finding a bad input: the point
    // is to cover the failures nobody predicted, so the test must not depend on
    // predicting one.
    const poison = path.join(sandbox, "poison-render.cjs");
    const module = path.join(ROOT, "gutt-core", "hooks", "lib", "runtime-config.cjs");
    fs.writeFileSync(
      poison,
      `const t = require.resolve(${JSON.stringify(module)});\n` +
        `require(t);\n` +
        `require.cache[t].exports.readConfig = () => { throw new Error("boom"); };\n`
    );
    const line = render(PAYLOAD, { preload: poison });
    assert.match(line, /\[gutt/, "a status line that prints nothing is the original sin here");
    assert.match(line, /⚠/, "and it must not be mistakable for a healthy session");
    assert.doesNotMatch(line, /⚪/, "⚪ means 'nothing observed yet' and must keep meaning it");

    const log = path.join(dataDir, "hook-errors.log");
    assert.ok(fs.existsSync(log), "the reason must be recoverable afterwards");
    assert.match(fs.readFileSync(log, "utf8"), /boom/);
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
    assert.equal(result.status, "written");
    const shim = fs.readFileSync(result.path, "utf8");
    assert.match(shim, /require\(/);
    assert.ok(shim.includes(JSON.stringify(result.target)));
  });

  it("exits quietly when the renderer it points at is gone", () => {
    // The shim outlives what it points at: uninstalling deletes the renderer, and a
    // half-finished update moves it. Unguarded, the status bar becomes a repeating
    // module-not-found trace from a plugin that may not even be installed any more.
    //
    // Pointed at a throwaway root, never the real one. `rendererPath()` resolves
    // from CLAUDE_PLUGIN_ROOT or, absent it, from the module's own location — which
    // in this suite is the working tree. A test that deletes its own repository's
    // renderer is one line away, and this comment is here so nobody writes it again.
    const missingRoot = path.join(sandbox, "uninstalled");
    const previous = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = missingRoot;
    try {
      delete require.cache[require.resolve(INSTALL_LIB)];
      const gone = require(INSTALL_LIB);
      const { path: shim, target } = gone.refreshShim();
      assert.ok(!fs.existsSync(target), "the renderer must not exist for this case");
      const run = spawnSync(process.execPath, [shim], { input: "{}", encoding: "utf8" });
      assert.equal(run.status, 0, `shim exited ${run.status}: ${run.stderr}`);
      assert.doesNotMatch(run.stderr, /Cannot find module/);
      // Quietly, which is the half of this the asserts above do not cover. The shim
      // also has a *loud* path, for a renderer that is present and will not load, and
      // nothing stopped that firing here too: an uninstalled plugin would then print
      // "statusline failed to load" on every refresh, several times a second, from
      // something the user deliberately removed. Silence is the whole point of this
      // branch and has to be asserted, not assumed.
      assert.equal(run.stdout.trim(), "", "an uninstalled plugin must say nothing at all");
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = previous;
      }
      delete require.cache[require.resolve(INSTALL_LIB)];
      install = require(INSTALL_LIB);
    }
  });

  it("says so, loudly, when the renderer is there and will not load", () => {
    // The other failure that lands in the shim's catch, and the one silence is wrong
    // for. A renderer that is *present* and throws is a bug — a half-finished update,
    // a missing transitive require, or a checkout that mangled the file, which is
    // exactly how 3.0.0 shipped dead on Windows and went a release without anyone
    // noticing, because a blank bar looks like a plugin nobody installed.
    const brokenRoot = path.join(sandbox, "broken-version");
    fs.mkdirSync(path.join(brokenRoot, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(brokenRoot, "hooks", "statusline.cjs"),
      "this is not valid javascript ((("
    );
    const previous = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = brokenRoot;
    try {
      delete require.cache[require.resolve(INSTALL_LIB)];
      const broken = require(INSTALL_LIB);
      const { path: shim } = broken.refreshShim();
      const run = spawnSync(process.execPath, [shim], { input: "{}", encoding: "utf8" });
      assert.equal(run.status, 0, "still never a non-zero exit — nobody reads it");
      assert.match(run.stdout, /statusline failed to load/, "a broken renderer must not be silent");
      // And the reason is recoverable, which silence never leaves behind.
      const log = path.join(dataDir, "hook-errors.log");
      assert.ok(fs.existsSync(log), "the reason must be written down somewhere");
      assert.match(fs.readFileSync(log, "utf8"), /statusline-shim/);
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = previous;
      }
      delete require.cache[require.resolve(INSTALL_LIB)];
      install = require(INSTALL_LIB);
    }
  });

  it("does not rewrite when nothing moved", () => {
    install.refreshShim();
    assert.equal(install.refreshShim().status, "current");
  });

  it("follows the shim's own target when asked whether the HUD resolves", () => {
    // The question is "does what is installed actually run", and the only thing that
    // knows what is installed is the shim on disk. Checking `rendererPath()` instead
    // answers a different question — is *this* version's renderer present — whose
    // answer is yes in essentially every circumstance where there is a command around
    // to ask, including the one circumstance that matters.
    install.refreshShim();
    assert.deepEqual(install.shimResolves(), { shim: true, current: true, renderer: true });

    // A shim left behind by a version whose directory has since been removed: it reads
    // fine, it is not this version's, and nothing starts from it.
    const stale = path.join(sandbox, "v-old", "hooks", "statusline.cjs");
    fs.writeFileSync(install.shimPath(), install.shimContents(stale));
    assert.deepEqual(install.shimResolves(), { shim: true, current: false, renderer: false });

    // And one pointing at a real renderer from an older version — stale, but working.
    // Reporting this as broken would send the user to fix a bar that is rendering.
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "// an older but perfectly loadable renderer\n");
    assert.deepEqual(install.shimResolves(), { shim: true, current: false, renderer: true });
  });

  it("reads the target out of shims it did not write", () => {
    // The entire reason to open the shim is to learn about shims *this* version did
    // not write — so a parser anchored on this version's exact formatting answers the
    // one case it exists for with "no target". That is not a harmless miss: it was
    // reported as a missing renderer, which is a claim about a file rather than about
    // our ability to read one, and it sent people to repair a bar that was rendering.
    const target = path.join(sandbox, "v-old", "hooks", "statusline.cjs");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// loadable\n");
    const json = JSON.stringify(target);

    const spellings = [
      `var TARGET = ${json};`,
      `const TARGET = ${json};`,
      `let TARGET  =  ${json}`,
      `  var TARGET = ${json};`,
      `require(${json});`, // the shape the first generated shim used
      `var TARGET = ${json.replace(/^"|"$/g, "'")};`, // single quotes
    ];
    for (const line of spellings) {
      fs.writeFileSync(install.shimPath(), `${line}\ntry { require(TARGET); } catch (e) {}\n`);
      const result = install.shimResolves();
      assert.equal(result.renderer, true, `must follow the target in: ${line}`);
      assert.equal(result.current, false, "and still know it is not this version's");
    }
  });

  it("says it could not tell, rather than claiming the renderer is gone", () => {
    // The distinction the tri-state exists for. "The file it names is missing" and "I
    // cannot work out what it names" have different remedies, and collapsing the
    // second into the first is how a working bar gets diagnosed as broken.
    fs.writeFileSync(install.shimPath(), "// nothing here names anything at all\n");
    assert.deepEqual(install.shimResolves(), { shim: true, current: false, renderer: null });
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
      assert.equal(result.status, "written");
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
    writeState({ connectionStatus: "ok", mcpConfigured: true });
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
    // Green is the proof: `defaultState()` has no connectionStatus, so ⚪ is what a
    // renderer that failed to find the record would print — and it is exactly the
    // failure this test exists to catch, since it looks identical to a down server.
    assert.match(result.stdout, /🟢/, "should find the session record through the shim");
    assert.doesNotMatch(result.stdout, /⚪/, "should not fall back to a default state");
  });

  it("lets a plugin environment that is already set win", () => {
    // Defensive: if a future platform does set the variable for status lines, its
    // answer is better than the shim's guess and must not be clobbered.
    //
    // Asserted by running the shim, not by pattern-matching its source. The old
    // version regexed the generated text for the assignment, which passes whether or
    // not the assignment does anything and breaks when the formatter changes a quote.
    const elsewhere = path.join(sandbox, "other-data");
    fs.mkdirSync(path.join(elsewhere, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(elsewhere, "sessions", "s1.json"),
      JSON.stringify({
        sessionId: "s1",
        connectionStatus: "error",
        connectionObservedAt: new Date().toISOString(),
        mcpConfigured: true,
      })
    );
    // A different, contradicting record in the shim's own directory. If the shim
    // overrode the environment, this is the one that would be read.
    writeState({ connectionStatus: "ok", mcpConfigured: true });

    const { path: shim } = install.refreshShim();
    const result = spawnSync(process.execPath, [shim], {
      input: JSON.stringify(PAYLOAD),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: elsewhere },
    });
    assert.equal(result.status, 0, `shim exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /🔴/, "the environment's data dir must win");
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
    const backup = path.join(
      dataDir,
      "migrations",
      "settings-backup-statusline-1700000000000.json"
    );
    assert.ok(fs.existsSync(backup));
    // The whole file verbatim: backing up only the changed key would still lose
    // the file if the rewrite went wrong.
    assert.match(JSON.parse(fs.readFileSync(backup, "utf8")).original, /"model": "opus"/);
  });
});

describe("what the backup sweep may delete", () => {
  /** The directory both backup writers share. */
  function backupDir() {
    return path.join(dataDir, "migrations");
  }

  it("keeps the newest few of its own and drops the rest", () => {
    for (let i = 1; i <= 8; i += 1) {
      writeSettings({ model: `v${i}` });
      install.installEntry({ settingsFile, now: 1_700_000_000_000 + i });
      // Put it back so the next install is a real change and takes a fresh backup.
      writeSettings({ model: `v${i}` });
    }
    const kept = fs
      .readdirSync(backupDir())
      .filter((n) => n.startsWith("settings-backup-"))
      .sort();
    assert.equal(kept.length, 5, `expected five, got ${kept.join(", ")}`);
    assert.equal(kept.at(-1), "settings-backup-statusline-1700000000008.json", "newest survives");
  });

  it("keeps the newest by time, not by spelling", () => {
    // Real epoch-ms is 13 digits and stays that way until 2286, so a lexicographic
    // sort agrees with a numeric one by accident — and an accident like that holds
    // silently until the first caller passes a small `now`, where "10" sorts before
    // "2" and the sweep keeps the oldest and deletes the newest. Single digits either
    // side of the width change are what pin the ordering itself rather than the widths
    // that happen to be in use.
    for (let now = 1; now <= 12; now += 1) {
      writeSettings({ model: `v${now}` });
      install.installEntry({ settingsFile, now });
      writeSettings({ model: `v${now}` });
    }
    const kept = fs
      .readdirSync(backupDir())
      .filter((n) => n.startsWith("settings-backup-statusline-"))
      .map((n) => Number(/(\d+)\.json$/.exec(n)[1]))
      .sort((a, b) => a - b);
    assert.deepEqual(kept, [8, 9, 10, 11, 12], "the five newest, by time");
  });

  it("never touches the migration's copy, which may be the only one from before 3.x", () => {
    // Same directory, same `settings-backup-` prefix, entirely different job: the 2.x
    // migration takes one copy of settings.json before rewriting it, and that copy can
    // be the last image of the file from before the upgrade. Under a shared name the
    // sweep could not tell the two apart — and since this path runs about once per
    // session on the platforms the repair exists for, the irreplaceable copy was
    // evicted within five sessions by newer copies of something else.
    fs.mkdirSync(backupDir(), { recursive: true });
    const migration = path.join(backupDir(), "settings-backup-1600000000000.json");
    fs.writeFileSync(migration, JSON.stringify({ migratedAt: "old", original: "{}" }));

    for (let i = 1; i <= 8; i += 1) {
      writeSettings({ model: `v${i}` });
      install.installEntry({ settingsFile, now: 1_700_000_000_000 + i });
      writeSettings({ model: `v${i}` });
    }

    assert.ok(
      fs.existsSync(migration),
      "the oldest file in the directory is the one that must not be swept"
    );
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

  it("never rewrites a settings file that is valid JSON but not an object", () => {
    // `[]`, `42` and `"str"` all parse. None is something a key can be added to, and
    // treating any of them as an empty object would replace the file wholesale with
    // one containing only our key. Deleting the guard was invisible to the suite.
    for (const raw of ["[]", "42", '"a string"', "null"]) {
      fs.writeFileSync(settingsFile, raw);
      const result = install.installEntry({ settingsFile });
      assert.equal(result.ok, false, `${raw} must be refused`);
      assert.equal(result.status, "settings-unreadable", `${raw} must read as unreadable`);
      assert.equal(fs.readFileSync(settingsFile, "utf8"), raw, `${raw} must be left alone`);
    }
  });

  it("says the file is missing, and where both copies are, when it could not be put back", () => {
    // The one outcome that must never be described as "nothing was changed". The
    // rename fallback unlinks the target before its second attempt, so a failure
    // there leaves settings.json absent — permissions, model, env, every other
    // plugin's config. The temp file is then the only copy and is deliberately left
    // on disk rather than cleaned up; a message that does not name it is the
    // difference between a rename and a rebuild.
    const lost = install.writeFailure(
      "/home/u/.claude/settings.json",
      { ok: false, orphan: "/home/u/.claude/settings.json.gutt-statusline.99" },
      "/data/migrations/settings-backup-1.json"
    );
    assert.equal(lost.ok, false);
    assert.equal(lost.status, "settings-lost");
    assert.match(lost.detail, /missing/);
    assert.match(lost.detail, /settings\.json\.gutt-statusline\.99/, "must name the replacement");
    assert.match(lost.detail, /settings-backup-1\.json/, "must name the backup");
    assert.doesNotMatch(lost.detail, /unchanged/, "the file was changed — it is gone");
  });

  it("still names the replacement when there is no backup to point at", () => {
    const lost = install.writeFailure("/s.json", { ok: false, orphan: "/s.json.tmp" }, null);
    assert.equal(lost.status, "settings-lost");
    assert.match(lost.detail, /s\.json\.tmp/);
  });

  it("names the backup when a write fails without losing the original", () => {
    // The harmless failure: the temp write never landed, so settings.json is exactly
    // as it was. The message has to say so — "could not write" on its own reads as
    // ambiguous at precisely the moment a user is deciding whether to panic.
    writeSettings({ model: "opus" });
    const before = fs.readFileSync(settingsFile, "utf8");
    const result = install.installEntry({
      settingsFile: path.join(sandbox, "no-such-dir", "s.json"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "write-failed");
    assert.match(result.detail, /unchanged/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
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

  it("carries the reason out with it, not just the label", () => {
    // This is the one caller of installEntry that runs with nobody watching, so it is
    // the one that can reach the whole-file loss path unattended. `status` alone is an
    // internal token — told only "settings-lost", the user has a word, while the
    // sentence naming where their settings actually went dies in a local variable.
    // Nothing reconstructs it later: by then settings.json is simply absent, and a
    // fresh install takes the "no file, create one" branch and reports plain success.
    //
    // Provoked through the backup, which is the first thing `installEntry` does that
    // can fail with something worth saying: a plain file where the backup directory
    // has to go means `mkdir` cannot run, so nothing is rewritten and the reason is
    // the whole of what the user gets.
    writeSettings({ model: "opus" });
    fs.writeFileSync(path.join(dataDir, "migrations"), "not a directory");
    const failed = install.reassertEntry({ consented: true, settingsFile });
    assert.equal(failed.restored, false);
    assert.equal(failed.status, "backup-failed");
    assert.match(failed.detail, /backup/, "the reason must survive the return");
    assert.equal(readSettings().statusLine, undefined, "and nothing may have been written");
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

  it("does not tell the user nothing happened when consent was withdrawn", () => {
    // `off` with no HUD installed used to answer "nothing changed" — flatly wrong for
    // its most likely caller, someone whose HUD the platform already dropped and who
    // typed this to stop it coming back. The durable flag deciding exactly that had
    // just been cleared: the one thing they wanted was the one thing they were told
    // had not occurred.
    const out = runCommand("/gutt-pro:statusline off");
    assert.doesNotMatch(out, /nothing changed/i);
    assert.match(out, /will not|do not want/i, "the reply must say the HUD stays away");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).statusline.installed,
      false
    );
  });

  it("never frames a lost settings.json as a file it did not change", () => {
    // The module was taught to distinguish "could not write it, it is unchanged" from
    // "could not write it and could not put it back" — and both callers then pasted
    // the same reassuring clause in front of either, so the losing case arrived as
    // "gutt did not change your settings: ... could not be put back — it is missing."
    // A user who reads six words and stops has been told their settings file is fine
    // at the moment it does not exist.
    const lost = { ok: false, status: "settings-lost", detail: "it is missing. Copy is at /tmp/x" };
    for (const lead of ["gutt did not change your settings", "gutt did not install the HUD"]) {
      const message = command.statuslineFailure(lead, lost);
      assert.doesNotMatch(message, /did not change|did not install/, `contradicted by: ${message}`);
      assert.match(message, /lost/, "the loss has to be the headline, not the footnote");
      assert.match(message, /Copy is at \/tmp\/x/, "and the remedy has to survive");
    }
    // The harmless case keeps its reassurance, which is what makes the other one mean
    // something.
    const unchanged = { ok: false, status: "write-failed", detail: "it is unchanged." };
    assert.match(
      command.statuslineFailure("gutt did not change your settings", unchanged),
      /^gutt did not change your settings: /
    );
  });

  it("names the forms rather than silently ignoring an unknown argument", () => {
    const out = runCommand("/gutt-pro:statusline nonsense");
    assert.match(out, /did not recognise/);
    assert.match(out, /Nothing was changed/);
  });

  it("writes nothing at all for a bare /statusline", () => {
    // Claude Code owns `/statusline`, and this surface reads prompt text rather than
    // routing — so without the namespaced-only guard a prompt aimed at the built-in
    // would install the HUD into the user's settings.json. The strongest available
    // assertion is that the file was never created: it does not exist until something
    // writes it, so its absence proves no write was attempted rather than merely
    // proving the content came out unchanged.
    for (const typed of ["/statusline", "/statusline off", "/statusline status"]) {
      assert.equal(runCommand(typed), "", typed);
      assert.equal(fs.existsSync(homeSettings()), false, typed);
    }
    // And no consent was recorded, which is what would have a later session install it.
    const configPath = path.join(dataDir, "config.json");
    assert.equal(fs.existsSync(configPath), false);
  });
});

describe("the async SessionStart hook maintains the HUD", () => {
  /**
   * Run session-connectivity.cjs against the sandbox.
   *
   * `preload` is a `--require` script, which runs before the hook loads and can
   * therefore replace an export the hook destructures at load time. It is the only way
   * to reach the whole-file loss outcome: that is produced by a `rename` onto an
   * existing file failing with EPERM after the target has already been unlinked, which
   * no arrangement of files provokes on POSIX. The behaviour under test here is not
   * the rename — it is what this hook does with the outcome.
   */
  function runHook(home, preload) {
    return spawnSync(
      process.execPath,
      [
        ...(preload ? ["--require", preload] : []),
        path.join(ROOT, "gutt-core", "hooks", "session-connectivity.cjs"),
      ],
      {
        input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" }),
        encoding: "utf8",
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dataDir },
      }
    );
  }

  /** A `--require` script forcing the repair to report a lost settings.json. */
  function forceSettingsLost(detail) {
    const file = path.join(sandbox, "force-lost.cjs");
    fs.writeFileSync(
      file,
      `const t = require.resolve(${JSON.stringify(INSTALL_LIB)});\n` +
        `require(t);\n` +
        `require.cache[t].exports.reassertEntry = () => ({\n` +
        `  restored: false, status: "settings-lost", detail: ${JSON.stringify(detail)},\n` +
        `});\n`
    );
    return file;
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

  it("says a lost settings.json out loud, on one line, without being asked", () => {
    // The only message on this hook that is not a courtesy. Everything else here
    // reports something the user can rediscover whenever they like; this reports that
    // their settings.json is gone and names the file holding its contents, and nothing
    // else says so unprompted — re-running the install finds no settings.json, takes
    // the "create one" branch, and reports plain success.
    const home = path.join(sandbox, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const detail = "it is missing. The replacement is at /tmp/settings.json.gutt.99";
    const r = runHook(home, forceSettingsLost(detail));

    assert.equal(r.status, 0, "even this must not fail the session");
    assert.match(r.stdout, /lost in the attempt/, "the loss must be announced");
    assert.match(r.stdout, /settings\.json\.gutt\.99/, "and the remedy must reach the user");
    // One line. A source hard-wrap inside a template literal puts a real newline in
    // the output, which splits the sentence across two lines in the transcript.
    const announced = r.stdout.split("\n").filter((line) => line.includes("lost in the attempt"));
    assert.equal(announced.length, 1);
    assert.match(announced[0], /settings\.json\.gutt\.99/, "the whole sentence on one line");
  });

  it("keeps the reason for a failed repair, not just its label", () => {
    // `status` is the surface that prints this, and it can only print what reached the
    // state file. The label alone is an internal token; the sentence naming where the
    // user's settings went is the entire remedy, and this is its only path there.
    const home = path.join(sandbox, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const detail = "it is missing. The replacement is at /tmp/settings.json.gutt.42";
    assert.equal(runHook(home, forceSettingsLost(detail)).status, 0);

    const recorded = readSessionState().statuslineReassert;
    assert.equal(recorded.status, "settings-lost");
    assert.equal(recorded.detail, detail, "the reason must survive into state");
  });

  it("records why the shim could not be repointed, and says so when asked", () => {
    // The value case of a field whose only tested value was `null`. It exists for a
    // data dir that cannot be written — a read-only or full one — which leaves the
    // entry point aimed at a renderer the last update moved. Nothing downstream can
    // rediscover that: the stale target usually still exists, so the shim reads and
    // resolves and looks healthy.
    const home = path.join(sandbox, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    // A directory where the shim has to go: every write to that path fails, and it is
    // the one failure that does not also break the state file next to it.
    fs.rmSync(path.join(dataDir, "statusline.cjs"), { force: true });
    fs.mkdirSync(path.join(dataDir, "statusline.cjs"), { recursive: true });

    assert.equal(runHook(home).status, 0, "an unwritable shim must not fail the session");
    const recorded = readSessionState().statuslineShim;
    assert.match(String(recorded), /could not write/, "the failure must be recorded at all");

    fs.rmSync(path.join(dataDir, "statusline.cjs"), { recursive: true, force: true });
  });

  it("stops reporting a repair failure once a later attempt works", () => {
    // SessionStart fires again on resume, on /clear and on compact, all against the
    // same session record — so a field written only on failure is written once and
    // never corrected. Someone whose settings.json was briefly unparseable at startup,
    // and who then fixed it, went on being told for the rest of the session that the
    // repair "could not" run, and sent to debug a condition that no longer existed.
    const home = path.join(sandbox, "home");
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ statusline: { installed: true } })
    );

    fs.writeFileSync(settings, "{ not json");
    assert.equal(runHook(home).status, 0);
    const failed = readSessionState().statuslineReassert;
    assert.equal(failed.status, "settings-unreadable", "the failure must be recorded at all");

    // The user fixes the file; the next SessionStart in this same session succeeds.
    fs.writeFileSync(settings, JSON.stringify({ model: "opus" }, null, 2));
    assert.equal(runHook(home).status, 0);
    assert.ok(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine, "and it did restore it");
    assert.equal(
      readSessionState().statuslineReassert,
      null,
      "a stale reason is worse than none — it names a cause that has been fixed"
    );
  });
});

describe("recognising our own status line", () => {
  it("accepts the shim this version writes", () => {
    // The unambiguous case, and the one every current install is in: an exact path
    // match needs no inference about who wrote it.
    const { path: shim } = install.refreshShim();
    assert.equal(install.isOurStatusLine(`node ${JSON.stringify(shim)}`), true);
  });

  it("accepts an older entry whose path is still attributably ours", () => {
    // A 2.x entry points somewhere this version no longer writes, so the exact match
    // cannot see it. Attribution then comes from the path carrying a plugin-owned
    // fragment — without this an upgrade would refuse to take over from the version
    // it is replacing, and the user would be left removing the old entry by hand.
    assert.equal(
      install.isOurStatusLine('node "/home/u/.claude/plugins/gutt/statusline.cjs"'),
      true
    );
    // The shape a real install actually has: the data directory is named for the
    // plugin and the marketplace it came from, and both halves carry our name.
    assert.equal(
      install.isOurStatusLine(
        'node "/home/u/.claude/plugins/data/gutt-pro-gutt-plugins/statusline.cjs"'
      ),
      true
    );
    // A 2.x cache path, which was version-scoped and is long gone, but still ours.
    assert.equal(
      install.isOurStatusLine(
        'node "/home/u/.claude/plugins/cache/gutt-plugins/hooks/statusline.cjs"'
      ),
      true
    );
  });

  it("leaves another plugin's status line alone, wherever it is installed", () => {
    // Attribution used to accept the bare fragment `plugins`, and every plugin's
    // data directory is under ~/.claude/plugins/data/ — so another vendor's status
    // line read as ours. `removeEntry` would have deleted it and `installEntry`
    // overwritten it, which are the two things this module promises never to do.
    // The marker has to name *this* plugin, not the container they all share.
    assert.equal(
      install.isOurStatusLine(
        'node "/home/u/.claude/plugins/data/context7-claude-plugins-official/statusline.cjs"'
      ),
      false
    );
    assert.equal(
      install.isOurStatusLine('node "/home/u/.claude/plugins/data/some-other/gutt-statusline.cjs"'),
      false
    );
    // A user's own checkout that merely has "plugins" somewhere in the path.
    assert.equal(install.isOurStatusLine("node /home/u/projects/my-plugins/statusline.cjs"), false);
    assert.equal(install.isOurStatusLine('node "/x/plugin_data/gutt-statusline.cjs"'), false);
  });

  it("rejects a script that merely shares the name", () => {
    // The bug this replaced: `statusline.cjs` is the obvious name for the job, so a
    // basename test claimed a user's own script. `removeEntry` would then delete
    // someone else's status line, and `installEntry` would report "already installed"
    // against a file it had never touched — leaving the HUD absent behind a success
    // message. Neither is recoverable from inside this module, so an unattributable
    // path is foreign even when we might in fact have written it.
    assert.equal(install.isOurStatusLine('node "/x/y/statusline.cjs"'), false);
    assert.equal(install.isOurStatusLine('node "/home/u/.claude/statusline.cjs"'), false);
    assert.equal(install.isOurStatusLine('node "/tmp/probe-1234/statusline.cjs"'), false);
  });

  it("reads attribution from the directory, not from the filename", () => {
    // `gutt-statusline.cjs` carries the marker `gutt` in its own basename, so a
    // whole-path attribution test passes on the name alone and lets any directory
    // through — re-admitting the bug above by the back door. Where a file lives is
    // evidence about who put it there; what it is called is not.
    assert.equal(install.isOurStatusLine('node "/x/y/gutt-statusline.cjs"'), false);
    assert.equal(install.isOurStatusLine('node "/tmp/gutt-statusline.cjs"'), false);
    // The directory names us, so this one is ours — and it is the filename that is
    // being ignored, not the marker.
    assert.equal(install.isOurStatusLine('node "/x/gutt-pro/gutt-statusline.cjs"'), true);
  });

  it("rejects everything else", () => {
    assert.equal(install.isOurStatusLine("npx -y ccstatusline@latest"), false);
    assert.equal(install.isOurStatusLine("~/.claude/statusline.sh"), false);
    assert.equal(install.isOurStatusLine(""), false);
    assert.equal(install.isOurStatusLine(null), false);
    assert.equal(install.isOurStatusLine(undefined), false);
    assert.equal(install.isOurStatusLine(42), false);
  });

  it("does not require the target to exist", () => {
    // The live entry is the one that matters here: an install must be idempotent
    // against a working HUD, and a removal must be able to take one away. Requiring a
    // resolvable target would disown our own entry for the window after an upgrade
    // moves the renderer — that check belongs to the migration that cleans up corpses.
    const { path: shim } = install.refreshShim();
    fs.rmSync(shim);
    assert.equal(install.isOurStatusLine(`node ${JSON.stringify(shim)}`), true);
  });

  it("classifies the slot the same way for every caller", () => {
    // install, remove and the SessionStart re-assert all ask this one function, so
    // there is no shape any of them can read differently from the others.
    const { path: shim } = install.refreshShim();
    const ours = { statusLine: { type: "command", command: `node ${JSON.stringify(shim)}` } };
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
