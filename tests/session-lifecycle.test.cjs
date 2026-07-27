#!/usr/bin/env node
/**
 * Tests for the GP-863 session lifecycle: SessionStart/SessionEnd state,
 * the R37 TTL sweep, and the snooze primitives they operate on.
 *
 * Run: node --test tests/session-lifecycle.test.cjs
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const pluginState = require("../shared/plugin-state.cjs");
const sessionState = require("../shared/session-state.cjs");
const runtimeConfig = require("../shared/runtime-config.cjs");
const { guard } = require("../shared/debug.cjs");
// The hook module, required rather than spawned: gated behind `require.main`, it
// exports the real ttlSweep so the sweep tests below can't drift from shipped code.
const { ttlSweep } = require("../gutt-core/hooks/session-start.cjs");

const HOOKS = path.join(__dirname, "..", "gutt-core", "hooks");
const HOUR = 60 * 60 * 1000;

const ORIGINAL_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;

function restoreEnv() {
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_DATA_DIR;
  }
}

/** Fresh, isolated ${CLAUDE_PLUGIN_DATA} for a describe block. */
function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-lifecycle-"));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

function readSession(dir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(dir, "sessions", `${sessionId}.json`), "utf8"));
}

/**
 * Run a hook the way Claude Code does: a fresh node process fed the event JSON
 * on stdin. HOME is redirected so a hook that reaches for the user's home dir
 * writes into the sandbox instead of the developer's real one.
 * @param {string} name - hook filename
 * @param {Object} payload - stdin JSON
 * @param {{dataDir: string, home: string}} env
 */
function runHook(name, payload, { dataDir, home }) {
  return spawnSync("node", [path.join(HOOKS, name)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PROJECT_DIR: home,
    },
  });
}

// ---------------------------------------------------------------------------
// beginSession / finalizeSession — the matcher-aware state machine (AC1)
// ---------------------------------------------------------------------------

describe("session lifecycle: SessionStart matcher branches", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(dir, "sessions"), { recursive: true, force: true });
  });

  for (const source of ["startup", "resume", "clear"]) {
    it(`${source} arms firstPromptPending and leaves compacted alone`, () => {
      sessionState.init(`s-${source}`);
      const state = sessionState.beginSession(`s-${source}`, source);
      assert.equal(state.firstPromptPending, true);
      assert.equal(state.compacted, false);
      assert.equal(state.source, source);
    });
  }

  it("compact sets compacted without re-arming firstPromptPending", () => {
    sessionState.init("s-compact");
    sessionState.beginSession("s-compact", "startup");
    sessionState.consumeFirstPromptPending(); // the guard already ran this session
    const state = sessionState.beginSession("s-compact", "compact");
    assert.equal(state.compacted, true);
    assert.equal(state.firstPromptPending, false, "compact is mid-session, not a restart");
    assert.equal(state.source, "compact");
  });

  it("an unknown future matcher is treated as a restart, not a compaction", () => {
    sessionState.init("s-fork");
    const state = sessionState.beginSession("s-fork", "fork");
    assert.equal(state.firstPromptPending, true);
    assert.equal(state.compacted, false);
  });

  it("beginSession never writes connectionStatus (the async hook owns it)", () => {
    sessionState.init("s-conn");
    sessionState.beginSession("s-conn", "startup");
    // Stand-in for the async probe, which writes the field directly rather than
    // through a named setter.
    sessionState.updateState((state) => {
      state.connectionStatus = "ok";
      return state;
    });
    const state = sessionState.beginSession("s-conn", "resume");
    assert.equal(state.connectionStatus, "ok", "a restart must not clobber the probe result");
  });

  it("SessionEnd finalizes the record and clears the lifecycle flags", () => {
    sessionState.init("s-end");
    sessionState.beginSession("s-end", "startup");
    const state = sessionState.finalizeSession("logout");
    assert.equal(state.endReason, "logout");
    assert.ok(state.endedAt, "endedAt stamped");
    assert.equal(state.firstPromptPending, false);
    assert.equal(state.compacted, false);
    assert.ok(fs.existsSync(path.join(dir, "sessions", "s-end.json")), "file kept, not deleted");
  });

  it("a restart after an end reopens the record", () => {
    sessionState.init("s-reopen");
    sessionState.beginSession("s-reopen", "startup");
    sessionState.finalizeSession("clear");
    const state = sessionState.beginSession("s-reopen", "clear");
    assert.equal(state.endedAt, null);
    assert.equal(state.endReason, null);
    assert.equal(state.firstPromptPending, true);
  });

  // The two hooks above run as separate processes with no completion ordering
  // between them, so `/clear` can deliver them either way round. The lock makes
  // the writes atomic; it does not make them ordered.
  it("SessionEnd does not close a session that started after it was dispatched", () => {
    sessionState.init("s-clear-race");
    sessionState.beginSession("s-clear-race", "startup");

    // SessionEnd was issued a second ago and is only now reaching the record —
    // by which time the replacement SessionStart has already reopened it.
    const dispatchedAt = Date.now() - 1000;
    const reopened = sessionState.beginSession("s-clear-race", "clear");
    assert.ok(
      Date.parse(reopened.startedAt) > dispatchedAt,
      "precondition: the restart is stamped after the dispatch"
    );

    const state = sessionState.finalizeSession("clear", dispatchedAt);
    assert.equal(state.endedAt, null, "the live session was not marked ended");
    assert.equal(state.endReason, null, "no end reason stamped on a live session");
    assert.equal(state.firstPromptPending, true, "the new session keeps its first-prompt flag");
  });

  it("SessionEnd still closes a session that started before it was dispatched", () => {
    sessionState.init("s-clear-ordered");
    sessionState.beginSession("s-clear-ordered", "startup");

    // The ordinary case, with the stamp made explicit: nothing restarted the
    // record after this SessionEnd, so the guard must stay out of the way.
    const state = sessionState.finalizeSession("clear", Date.now() + 1000);
    assert.equal(state.endReason, "clear");
    assert.ok(state.endedAt, "endedAt stamped");
    assert.equal(state.firstPromptPending, false);
  });
});

