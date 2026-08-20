#!/usr/bin/env node
/**
 * GP-892 end-to-end: prove the *routing* behaviour of the rebuilt hook set
 * (GP-844) in real Claude Code sessions.
 *
 * `session-lifecycle.e2e.cjs` covers one startup session and the state contract.
 * This file covers the claims that only a live session can settle, each with its own
 * run:
 *
 *   Run 2  the anti-nag guarantee — two prompts, one SessionStart, one injection
 *   Run 3  the snooze row suppresses the pointer without consuming it
 *   Run 4  the Stop router fires, and then stops firing
 *   Run 5  R23 coexistence with a second plugin in the same session
 *   Run 6  a `/gutt` config command is applied, and the result reaches the model
 *
 * Why the debug log carries most of the weight here: a `type: "prompt"` hook has
 * no side effects at all. Its verdict never reaches disk, so a hook that was never
 * evaluated looks exactly like one that returned ok:true. The CLI's own log is the
 * only evidence that distinguishes them.
 *
 * Cost and prerequisites: five Haiku runs plus one Sonnet run (run 4), a few cents,
 * against the machine's logged-in subscription. Not part of `npm test`; see
 * tests/e2e/README.md.
 *
 * Run with: npm run test:e2e
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  COMPANION_PLUGIN_NAME,
  PLUGIN_DATA_ROOT,
  PLUGIN_DIR,
  REPO_ROOT,
  additionalContextEvents,
  claudeVersion,
  createCompanionPlugin,
  createProject,
  findSessionStateFile,
  hookCompletions,
  readJsonQuiet,
  removeDir,
  runClaude,
  runClaudeStream,
  sessionStartEvents,
  stopJudgements,
  stopOutcomes,
  withPlantedConfig,
} = require("./lib/claude-run.cjs");

const { OUTCOMES, BROKEN_OUTCOMES } = require("../../gutt-core/hooks/lib/stop-judge.cjs");

/**
 * The Stop outcomes this tier expects to see, read from the source of truth rather than
 * duplicated — a label renamed in `stop-judge.cjs` must fail here, not silently widen
 * what counts as recognised. The three router rows are not in `OUTCOMES` because the
 * router owns them, so they are listed.
 */
const KNOWN_STOP_OUTCOMES = [...Object.values(OUTCOMES), "skipped, already active", "suppressed"];

/** Outcomes that mean the judge failed rather than answering. */
const BROKEN_STOP_OUTCOMES = [...BROKEN_OUTCOMES];

/**
 * `deferred, N agent task(s) in flight: …` carries a count and task labels, so it is
 * matched by prefix rather than listed.
 * @param {string} outcome
 * @returns {boolean}
 */
function isKnownStopOutcome(outcome) {
  return KNOWN_STOP_OUTCOMES.includes(outcome) || outcome.startsWith("deferred, ");
}

/**
 * A session id per run, chosen up front so a test can plant config keyed to the
 * session it is about to launch instead of discovering the id afterwards.
 *
 * Freshly generated rather than hardcoded. The state sampler only samples files
 * that *appear* during a run — anything already on disk belongs to someone else —
 * so a fixed id silently stops producing samples from the second run onward, and
 * every assertion about transient state passes vacuously or fails for the wrong
 * reason. Learned the hard way.
 */
const IDS = {
  multiPrompt: crypto.randomUUID(),
  snoozed: crypto.randomUUID(),
  stopRouter: crypto.randomUUID(),
  stopRouterRetry: crypto.randomUUID(),
  stopRouterRetry2: crypto.randomUUID(),
  coexist: crypto.randomUUID(),
  configCommand: crypto.randomUUID(),
};

