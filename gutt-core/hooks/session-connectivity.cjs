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
 * Sole writer of `connectionStatus` in `sessions/<id>.json` (AC4) — the
 * statusline is a read-only consumer. Running async means this races the
 * synchronous hook, so the probe finishes *before* the one state write; that
 * keeps the read-modify-write window to a single tick, and session-start.cjs
 * never touches the connectivity fields.
 */

const { diagnoseGuttMcp } = require("./lib/mcp-config.cjs");
const { clearMemoryCache } = require("./lib/memory-cache.cjs");
const { clearSeedCache } = require("./lib/seed-registry.cjs");
const { init, updateState } = require("./lib/session-state.cjs");
const { debugLog } = require("./lib/debug.cjs");

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

  // Stale results from the previous session must not leak into this one.
  try {
    clearMemoryCache();
    clearSeedCache();
  } catch (err) {
    debugLog("SessionStart/async", `cache clear: ${err.message || err}`);
  }

  let diag = { configured: false, url: null, error: "probe failed" };
  try {
    diag = diagnoseGuttMcp();
  } catch (err) {
    debugLog("SessionStart/async", `mcp diagnose: ${err.message || err}`);
  }

  // Conservative mapping, unchanged from 2.x: only a configured server with a
  // reachable-looking URL counts as "ok". A stdio-transport server can't be
  // verified from a hook, so it stays "unknown" rather than showing red. The raw
  // facts go in alongside it so the HUD port (GP-867) can fix the false "!"
  // without re-running this probe.
  try {
    updateState((state) => {
      state.connectionStatus = diag.configured && diag.url ? "ok" : "unknown";
      state.mcpConfigured = Boolean(diag.configured);
      state.mcpUrl = diag.url || null;
      state.connectionCheckedAt = new Date().toISOString();
      return state;
    });
  } catch (err) {
    debugLog("SessionStart/async", `state write: ${err.message || err}`);
  }

  // Best-effort user-facing note. An async hook's stdout is not guaranteed to
  // surface in the transcript; the state written above is the contract, this is
  // the courtesy.
  if (!diag.configured) {
    console.log(
      "💡 gutt memory not configured. Run /gutt-claude-code-plugin:setup or /gutt-claude-code-plugin:onboard to get started."
    );
  } else if (diag.url) {
    const display = diag.url.length > 50 ? `${diag.url.slice(0, 47)}...` : diag.url;
    console.log(`✅ gutt memory connected (${display})`);
  }

  process.exitCode = 0;
});