// ---------------------------------------------------------------------------
// Flags consumed by the GP-864 command guard
// ---------------------------------------------------------------------------

describe("session lifecycle: flag consumption", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
    sessionState.init("s-flags");
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("firstPromptPending and compacted each fire exactly once", () => {
    sessionState.beginSession("s-flags", "startup");
    assert.equal(sessionState.consumeFirstPromptPending(), true);
    assert.equal(sessionState.consumeFirstPromptPending(), false, "second read is false");

    sessionState.beginSession("s-flags", "compact");
    assert.equal(sessionState.consumeCompacted(), true);
    assert.equal(sessionState.consumeCompacted(), false);
  });

  it("consuming an unset flag does not rewrite the file", () => {
    sessionState.beginSession("s-flags", "startup");
    sessionState.consumeCompacted(); // already false
    const before = fs.statSync(path.join(dir, "sessions", "s-flags.json")).mtimeMs;
    assert.equal(sessionState.consumeCompacted(), false);
    assert.equal(fs.statSync(path.join(dir, "sessions", "s-flags.json")).mtimeMs, before);
  });

  it("getState() hands out an independent record per call", () => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_DATA; // force the default-state path
    const a = sessionState.getState();
    a.endReason = "leak";
    // A module-level literal would make both calls the same object, so a
    // mutation here would show up there.
    assert.equal(sessionState.getState().endReason, null, "defaults must not be shared");
    process.env.CLAUDE_PLUGIN_DATA = saved;
  });
});

// ---------------------------------------------------------------------------
// Parallel-hook safety. Claude Code runs sibling hooks on one event at once, so
// the session file is genuinely contended (AC4).
// ---------------------------------------------------------------------------