/**
 * The turn run 4 needs: one that leaves a durable **Insight** behind.
 *
 * Every tool is denied in that run, so the assistant cannot discover anything — the
 * finding has to come out of its own knowledge, which narrows the usable shapes a
 * lot. Two constraints found by measuring candidates against the live hook:
 *
 *   - It cannot be a **Decision**. The previous fixture asked the model to commit to
 *     a design choice with rationale, which fired 16/16 before GP-844 narrowed
 *     unprompted capture to Insight and Incident. Afterwards the judge correctly
 *     refuses it — "this is a Decision, which requires explicit user signal" — so the
 *     test was asserting against shipped policy.
 *   - It cannot be about this plugin. A session injects memory context, and the judge
 *     dedups against it: a fixture about hook loading drew "synthesizes existing
 *     memory ... already written" and fired 1/4. SQLite is a subject the graph holds
 *     nothing on.
 *
 * The misses are defensible calls rather than bugs — "restates documented SQLite
 * behaviour, not a novel organizational insight" — which is what `before` allows up to
 * three attempts for.
 */
const DURABLE_TURN =
  "Work this out from what I give you — do not run anything, and answer from your own " +
  "knowledge. In a SQLite database with a parent table and a child table declared " +
  "FOREIGN KEY ... ON DELETE CASCADE, a nightly job that refreshes parent rows with " +
  "INSERT OR REPLACE keeps losing every child row, even though no DELETE statement " +
  "appears anywhere in the job. Foreign keys are enabled. Explain the underlying " +
  "mechanism that makes the child rows disappear, and state what it means for anyone " +
  "using INSERT OR REPLACE as an upsert against a parent table.";

/**
 * Run 4 is the one run that cannot use the suite's default Haiku.
 *
 * The judge itself is always Haiku — a prompt-hook dispatch is followed immediately by a
 * `model=claude-haiku-4-5` call even inside a `--model sonnet` session, verified in the
 * debug log. What changes with the session model is the *turn being judged*: on this
 * prompt a Haiku assistant writes ~1,850 bytes and a Sonnet assistant ~3,000, and the
 * thinner answer reads to the judge as less of a finding. Measured on the same fixture and
 * the same prompt revision: **0/3 fires from Haiku turns, 2/3 from Sonnet turns.**
 *
 * So this is not the test buying itself a nicer grader. The assertion is that a turn which
 * produced a durable Insight gets routed, and it needs a turn that actually produced one.
 */
const ROUTER_MODEL = "claude-sonnet-5";

/**
 * Remove the state file this suite's own run created. Each run owns exactly one
 * session record; leaving them behind would litter the developer's data dir until
 * the 24h TTL sweep. Never touches a file this suite did not create.
 * @param {string} sessionId
 */
function dropOwnState(sessionId) {
  const file = findSessionStateFile(sessionId);
  if (file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort — cleanup must never fail a test */
    }
  }
}

/**
 * How many Stop evaluations one turn may cost before it counts as a loop.
 *
 * `ok:false` feeds the reason back and the turn continues, which re-fires Stop —
 * so an unbounded judge re-asks forever. One legitimate re-ask (the judge sees the
 * work land and relents) plus slack is 3. The probe that motivated this measured
 * **16** consecutive `ok:false` verdicts on a single turn, with `stop_hook_active`
 * true for 15 of them, ending in an empty reply to the user.
 */
const MAX_STOP_EVALUATIONS_PER_TURN = 3;

const version = claudeVersion();

// Same gate as the lifecycle suite: skipping is the default, but a suite that
// reports `pass 0 / fail 0` must not be mistaken for a green one where it is
// meant to gate.
if (!version && process.env.GUTT_E2E_REQUIRED === "1") {
  throw new Error(
    "GUTT_E2E_REQUIRED=1 but the `claude` CLI is unusable (missing from PATH, " +
      "non-zero exit, or timed out) — refusing to report a green run that asserted nothing"
  );
}

const skip = version ? false : "the `claude` CLI is not available on PATH";

// ---------------------------------------------------------------------------
// Run 2 — the anti-nag guarantee
// ---------------------------------------------------------------------------

