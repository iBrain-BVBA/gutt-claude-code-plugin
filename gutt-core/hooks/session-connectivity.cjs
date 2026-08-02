#!/usr/bin/env node
/**
 * SessionStart (async) — MCP connectivity probe and cache reset (GP-863, S3.2).
 *
 * Split out of session-start.cjs to keep the synchronous lifecycle path inside
 * the ≤50ms budget (R25): diagnosing the MCP config walks up to five settings
 * files plus the plugin cache directory, which is by far the most expensive
 * thing SessionStart used to do. hooks.json runs this with `async: true`, so it
 * never delays the session.
 *
 * Sole writer of the *configuration* fields of `sessions/<id>.json` — `mcpConfigured`,
 * `mcpUrl`, `mcpError` — which nothing else touches, and which the statusline only
 * reads. `mcpToolsAvailable` is shared with `user-prompt-submit.cjs`, the steady-state
 * owner; see the write below for why this hook contributes to it at all and why it
 * abstains rather than writing "unknown".
 *
 * Running async means this races the synchronous hook, so the probe finishes
 * *before* the one state write, keeping the read-modify-write window short.
 */

const { diagnoseGuttMcp } = require("./lib/mcp-config.cjs");
const { init, updateState, noteToolAvailability } = require("./lib/session-state.cjs");
const { guttToolAvailability } = require("./lib/mcp-availability.cjs");
const { statuslineConsented } = require("./lib/runtime-config.cjs");
const { refreshShim, reassertEntry } = require("./lib/statusline-install.cjs");
const { guard } = require("./lib/debug.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");