describe("session lifecycle: concurrent writers", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no update is lost when processes contend for one session file", () => {
    // Regression test for a real lost update: a `claude -p` run where the async
    // connectivity probe succeeded but its connectionStatus never reached disk.
    // Each child holds its read open 3ms, which is enough that an unguarded
    // read-modify-write loses 5 of these 6 increments every single run.
    const fixture = path.join(__dirname, "fixtures", "concurrent-increment.cjs");
    const writers = 6;
    // spawnSync serialises, so background the children through the shell to get
    // genuine OS-level parallelism.
    const cmd =
      Array.from({ length: writers }, () => `node ${JSON.stringify(fixture)} contended 3 &`).join(
        " "
      ) + " wait";
    const res = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 0, res.stderr);

    const state = JSON.parse(fs.readFileSync(path.join(dir, "sessions", "contended.json"), "utf8"));
    assert.equal(
      state.memoryQueries,
      writers,
      `expected all ${writers} increments to survive, got ${state.memoryQueries}`
    );
    assert.equal(state.rev, writers, "every write bumped the revision exactly once");
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "sessions")).filter((f) => f.endsWith(".lock")),
      [],
      "no lock left behind"
    );
  });

  it("the two SessionStart hooks do not clobber each other's fields", () => {
    // The exact real-world pairing: the fast lifecycle hook and the async probe.
    const sessionId = "parallel-start";
    const cmd =
      `echo '{"session_id":"${sessionId}","source":"startup"}' | node ${JSON.stringify(path.join(HOOKS, "session-start.cjs"))} & ` +
      `echo '{"session_id":"${sessionId}"}' | node ${JSON.stringify(path.join(HOOKS, "session-connectivity.cjs"))} & wait`;
    const res = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 0, res.stderr);

    const state = JSON.parse(
      fs.readFileSync(path.join(dir, "sessions", `${sessionId}.json`), "utf8")
    );
    // Each hook's own field survived the other's write.
    assert.equal(state.source, "startup", "lifecycle hook's field survived");
    assert.equal(state.firstPromptPending, true, "lifecycle hook's flag survived");
    assert.ok(state.connectionCheckedAt, "connectivity probe's result survived");
    assert.equal(typeof state.mcpConfigured, "boolean");
  });

  it("an unremovable lock is waited out, never spun on", () => {
    // The fail-open contract has one way to betray itself: a lock that cannot be
    // deleted. A directory or dangling symlink at the lock path makes openSync
    // return EEXIST and unlinkSync throw every time, and an early `continue`
    // past the deadline check turns that into a hot loop that never returns —
    // hanging the very session the fail-open exists to protect.
    const statePathForSession = pluginState.statePath("sessions", "unremovable.json");
    const lockPath = `${statePathForSession}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    for (const [shape, make] of [
      ["directory", () => fs.mkdirSync(lockPath)],
      ["dangling symlink", () => fs.symlinkSync(path.join(dir, "does-not-exist"), lockPath)],
    ]) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      make();
      let elapsed;
      let returned;
      try {
        const startedAt = Date.now();
        returned = pluginState.withLock(statePathForSession, () => "ran");
        elapsed = Date.now() - startedAt;
      } finally {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
      assert.equal(returned, "ran", `${shape}: must fail open and still run fn`);
      assert.ok(elapsed < 2000, `${shape}: took ${elapsed}ms — it is spinning, not failing open`);
    }
  });

  it("a holder that stalled does not release the lock that replaced it", () => {
    // The stale reclaim has a mirror-image failure. If a holder stalls past
    // LOCK_STALE_MS — laptop suspend, heavy swap, an fsync stall on a network
    // HOME — a second writer correctly reclaims the lock and creates its own.
    // Releasing by path would then delete *that* writer's lock, letting a third
    // writer in alongside it: exactly the concurrent read-modify-write the lock
    // exists to prevent.
    //
    // Staged in-process rather than by stalling for 5s: rename the held lock
    // aside and drop a different file in its place, which is the state the
    // stalled holder would wake up to. Renaming rather than deleting keeps the
    // original inode allocated, so the replacement cannot be handed the same
    // one and quietly turn this into a tautology.
    const file = pluginState.statePath("sessions", "stalled-holder.json");
    const lockPath = `${file}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.rmSync(lockPath, { recursive: true, force: true });

    let inodesDiffered = false;
    pluginState.withLock(file, () => {
      const held = fs.lstatSync(lockPath).ino;
      fs.renameSync(lockPath, `${lockPath}.parked`);
      fs.writeFileSync(lockPath, "second writer");
      inodesDiffered = fs.lstatSync(lockPath).ino !== held;
    });

    assert.ok(inodesDiffered, "test setup: the replacement lock must be a different inode");
    assert.equal(
      fs.existsSync(lockPath),
      true,
      "the reclaiming writer's lock was deleted — a third writer can now run concurrently"
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), "second writer");
    fs.rmSync(lockPath, { force: true });
    fs.rmSync(`${lockPath}.parked`, { force: true });
  });

  it("a lock left by a dead process is reclaimed rather than waited out", () => {
    sessionState.init("reclaim");
    const lockPath = `${pluginState.statePath("sessions", "reclaim.json")}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "held by a process that died");
    const stale = new Date(Date.now() - 30_000); // > LOCK_STALE_MS
    fs.utimesSync(lockPath, stale, stale);

    const startedAt = Date.now();
    const result = sessionState.applyUpdate((state) => {
      state.memoryQueries = 7;
      return state;
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 200, `reclaim must be immediate, took ${elapsed}ms`);
    assert.equal(result.written, true);
    assert.equal(readSession(dir, "reclaim").memoryQueries, 7);
    assert.equal(fs.existsSync(lockPath), false, "the reclaiming writer released the lock");
  });

  it("a held lock is waited out and the write still lands", () => {
    // Fail-open must mean "proceed without the lock", not "silently skip the
    // write" — a dropped finalizeSession leaves a session marked live for 24h.
    sessionState.init("failopen");
    sessionState.updateState((state) => {
      state.memoryQueries = 5;
      return state;
    });
    const lockPath = `${pluginState.statePath("sessions", "failopen.json")}.lock`;
    fs.writeFileSync(lockPath, "held"); // fresh mtime — not reclaimable

    let result;
    try {
      result = sessionState.applyUpdate((state) => {
        state.memoryQueries = 99;
        return state;
      });
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    assert.equal(result.written, true, "fail-open must still perform the write");
    assert.equal(readSession(dir, "failopen").memoryQueries, 99);
  });

  it("consumeFlag hands the flag to exactly one of two racing readers", () => {
    // The unlocked fast path decides only "is there anything to do"; whether
    // *this* caller consumed it has to be settled inside the lock, or both
    // hooks on one event return true and a one-shot injection fires twice.
    sessionState.init("one-shot");
    sessionState.beginSession("one-shot", "startup");

    const fixture = path.join(__dirname, "fixtures", "consume-once.cjs");
    const readers = 6;
    const cmd =
      Array.from({ length: readers }, () => `node ${JSON.stringify(fixture)} one-shot &`).join(
        " "
      ) + " wait";
    const res = spawnSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(res.status, 0, res.stderr);

    const wins = res.stdout.split("\n").filter((line) => line.trim() === "consumed").length;
    assert.equal(wins, 1, `expected exactly one consumer, ${wins} of ${readers} claimed the flag`);
    assert.equal(readSession(dir, "one-shot").firstPromptPending, false);
  });

  it("config.json mutations take the write lock too", () => {
    // config.json is global — every concurrent session on the machine shares it,
    // and SessionStart expires a snooze while SessionEnd drops one. It shipped
    // with the same unguarded read-then-write that cost us the session file, so
    // this pins the mutators to the lock.
    //
    // Asserted by holding the lock and timing the mutator: a locked writer waits
    // out LOCK_TIMEOUT_MS (250ms) and then fails open, an unlocked one returns
    // immediately.
    const lockPath = `${runtimeConfig.configPath()}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "held by the test");

    let elapsed;
    try {
      const startedAt = Date.now();
      runtimeConfig.setSnooze({ sessionId: "locked-out" });
      elapsed = Date.now() - startedAt;
    } finally {
      fs.rmSync(lockPath, { force: true });
    }

    assert.ok(
      elapsed >= 200,
      `setSnooze returned in ${elapsed}ms while the lock was held — it is not locked`
    );
  });
});

