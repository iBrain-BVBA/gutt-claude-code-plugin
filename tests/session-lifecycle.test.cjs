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

const pluginState = require("../gutt-core/hooks/lib/plugin-state.cjs");
const sessionState = require("../gutt-core/hooks/lib/session-state.cjs");
const runtimeConfig = require("../gutt-core/hooks/lib/runtime-config.cjs");
const { guard } = require("../gutt-core/hooks/lib/debug.cjs");
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
    sessionState.advanceTurn(); // the guard already ran this session
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
    assert.equal(sessionState.advanceTurn().firstPrompt, true);
    assert.equal(sessionState.advanceTurn().firstPrompt, false, "second read is false");

    sessionState.beginSession("s-flags", "compact");
    assert.equal(sessionState.advanceTurn().compacted, true);
    assert.equal(sessionState.advanceTurn().compacted, false);
  });

  it("a turn with nothing to consume and no recall seen does not rewrite the file", () => {
    // The unlocked fast path on the ≤50ms hot path (R25). It survives only while
    // both flags are spent *and* no recall has been recorded — once
    // turnsSinceSearch is a number every turn has to write to advance it.
    sessionState.beginSession("s-flags", "startup");
    sessionState.advanceTurn(); // drains firstPromptPending
    assert.equal(
      sessionState.getState().turnsSinceSearch,
      null,
      "precondition: no recall recorded, so there is nothing to advance"
    );
    const before = fs.statSync(path.join(dir, "sessions", "s-flags.json")).mtimeMs;
    assert.equal(sessionState.advanceTurn().firstPrompt, false);
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
// Recall recency — trigger-matrix row 4 (GP-864)
// ---------------------------------------------------------------------------

describe("recall recency: the turnsSinceSearch counter", () => {
  let dir;
  before(() => {
    dir = makeDataDir();
  });
  after(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stays null until a recall happens, so a fresh session is never gated", () => {
    sessionState.init("t-null");
    sessionState.beginSession("t-null", "startup");
    assert.equal(sessionState.advanceTurn().turnsSinceSearch, null);
    // null and 0 are easy to conflate and mean opposite things: "no recall in this
    // conversation" must not gate, "a recall just happened" must.
    assert.equal(sessionState.isRecallRecent(null), false, "null must gate nothing");
    assert.equal(sessionState.isRecallRecent(0), true, "0 is a real recall, not an absence");
  });

  it("counts one per turn from the recall, and reopens the gate on the sixth", () => {
    sessionState.init("t-count");
    sessionState.beginSession("t-count", "startup");
    sessionState.noteMemorySearch();

    const seen = [];
    for (let i = 0; i < 6; i++) {
      const { turnsSinceSearch } = sessionState.advanceTurn();
      seen.push([turnsSinceSearch, sessionState.isRecallRecent(turnsSinceSearch)]);
    }
    assert.deepEqual(
      seen,
      [
        [1, true],
        [2, true],
        [3, true],
        [4, true],
        [5, true],
        [6, false],
      ],
      `the ${sessionState.RECENT_SEARCH_TURNS} turns after a recall are gated; the next is not`
    );
  });

  it("a compaction advances the counter the way a turn does", () => {
    sessionState.init("t-comp");
    sessionState.beginSession("t-comp", "startup");
    sessionState.noteMemorySearch();
    assert.equal(sessionState.beginSession("t-comp", "compact").turnsSinceSearch, 1);
    assert.equal(sessionState.beginSession("t-comp", "compact").turnsSinceSearch, 2);
  });

  it("a compaction cannot invent a recall that never happened", () => {
    sessionState.init("t-comp-null");
    sessionState.beginSession("t-comp-null", "startup");
    assert.equal(
      sessionState.beginSession("t-comp-null", "compact").turnsSinceSearch,
      null,
      "advancing 'no recall yet' must not turn it into a number"
    );
  });

  it("startup and clear reset the counter; resume keeps it", () => {
    for (const source of ["startup", "clear"]) {
      const id = `t-reset-${source}`;
      sessionState.init(id);
      sessionState.beginSession(id, "startup");
      sessionState.noteMemorySearch();
      assert.equal(
        sessionState.beginSession(id, source).turnsSinceSearch,
        null,
        `${source} starts with an empty context, so an earlier recall must not gate its first prompt`
      );
    }

    sessionState.init("t-resume");
    sessionState.beginSession("t-resume", "startup");
    sessionState.noteMemorySearch();
    assert.equal(
      sessionState.beginSession("t-resume", "resume").turnsSinceSearch,
      0,
      "resume keeps the transcript, so the recall still in it still counts"
    );
  });

  it("noteMemorySearch resets a counter that had run on", () => {
    sessionState.init("t-reset-run");
    sessionState.beginSession("t-reset-run", "startup");
    sessionState.noteMemorySearch();
    sessionState.advanceTurn();
    sessionState.advanceTurn();
    assert.equal(sessionState.getState().turnsSinceSearch, 2);
    assert.equal(sessionState.noteMemorySearch().turnsSinceSearch, 0);
  });
});

describe("recall recency: which tool calls count as recall", () => {
  const RECALL = [
    "mcp__claude_ai_gutt-pro-memory__search",
    "mcp__claude_ai_gutt-pro-memory__search_memory_nodes",
    "mcp__claude_ai_gutt-pro-memory__search_memory_facts",
    "mcp__claude_ai_gutt-pro-memory__fetch_lessons_learned",
    "mcp__claude_ai_gutt-pro-memory__get_episodes",
    "mcp__claude_ai_gutt-pro-memory__find_path",
    "mcp__claude_ai_gutt-pro-memory__list_entities",
    "mcp__gutt-pro-memory__search_memory_nodes",
  ];

  const NOT_RECALL = [
    // Writes. Recording something is not recalling it, and a capture must not
    // silence the pointer that asks the agent to look things up.
    "mcp__claude_ai_gutt-pro-memory__add_memory_to_gutt_pro",
    "mcp__claude_ai_gutt-pro-memory__add_personal_memory",
    "mcp__claude_ai_gutt-pro-memory__delete_episode",
    "mcp__claude_ai_gutt-pro-memory__clear_graph",
    "mcp__claude_ai_gutt-pro-memory__register_agent",
    // Schema introspection reads the graph's shape, not anything remembered in it.
    "mcp__claude_ai_gutt-pro-memory__get_schema",
    "mcp__claude_ai_gutt-pro-memory__get_available_schemas",
    // A different server, and ordinary tools.
    "mcp__claude_ai_Atlassian__search",
    "mcp__claude_ai_Ahrefs__authenticate",
    "Read",
    "Grep",
    "",
  ];

  for (const name of RECALL) {
    it(`counts ${name}`, () => {
      assert.equal(sessionState.isRecallTool(name), true);
    });
  }

  for (const name of NOT_RECALL) {
    it(`ignores ${name || "(an empty tool name)"}`, () => {
      assert.equal(sessionState.isRecallTool(name), false);
    });
  }

  it("survives a tool name that is not a string", () => {
    // The hook coerces, but this is the one input it reads from an untrusted
    // payload before any guard, so the classifier has to hold on its own.
    for (const bad of [undefined, null, 123, {}, []]) {
      assert.equal(sessionState.isRecallTool(bad), false, `rejected ${JSON.stringify(bad)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// What a tool response proves about the connection. The settings-file probe can
// only establish that a server is configured; this is the one place a real round
// trip is visible.
// ---------------------------------------------------------------------------

describe("classifying what a gutt call came back with", () => {
  const { classifyToolResponse, isObservationFresh, OBSERVATION_TTL_MS } = sessionState;

  it("treats any non-error response as proof the server answered", () => {
    for (const response of [
      "some results",
      { content: [{ type: "text", text: "3 facts found" }] },
      { content: [] },
      {},
      "",
      undefined,
      null,
      42,
    ]) {
      assert.equal(
        classifyToolResponse(response),
        "ok",
        `should accept ${JSON.stringify(response)}`
      );
    }
  });

  it("recognises an authentication failure however it is framed", () => {
    for (const response of [
      "Access denied: you are not authorized for the requested group scope",
      { isError: true, content: [{ type: "text", text: "401 Unauthorized" }] },
      { error: "authentication required" },
      { is_error: true, content: [{ type: "text", text: "token expired" }] },
      "Error: forbidden",
    ]) {
      assert.equal(
        classifyToolResponse(response),
        "auth",
        `should flag ${JSON.stringify(response)}`
      );
    }
  });

  it("separates other failures from auth ones", () => {
    for (const response of [
      { isError: true, content: [{ type: "text", text: "upstream timeout" }] },
      { error: "ECONNREFUSED" },
      "Error: the graph is unavailable",
    ]) {
      assert.equal(classifyToolResponse(response), "error");
    }
  });

  it("does not mistake recalled content about auth for an auth failure", () => {
    // The trap this classifier exists to avoid. The graph holds episodes about
    // authentication incidents, so a *successful* search can return a body full of
    // the words an error would use. Matching on content would let memory working
    // correctly report the server as broken.
    const recalled = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            facts: [
              { fact: "The 401 Unauthorized incident was caused by an expired token" },
              { fact: "Access denied errors trace to the group scope check" },
            ],
          }),
        },
      ],
    };
    assert.equal(classifyToolResponse(recalled), "ok");
  });

  it("ages an observation out, and treats a missing one as unknown", () => {
    const now = Date.now();
    assert.equal(isObservationFresh(new Date(now - 1000).toISOString(), now), true);
    assert.equal(
      isObservationFresh(new Date(now - OBSERVATION_TTL_MS - 1).toISOString(), now),
      false
    );
    for (const bad of [null, undefined, "", "not a date"]) {
      assert.equal(isObservationFresh(bad, now), false);
    }
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

  it("advanceTurn hands the flag to exactly one of two racing readers", () => {
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

  // The sweep touches only the two snooze keys. That used to be phrased as "these
  // keys belong to GP-866, not to this module", which is no longer why: GP-866
  // landed `setEnabled`/`setMode` in this same module, so ownership is not what
  // separates them any more — scope is. `clearExpiredSnooze` goes through
  // `withoutSnooze`, and `restore()` (the `/gutt on` path) is the only thing here
  // that deletes `enabled`. Routing the sweep through `restore()` would break this.
  it("clearing snooze leaves the preference keys untouched", () => {
    pluginState.writeJson(runtimeConfig.configPath(), {
      enabled: false,
      mode: "manual",
      snoozeUntil: new Date(Date.now() - HOUR).toISOString(),
    });
    runtimeConfig.clearExpiredSnooze();
    const raw = runtimeConfig.readRawConfig();
    assert.equal(raw.enabled, false, "a durable off survives a snooze sweep");
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

  it("trimLog bounds an oversized log that has no line structure at all", () => {
    // Both axes at once: past DISCARD_BYTES *and* without a single newline. Only
    // that combination reaches readTail's partial-line drop with nothing behind the
    // cut. The test above is newline-free but small enough to take the plain
    // readFileSync path; the one at the top of this block is oversized but has
    // newlines. Neither gets there.
    //
    // What protects the file is the `rest.trim() !== ""` check — drop it and a 5MB
    // structureless hook-errors.log trims to nothing, with trimLog still reporting
    // {trimmed: true} and guard() seeing no throw, so the failure is invisible
    // precisely because the log is what got wiped. (The `nl === -1` ternary beside
    // it is belt-and-braces, not the guard: slice(-1 + 1) is slice(0), so without
    // the ternary `rest` would be the whole tail and the outcome identical.)
    const log = pluginState.statePath("hook-errors.log");
    fs.writeFileSync(log, "x".repeat(5 * 1024 * 1024));
    assert.ok(fs.statSync(log).size > 4 * 1024 * 1024, "fixture must exceed DISCARD_BYTES");

    const res = pluginState.trimLog(log, { maxBytes: 256 * 1024, keepLines: 200 });

    assert.equal(res.discarded, true, "the tail read must report it dropped content");
    assert.ok(fs.statSync(log).size <= 256 * 1024, "bounded to maxBytes");
    assert.ok(fs.statSync(log).size > 1, "bounded, not wiped to a single newline");
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
    // `enabled: false` is planted alongside the snooze because SessionEnd is the one
    // place "survives restarts" is actually delivered (GP-931 D3). If `SNOOZE_KEYS` or
    // `withoutSnooze` ever grew `enabled`, every `/gutt-pro:disable` would quietly
    // decay into a session-scoped off — the reversal undoing itself in the one
    // direction the in-process tests cannot see.
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ mode: "auto", enabled: false, snoozeSessionId: "e2e-end" })
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
    assert.equal(config.enabled, false, "a durable disable must outlive the session that saw it");
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

    // Namespaced, because the bare stem is not invocable: a real session lists the
    // skill as `gutt-pro:memory-search`, so pointing at
    // `memory-search` alone leaves the model guessing the prefix. This asserts the
    // text the hook actually emitted — the static guard in
    // hook-architecture.test.cjs cannot see a name composed at runtime, which is
    // exactly how a bare stem shipped once already.
    // Backticks included deliberately: they pin both ends of the id, so a typo'd
    // stem like `memory-searchh` fails instead of matching as a substring.
    assert.match(
      ctx,
      /`gutt-pro:memory-search`/,
      `the pointer must name the skill's full namespaced id, got: ${ctx}`
    );
  });

  it("the fall-through: every later prompt is silent — the flag is consumed once", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-once", source: "startup" },
      { dataDir: dir, home }
    );
    assert.ok(contextOf(submit("m-once")), "first prompt speaks");
    assert.equal(submit("m-once"), null, "second prompt must be silent");
    assert.equal(submit("m-once"), null, "third prompt must be silent");
  });

  /** Tell the plugin the agent just recalled something, the way PostToolUse does. */
  function recall(sessionId, toolName = "mcp__claude_ai_gutt-pro-memory__search_memory_nodes") {
    return runHook(
      "post-memory-search.cjs",
      { session_id: sessionId, tool_name: toolName, tool_input: {}, tool_response: "ok" },
      { dataDir: dir, home }
    );
  }

  it("row 4: a recent recall silences the pointer a compaction would inject", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-recent", source: "startup" },
      { dataDir: dir, home }
    );
    submit("m-recent"); // burn the first-prompt flag

    const r = recall("m-recent");
    assert.equal(r.status, 0, `the recall hook must exit 0: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "", "PostToolUse runs after the tool — it must emit nothing");
    assert.equal(readSession(dir, "m-recent").turnsSinceSearch, 0, "the recall was recorded");

    submit("m-recent");
    runHook(
      "session-start.cjs",
      { session_id: "m-recent", source: "compact" },
      { dataDir: dir, home }
    );
    assert.equal(submit("m-recent"), null, "a recall this recent makes the re-ground redundant");
  });

  it("row 4 opens again once the recall is far enough behind", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-stale", source: "startup" },
      { dataDir: dir, home }
    );
    submit("m-stale");
    recall("m-stale");

    // Walk out the whole window, so this asserts the gate reopens rather than that
    // it was never closed.
    for (let i = 0; i < sessionState.RECENT_SEARCH_TURNS; i++) {
      assert.equal(submit("m-stale"), null, `turn ${i + 1} after the recall is still gated`);
    }
    runHook(
      "session-start.cjs",
      { session_id: "m-stale", source: "compact" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-stale"));
    assert.ok(ctx, "past the window the re-ground pointer must fire again");
    assert.match(ctx, /compacted/i);
  });

  it("capturing a memory is not recalling one", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-write", source: "startup" },
      { dataDir: dir, home }
    );
    recall("m-write", "mcp__claude_ai_gutt-pro-memory__add_memory_to_gutt_pro");
    assert.equal(
      readSession(dir, "m-write").turnsSinceSearch,
      null,
      "a write must not start the recency clock"
    );
    assert.ok(contextOf(submit("m-write")), "so the first-prompt pointer still fires");
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

  it("row 1: a durable off is silent, and does not burn the flag either", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-off", source: "startup" },
      { dataDir: dir, home }
    );
    // The only test that proves `isSuppressed` is wired into the router rather than
    // merely exported. Before GP-866 this file was read by nobody and this prompt
    // would have spoken.
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ enabled: false }));
    assert.equal(submit("m-off"), null, "a durable off must be silent");

    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({}));
    assert.ok(contextOf(submit("m-off")), "flag survived the durable off");
  });

  // ---------------------------------------------------------------------------
  // Row 0 — the /gutt config commands (GP-866)
  // ---------------------------------------------------------------------------

  it("row 0: a config command reports the configuration", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-cfg", source: "startup" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-cfg", "/gutt-pro:config"));
    assert.ok(ctx, "a config command must be answered");
    assert.match(ctx, /enabled: true/);
    assert.match(ctx, /mode: auto/);
    assert.match(ctx, /snooze: none/);
  });

  it("row 0: a config turn does not burn the first-prompt flag", () => {
    runHook("session-start.cjs", { session_id: "m-nb", source: "startup" }, { dataDir: dir, home });
    assert.ok(contextOf(submit("m-nb", "/gutt-pro:config")), "the command is answered");
    assert.equal(
      readSession(dir, "m-nb").firstPromptPending,
      true,
      "a config turn is bookkeeping — it must not spend the session's one pointer"
    );
    const ctx = contextOf(submit("m-nb"));
    assert.match(ctx, /memory-search/, "the pointer is still owed after a config turn");
  });

  // The highest-value case here. Put row 0 below the suppression row and `/gutt-pro:on`
  // can never un-stick the plugin: the off switch becomes one-way and hand-editing
  // config.json is the only way back. Nothing else would report that.
  it("row 0 beats row 1: /gutt-pro:on works while the plugin is off", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-unstick", source: "startup" },
      { dataDir: dir, home }
    );
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ enabled: false }));
    assert.equal(submit("m-unstick"), null, "off, so an ordinary prompt is silent");

    const ctx = contextOf(submit("m-unstick", "/gutt-pro:on"));
    assert.ok(ctx, "/gutt-pro:on must be answered even while suppressed");
    assert.match(ctx, /back on/);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal("enabled" in raw, false, "`/gutt-pro:on` clears the key rather than storing true");
    assert.ok(contextOf(submit("m-unstick")), "and the pointer flows again");
  });

  it("row 0 beats row 1: a config command answers under a session snooze", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-snzcfg", source: "startup" },
      { dataDir: dir, home }
    );
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ snoozeSessionId: "m-snzcfg" })
    );
    const ctx = contextOf(submit("m-snzcfg", "/gutt-pro:config"));
    assert.match(ctx, /rest of this session/, "the snooze is reported, not obeyed");
  });

  it("row 0: a minute snooze suppresses the next prompt and expires at guard time", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-min", source: "startup" },
      { dataDir: dir, home }
    );
    assert.match(contextOf(submit("m-min", "/gutt-pro:off 30")), /30 minutes/);
    assert.equal(submit("m-min"), null, "snoozed by the command, so silent");

    // Guard-time expiry, through the real hook: the deadline is in the past, so the
    // row-1 check must let this through without waiting for a SessionStart sweep.
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ snoozeUntil: new Date(Date.now() - HOUR).toISOString() })
    );
    assert.ok(contextOf(submit("m-min")), "a lapsed deadline no longer suppresses");
  });

  it("row 0: bare /gutt-pro:off scopes to the session id the hook was handed", () => {
    // The one form whose success depends on session_id surviving the trip through the
    // hook: user-prompt-submit defaults a missing id to "unknown", and runOff refuses
    // on "unknown" rather than writing a snooze SessionEnd could never reclaim. Every
    // in-process test passes the id directly, so a break in that wiring would make the
    // flagship verb answer "could not scope a snooze" for every user while the unit
    // suite stayed green.
    runHook(
      "session-start.cjs",
      { session_id: "m-bareoff", source: "startup" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-bareoff", "/gutt-pro:off"));
    assert.match(ctx, /rest of this session/);
    assert.doesNotMatch(ctx, /could not scope/, "the session id did not reach the hook");

    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(raw.snoozeSessionId, "m-bareoff");
    assert.equal("enabled" in raw, false, "a session off must not write the durable flag");
    assert.equal(submit("m-bareoff"), null, "and it suppresses the next prompt");
  });

  it("row 0: an unrecognised /gutt-pro form changes nothing and says so", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-bad", source: "startup" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-bad", "/gutt-pro:off 30 and fix the tests"));
    assert.match(ctx, /did not recognise/);

    // Asserted per key rather than by the file's absence: SessionStart already
    // created config.json to record `migrationsVersion`, so "no file" was never the
    // right shape for this claim.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.deepEqual(
      Object.keys(raw).filter((k) => runtimeConfig.OWNED_KEYS.includes(k)),
      [],
      `a malformed command must write nothing, got ${JSON.stringify(raw)}`
    );
  });

  // GP-931 D2, at the router. The in-process half is covered in
  // `config-command.test.cjs`; this is the half that matters to a user, because a
  // legacy spelling reaching row 0 at all would mean `/gutt off` still mutating
  // config after D3 reversed what `off` means.
  it("row 0: a 3.0 spelling is ordinary prompt text now, not a command", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-legacy", source: "startup" },
      { dataDir: dir, home }
    );
    const ctx = contextOf(submit("m-legacy", "/gutt off 30"));
    // It may still draw the first-prompt memory pointer — it is a prompt like any
    // other now — but nothing from the config surface may appear in it.
    if (ctx) {
      assert.doesNotMatch(
        ctx,
        /did not recognise|memory recall is off|configuration, read from/,
        "a retired spelling must not reach the config surface"
      );
    }
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.deepEqual(
      Object.keys(raw).filter((k) => runtimeConfig.OWNED_KEYS.includes(k)),
      [],
      `a retired spelling must write nothing, got ${JSON.stringify(raw)}`
    );
  });

  it("never blocks: no decision field, and unparseable stdin still exits 0", () => {
    runHook(
      "session-start.cjs",
      { session_id: "m-safe", source: "startup" },
      { dataDir: dir, home }
    );
    const parsed = submit("m-safe");
    assert.equal(parsed.decision, undefined, "must never set `decision` (R23)");

    // The config commands are the one row that emits on a prompt the user typed
    // deliberately, which makes a `decision` here the most tempting mistake in the
    // hook: blocking would erase `/gutt-pro:off 30` and show the result to the user
    // instead of Claude. R23 forbids it on every row.
    const command = submit("m-safe", "/gutt-pro:config");
    assert.equal(command.decision, undefined, "not on a config command either (R23)");

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
   * an oversized log, a lapsed snooze, and debris.
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
      path.join(dir, "config.json.tmp.1234"),
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

    // The two debris steps had no outcome assertion at all: deleting either one
    // left this suite green. The fresh lock is the one that matters most — a wrong
    // DEBRIS_TTL_MS, or an isDebris that stopped consulting mtime, would reclaim a
    // lock out from under a hook that is still holding it.
    assert.equal(
      fs.existsSync(path.join(dir, "config.json.tmp.1234")),
      false,
      "root-debris reclaimed the orphaned temp"
    );
    assert.equal(
      fs.existsSync(path.join(sessions, "bench-0.json.lock")),
      false,
      "session-debris reclaimed the stale lock"
    );
    assert.equal(
      fs.existsSync(path.join(sessions, "bench-0.json.tmp.1234")),
      false,
      "session-debris reclaimed the orphaned temp"
    );
    assert.equal(
      fs.existsSync(path.join(sessions, "live.json.lock")),
      true,
      "a lock younger than DEBRIS_TTL_MS must survive — it may still be held"
    );
  });
});
