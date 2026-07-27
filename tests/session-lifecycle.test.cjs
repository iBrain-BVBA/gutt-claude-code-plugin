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
const { spawnSync } = require("child_process");

const pluginState = require("../shared/plugin-state.cjs");
const sessionState = require("../shared/session-state.cjs");
const runtimeConfig = require("../shared/runtime-config.cjs");
const { guard } = require("../shared/debug.cjs");

const HOOKS = path.join(__dirname, "..", "gutt-core", "hooks");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

  it("clear zeroes the counters; resume and compact keep them", () => {
    sessionState.init("s-counters");
    sessionState.beginSession("s-counters", "startup");
    sessionState.incrementMemoryQueries();
    sessionState.incrementLessonsCaptured();
    sessionState.incrementSignificantOps();

    let state = sessionState.beginSession("s-counters", "resume");
    assert.equal(state.memoryQueries, 1, "resume keeps the tally");
    assert.equal(state.lessonsCaptured, 1);
    assert.equal(state.significantOps, 1);

    state = sessionState.beginSession("s-counters", "compact");
    assert.equal(state.memoryQueries, 1, "compact keeps the tally");

    state = sessionState.beginSession("s-counters", "clear");
    assert.equal(state.memoryQueries, 0, "clear resets");
    assert.equal(state.lessonsCaptured, 0);
    assert.equal(state.significantOps, 0);
  });

  it("beginSession never writes connectionStatus (the async hook owns it)", () => {
    sessionState.init("s-conn");
    sessionState.beginSession("s-conn", "startup");
    sessionState.setConnectionStatus("ok"); // stand-in for the async probe
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

  it("the lesson-prompt record replaces the retired marker file", () => {
    sessionState.beginSession("s-flags", "startup");
    assert.equal(sessionState.wasLessonsPrompted(), false);
    assert.equal(sessionState.markLessonsPrompted().written, true);
    assert.equal(sessionState.wasLessonsPrompted(), true);
    assert.equal(sessionState.clearLessonsPrompted(), true, "a new prompt re-arms it");
    assert.equal(sessionState.wasLessonsPrompted(), false);
    assert.equal(sessionState.clearLessonsPrompted(), false, "already clear");

    const strays = fs.readdirSync(dir).filter((f) => f.endsWith(".lessons-prompted"));
    assert.deepEqual(strays, [], "no marker files are created any more");
  });

  it("markLessonsPrompted reports failure so Stop can fail open", () => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_DATA;
    assert.equal(sessionState.markLessonsPrompted().written, false, "no data dir → not persisted");
    process.env.CLAUDE_PLUGIN_DATA = saved;
  });

  it("getState() hands out an independent ticker per call", () => {
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_DATA; // force the default-state path
    const a = sessionState.getState();
    a.ticker.items.push({ icon: "x", text: "leak" });
    assert.deepEqual(sessionState.getState().ticker.items, [], "defaults must not be shared");
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

  const queuePath = () => pluginState.statePath("capture-queue.jsonl");

  function writeQueue(entries) {
    fs.writeFileSync(queuePath(), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  function queueLines() {
    return fs.existsSync(queuePath())
      ? fs.readFileSync(queuePath(), "utf8").trim().split("\n").filter(Boolean)
      : [];
  }

  it("an oversized queue keeps its newest entries instead of being deleted", () => {
    // The 4MB cap exists so SessionStart never reads a huge file, not so the
    // user's un-drained captures get thrown away — and a queue only gets that
    // big precisely when nobody has drained it.
    const file = queuePath();
    const filler = `${JSON.stringify({ ts: new Date().toISOString(), n: "x".repeat(120) })}\n`;
    fs.writeFileSync(file, filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length)));
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), n: "newest" })}\n`);
    assert.ok(fs.statSync(file).size > 4 * 1024 * 1024, "fixture must exceed DISCARD_BYTES");

    const result = pluginState.pruneJsonl(file, { maxAgeMs: 7 * DAY, maxLines: 500 });

    assert.equal(result.discarded, true, "the unread head is reported as lost");
    assert.equal(fs.existsSync(file), true, "the queue must survive, not be unlinked");
    assert.ok(fs.statSync(file).size <= 4 * 1024 * 1024, "and it must now be bounded");
    assert.ok(
      queueLines().some((line) => line.includes("newest")),
      "the newest entry is exactly the one that must not be lost"
    );
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

  it("pruneJsonl drops entries past the TTL and keeps the rest", () => {
    writeQueue([
      { ts: new Date(Date.now() - 30 * DAY).toISOString(), n: "stale" },
      { ts: new Date(Date.now() - HOUR).toISOString(), n: "fresh" },
    ]);
    const res = pluginState.pruneJsonl(queuePath(), { maxAgeMs: 7 * DAY });
    assert.equal(res.removed, 1);
    assert.equal(queueLines().length, 1);
    assert.match(queueLines()[0], /fresh/);
  });

  it("pruneJsonl drops unparseable lines — no consumer can drain them", () => {
    fs.writeFileSync(queuePath(), '{"ts":"bad json\nnot json at all\n');
    const res = pluginState.pruneJsonl(queuePath(), { maxAgeMs: 7 * DAY });
    assert.equal(res.removed, 2);
    assert.equal(fs.existsSync(queuePath()), false, "nothing left → file removed");
  });

  it("pruneJsonl keeps an entry with no timestamp field", () => {
    writeQueue([{ n: "untimed" }]);
    assert.equal(pluginState.pruneJsonl(queuePath(), { maxAgeMs: 1 }).removed, 0);
    assert.equal(queueLines().length, 1);
  });

  it("pruneJsonl enforces the overflow cap, newest wins", () => {
    writeQueue(Array.from({ length: 10 }, (_, i) => ({ ts: new Date().toISOString(), n: i })));
    const res = pluginState.pruneJsonl(queuePath(), { maxAgeMs: DAY, maxLines: 4 });
    assert.equal(res.removed, 6);
    const kept = queueLines().map((l) => JSON.parse(l).n);
    assert.deepEqual(kept, [6, 7, 8, 9]);
  });

  it("pruneJsonl does not rewrite a clean file", () => {
    writeQueue([{ ts: new Date().toISOString(), n: 1 }]);
    const before = fs.statSync(queuePath()).mtimeMs;
    assert.equal(pluginState.pruneJsonl(queuePath(), { maxAgeMs: DAY }).removed, 0);
    assert.equal(fs.statSync(queuePath()).mtimeMs, before);
  });

  it("pruneJsonl and trimLog no-op on a missing file", () => {
    const missing = pluginState.statePath("nope.jsonl");
    assert.deepEqual(pluginState.pruneJsonl(missing, { maxAgeMs: DAY }), {
      removed: 0,
      discarded: false,
    });
    assert.deepEqual(pluginState.trimLog(missing, {}), { trimmed: false, discarded: false });
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
});

// ---------------------------------------------------------------------------
// Latency budget (AC2 / R25)
// ---------------------------------------------------------------------------

describe("session lifecycle: synchronous path stays inside the latency budget", () => {
  let dir;

  before(() => {
    dir = makeDataDir();
    // A deliberately dirty state dir: expired sessions to sweep, a queue with
    // stale entries, an oversized log, and a lapsed snooze — the worst case the
    // sweep can face on a real machine.
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      const f = path.join(dir, "sessions", `bench-${i}.json`);
      fs.writeFileSync(f, "{}");
      if (i % 2 === 0) {
        const old = new Date(Date.now() - 48 * HOUR);
        fs.utimesSync(f, old, old);
      }
    }
    const entries = Array.from({ length: 400 }, (_, i) =>
      JSON.stringify({ ts: new Date(Date.now() - (i < 100 ? 30 : 1) * DAY).toISOString(), n: i })
    );
    fs.writeFileSync(path.join(dir, "capture-queue.jsonl"), entries.join("\n") + "\n");
    fs.writeFileSync(
      path.join(dir, "hook-invocations.log"),
      `${"[2026-07-27 00:00:00] Prompt: lorem ipsum dolor sit amet".padEnd(79)}\n`.repeat(5000)
    );
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ snoozeUntil: new Date(Date.now() - HOUR).toISOString() })
    );
  });

  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sweep + state write stays well under 50ms p95", () => {
    // Measured in-process on purpose. Wall-clock for the spawned hook is
    // dominated by node's own interpreter startup (~20-50ms depending on the
    // machine), which no hook can influence and which would make this assertion
    // a coin flip on a loaded CI box. What GP-863 controls is the work below.
    //
    // 40 samples with the first discarded: p95 then tolerates two outliers
    // rather than one, so a GC pause or a noisy CI neighbour can't fail the run
    // without the budget genuinely being blown.
    const { statePath, sweep, pruneJsonl, trimLog } = pluginState;
    const sweepOnce = (i) => {
      sweep(statePath("sessions"), { maxAgeMs: DAY, match: (f) => f.endsWith(".json") });
      sweep(statePath(), { maxAgeMs: 0, match: (f) => f.endsWith(".lessons-prompted") });
      pruneJsonl(statePath("capture-queue.jsonl"), { maxAgeMs: 7 * DAY, maxLines: 500 });
      trimLog(statePath("hook-invocations.log"), { maxBytes: 256 * 1024, keepLines: 200 });
      runtimeConfig.clearExpiredSnooze();
      sessionState.init(`bench-run-${i}`);
      sessionState.beginSession(`bench-run-${i}`, "startup");
    };

    sweepOnce("warmup"); // cold-start I/O and JIT, not part of the measurement
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const started = process.hrtime.bigint();
      sweepOnce(i);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1];
    assert.ok(p95 < 50, `sweep + write p95 was ${p95.toFixed(1)}ms, budget is 50ms (R25)`);
  });

  it("the dirty-state sweep actually bounded every artifact", () => {
    assert.ok(
      fs.readFileSync(path.join(dir, "capture-queue.jsonl"), "utf8").trim().split("\n").length <=
        500,
      "queue capped"
    );
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