// ---------------------------------------------------------------------------
// Snooze: expiry at SessionStart, session-scope cleared at SessionEnd (AC1/AC2)
// ---------------------------------------------------------------------------

describe("session lifecycle: snooze", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(dir, "config.json"), { force: true });
  });

  it("reading config never creates the file", () => {
    assert.deepEqual(runtimeConfig.readConfig(), runtimeConfig.DEFAULTS);
    assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
  });

  it("a live snooze holds, an expired one does not", () => {
    runtimeConfig.setSnooze({ untilMs: Date.now() + HOUR });
    assert.equal(runtimeConfig.isSnoozed(), true);
    runtimeConfig.setSnooze({ untilMs: Date.now() - HOUR });
    assert.equal(runtimeConfig.isSnoozed(), false);
  });

  it("clearExpiredSnooze drops a lapsed snooze and keeps a live one", () => {
    runtimeConfig.setSnooze({ untilMs: Date.now() + HOUR });
    assert.equal(runtimeConfig.clearExpiredSnooze(), false, "live snooze survives");
    assert.ok(runtimeConfig.readConfig().snoozeUntil);

    runtimeConfig.setSnooze({ untilMs: Date.now() - HOUR });
    assert.equal(runtimeConfig.clearExpiredSnooze(), true);
    assert.equal(runtimeConfig.readConfig().snoozeUntil, null);
  });

  it("clearExpiredSnooze treats an unparseable deadline as stale", () => {
    pluginState.writeJson(runtimeConfig.configPath(), { snoozeUntil: "not-a-date" });
    assert.equal(runtimeConfig.clearExpiredSnooze(), true);
    assert.equal(runtimeConfig.readConfig().snoozeUntil, null);
  });

  it("a session-scoped snooze applies only to its own session", () => {
    runtimeConfig.setSnooze({ sessionId: "mine" });
    assert.equal(runtimeConfig.isSnoozed("mine"), true);
    assert.equal(runtimeConfig.isSnoozed("theirs"), false);
  });

  it("SessionEnd clears a session-scoped snooze but not a durable one", () => {
    runtimeConfig.setSnooze({ sessionId: "mine" });
    assert.equal(runtimeConfig.clearSessionSnooze("theirs"), false, "wrong session, no-op");
    assert.equal(runtimeConfig.clearSessionSnooze("mine"), true);
    assert.equal(runtimeConfig.readConfig().snoozeSessionId, null);

    runtimeConfig.setSnooze({ untilMs: Date.now() + HOUR }); // durable, unscoped
    assert.equal(runtimeConfig.clearSessionSnooze("mine"), false);
    assert.ok(runtimeConfig.readConfig().snoozeUntil, "durable snooze outlives the session");
  });

  it("clearing snooze leaves keys owned by the config commands untouched", () => {
    pluginState.writeJson(runtimeConfig.configPath(), {
      enabled: false,
      mode: "manual",
      snoozeUntil: new Date(Date.now() - HOUR).toISOString(),
    });
    runtimeConfig.clearExpiredSnooze();
    const raw = runtimeConfig.readRawConfig();
    assert.equal(raw.enabled, false, "GP-866's keys survive");
    assert.equal(raw.mode, "manual");
    assert.equal("snoozeUntil" in raw, false);
  });
});

// ---------------------------------------------------------------------------
// TTL primitives (AC2)
// ---------------------------------------------------------------------------

describe("session lifecycle: guard()", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const errorLog = () => path.join(dir, "hook-errors.log");
  const readLog = () => (fs.existsSync(errorLog()) ? fs.readFileSync(errorLog(), "utf8") : "");

  it("passes a successful result straight through", () => {
    assert.equal(
      guard("Probe", "fine", () => 42),
      42
    );
  });

  it("swallows a throw, returns undefined, and records it with a stack", () => {
    // guard() is the single reason it is safe for hooks to swallow errors, so a
    // swallow that loses the stack makes every one of them undiagnosable — the
    // throw is usually several frames inside a shared helper and five sweep
    // steps share one log.
    const returned = guard("Probe", "the step that failed", () => {
      throw new TypeError("kaboom");
    });

    assert.equal(returned, undefined);
    const log = readLog();
    assert.match(log, /\[Probe\] the step that failed: kaboom/);
    assert.match(log, /TypeError: kaboom/, "the stack must survive into the log");
    assert.match(log, /session-lifecycle\.test\.cjs/, "and it must name a frame");
  });

  it("handles a thrown non-Error", () => {
    assert.equal(
      guard("Probe", "threw a string", () => {
        throw "not an error object";
      }),
      undefined
    );
    assert.match(readLog(), /threw a string: not an error object/);
  });
});

