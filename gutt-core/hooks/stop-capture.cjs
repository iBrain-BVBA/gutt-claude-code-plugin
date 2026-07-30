#!/usr/bin/env node
/**
 * Stop — routes a finished turn to `memory-capture` when it produced something durable.
 *
 * A thin router, like the others: it decides *whether* to ask the judge and what to do
 * with the verdict. The judging, the prompt and the child process live in
 * `lib/stop-judge.cjs`, which also records why this stopped being a `type: "prompt"`
 * hook (GP-866) — in short, a prompt hook cannot read config, so it could honour neither
 * `/gutt off` nor `mode`.
 *
 * Four rows return before the judge is convened, cheapest first: a nested run, a turn
 * that already fired, a suppressed plugin, and a turn with background agents still in
 * flight. Only the last is about the turn rather than about configuration.
 *
 * Output contract for a command Stop hook: `decision: "block"` with `reason` continues
 * the turn with the reason as a system message to Claude, which is the same routing the
 * prompt hook's `ok: false` did. Staying quiet is exit 0 with no stdout.
 *
 * The non-blocking channel (`additionalContext` without blocking) is deliberately not
 * used yet. It would let a suggestion reach the model without re-entering the turn — the
 * failure mode that once produced 16 consecutive re-fires — but whether a *command* Stop
 * hook's `additionalContext` is delivered is still unverified
 * (`docs/hook-platform-capabilities.md` §3, Follow-up 2). Blocking reproduces today's
 * behaviour; changing the channel is a separate change with its own probe.
 */

const { statePath, appendLine } = require("./lib/plugin-state.cjs");
const { LOG_FILES, guard, debugLog } = require("./lib/debug.cjs");
const { isSuppressed, readConfig } = require("./lib/runtime-config.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");
const { judgeTurn, pendingAgentTasks, BROKEN_OUTCOMES } = require("./lib/stop-judge.cjs");

// The judge child is non-bare, so it loads this plugin and reaches this file at the end
// of its own single turn. Without this it would spawn a judge, which would spawn a judge.
if (isNestedRun()) {
  process.exit(0);
}

/**
 * A short label per pending task, for the log line.
 *
 * `description` is free text up to 1000 characters and may contain newlines, so it is
 * left out: this log is line-oriented, and the type plus the agent or workflow name is
 * enough to tell a stuck fan-out from one slow agent.
 * @param {Array<Object>} tasks
 * @returns {string}
 */
function taskLabels(tasks) {
  return tasks
    .map((task) => [task?.type, task?.agent_type || task?.name].filter(Boolean).join(":"))
    .join(", ")
    .slice(0, 200);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
  } catch (err) {
    // Unparseable stdin exits 0 silently to the *user*: this hook sits between them and
    // the end of their turn, and must never be the reason a turn cannot finish. It is not
    // silent to the log, though. If the platform renames a payload field the judge dies
    // outright, and without this line every artefact still reads as a healthy quiet turn.
    debugLog("Stop", `unparseable stdin (${input.length}B): ${err.message}`);
  }
  const sessionId = payload.session_id || "unknown";

  guard("Stop", "judge", () => {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const log = (line) =>
      appendLine(statePath(LOG_FILES.invocations), `[${timestamp}] Stop: ${line}`);

    // `stop_hook_active` true means this turn already fired once. Answering again
    // re-enters it — the livelock the judge prompt also guards against. Checked here as
    // well as there because a second opinion costs one boolean and the failure costs the
    // user their turn.
    if (payload.stop_hook_active) {
      log("skipped, already active");
      return;
    }

    // Off or snoozed → silent, and no child is spawned. This is the row that a
    // `type: "prompt"` hook could not have: it is the whole reason for the conversion,
    // since `/gutt off` used to silence recall while the judge kept asking for captures.
    if (isSuppressed(sessionId)) {
      log("suppressed");
      return;
    }

    // Background agents still working → defer, do not judge. The turn is not finished:
    // the judge reads only the closing assistant message, so it would score a summary
    // that says "three agents are still running" and either fire on partial work or pass
    // on a turn whose findings have not arrived yet.
    //
    // Deferring costs nothing, because each agent completion re-invokes the main loop and
    // produces another Stop. The one that runs after the last agent drains sees an empty
    // array and judges the whole thing — so this also collapses what used to be one judge
    // run per completion into one per task, which is most of the latency this hook adds to
    // a fan-out turn.
    const pending = pendingAgentTasks(payload);
    if (pending.length) {
      log(`deferred, ${pending.length} agent task(s) in flight: ${taskLabels(pending)}`);
      return;
    }

    const mode = readConfig().mode;
    const { outcome, reason, detail } = judgeTurn(payload, mode);
    log(`${outcome}${detail ? ` — ${detail}` : ""} (mode=${mode})`);
    // A judge that could not answer looks exactly like one with nothing to say, in a log
    // nobody reads until something is wrong. Only the outcomes that mean "did not answer"
    // reach the error log, so a healthy pass stays out of it.
    if (BROKEN_OUTCOMES.has(outcome)) {
      debugLog("Stop", `judge ${outcome}${detail ? `: ${detail}` : ""}`);
    }
    if (!reason) {
      return;
    }
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  });

  process.exitCode = 0;
});
