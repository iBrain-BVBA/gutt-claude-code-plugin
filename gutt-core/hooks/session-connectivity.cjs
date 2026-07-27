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
const { guard } = require("./lib/debug.cjs");

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

  // Conservative mapping, unchanged from 2.x: only a configured server with a
  // reachable-looking URL counts as "ok". A stdio-transport server can't be
  // verified from a hook, so it stays "unknown" rather than showing red. The raw
  // facts go in alongside it so the HUD port (GP-867) can fix the false "!"
  // without re-running this probe.
  guard("SessionStart/async", "state write", () =>
    updateState((state) => {
      state.connectionStatus = diag.configured && diag.url ? "ok" : "unknown";
      state.mcpConfigured = Boolean(diag.configured);
      state.mcpUrl = diag.url || null;
      // Persisted so a consumer can tell a failed probe from a genuine absence;
      // without it both look like `mcpConfigured: false`.
      state.mcpError = diag.error || null;
      state.connectionCheckedAt = new Date().toISOString();
      return state;
    })
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
      "💡 gutt memory not configured. Run /gutt-claude-code-plugin:setup or /gutt-claude-code-plugin:onboard to get started."
    );
  } else if (diag.url) {
    const display = diag.url.length > 50 ? `${diag.url.slice(0, 47)}...` : diag.url;
    console.log(`✅ gutt memory connected (${display})`);
  }

  process.exitCode = 0;
});