describe("session lifecycle: TTL primitives", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an oversized log keeps its tail rather than erasing its own evidence", () => {
    // trimLog used to unlink the file. For hook-errors.log that means the notice
    // explaining the deletion is written into the file being deleted — the only
    // diagnostic surface in the plugin, erasing itself when it matters most.
    const file = pluginState.statePath("hook-errors.log");
    const filler = `${new Date().toISOString()} [Hook] a routine logged failure\n`;
    fs.writeFileSync(file, filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length)));
    fs.appendFileSync(file, "the error someone needs to read\n");
    assert.ok(fs.statSync(file).size > 4 * 1024 * 1024, "fixture must exceed DISCARD_BYTES");

    const result = pluginState.trimLog(file, { maxBytes: 256 * 1024, keepLines: 200 });

    assert.equal(result.discarded, true);
    assert.equal(fs.existsSync(file), true, "the log must survive");
    assert.ok(fs.statSync(file).size <= 256 * 1024, "bounded to maxBytes");
    assert.match(
      fs.readFileSync(file, "utf8"),
      /the error someone needs to read/,
      "the newest entry survived"
    );
  });

  it("trimLog leaves a small log alone and tail-trims a large one", () => {
    const log = pluginState.statePath("hook-invocations.log");
    fs.writeFileSync(log, "one\ntwo\n");
    assert.deepEqual(pluginState.trimLog(log, { maxBytes: 1024, keepLines: 1 }), {
      trimmed: false,
      discarded: false,
    });

    fs.writeFileSync(log, Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n") + "\n");
    const res = pluginState.trimLog(log, { maxBytes: 100, keepLines: 3 });
    assert.equal(res.trimmed, true);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "line-497",
      "line-498",
      "line-499",
    ]);
  });

  it("trimLog still bounds a log made of a few enormous lines", () => {
    // keepLines can't help here — one line is already over the cap, so the
    // byte-bounded fallback has to kick in.
    const log = pluginState.statePath("hook-errors.log");
    fs.writeFileSync(log, "x".repeat(400 * 1024));
    assert.equal(pluginState.trimLog(log, { maxBytes: 8 * 1024, keepLines: 200 }).trimmed, true);
    assert.ok(fs.statSync(log).size <= 8 * 1024, "log bounded despite having no line breaks");
    // "Bounded" is not the whole contract — an empty file is bounded too, and
    // asserting only the size let a fallback that wiped the log to a single
    // newline pass for as long as it existed.
    assert.ok(fs.statSync(log).size > 1, "bounded, not emptied");
  });

  it("the byte bound holds when the cut lands mid-character", () => {
    // Every other trim fixture is ASCII, where a byte cut is always a character
    // cut. Slicing bytes and decoding afterwards turns a split multi-byte
    // character into U+FFFD, which re-encodes to more bytes than it replaced —
    // so the "bounded" result came back over the bound, and a log that stays
    // over its bound is re-read and rewritten on every SessionStart forever.
    const log = pluginState.statePath("hook-errors.log");
    for (const [script, ch] of Object.entries({ emoji: "😀", cjk: "日", latin1: "é" })) {
      for (const pad of [0, 1, 2, 3]) {
        fs.writeFileSync(log, `${"p".repeat(pad)}${ch.repeat(3000)}\n`);
        pluginState.trimLog(log, { maxBytes: 1000, keepLines: 200 });
        const size = fs.statSync(log).size;
        assert.ok(size <= 1000, `${script} pad=${pad}: ${size} bytes exceeds the 1000-byte bound`);
        assert.ok(size > 1, `${script} pad=${pad}: bounded, but emptied`);
      }
    }
  });

  it("a long line does not take the short ones with it", () => {
    // The realistic shape: an ordinary log that picks up one big stack trace.
    // The byte-bounded fallback used to drop "the partial first line" even when
    // that was the entire window, replacing the file with a lone "\n".
    const log = pluginState.statePath("hook-errors.log");
    fs.writeFileSync(
      log,
      "2026-07-27 INFO short line one\n" +
        "2026-07-27 INFO short line two\n" +
        `2026-07-27 ERROR ${"Z".repeat(5000)}-END\n`
    );
    pluginState.trimLog(log, { maxBytes: 1000, keepLines: 200 });

    const after = fs.readFileSync(log, "utf8");
    assert.ok(Buffer.byteLength(after) <= 1000, "bounded");
    assert.notEqual(after, "\n", "the log must not be wiped to a single newline");
    assert.ok(after.trim().length > 0, "something has to survive a trim");
  });
});

// ---------------------------------------------------------------------------
// The hooks themselves, run as Claude Code runs them
// ---------------------------------------------------------------------------

