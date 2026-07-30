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
const { LOG_FILES, guard } = require("./lib/debug.cjs");
const { isSuppressed, readConfig } = require("./lib/runtime-config.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");
const { judgeTurn } = require("./lib/stop-judge.cjs");

// The judge child is non-bare, so it loads this plugin and reaches this file at the end
// of its own single turn. Without this it would spawn a judge, which would spawn a judge.
if (isNestedRun()) {
  process.exit(0);
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
  } catch {
    // Unparseable stdin exits 0 silently. This hook sits between the user and the end of
    // their turn; it must never be the reason a turn cannot finish.
  }
  const sessionId = payload.session_id || "unknown";

  guard("Stop", "judge", () => {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

    // `stop_hook_active` true means this turn already fired once. Answering again
    // re-enters it — the livelock the judge prompt also guards against. Checked here as
    // well as there because a second opinion costs one boolean and the failure costs the
    // user their turn.
    if (payload.stop_hook_active) {
      appendLine(statePath(LOG_FILES.invocations), `[${timestamp}] Stop: skipped, already active`);
      return;
    }

    // Off or snoozed → silent, and no child is spawned. This is the row that a
    // `type: "prompt"` hook could not have: it is the whole reason for the conversion,
    // since `/gutt off` used to silence recall while the judge kept asking for captures.
    if (isSuppressed(sessionId)) {
      appendLine(statePath(LOG_FILES.invocations), `[${timestamp}] Stop: suppressed`);
      return;
    }

    const mode = readConfig().mode;
    const reason = judgeTurn(payload, mode);
    appendLine(
      statePath(LOG_FILES.invocations),
      `[${timestamp}] Stop: ${reason ? "fired" : "quiet"} (mode=${mode})`
    );
    if (!reason) {
      return;
    }
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  });

  process.exitCode = 0;
});
