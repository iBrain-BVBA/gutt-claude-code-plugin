#!/usr/bin/env node
/**
 * GP-893 AC1, failure paths: a hook that dies mid-flight must leave the same
 * clean filesystem a healthy run does.
 *
 * The happy path is covered by the AC1 watch every other e2e file now carries.
 * What no healthy run can show is hygiene under a crash — a hook killed halfway
 * through destructive work is exactly the writer of the debris the TTL sweep's
 * `session-debris` / `root-debris` steps exist for. Two runs, two different
 * lifecycle points:
 *
 *   1. SessionStart dies after its TTL sweep ran — start-of-session, state
 *      record never written.
 *   2. Stop dies after the judge was consulted — end-of-turn, deep inside a
 *      lib call, with the router's own crash guard bypassed so the throw
 *      actually kills the process (in production `guard()` swallows it; a
 *      swallowed throw is the covered case, a killing one is this suite's).
 *
 * How the sabotage reaches a real run: hooks are `node <script>` children of the
 * CLI, and NODE_OPTIONS is inherited environment — so a `--require` preload (the
 * same mechanism the unit tier's poisonProbe uses in-process) rides into every
 * node process of the run and no-ops everywhere but the targeted script. Each
 * poison writes a marker file into the throwaway project dir immediately before
 * throwing: without that, a poison that silently stopped firing would turn both
 * runs into healthy ones and this suite into decoration.
 *
 * What is deliberately not asserted: that the judge's *child* session behaves.
 * A --plugin-dir child has no installed copy of the plugin to re-enter, so the
 * nested-run guard's real shape is unreachable from this tier (see
 * hooks/lib/nested-run.cjs); its writes land in CLI-owned dirs the watch
 * sanctions anyway.
 *
 * Cost: two Haiku sessions, a few cents. Not part of `npm test`.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  PLUGIN_DIR,
  claudeVersion,
  createProject,
  removeDir,
  runClaude,
  stopOutcomes,
  withPlantedConfig,
} = require("./lib/claude-run.cjs");
const { beginStateWatch } = require("./lib/fs-snapshot.cjs");

const version = claudeVersion();

// GP-893 AC1 watermark: taken at module load, before anything here plants bait or
// launches a run, so everything this file's runs create falls inside the window.
const stateWatch = version ? beginStateWatch() : null;

if (!version && process.env.GUTT_E2E_REQUIRED === "1") {
  throw new Error(
    "GUTT_E2E_REQUIRED=1 but the `claude` CLI is unusable — refusing to report a green " +
      "run that asserted nothing"
  );
}

const skip = version ? false : "the `claude` CLI is not available on PATH";

const SWEEP_LIB = path.join(PLUGIN_DIR, "hooks", "lib", "session-sweep.cjs");
const DEBUG_LIB = path.join(PLUGIN_DIR, "hooks", "lib", "debug.cjs");
const JUDGE_LIB = path.join(PLUGIN_DIR, "hooks", "lib", "stop-judge.cjs");

/** Files a poisoned run may leave in its project dir, beyond the fixture's own. */
const PROJECT_ALLOWANCE = ["CLAUDE.md", "settings.json", "claude-debug.log", "latest"];

/**
 * Write a `--require` preload into the project dir and return the NODE_OPTIONS
 * value that arms it. The preload runs in every node process the run spawns —
 * the CLI itself included — so `body` must begin with an argv gate.
 * @param {string} projectDir
 * @param {string} name
 * @param {string} body
 * @returns {{nodeOptions: string, poisonFile: string}}
 */
function armPoison(projectDir, name, body) {
  const poisonFile = path.join(projectDir, name);
  fs.writeFileSync(poisonFile, body);
  // NODE_OPTIONS has no quoting mechanism a path with spaces survives; the
  // mkdtemp roots this suite uses have none, and a rename that introduces one
  // should fail here rather than as an inscrutable CLI launch error.
  assert.ok(!poisonFile.includes(" "), `poison path contains a space: ${poisonFile}`);
  return { nodeOptions: `--require ${poisonFile}`, poisonFile };
}

/** Everything in the project dir that neither the fixture nor the poison put there. */
function strayProjectFiles(projectDir, extraAllowed) {
  const allowed = new Set([...PROJECT_ALLOWANCE, ...extraAllowed]);
  return fs.readdirSync(projectDir).filter((name) => !allowed.has(name));
}