describe("session lifecycle: hooks end to end", () => {
  let dir;
  let home;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-hooks-data-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-hooks-home-"));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("SessionStart opens the record with the matcher's flags", () => {
    const r = runHook(
      "session-start.cjs",
      { session_id: "e2e-a", source: "startup" },
      { dataDir: dir, home }
    );
    assert.equal(r.status, 0);
    const state = readSession(dir, "e2e-a");
    assert.equal(state.sessionId, "e2e-a");
    assert.equal(state.source, "startup");
    assert.equal(state.firstPromptPending, true);
    assert.equal(state.compacted, false);
  });

  it("SessionStart[compact] marks the record compacted", () => {
    runHook(
      "session-start.cjs",
      { session_id: "e2e-b", source: "compact" },
      { dataDir: dir, home }
    );
    const state = readSession(dir, "e2e-b");
    assert.equal(state.compacted, true);
    assert.equal(state.source, "compact");
  });

  it("SessionStart sweeps session files older than 24h and keeps fresh ones", () => {
    const sessions = path.join(dir, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const stale = path.join(sessions, "ancient.json");
    fs.writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 48 * HOUR);
    fs.utimesSync(stale, old, old);

    runHook(
      "session-start.cjs",
      { session_id: "e2e-sweep", source: "startup" },
      { dataDir: dir, home }
    );
    assert.equal(fs.existsSync(stale), false, "stale session file swept");
    assert.ok(fs.existsSync(path.join(sessions, "e2e-sweep.json")), "this session survives");
  });

  it("SessionStart expires a lapsed snooze and clears retired marker files", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ mode: "auto", snoozeUntil: new Date(Date.now() - HOUR).toISOString() })
    );
    fs.writeFileSync(path.join(dir, "leftover.lessons-prompted"), "{}");

    runHook(
      "session-start.cjs",
      { session_id: "e2e-snooze", source: "startup" },
      { dataDir: dir, home }
    );

    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(config.snoozeUntil, undefined, "expired snooze cleared");
    assert.equal(config.mode, "auto", "unrelated config preserved");
    assert.equal(
      fs.existsSync(path.join(dir, "leftover.lessons-prompted")),
      false,
      "upgrade leftover removed"
    );
  });

  it("SessionStart survives a malformed payload without failing the session", () => {
    const r = spawnSync("node", [path.join(HOOKS, "session-start.cjs")], {
      input: "not json at all",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, HOME: home, USERPROFILE: home },
    });
    assert.equal(r.status, 0);
  });

  // Well-formed JSON carrying a wrong-typed session_id is the gap the test above
  // leaves: it parses fine, so nothing rejects it, and it reaches sanitizeSessionId
  // — which every lifecycle hook calls via init(), outside its guard(). All three
  // exited 1 on an uncaught TypeError before sanitizeSessionId coerced its input.
  for (const [label, sessionId] of [
    ["a number", 123],
    ["an array", ["a"]],
    ["an object", { id: "x" }],
    // Coerces via ToPrimitive -> Object.prototype.toString, which this shadows
    // with a non-callable; ToPrimitive then tries valueOf, gets the object back,
    // and throws. Plain `String(x)` is not safe on arbitrary parsed JSON.
    ["an object with a non-callable toString", { toString: "x" }],
    ["an object with toString and valueOf shadowed", { toString: 2, valueOf: 1 }],
    ["null", null],
    ["empty", ""],
  ]) {
    it(`every lifecycle hook survives ${label} session_id`, () => {
      for (const hook of ["session-start.cjs", "session-end.cjs", "session-connectivity.cjs"]) {
        const r = runHook(
          hook,
          { session_id: sessionId, source: "startup" },
          { dataDir: dir, home }
        );
        assert.equal(r.status, 0, `${hook} exited ${r.status}: ${r.stderr}`);
      }
      // The id still has to route to a real file rather than a bare ".json".
      const written = fs.readdirSync(path.join(dir, "sessions")).filter((f) => f.endsWith(".json"));
      assert.ok(
        written.every((f) => f.length > ".json".length),
        `unnamed state file among: ${written.join(", ")}`
      );
    });
  }

  it("SessionStart writes nothing outside CLAUDE_PLUGIN_DATA (AC3)", () => {
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-ac3-home-"));
    const probeData = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-ac3-data-"));
    try {
      for (const hook of ["session-start.cjs", "session-connectivity.cjs", "session-end.cjs"]) {
        runHook(
          hook,
          { session_id: "ac3", source: "startup", reason: "clear" },
          {
            dataDir: probeData,
            home: probeHome,
          }
        );
      }
      assert.deepEqual(fs.readdirSync(probeHome), [], "nothing written to HOME");
      assert.ok(
        fs.existsSync(path.join(probeData, "sessions", "ac3.json")),
        "state went to the data dir"
      );
    } finally {
      fs.rmSync(probeHome, { recursive: true, force: true });
      fs.rmSync(probeData, { recursive: true, force: true });
    }
  });

  it("the async connectivity hook records the probe result for the statusline (AC4)", () => {
    const r = runHook(
      "session-connectivity.cjs",
      { session_id: "e2e-conn" },
      { dataDir: dir, home }
    );
    assert.equal(r.status, 0);
    const state = readSession(dir, "e2e-conn");
    assert.ok(["ok", "unknown", "error"].includes(state.connectionStatus));
    assert.equal(typeof state.mcpConfigured, "boolean");
    assert.ok(state.connectionCheckedAt, "probe timestamped");
  });

  it("SessionEnd finalizes the record and drops this session's snooze", () => {
    runHook(
      "session-start.cjs",
      { session_id: "e2e-end", source: "startup" },
      { dataDir: dir, home }
    );
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ mode: "auto", snoozeSessionId: "e2e-end" })
    );

    const r = runHook(
      "session-end.cjs",
      { session_id: "e2e-end", reason: "logout" },
      { dataDir: dir, home }
    );
    assert.equal(r.status, 0);

    const state = readSession(dir, "e2e-end");
    assert.equal(state.endReason, "logout");
    assert.ok(state.endedAt);
    assert.equal(state.firstPromptPending, false);

    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(config.snoozeSessionId, undefined, "session-scoped snooze cleared");
    assert.equal(config.mode, "auto");
  });

  it("SessionEnd defaults the reason when the payload omits it", () => {
    runHook(
      "session-start.cjs",
      { session_id: "e2e-noreason", source: "startup" },
      { dataDir: dir, home }
    );
    runHook("session-end.cjs", { session_id: "e2e-noreason" }, { dataDir: dir, home });
    assert.equal(readSession(dir, "e2e-noreason").endReason, "other");
  });

  // The guard's cutoff is the moment SessionEnd was *dispatched*, not the moment
  // it gets around to writing. Only a stamp taken at module load distinguishes
  // the two, and nothing else in the suite can tell them apart: reading the
  // clock at call time would pass every other SessionEnd test here.
  it("SessionEnd stamps its cutoff at dispatch, not at write time", async () => {
    const child = spawn("node", [path.join(HOOKS, "session-end.cjs")], {
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PROJECT_DIR: home,
      },
    });

    // The hook is now booted and blocked on stdin. Open the record well after
    // its dispatch but before it can act — the `/clear` race, held still.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sessions = path.join(dir, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "e2e-dispatch.json"),
      JSON.stringify({
        sessionId: "e2e-dispatch",
        startedAt: new Date().toISOString(),
        rev: 1,
        firstPromptPending: true,
        endedAt: null,
        endReason: null,
      })
    );

    child.stdin.end(JSON.stringify({ session_id: "e2e-dispatch", reason: "clear" }));
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);

    const state = readSession(dir, "e2e-dispatch");
    assert.equal(state.endedAt, null, "a session opened after dispatch was left running");
    assert.equal(state.firstPromptPending, true, "its first-prompt flag survived");
  });
});