// A judge subprocess's MCP reachability is not the user's, and this hook is the sole
// writer of the *configuration* fields the HUD reads — letting a child write them
// would show the user a probe result from a session they never started.
if (isNestedRun()) {
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let sessionId = "unknown";
  let transcriptPath = null;
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    sessionId = data.session_id || "unknown";
    transcriptPath = data.transcript_path || null;
  } catch {
    // Parse error — fall through with the default id.
  }
  init(sessionId);

  // A throw here is "we could not tell", which is a different thing from "not
  // configured" and must not be flattened into it — the difference decides both
  // what the user is told below and what the HUD shows.
  const probe = guard("SessionStart/async", "mcp diagnose", diagnoseGuttMcp);
  const diag = probe || { configured: false, url: null, error: "probe failed" };

  // This hook no longer writes `connectionStatus`, and the omission is the point.
  // It reads settings files; a hook cannot open a socket, so "a gutt server is
  // configured with a URL" is the strongest claim available here — and that was
  // being rendered as a green light meaning "connected". A server that was down, or
  // whose authentication had lapsed, looked identical to a working one for the whole
  // session. The glyph is now driven by observed tool responses (post-memory-search),
  // which is the only place a real round trip is visible, and it starts at "not
  // observed yet" rather than at an assumption.
  //
  // What is still worth writing here is configuration, which the HUD reports
  // separately as `!` and which the tool-traffic path genuinely cannot see: a server
  // nobody has configured produces no calls to observe.
  guard("SessionStart/async", "state write", () =>
    updateState((state) => {
      // Three states, not two. A probe that threw knows nothing, and `false` is a
      // claim — the HUD renders it as `!`, which tells the user in as many words to
      // go and run setup on a configuration that may be perfectly fine. `null` is
      // the honest reading, and every consumer already tests `=== false`, so an
      // unknown shows nothing rather than accusing anyone.
      //
      // This used to be `Boolean(diag.configured)` against a default object, which
      // flattened the throw into a denial — directly contradicting the comment above
      // this block. The `mcpError` field below was offered as the discriminator that
      // made that acceptable, and nothing ever read it. A field only distinguishes
      // anything once something consults it; until then the distinction lives in
      // prose. So the distinction now lives in the value a consumer actually reads.
      state.mcpConfigured = probe ? Boolean(diag.configured) : null;
      state.mcpUrl = diag.url || null;
      // Diagnostic only, and deliberately so: `mcpConfigured` above is what carries
      // the failed-probe case to a reader, and no code anywhere reads this. It is
      // written for whoever opens the session record by hand while working out why a
      // probe failed, which is the same audience as `hook-errors.log`. Claiming a
      // code reader it does not have is what let the flattened `Boolean(...)` above
      // look defensible for as long as it did.
      state.mcpError = diag.error || null;
      state.connectionCheckedAt = new Date().toISOString();
      return state;
    })
  );

  // Tool-list presence, from the transcript. Read here as well as on every prompt
  // because the case this exists for is visible before the user types anything: a
  // connector that has not been authenticated publishes only its sign-in tools, so
  // the PostToolUse hook that would otherwise notice never fires — there is no real
  // tool to call. Waiting for the first prompt would show a green HUD until then.
  //
  // Only when there is an answer, unlike the per-prompt writer. This hook is
  // `async: true` and races the first prompt, and at session start the transcript is
  // usually empty or not yet flushed; writing that abstention could land *after* the
  // prompt hook's real verdict and erase it. On a resumed session or after /clear the
  // history is already there, which is where this pays off.
  guard("SessionStart/async", "tool availability", () => {
    const availability = guttToolAvailability(transcriptPath);
    if (availability !== "unknown") {
      noteToolAvailability(availability);
    }
  });

  // Keep the HUD's entry point pointing at this version (GP-867). Both steps live
  // on the async hook rather than the synchronous one for the same reason the probe
  // does: SessionStart has a ≤50ms budget (R25) and this is filesystem work nobody
  // is waiting on.
  //
  // The shim is what makes an upgrade invisible. The user's settings.json names a
  // stable path under ${CLAUDE_PLUGIN_DATA}; this repoints it at the current
  // CLAUDE_PLUGIN_ROOT, which every update moves. Unchanged content writes nothing.
  //
  // The outcome is recorded on failure for the same reason the reassert below is:
  // this is the caller that runs every session, and a data dir that is read-only or
  // full leaves the shim pointing at a renderer the last update moved. Nothing else
  // can find that afterwards — `shimResolves` sees a shim that reads and a target
  // that exists, because a stale target from the previous version usually does.
  guard("SessionStart/async", "statusline shim", () => {
    const shim = refreshShim();
    updateState((state) => {
      state.statuslineShim = shim.status === "failed" ? `could not write ${shim.path}` : null;
      return state;
    });
  });

  // The narrow repair for anthropics/claude-code#62486 — Claude Code rewrites
  // settings.json mid-session and drops keys it is not currently serialising,
  // `statusLine` among them, and the issue is closed as not planned. Gated on a
  // consent record, so this only ever restores a HUD the user explicitly asked for.
  // No consent, or a status line that is now someone else's, and it does nothing.
  //
  // The outcome is recorded rather than discarded. `/gutt-pro:statusline status`
  // told users outright that "the next session restores it" — a prediction it had no
  // evidence for, and which is wrong for exactly the user whose repair fails every
  // session on an unwritable settings file. Persisting the verdict is what lets that
  // command report what happened instead of what usually happens.
  //
  // **Every outcome writes, including the good ones.** SessionStart fires again on
  // resume, on /clear and on compact, against the same session record, so a field
  // only ever written on failure is written once and never corrected. A repair that
  // failed at startup on a momentarily unreadable settings.json, and succeeded an
  // hour later after the user fixed it, went on reporting the original reason for the
  // rest of the session — sending them to debug a condition that no longer existed.
  // Clearing on success costs the same write and makes the field mean "the latest
  // attempt" rather than "the first one that ever went wrong".
  let lostSettings = null;
  guard("SessionStart/async", "statusline reassert", () => {
    const outcome = reassertEntry({ consented: statuslineConsented() });
    const settled =
      outcome.restored || outcome.status === "no-consent" || outcome.status === "present";
    if (outcome.status === "settings-lost") {
      lostSettings = outcome.detail;
    }
    updateState((state) => {
      // The detail travels with the status. `settings-lost` is the case this whole
      // repair has to be able to explain, and it is the one where the status alone is
      // useless: the sentence naming where the user's settings ended up is the entire
      // remedy, and re-running the command cannot reconstruct it — by then
      // settings.json is simply absent and a fresh install reports plain success.
      state.statuslineReassert = settled
        ? null
        : { status: outcome.status, detail: outcome.detail || null };
      return state;
    });
  });

  // The one thing here that is not a courtesy. Every other message on this hook
  // reports a condition the user can rediscover whenever they like; this one reports
  // that their settings.json is gone and names the file holding its contents, and
  // nothing else will say so unprompted. Printed first, and unconditionally, because
  // it does not compete for attention with a note about memory configuration.
  if (lostSettings) {
    // Concatenated, not a wrapped template literal: the newline a source hard-wrap
    // leaves in the string is a newline in the output, and this is the one message
    // here that must read as a single sentence.
    console.log(
      "⚠️ gutt could not restore your status line and your settings.json was lost in the " +
        `attempt. ${lostSettings}`
    );
  }

  // Best-effort user-facing note. An async hook's stdout is not guaranteed to
  // surface in the transcript; the state written above is the contract, this is
  // the courtesy.
  if (!probe) {
    // Telling someone with a working setup to go and re-run setup is worse than
    // saying nothing, so say what actually happened instead.
    console.log(`💡 gutt memory status could not be determined (${diag.error}).`);
  } else if (!diag.configured) {
    console.log(
      "💡 gutt memory not configured. Run /gutt-pro:setup or /gutt-pro:onboard to get started."
    );
  } else if (diag.url) {
    const display = diag.url.length > 50 ? `${diag.url.slice(0, 47)}...` : diag.url;
    console.log(`✅ gutt memory connected (${display})`);
  }

  process.exitCode = 0;
});
