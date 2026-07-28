#!/usr/bin/env node
/**
 * GP-892 end-to-end: prove the *routing* behaviour of the rebuilt hook set
 * (GP-844) in real Claude Code sessions.
 *
 * `session-lifecycle.e2e.cjs` covers one startup session and the state contract.
 * This file covers the three claims that only a live session can settle, each with
 * its own run:
 *
 *   Run 2  the anti-nag guarantee — two prompts, one SessionStart, one injection
 *   Run 3  the snooze row suppresses the pointer without consuming it
 *   Run 4  the Stop router fires, and then stops firing
 *   Run 5  R23 coexistence with a second plugin in the same session
 *
 * Why the debug log carries most of the weight here: a `type: "prompt"` hook has
 * no side effects at all. Its verdict never reaches disk, so a hook that was never
 * evaluated looks exactly like one that returned ok:true. The CLI's own log is the
 * only evidence that distinguishes them.
 *
 * Cost and prerequisites: four Haiku runs, a few cents, against the machine's
 * logged-in subscription. Not part of `npm test`; see tests/e2e/README.md.
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
  PLUGIN_DIR,
  REPO_ROOT,
  additionalContextEvents,
  claudeVersion,
  createProject,
  findSessionStateFile,
  hookCompletions,
  promptHookEvaluations,
  readJsonQuiet,
  removeDir,
  runClaude,
  runClaudeStream,
  sessionStartEvents,
  stopHookActiveStates,
  stopVerdicts,
  withPlantedConfig,
} = require("./lib/claude-run.cjs");

const AUTO_LINT_DIR = path.join(REPO_ROOT, "auto-lint-plugin");

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
  coexist: crypto.randomUUID(),
};

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

    it("evaluates the Stop judge once per turn", () => {
      // Two turns, so two evaluations. Fewer means Stop is not wired; more means a
      // turn was re-prompted, which run 4 covers in detail.
      const evaluations = promptHookEvaluations(run.debug);
      assert.equal(evaluations, 2, `expected 1 Stop evaluation per turn, saw ${evaluations}`);
    });

    it("returns a parseable verdict from every Stop evaluation", () => {
      const verdicts = stopVerdicts(run.debug);
      assert.equal(verdicts.length, 2, `expected 2 verdicts, saw ${verdicts.length}`);
      for (const verdict of verdicts) {
        assert.ok(verdict.parsed, `unparseable Stop verdict: ${verdict.raw.slice(0, 200)}`);
        assert.equal(
          typeof verdict.parsed.ok,
          "boolean",
          `verdict carried no boolean ok: ${verdict.raw}`
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
    let run;

    before(
      async () => {
        projectDir = createProject("stop-router");
        // The *assistant* has to produce the durable content, because a turn with
        // every tool denied cannot discover anything on its own. A design decision
        // with rationale is the cheapest shape that reliably reads as durable.
        run = await runClaude({
          projectDir,
          sessionId: IDS.stopRouter,
          prompt:
            "Decide, and commit to one answer with your reasoning: for a hook that writes shared " +
            "JSON state from processes that run in parallel, should we use one global lock file or " +
            "a lock file per record? This is a design decision this project will follow.",
        });
      },
      { timeout: 460000 }
    );

    after(() => {
      dropOwnState(IDS.stopRouter);
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
      // Characterization, not contract: the verdict comes from a model call. On the
      // probe shapes this fired 16/16 for a design decision and 2/3 for an
      // articulated lesson, and 0/2 for a plain acknowledgement. If this ever starts
      // failing, the prompt has drifted conservative rather than the code breaking.
      const verdicts = stopVerdicts(run.debug);
      assert.ok(verdicts.length > 0, "the Stop hook was never evaluated");
      const routed = verdicts.filter((v) => v.parsed && v.parsed.ok === false);
      assert.ok(
        routed.length > 0,
        `no verdict asked for a capture on a turn that produced a decision:\n` +
          verdicts.map((v) => v.raw.slice(0, 200)).join("\n")
      );
      assert.match(
        String(routed[0].parsed.reason || ""),
        /memory-capture/i,
        "the reason fed back to Claude does not name the skill to run"
      );
    });

    it("bounds how many times one turn may be re-judged", () => {
      // The regression this whole run exists for. Without a termination condition
      // the judge re-asks on every re-entry: 16 consecutive ok:false verdicts on one
      // turn, 16 model calls, and an empty answer for the user.
      const evaluations = promptHookEvaluations(run.debug);
      assert.ok(
        evaluations <= MAX_STOP_EVALUATIONS_PER_TURN,
        `the Stop hook re-judged one turn ${evaluations} times (limit ${MAX_STOP_EVALUATIONS_PER_TURN}) — ` +
          "the judge has no termination condition and is looping"
      );
    });

    it("relents once Claude Code reports stop_hook_active", () => {
      // The platform hands the hook its own loop breaker. If the flag went true and
      // the very next verdict was still ok:false, the prompt is ignoring it.
      const active = stopHookActiveStates(run.debug);
      const verdicts = stopVerdicts(run.debug);
      const firstActive = active.indexOf(true);
      if (firstActive === -1) {
        return; // never re-entered — nothing to relent from
      }
      const verdictWhileActive = verdicts[firstActive];
      assert.ok(
        verdictWhileActive && verdictWhileActive.parsed,
        "no verdict recorded for the re-entered evaluation"
      );
      assert.equal(
        verdictWhileActive.parsed.ok,
        true,
        "the judge asked again after stop_hook_active went true, which is what loops the turn"
      );
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
    let run;

    before(
      async () => {
        projectDir = createProject("coexist");
        run = await runClaude({
          projectDir,
          sessionId: IDS.coexist,
          pluginDirs: [PLUGIN_DIR, AUTO_LINT_DIR],
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
    });

    it("loads both plugins from this working tree", () => {
      assert.equal(run.code, 0, `claude exited ${run.code}\nstderr: ${run.stderr}`);
      const gutt = run.debug
        .split("\n")
        .filter((l) => /Read hooks\.json for plugin gutt-claude-code-plugin/.test(l));
      const lint = run.debug
        .split("\n")
        .filter((l) => /Read hooks\.json for plugin auto-lint-plugin/.test(l));
      assert.equal(gutt.length, 1, `expected exactly one gutt plugin to load, got ${gutt.length}`);
      assert.equal(lint.length, 1, `auto-lint-plugin did not load: ${lint.length} reads`);
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
      // R23 is specifically that the hook set must not rely on `decision: block`,
      // which Cowork does not support and which would end a shared session.
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

    it("keeps its own state file, untouched by the other plugin", () => {
      // Each plugin gets its own data dir, so auto-lint cannot reach gutt's state.
      assert.match(run.stateFile, /gutt-claude-code-plugin-inline/);
      assert.doesNotMatch(run.stateFile, /auto-lint/);
    });
  }
);