// ---------------------------------------------------------------------------
// The UserPromptSubmit trigger matrix (GP-864). Four rows, and the two silent
// ones matter as much as the two that speak: a hook that fires on every prompt
// is the 2.x nag in new wording.
// ---------------------------------------------------------------------------

describe("UserPromptSubmit: deterministic trigger matrix", () => {
  let dir;
  let home;

  /** @returns {Object|null} the parsed hook output, or null when it stayed silent */
  function submit(sessionId, prompt = "do some work") {
    const r = runHook(
      "user-prompt-submit.cjs",
      { session_id: sessionId, prompt },
      { dataDir: dir, home }
    );
    assert.equal(r.status, 0, `hook must exit 0, got ${r.status}: ${r.stderr}`);
    const out = r.stdout.trim();
    return out === "" ? null : JSON.parse(out);
  }

  function contextOf(parsed) {
    return parsed?.hookSpecificOutput?.additionalContext || null;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-ups-data-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-ups-home-"));
  });
  after(() => restoreEnv());

  it("row 2: the first prompt of a session points at memory-search", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-first", source: "startup" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-first"));
    assert.ok(ctx, "first prompt must inject context");
    assert.match(ctx, /memory-search/);
  });

  it("row 4: every later prompt is silent — the flag is consumed once", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-once", source: "startup" },
      { dataDir: dir, home }
    );
    assert.ok(contextOf(submit("m-once")), "first prompt speaks");
    assert.equal(submit("m-once"), null, "second prompt must be silent");
    assert.equal(submit("m-once"), null, "third prompt must be silent");
  });

  it("row 3: the first prompt after a compaction asks to re-ground", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-comp", source: "startup" },
      { dataDir: dir, home }
    );
    submit("m-comp"); // burn the first-prompt flag
    runHook(
      "session-start.cjs",
      { session_id: "m-comp", source: "compact" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-comp"));
    assert.ok(ctx, "post-compact prompt must inject context");
    assert.match(ctx, /compacted/i);
  });

  it("row 1: a snoozed session is silent, and the snooze does not burn the flag", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-snz", source: "startup" },
      { dataDir: dir, home }
    );
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ snoozeSessionId: "m-snz" }));
    assert.equal(submit("m-snz"), null, "snoozed must be silent");

    // Lifting the snooze must reveal the still-unconsumed flag. If the snoozed
    // path had consumed it, this would stay silent forever and `/gutt off`
    // would permanently cost the user their session's one injection.
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({}));
    assert.ok(contextOf(submit("m-snz")), "flag survived the snooze");
  });

  it("never blocks: no decision field, and unparseable stdin still exits 0", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-safe", source: "startup" },
      { dataDir: dir, home }
    );
    const parsed = submit("m-safe");
    assert.equal(parsed.decision, undefined, "must never set `decision` (R23)");

    const bad = spawnSync("node", [path.join(HOOKS, "user-prompt-submit.cjs")], {
      input: "{not json",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, HOME: home, USERPROFILE: home },
    });
    assert.equal(bad.status, 0, "a malformed payload must not take the hook down");
  });

  it("carries no nag phrasing — factual statements only (GP-868)", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-tone", source: "startup" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-tone"));
    // Imperative, out-of-band framing is what trips Claude's prompt-injection
    // defenses, which surfaces the text to the user instead of using it.
    assert.doesNotMatch(ctx, /MANDATORY|YOU MUST|you MUST|NEVER skip|CRITICAL violation/);
  });
});

// ---------------------------------------------------------------------------
// Latency budget (AC2 / R25)
// ---------------------------------------------------------------------------

