#!/usr/bin/env node
/**
 * GP-931 platform probe: does a bare `/config`, `/on`, `/off`, `/disable`, `/mode`
 * resolve to this plugin's command and reach UserPromptSubmit — and does bare
 * `/config` reach us at all, or is it swallowed by Claude Code's own `/config`?
 *
 * Built on the e2e harness so it is a real `claude` run against the working tree,
 * not a simulation. One session, one prompt per verb, config planted empty and
 * restored afterwards. The evidence is per-turn: whether the hook injected a
 * config-command outcome (which only `configCommandResult` produces) and what the
 * turn's own reply looked like.
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
  } catch (err) {
    console.log(`PROBE FAILED: ${err && err.message}`);
    process.exitCode = 1;
  } finally {
    if (projectDir) {
      removeDir(projectDir);
    }
  }
})();