describe(
  "GP-892 run 2: two prompts, one session, one memory pointer",
  { skip, timeout: 420000 },
  () => {
    let projectDir;
    let run;

    before(
      async () => {
        projectDir = createProject("multi-prompt");
        // Both prompts ask for a single word: the point of this run is the hook
        // accounting, and a chatty turn only buys judge latency.
        run = await runClaudeStream({
          projectDir,
          sessionId: IDS.multiPrompt,
          debugLabel: "claude-debug",
          prompts: ["Reply with exactly: alpha", "Reply with exactly: beta"],
        });
      },
      { timeout: 400000 }
    );

    after(() => {
      dropOwnState(IDS.multiPrompt);
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("answers both prompts in one session", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.equal(run.turns.length, 2, `expected 2 turns, saw ${run.turns.length}`);
      for (const turn of run.turns) {
        assert.equal(turn.is_error, false);
        assert.equal(turn.session_id, IDS.multiPrompt, "a turn ran under a different session id");
      }
      assert.match(String(run.turns[0].result), /alpha/i);
      assert.match(String(run.turns[1].result), /beta/i);
    });

    it("starts and ends the session exactly once across both prompts", () => {
      // Load-bearing for the next test rather than interesting on its own: if the
      // CLI had restarted the session between prompts, the second prompt would be a
      // *first* prompt again and "exactly one injection" would be vacuous.
      const starts = sessionStartEvents(run.debug);
      assert.deepEqual(
        starts,
        ["startup"],
        `expected one startup SessionStart, saw ${starts.join(", ")}`
      );
      const ends = hookCompletions(run.debug, "session-end.cjs");
      assert.deepEqual(
        ends,
        [0],
        `SessionEnd ran ${ends.length} times with statuses ${ends.join(", ")}`
      );
      assert.equal(run.state.source, "startup", "the session record was reopened mid-run");
    });

    it("injects the memory pointer exactly once — later prompts are silent (row 4)", () => {
      // The headline claim of the rebuild. 2.x injected on every prompt; the flag is
      // consumed on read, so exactly one of these two turns may carry an injection.
      const events = additionalContextEvents(run.debug);
      assert.equal(
        events.length,
        1,
        `expected exactly 1 additionalContext injection across 2 prompts, got ${events.length}:\n${events.join("\n")}`
      );
      assert.match(events[0], /user-prompt-submit\.cjs/, "the injection came from some other hook");
    });

    it("injects the first-prompt text, not the compaction text", () => {
      const injected = run.transcript
        .filter((row) => row.type === "attachment" && row.attachment)
        .map((row) => row.attachment)
        .filter((a) => a.type === "hook_additional_context")
        .flatMap((a) => [].concat(a.content))
        .join("\n");
      assert.match(injected, /organizational memory available through gutt/i);
      assert.doesNotMatch(injected, /compacted/i, "a startup session got the re-ground text");
    });

    it("convenes the Stop judge once per turn", () => {
      // Two turns, so two judgements. Fewer means Stop is not wired; more means a turn
      // was re-judged, which run 4 covers in detail.
      const judgements = stopJudgements(run.dataDir);
      assert.equal(judgements, 2, `expected 1 Stop judgement per turn, saw ${judgements}`);
    });

    it("records a recognised outcome for every Stop, and no broken judge", () => {
      // Replaces a verdict-parsing assertion that read the CLI's debug log. A command
      // hook logs its own outcome, which says more: it separates a judge that passed
      // from one that could not answer at all.
      const outcomes = stopOutcomes(run.dataDir);
      assert.ok(outcomes.length > 0, "the Stop hook left no record of running");
      for (const entry of outcomes) {
        assert.ok(
          isKnownStopOutcome(entry.outcome),
          `unrecognised Stop outcome "${entry.outcome}" in: ${entry.line}`
        );
        assert.ok(
          !BROKEN_STOP_OUTCOMES.includes(entry.outcome),
          `the judge failed rather than answering: ${entry.line}`
        );
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Run 3 — the snooze row
// ---------------------------------------------------------------------------

describe(
  "GP-892 run 3: a snoozed session stays silent without burning the flag",
  { skip, timeout: 420000 },
  () => {
    let projectDir;
    let run;
    let configAfterRun;

    before(
      async () => {
        projectDir = createProject("snoozed");
        // A session-scoped snooze with no deadline: in force for exactly this
        // session, and SessionEnd should drop it. `enabled`/`mode` belong to the
        // config command surface (GP-866) and must survive untouched.
        await withPlantedConfig(
          {
            enabled: true,
            mode: "auto",
            snoozeSessionId: IDS.snoozed,
            snoozeUntil: null,
          },
          async (configFile) => {
            run = await runClaude({
              projectDir,
              sessionId: IDS.snoozed,
              prompt: "Reply with exactly: pong",
            });
            // Read before withPlantedConfig restores the developer's own file.
            configAfterRun = readJsonQuiet(configFile);
          }
        );
      },
      { timeout: 400000 }
    );

    after(() => {
      dropOwnState(IDS.snoozed);
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("still answers the user normally", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.equal(run.result.is_error, false);
      assert.match(String(run.result.result), /pong/i);
    });

    it("injects nothing at all while snoozed (row 1)", () => {
      const events = additionalContextEvents(run.debug);
      assert.deepEqual(
        events,
        [],
        `a snoozed session still injected context:\n${events.join("\n")}`
      );
    });

    it("suppresses the pointer without consuming the one-shot flag", () => {
      // The subtle half of row 1: the snooze is checked *before* any flag is read,
      // so it must not burn the pointer it suppressed. SessionEnd clears the flag,
      // so the final file cannot show this — only a mid-run sample can.
      assert.ok(run.samples.length > 0, "no session-state samples were captured during the run");
      const armed = run.samples.filter((entry) => entry.state.firstPromptPending === true);
      assert.ok(
        armed.length > 0,
        `firstPromptPending was never observed set across ${run.samples.length} samples — ` +
          "the snooze consumed the flag it was supposed to suppress"
      );
    });

    it("drops the session-scoped snooze on SessionEnd and leaves the rest alone", () => {
      assert.ok(configAfterRun, "config.json vanished during the run");
      assert.equal(
        configAfterRun.snoozeSessionId,
        undefined,
        "the session-scoped snooze outlived its session"
      );
      assert.equal(configAfterRun.snoozeUntil, undefined, "a snooze deadline was left behind");
      // The carve-out: this module owns the snooze keys and nothing else.
      assert.equal(
        configAfterRun.enabled,
        true,
        "SessionEnd clobbered a key owned by the config commands"
      );
      assert.equal(
        configAfterRun.mode,
        "auto",
        "SessionEnd clobbered a key owned by the config commands"
      );
    });
  }
);

// ---------------------------------------------------------------------------
// Run 4 — the Stop router
// ---------------------------------------------------------------------------

describe(
  "GP-892 run 4: the Stop router fires, and then stops firing",
  { skip, timeout: 480000 },
  () => {
    let projectDir;
    /** Every session attempted, in order. `runs[0]` is the one the other tests read. */
    const runs = [];
    let run;

    /** Every turn across all attempts where the judge asked for a capture. */
    function routedVerdicts() {
      return runs.flatMap((r) => stopOutcomes(r.dataDir)).filter((o) => o.outcome === "fired");
    }

    before(
      async () => {
        projectDir = createProject("stop-router");
        // The verdict is a model call, and on this turn it fired 13 times out of 17
        // across three prompt revisions (~76%). One session is therefore a ~24%-flaky
        // basis for an at-least-once assertion; three independent draws take it under
        // 2%, and the extra sessions are only paid for on a roll that misses. Retrying
        // is honest here because the claim under test is that the routing path works at
        // all, not that this exact wording fires every single time.
        const ids = [IDS.stopRouter, IDS.stopRouterRetry, IDS.stopRouterRetry2];
        for (const sessionId of ids) {
          runs.push(
            await runClaude({ projectDir, sessionId, prompt: DURABLE_TURN, model: ROUTER_MODEL })
          );
          run = runs[0];
          if (routedVerdicts().length) {
            break;
          }
        }
      },
      { timeout: 460000 }
    );

    after(() => {
      dropOwnState(IDS.stopRouter);
      dropOwnState(IDS.stopRouterRetry);
      dropOwnState(IDS.stopRouterRetry2);
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("completes the session", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.ok(run.result, "no result envelope in stdout");
      assert.equal(run.result.is_error, false);
    });

    it("routes a durable turn into memory-capture at least once", () => {
      // Characterization, not contract: the verdict comes from a model call. Two
      // independent sessions at a measured 5/6 each, so a failure here means the
      // prompt has drifted conservative rather than the code breaking — read the
      // printed reasons, they say why the judge stayed quiet.
      const outcomes = runs.flatMap((r) => stopOutcomes(r.dataDir));
      assert.ok(outcomes.length > 0, "the Stop hook left no record of running");
      const routed = routedVerdicts();
      assert.ok(
        routed.length > 0,
        `no turn asked for a capture across ${runs.length} session(s) on a turn that ` +
          `produced an Insight:\n` +
          outcomes.map((o) => o.line).join("\n")
      );
      // That the reason names the skill is pinned by unit guards on JUDGE_CONDITION
      // (`tests/hook-architecture.test.cjs`, "asks for the skill line"), which is where a
      // wording claim belongs. Here the claim is only that the routing path fires.
    });

    it("bounds how many times one turn may be re-judged", () => {
      // The regression this whole run exists for. Without a termination condition the
      // judge re-asks on every re-entry: 16 consecutive ok:false verdicts on one turn,
      // 16 model calls, and an empty answer for the user.
      //
      // This used to count `Hooks: Processing prompt hook` lines in the CLI debug log.
      // After GP-866 made Stop a command hook, that string is never emitted, so the
      // count was always 0 and this assertion passed without testing anything — the
      // vacuous-guard failure this PR is otherwise about, sitting on a P1.
      const judgements = stopJudgements(run.dataDir);
      assert.ok(judgements > 0, "no Stop judgement recorded — the bound below is vacuous");
      assert.ok(
        judgements <= MAX_STOP_EVALUATIONS_PER_TURN,
        `the Stop hook judged one turn ${judgements} times (limit ${MAX_STOP_EVALUATIONS_PER_TURN}) — ` +
          "the judge has no termination condition and is looping"
      );
    });

    it("never judges a turn it has already judged", () => {
      // The router short-circuits on `stop_hook_active` in code now, before any child is
      // spawned, so re-entry is observable as its own outcome. Asserting the log exists
      // first keeps this from going quiet if Stop stops running altogether.
      const outcomes = stopOutcomes(run.dataDir);
      assert.ok(outcomes.length > 0, "the Stop hook left no record of running");
      const reentries = outcomes.filter((o) => o.outcome === "skipped, already active");
      for (const entry of reentries) {
        assert.doesNotMatch(
          entry.line,
          /\(mode=/,
          `a re-entered turn was judged again, which is what loops it: ${entry.line}`
        );
      }
    });

    it("still gives the user an answer", () => {
      // A looping Stop hook is not just wasteful: the probe's 16-verdict turn came
      // back with an empty result.
      const reply = String(run.result.result || "").trim();
      assert.notEqual(reply, "", "the turn ended with no answer for the user");
    });

    it("never leaks the judge protocol into the reply", () => {
      // The fed-back reason can pull the assistant into answering the *hook* instead
      // of the user. Observed: a reply that opened with a fenced {"ok": true}.
      const reply = String(run.result.result || "");
      assert.doesNotMatch(
        reply,
        /"ok"\s*:\s*(true|false)/,
        `the reply contains the judge's JSON: ${reply.slice(0, 300)}`
      );
      assert.doesNotMatch(
        reply,
        /^\s*```\s*json/i,
        `the reply opens with a JSON fence, which is the judge protocol surfacing: ${reply.slice(0, 200)}`
      );
    });
  }
);

// ---------------------------------------------------------------------------
// Run 5 — coexistence (R23)
// ---------------------------------------------------------------------------

describe(
  "GP-892 run 5: coexists with another plugin in one session (R23)",
  { skip, timeout: 420000 },
  () => {
    let projectDir;
    let companionDir;
    let run;

    before(
      async () => {
        projectDir = createProject("coexist");
        companionDir = createCompanionPlugin();
        run = await runClaude({
          projectDir,
          sessionId: IDS.coexist,
          pluginDirs: [PLUGIN_DIR, companionDir],
          prompt: "Reply with exactly: pong",
        });
      },
      { timeout: 400000 }
    );

    after(() => {
      dropOwnState(IDS.coexist);
      if (projectDir) {
        removeDir(projectDir);
      }
      if (companionDir) {
        removeDir(companionDir);
      }
    });

    it("loads both plugins from this working tree", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      const gutt = run.debug
        .split("\n")
        .filter((l) => /Read hooks\.json for plugin gutt-pro/.test(l));
      const companion = run.debug
        .split("\n")
        .filter((l) => new RegExp(`Read hooks\\.json for plugin ${COMPANION_PLUGIN_NAME}`).test(l));
      assert.equal(gutt.length, 1, `expected exactly one gutt plugin to load, got ${gutt.length}`);
      assert.equal(
        companion.length,
        1,
        `the companion plugin did not load: ${companion.length} reads`
      );
      assert.match(
        gutt[0],
        new RegExp(REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the loaded hooks.json is not the one in this repo"
      );
    });

    it("still runs the gutt lifecycle with a second plugin present", () => {
      assert.deepEqual(sessionStartEvents(run.debug), ["startup"]);
      assert.deepEqual(hookCompletions(run.debug, "session-end.cjs"), [0]);
      assert.ok(run.state, `no session state file for ${run.sessionId}`);
      assert.equal(run.state.sessionId, IDS.coexist);
      assert.ok(Number.isFinite(Date.parse(run.state.endedAt)), "the session was never finalized");
    });

    it("blocks nothing — no hook ends the session for another plugin (R23)", () => {
      // R23 is specifically that the hook set must not rely on `decision: block`.
      // Its original justification — that Cowork does not support it — is false:
      // measured on both Cowork surfaces, a command Stop hook's blocking decision is
      // honoured there exactly as on the CLI (`docs/hook-platform-capabilities.md` §9.1).
      // The assertion still earns its place, for the surviving half of the reason: a
      // blocking decision in a session shared with another plugin ends that plugin's
      // turn too, which is a coexistence problem whether or not the platform honours it.
      //
      // Scope worth stating, because the assertion reads stronger than it is: this passes
      // because the judge finds nothing to capture in this scenario, not because the hook
      // set never blocks. `stop-capture.cjs` emits `decision: "block"` on every fire.
      assert.equal(run.result.is_error, false);
      assert.match(String(run.result.result), /pong/i);
      assert.doesNotMatch(
        run.debug,
        /"decision"\s*:\s*"block"/,
        "a gutt hook emitted a blocking decision"
      );
      const blocked = run.transcript
        .filter((row) => row.type === "attachment" && row.attachment)
        .map((row) => row.attachment)
        .filter((a) => a.blockingError);
      assert.deepEqual(blocked, [], "a hook raised a blocking error in a shared session");
    });

    it("runs the companion's hook, rather than merely loading the plugin", () => {
      // Loading proves registration; a completion proves both plugins handled an event
      // in the same session, which is what coexistence has to mean. The companion's
      // handler sits on SessionEnd because that is the only event whose completion the
      // CLI attributes to a named script — SessionStart is registered as one opaque
      // async hook whose command never reaches the debug log, so a companion there is
      // unobservable rather than absent.
      assert.deepEqual(hookCompletions(run.debug, "noop.cjs"), [0]);
    });

    it("keeps its own state file, and the companion writes no state at all", () => {
      // Each plugin gets its own data dir, so the companion cannot reach gutt's state.
      // Asserting against the companion's *own* dir is what gives this teeth: a path
      // that already matched /gutt-pro-inline/ could not also contain the companion's
      // name, so checking for its absence there could never have failed.
      assert.match(run.stateFile, /gutt-pro-inline/);
      const companionData = path.join(PLUGIN_DATA_ROOT, `${COMPANION_PLUGIN_NAME}-inline`);
      const wrote = fs.existsSync(companionData) ? fs.readdirSync(companionData) : [];
      assert.deepEqual(wrote, [], `the companion plugin wrote state: ${wrote.join(", ")}`);
    });
  }
);

// ---------------------------------------------------------------------------
// Run 6 — the /gutt config command surface (GP-866)
// ---------------------------------------------------------------------------

describe(
  "GP-892 run 6: a /gutt config command is applied deterministically and relayed",
  { skip, timeout: 420000 },
  () => {
    let projectDir;
    let run;
    let configAfterRun;
    const plantedAt = Date.now();

    before(
      async () => {
        projectDir = createProject("config-command");
        // Planted empty so the run starts from the documented defaults, and so the
        // developer's own config is restored afterwards either way.
        await withPlantedConfig({}, async (configFile) => {
          run = await runClaudeStream({
            projectDir,
            sessionId: IDS.configCommand,
            debugLabel: "claude-debug",
            // The namespaced spelling first, deliberately: it is what the `/` menu
            // inserts, so it is the form real users produce, and a parser that only
            // handled the hand-typed variants would fail exactly here.
            prompts: ["/gutt-pro:off 30", "/gutt-pro:config"],
          });
          configAfterRun = readJsonQuiet(configFile);
        });
      },
      { timeout: 400000 }
    );

    after(() => {
      dropOwnState(IDS.configCommand);
      if (projectDir) {
        removeDir(projectDir);
      }
    });

    it("answers both command turns without erroring", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      assert.equal(run.turns.length, 2, `expected 2 turns, saw ${run.turns.length}`);
      for (const turn of run.turns) {
        assert.equal(turn.is_error, false);
      }
    });

    it("applies the command and injects the outcome, on both turns", () => {
      // Two injections and no memory pointer: row 0 returns before the pointer rows,
      // so a config turn spends nothing. That is the whole reason it sits where it
      // does.
      const events = additionalContextEvents(run.debug);
      assert.equal(
        events.length,
        2,
        `expected one injection per command turn, got ${events.length}:\n${events.join("\n")}`
      );
      for (const event of events) {
        assert.match(event, /user-prompt-submit\.cjs/, "the injection came from some other hook");
      }
    });

    it("writes the snooze to config.json and nothing else", () => {
      assert.ok(configAfterRun, "config.json vanished during the run");
      const until = Date.parse(configAfterRun.snoozeUntil);
      assert.ok(
        Number.isFinite(until),
        `no snooze deadline was written: ${configAfterRun.snoozeUntil}`
      );
      // Generous window: the run takes tens of seconds and the deadline is stamped
      // when the hook fires, not when the test planted the file.
      const minutesOut = (until - plantedAt) / 60000;
      assert.ok(
        minutesOut > 29 && minutesOut < 35,
        `expected a deadline ~30 minutes out, got ${minutesOut.toFixed(1)} minutes`
      );
      assert.equal(
        "enabled" in configAfterRun,
        false,
        "a minute snooze must not touch the durable off flag"
      );
    });

    it("relays the outcome to the user rather than flagging it (GP-868)", () => {
      // The one thing no other tier can settle. The injected text is factual prose,
      // so the model should consume it and report; the failure mode this catches is
      // Claude surfacing it as a suspicious out-of-band instruction, or ignoring it
      // and improvising about config it never read.
      const first = String(run.turns[0].result);
      assert.match(
        first,
        /30 minutes|30-minute/i,
        `the model did not relay the applied change:\n${first}`
      );
      const second = String(run.turns[1].result);
      assert.match(second, /snooze|enabled|recall/i, `/gutt config was not relayed:\n${second}`);
    });

    it("does not consume the session's memory pointer on a command turn", () => {
      assert.ok(run.samples.length > 0, "no session-state samples were captured during the run");
      const armed = run.samples.filter((entry) => entry.state.firstPromptPending === true);
      assert.ok(
        armed.length > 0,
        `firstPromptPending was never observed set across ${run.samples.length} samples — ` +
          "a config turn burned the pointer it never used"
      );
    });

    it("never blocks, on the one row the user typed on purpose (R23)", () => {
      assert.doesNotMatch(
        run.debug,
        /"decision"\s*:\s*"block"/,
        "the config row emitted a blocking decision — it would erase the user's command"
      );
    });
  }
);
