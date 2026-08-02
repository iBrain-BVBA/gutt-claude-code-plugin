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
 * Sole writer of the connectivity fields of `sessions/<id>.json`:
 * session-start.cjs never touches them, and the statusline is a read-only
 * consumer.
 *
 * Running async means this races the synchronous hook, so the probe finishes
 * *before* the one state write, keeping the read-modify-write window short.
 */

const { diagnoseGuttMcp } = require("./lib/mcp-config.cjs");
const { init, updateState } = require("./lib/session-state.cjs");
const { statuslineConsented } = require("./lib/runtime-config.cjs");
const { refreshShim, reassertEntry } = require("./lib/statusline-install.cjs");
const { guard } = require("./lib/debug.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");

// A judge subprocess's MCP reachability is not the user's, and this hook is the
// sole writer of the connectivity fields the HUD reads — letting a child write
// them would show the user a probe result from a session they never started.
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
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    sessionId = data.session_id || "unknown";
  } catch {
    // Parse error — fall through with the default id.
  }
  init(sessionId);

  // A throw here is "we could not tell", which is a different thing from "not
  // configured" and must not be flattened into it — the difference decides both
  // what the user is told below and what the HUD shows.
  const probe = guard("SessionStart/async", "mcp diagnose", diagnoseGuttMcp);
  const diag = probe || { configured: false, url: null, error: "probe failed" };

  // Conservative mapping: only a configured server with a reachable-looking URL
  // counts as "ok". A stdio-transport server can't be verified from a hook, so it
  // stays "unknown" rather than showing red at someone whose setup is fine.
  //
  // "error" means the probe itself failed — we could not tell, which is a third
  // thing and not the same as "not configured". Until GP-867 nothing wrote it and
  // the HUD's red branch was unreachable; a diagnosis that threw looked identical
  // to a machine with no MCP server at all.
  guard("SessionStart/async", "state write", () =>
    updateState((state) => {
      if (!probe) {
        state.connectionStatus = "error";
      } else {
        state.connectionStatus = diag.configured && diag.url ? "ok" : "unknown";
      }
      state.mcpConfigured = Boolean(diag.configured);
      state.mcpUrl = diag.url || null;
      // Persisted so a consumer can tell a failed probe from a genuine absence;
      // without it both look like `mcpConfigured: false`.
      state.mcpError = diag.error || null;
      state.connectionCheckedAt = new Date().toISOString();
      return state;
    })
  );

  // Keep the HUD's entry point pointing at this version (GP-867). Both steps live
  // on the async hook rather than the synchronous one for the same reason the probe
  // does: SessionStart has a ≤50ms budget (R25) and this is filesystem work nobody
  // is waiting on.
  //
  // The shim is what makes an upgrade invisible. The user's settings.json names a
  // stable path under ${CLAUDE_PLUGIN_DATA}; this repoints it at the current
  // CLAUDE_PLUGIN_ROOT, which every update moves. Unchanged content writes nothing.
  guard("SessionStart/async", "statusline shim", refreshShim);

  // The narrow repair for anthropics/claude-code#62486 — Claude Code rewrites
  // settings.json mid-session and drops keys it is not currently serialising,
  // `statusLine` among them, and the issue is closed as not planned. Gated on a
  // consent record, so this only ever restores a HUD the user explicitly asked for.
  // No consent, or a status line that is now someone else's, and it does nothing.
  guard("SessionStart/async", "statusline reassert", () =>
    reassertEntry({ consented: statuslineConsented() })
  );

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
