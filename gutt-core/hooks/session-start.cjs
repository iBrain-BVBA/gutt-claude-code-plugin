#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 * Clears memory cache for fresh state each session
 */

const { diagnoseGuttMcp } = require("./lib/mcp-config.cjs");
const { clearMemoryCache } = require("./lib/memory-cache.cjs");
const { clearSeedCache } = require("./lib/seed-registry.cjs");
const {
  init,
  getState,
  updateState,
  resetCounters,
  setConnectionStatus,
} = require("./lib/session-state.cjs");
const { statePath, sweep } = require("./lib/plugin-state.cjs");
const { debugLog } = require("./lib/debug.cjs");

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Remove stale per-session files and one-shot markers older than 24h.
 * The R37 SessionStart TTL sweep (GP-855) — generalizes the old cleanup and
 * keeps ${CLAUDE_PLUGIN_DATA} tidy without a separate cron job. (Only patterns
 * something actually writes: the old dead gutt-routing-session-/.plan-feedback-
 * prompted/.session-summary-prompted filters matched nothing and were dropped.)
 */
function cleanupStaleState() {
  sweep(statePath("sessions"), { maxAgeMs: MAX_AGE_MS, match: (f) => f.endsWith(".json") });
  sweep(statePath(), { maxAgeMs: MAX_AGE_MS, match: (f) => f.endsWith(".lessons-prompted") });
}

// Read JSON input from stdin (required for hooks)
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  // Parse session_id from hook input and initialise per-session state path
  let sessionId = "unknown";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    sessionId = data.session_id || "unknown";
  } catch {
    // Parse error - continue with defaults
  }
  init(sessionId);

  // Clean up stale session state files older than 24 hours
  try {
    cleanupStaleState();
  } catch (err) {
    debugLog("SessionStart", `stale file cleanup: ${err.message || err}`);
  }

  // Reset carried-over counters if this session id already had activity
  try {
    const prevState = getState();
    if (prevState.memoryQueries > 0 || prevState.lessonsCaptured > 0) {
      resetCounters();
    }
  } catch (err) {
    debugLog("SessionStart", `counter reset: ${err.message || err}`);
  }

  // Always reinitialize session identity on new session start
  try {
    updateState((state) => {
      state.sessionId = sessionId;
      state.startedAt = new Date().toISOString();
      return state;
    });
  } catch (err) {
    debugLog("SessionStart", `session identity reset: ${err.message || err}`);
  }

  // Clear caches for fresh state each session
  try {
    clearMemoryCache();
    clearSeedCache();
  } catch (err) {
    debugLog("SessionStart", err);
  }

  // Check gutt MCP configuration status
  const diag = diagnoseGuttMcp();
  if (!diag.configured) {
    console.log(
      `💡 gutt memory not configured. Run /gutt-claude-code-plugin:setup or /gutt-claude-code-plugin:onboard to get started.`
    );
  } else if (diag.url) {
    const display = diag.url.length > 50 ? diag.url.slice(0, 47) + "..." : diag.url;
    setConnectionStatus("ok");
    console.log(`✅ gutt memory connected (${display})`);
  }

  // Use exitCode instead of process.exit() to allow stdout to flush
  process.exitCode = 0;
});