describe(
  "GP-893 AC1 failure path 1: SessionStart dies mid-flight, after its sweep ran",
  { skip, timeout: 360000 },
  () => {
    let projectDir;
    let run;
    let marker;

    before(
      async () => {
        projectDir = createProject("poisoned-start");
        marker = path.join(projectDir, "poison-fired.flag");
        const { nodeOptions } = armPoison(
          projectDir,
          "poison-session-start.cjs",
          `if ((process.argv[1] || "").endsWith("session-start.cjs")) {\n` +
            `  const target = require.resolve(${JSON.stringify(SWEEP_LIB)});\n` +
            `  require(target);\n` +
            `  const real = require.cache[target].exports.ttlSweep;\n` +
            `  require.cache[target].exports.ttlSweep = () => {\n` +
            `    real();\n` +
            `    require("fs").writeFileSync(${JSON.stringify(marker)}, "sweep ran");\n` +
            `    throw new Error("e2e poison: SessionStart killed mid-flight");\n` +
            `  };\n` +
            `}\n`
        );
        run = await runClaude({
          projectDir,
          prompt: "Reply with exactly: pong",
          extraEnv: { NODE_OPTIONS: nodeOptions },
        });
      },
      { timeout: 340000 }
    );

    after(() => {
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("the poison provably fired: the sweep ran and then the hook was killed", () => {
      assert.ok(
        fs.existsSync(marker),
        "the poison never reached ttlSweep — this run tested nothing"
      );
    });

    it("the session record was never begun — the crash landed before beginSession", () => {
      // The async connectivity sibling still creates the session file, and it
      // initialises `source` to null; only beginSession writes the real value.
      // So null and absent both mean "never begun" — a string means it ran.
      const source = run.state ? run.state.source : undefined;
      assert.ok(
        source === null || source === undefined,
        `beginSession ran despite the poison: state carries source=${source}`
      );
    });

    it("the session itself survives a dead SessionStart hook", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.ok(run.result, "no result envelope in stdout");
      assert.equal(run.result.is_error, false);
    });

    it("leaves nothing in the project dir beyond the fixture and the poison", () => {
      const strays = strayProjectFiles(projectDir, [
        "poison-session-start.cjs",
        "poison-fired.flag",
      ]);
      assert.deepEqual(
        strays,
        [],
        `the crashed run littered the project dir: ${strays.join(", ")}`
      );
    });
  }
);

describe(
  "GP-893 AC1 failure path 2: Stop dies mid-flight, after the judge was consulted",
  { skip, timeout: 360000 },
  () => {
    let projectDir;
    let run;
    let marker;

    before(
      async () => {
        projectDir = createProject("poisoned-stop");
        marker = path.join(projectDir, "poison-fired.flag");
        // Bypass the router's own crash guard for exactly its "judge" step — inner
        // guards stay real, so lib-internal recoveries keep working and the only
        // change is that the wrapper's throw kills the process instead of being
        // logged and swallowed.
        const { nodeOptions } = armPoison(
          projectDir,
          "poison-stop.cjs",
          `if ((process.argv[1] || "").endsWith("stop-capture.cjs")) {\n` +
            `  const debugLib = require.resolve(${JSON.stringify(DEBUG_LIB)});\n` +
            `  require(debugLib);\n` +
            `  const realGuard = require.cache[debugLib].exports.guard;\n` +
            `  require.cache[debugLib].exports.guard = (hook, label, fn) =>\n` +
            `    hook === "Stop" && label === "judge" ? fn() : realGuard(hook, label, fn);\n` +
            `  const judgeLib = require.resolve(${JSON.stringify(JUDGE_LIB)});\n` +
            `  require(judgeLib);\n` +
            `  const realJudge = require.cache[judgeLib].exports.judgeTurn;\n` +
            `  require.cache[judgeLib].exports.judgeTurn = (payload, mode) => {\n` +
            `    realJudge(payload, mode);\n` +
            `    require("fs").writeFileSync(${JSON.stringify(marker)}, "judge ran");\n` +
            `    throw new Error("e2e poison: Stop killed mid-flight");\n` +
            `  };\n` +
            `}\n`
        );
        // Pin the config: with the developer's own config inherited, a disabled or
        // snoozed plugin returns before judgeTurn and the poison never fires.
        await withPlantedConfig({ enabled: true, mode: "auto" }, async () => {
          run = await runClaude({
            projectDir,
            prompt: "Reply with exactly: pong",
            extraEnv: { NODE_OPTIONS: nodeOptions },
          });
        });
      },
      { timeout: 340000 }
    );

    after(() => {
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("the poison provably fired: the judge was consulted and then the hook was killed", () => {
      assert.ok(
        fs.existsSync(marker),
        "the poison never reached judgeTurn — this run tested nothing"
      );
    });

    it("the router died before its own log line — a genuinely mid-flight death", () => {
      // A healthy judged turn always appends exactly one Stop line; the wrapper
      // throws between judgeTurn and that append, so this run must show none.
      const outcomes = stopOutcomes(run);
      assert.equal(
        outcomes.length,
        0,
        `the Stop router reached its log line despite the poison:\n${outcomes
          .map((o) => o.line)
          .join("\n")}`
      );
    });

    it("the session itself survives a dead Stop hook", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.ok(run.result, "no result envelope in stdout");
      assert.equal(run.result.is_error, false);
    });

    it("leaves nothing in the project dir beyond the fixture and the poison", () => {
      const strays = strayProjectFiles(projectDir, ["poison-stop.cjs", "poison-fired.flag"]);
      assert.deepEqual(
        strays,
        [],
        `the crashed run littered the project dir: ${strays.join(", ")}`
      );
    });
  }
);

describe("GP-893 AC1: filesystem hygiene across this file's runs", { skip }, () => {
  it("created nothing outside the sanctioned roots", () => stateWatch.assertNoStrays());
  it("left the repo working tree exactly as it found it", () => stateWatch.assertRepoUnchanged());
});
