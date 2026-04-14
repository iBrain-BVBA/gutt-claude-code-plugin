#!/usr/bin/env node
/**
 * SessionStart hook script (Node.js - cross-platform)
 * Shows setup reminder if gutt-mcp-remote is not configured
 * Clears memory cache for fresh state each session
 */

const { diagnoseGuttMcp } = require("./lib/mcp-config.cjs");
const { clearMemoryCache } = require("./lib/memory-cache.cjs");
const { clearSeedCache } = require("./lib/seed-registry.cjs");
const fs = require("fs");
const path = require("path");
const {
  init,
  getState,
  updateState,
  resetCounters,
  setConnectionStatus,
} = require("./lib/session-state.cjs");
const { recordSessionMetrics } = require("./lib/cross-session-learner.cjs");
const { PROJECT_STATE_DIR } = require("./lib/env.cjs");
const { debugLog } = require("./lib/debug.cjs");

const HOOK_STATE_DIR = path.join(PROJECT_STATE_DIR, "hooks", ".state");

/**
 * Remove stale per-session state files older than 24 hours.
 * These accumulate as sessions start and stop; cleaning on session start
 * keeps the .state directory tidy without needing a separate cron job.
 */
function cleanupStaleSessionFiles() {
  if (!fs.existsSync(HOOK_STATE_DIR)) {
    return;
  }
  const now = Date.now();
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  const files = fs.readdirSync(HOOK_STATE_DIR);
  for (const file of files) {
    // Only clean up session-scoped files (contain a session ID segment)
    if (
      !file.startsWith("gutt-session-") &&
      !file.startsWith("gutt-routing-session-") &&
      !file.includes(".lessons-prompted") &&
      !file.includes(".plan-feedback-prompted") &&
      !file.includes(".session-summary-prompted")
    ) {
      continue;
    }
    const filePath = path.join(HOOK_STATE_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Skip files we can't stat/delete
    }
  }
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
    cleanupStaleSessionFiles();
  } catch (err) {
    debugLog("SessionStart", `stale file cleanup: ${err.message || err}`);
  }

  // Flush previous session metrics into cross-session analytics before clearing
  try {
    const prevState = getState();
    if (prevState.memoryQueries > 0 || prevState.lessonsCaptured > 0) {
      recordSessionMetrics(prevState);
      resetCounters();
    }
  } catch (err) {
    debugLog("SessionStart", `cross-session flush: ${err.message || err}`);
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
