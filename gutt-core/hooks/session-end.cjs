#!/usr/bin/env node
/**
 * SessionEnd — closes out the session record (GP-863, S3.2).
 *
 * Two jobs, both cheap:
 *  1. Drop a snooze that was scoped to this session. A durable snooze (one with
 *     a wall-clock deadline and no session id) is left alone — it is meant to
 *     outlive the session, and SessionStart's TTL sweep expires it.
 *  2. Finalize `sessions/<id>.json` — stamp `endedAt`/`endReason` and clear the
 *     lifecycle flags. The file is kept, not deleted, so the statusline and the
 *     next SessionStart can still read the last known state; the 24h sweep
 *     reclaims it.
 *
 * SessionEnd cannot block a session and has no decision output, so this only
 * ever produces side effects and exit code 0.
 */

const { init, finalizeSession } = require("./lib/session-state.cjs");
const { clearSessionSnooze } = require("./lib/runtime-config.cjs");
const { guard } = require("./lib/debug.cjs");

// Stamped at module load, the earliest moment this process can observe — before
// stdin, before the lock. finalizeSession() refuses to close a record that was
// started after this instant, because on `/clear` that record belongs to the
// session which replaced ours. See the ordering guard in session-state.cjs.
const DISPATCHED_AT = Date.now();

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let sessionId = "unknown";
  let reason = "other";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    sessionId = data.session_id || "unknown";
    reason = data.reason || data.source || "other";
  } catch {
    // Parse error — still finalize under the default id.
  }
  init(sessionId);

  guard("SessionEnd", "clear session snooze", () => clearSessionSnooze(sessionId));
  guard("SessionEnd", "finalize session", () => finalizeSession(reason, DISPATCHED_AT));

  process.exitCode = 0;
});
