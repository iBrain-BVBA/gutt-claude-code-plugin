#!/usr/bin/env node
/**
 * GP-931 platform probe: does a bare `/config`, `/on`, `/off`, `/disable`, `/mode`
 * resolve to this plugin's command and reach UserPromptSubmit — and does bare
 * `/config` reach us at all, or is it swallowed by Claude Code's own `/config`?
 *
 * Built on the e2e harness so it is a real `claude` run against the working tree,
 * not a simulation. One session, one prompt per verb, config planted empty and
 * restored afterwards.
 *
 * The evidence is a whole-session census of `additionalContext` injections — which
 * only `configCommandResult` produces — plus each turn's own reply. The census is
 * flat rather than per-turn, so what it supports is a count, not an attribution:
 * five config-verb prompts producing four of our injections is what rules `/config`
 * out. It cannot show that `/config` produced *no* injection of any kind, because a
 * config-verb turn never emits the recall pointer anyway.
 *
 * A run with zero injections is a harness failure, not a negative result — every
 * verb here is one we already know resolves. It exits non-zero rather than printing
 * an all-negative table that would read as Measured evidence for the opposite
 * conclusion. Same for a short turn count: the reply loop pairs `PROMPTS[i]` with
 * `turns[i]`, so a dropped turn mislabels every reply after it.
 *
 * Deliberately **not** named `*.e2e.cjs`: `npm run test:e2e` globs that suffix, and this
 * is a probe rather than a guard — it costs real model calls and has no pass/fail. Its
 * result is recorded as Measured in `docs/plugin-platform-reference.md` §8; it lives here
 * so that result can be reproduced rather than taken on trust.
 *
 * Run: node tests/e2e/probes/bare-verb-resolution.cjs
 */
"use strict";

const path = require("path");
const REPO = path.join(__dirname, "..", "..", "..");
const { createProject, runClaudeStream, withPlantedConfig, removeDir, hookAttachments } = require(
  path.join(REPO, "tests/e2e/lib/claude-run.cjs")
);

// `/config` first: it is the one with a known built-in collision, and a later turn
// could not tell us whether the collision or our command won on a cold start.
const PROMPTS = ["/config", "/mode hitl", "/off", "/on", "/disable"];

// Text only `configCommandResult` emits. Matching the rendered block and the mutation
// replies separately, so a partial answer is visible rather than rounded to "no".
const OURS = /gutt configuration, read from|gutt memory recall is|gutt capture mode|gutt did not/i;

(async () => {
  const projectDir = createProject("gp931-bare-verb-probe");
  let run;
  try {
    await withPlantedConfig({}, async () => {
      run = await runClaudeStream({
        projectDir,
        debugLabel: "probe-debug",
        prompts: PROMPTS,
        timeoutMs: 420000,
      });
    });

    console.log(`\nexit=${run.code} turns=${run.turns.length} of ${PROMPTS.length} prompts`);
    if (run.stderr && run.stderr.trim()) {
      console.log(`stderr: ${run.stderr.trim().slice(0, 400)}`);
    }

    const injected = hookAttachments(run.transcript || [])
      .filter((a) => a.type === "hook_additional_context")
      .flatMap((a) => [].concat(a.content));

    console.log(`\n--- ${injected.length} additionalContext injection(s) ---`);
    injected.forEach((text, i) => {
      const mine = OURS.test(text);
      console.log(`[${i}] ours=${mine} :: ${String(text).replace(/\s+/g, " ").slice(0, 220)}`);
    });

    console.log(`\n--- per-turn replies ---`);
    (run.turns || []).forEach((turn, i) => {
      const reply = String(turn.result || turn.text || "").replace(/\s+/g, " ");
      console.log(
        `prompt ${JSON.stringify(PROMPTS[i])} err=${turn.is_error} :: ${reply.slice(0, 220)}`
      );
    });

    // Soundness gates. Neither is a finding about the platform — both mean the run
    // did not happen properly and its table must not be recorded as Measured.
    if (injected.length === 0) {
      console.log(
        "\nPROBE UNSOUND: no additionalContext at all. Either the transcript is missing " +
          "or the hook never ran — this is not evidence that the verbs failed to resolve."
      );
      process.exitCode = 1;
    }
    if ((run.turns || []).length !== PROMPTS.length) {
      console.log(
        `\nPROBE UNSOUND: ${run.turns?.length ?? 0} turns for ${PROMPTS.length} prompts — ` +
          "the per-turn replies above are misaligned from the first missing turn onward."
      );
      process.exitCode = 1;
    }
  } catch (err) {
    console.log(`PROBE FAILED: ${err && err.message}`);
    process.exitCode = 1;
  } finally {
    if (projectDir) {
      removeDir(projectDir);
    }
  }
})();