describe("session lifecycle: synchronous path stays inside the latency budget", () => {
  let dir;

  /**
   * Re-seed the worst dirty state a real machine can present: expired sessions,
   * a queue with stale entries, an oversized log, a lapsed snooze, and debris.
   *
   * Repeatable on purpose. It used to run once in before(), which meant the
   * latency loop swept an already-clean dir for 39 of its 40 samples and the
   * bounding assertions below silently depended on that loop having run first.
   */
  function seedDirtyState() {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      const f = path.join(dir, "sessions", `bench-${i}.json`);
      fs.writeFileSync(f, "{}");
      if (i % 2 === 0) {
        const old = new Date(Date.now() - 48 * HOUR);
        fs.utimesSync(f, old, old);
      }
    }
    fs.writeFileSync(
      path.join(dir, "hook-invocations.log"),
      `${"[2026-07-27 00:00:00] Prompt: lorem ipsum dolor sit amet".padEnd(79)}\n`.repeat(5000)
    );
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ snoozeUntil: new Date(Date.now() - HOUR).toISOString() })
    );
    // Debris from hooks killed mid-write: a lock whose session id will never be
    // reused (so nothing ever contends for it to trigger stale reclamation) and
    // an orphaned atomic-write temp. Backdated past DEBRIS_TTL_MS so the sweep
    // is entitled to reclaim them; the fresh pair below must survive.
    const stale = new Date(Date.now() - 2 * HOUR);
    for (const f of [
      path.join(dir, "sessions", "bench-0.json.lock"),
      path.join(dir, "sessions", "bench-0.json.tmp.1234"),
      // Root-level debris has to be a temp, not a lock: config.json is contended
      // by the sweep's own clearExpiredSnooze, so a stale lock there is reclaimed
      // by withLock and would prove nothing about this step. A temp filename is
      // never reused, so nothing but root-debris will ever remove it.
      path.join(dir, "capture-queue.jsonl.tmp.1234"),
    ]) {
      fs.writeFileSync(f, "");
      fs.utimesSync(f, stale, stale);
    }
    fs.writeFileSync(path.join(dir, "sessions", "live.json.lock"), "");
  }

  before(() => {
    dir = makeDataDir();
  });

  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One SessionStart's synchronous work: the hook's own ttlSweep — not a copy,
   * which would keep passing while the real sweep grew a slow step or lost one
   * — plus the single state write that follows it.
   *
   * Measured in-process on purpose. Wall-clock for the spawned hook is dominated
   * by node's own interpreter startup (~20-50ms depending on the machine), which
   * no hook can influence and which would make this a coin flip on a loaded CI
   * box. What GP-863 controls is the work below.
   */
  function sweepOnce(i) {
    ttlSweep();
    sessionState.init(`bench-run-${i}`);
    sessionState.beginSession(`bench-run-${i}`, "startup");
  }

  /**
   * @param {number} n samples
   * @param {(i: number) => void} run the timed work
   * @param {(i: number) => void} [prepare] untimed setup, run before each sample
   *   — seeding writes ~400KB and would otherwise dominate the measurement
   * @returns {{p95: number, max: number}}
   */
  function measure(n, run, prepare) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      prepare?.(i);
      const started = process.hrtime.bigint();
      run(i);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return { p95: samples[Math.ceil(0.95 * n) - 1], max: samples[n - 1] };
  }

  it("sweep + state write stays well under 50ms p95", () => {
    // The R25 assertion proper, on the steady state — which is what a real p95
    // is made of. A dirty dir is swept clean by the first SessionStart after it
    // goes dirty; every subsequent one finds nothing to reclaim, so the dirty
    // case below is a tail event, not the 95th percentile.
    //
    // 40 samples after a warmup: p95 then tolerates two outliers rather than
    // one, so a GC pause or a noisy CI neighbour can't fail the run without the
    // budget genuinely being blown.
    seedDirtyState();
    sweepOnce("warmup"); // absorbs the dirt, plus cold-start I/O and JIT
    const { p95 } = measure(40, sweepOnce);
    assert.ok(
      p95 < 50,
      `steady-state sweep + write p95 was ${p95.toFixed(1)}ms, budget 50ms (R25)`
    );
  });

  it("a cold sweep of a fully dirty dir stays bounded", () => {
    // The tail the test above deliberately excludes: the first SessionStart
    // after a dirty period, re-seeded before every sample so each one pays the
    // full cost. This is real work — reclaiming 30 session files and rewriting
    // a 400KB log — and it is not free: measured on an M4 at p95 33-37ms with
    // occasional maxima past 50ms, against a steady state of 1-9ms.
    //
    // So the budget here is a regression guard, not R25: 250ms is ~4x the worst
    // observed locally, leaving room for a slower CI disk while still catching
    // anything that makes the sweep super-linear. If this starts failing, the
    // sweep got algorithmically worse — don't just raise the number.
    seedDirtyState();
    sweepOnce("warmup");
    const { p95, max } = measure(20, sweepOnce, seedDirtyState);
    assert.ok(
      p95 < 250,
      `cold dirty sweep p95 was ${p95.toFixed(1)}ms (max ${max.toFixed(1)}ms), guard is 250ms`
    );
  });

  it("the dirty-state sweep actually bounded every artifact", () => {
    // Seeds and sweeps for itself, so running this test alone still works.
    seedDirtyState();
    ttlSweep();

    assert.ok(fs.statSync(path.join(dir, "hook-invocations.log")).size < 256 * 1024, "log trimmed");
    assert.equal(runtimeConfig.readConfig().snoozeUntil, null, "snooze expired");

    const sessions = path.join(dir, "sessions");
    // Seeded even-numbered bench files were backdated 48h; odd ones are fresh.
    assert.equal(fs.existsSync(path.join(sessions, "bench-0.json")), false, "expired file swept");
    assert.equal(fs.existsSync(path.join(sessions, "bench-1.json")), true, "fresh file kept");
    assert.equal(
      fs.readdirSync(sessions).filter((f) => /^bench-\d+\.json$/.test(f)).length,
      30,
      "exactly the 30 backdated files were reclaimed"
    );
  });
});
