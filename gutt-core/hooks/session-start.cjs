#!/usr/bin/env node
/**
 * SessionStart — the single session-lifecycle hook (GP-863, S3.2).
 *
 * Replaces the 2.x pair `session-start.cjs` + `sessionstart-setup.cjs`. It is
 * matcher-aware (it branches on the payload's `source`) and deliberately narrow:
 * open the session record, run the R37 TTL sweep, exit. Nothing here touches the
 * network, the user's settings, or the project tree.
 *
 * Latency (R25): this is the synchronous path and must stay ≤50ms p95, so it
 * does exactly one state write and no MCP inspection. The connectivity probe and
 * cache clears — the only heavy work — moved to session-connectivity.cjs, which
 * hooks.json runs with `async: true`.
 *
 * Never blocks a session: every step is individually guarded and the exit code
 * is always 0.
 */

const { beginSession, init } = require("./lib/session-state.cjs");
const { statePath, sweep, pruneJsonl, trimLog } = require("./lib/plugin-state.cjs");
const { clearExpiredSnooze } = require("./lib/runtime-config.cjs");
const { LOG_FILES, guard } = require("./lib/debug.cjs");

// R37 TTL policy. One place, because E8-S8.4 (GP-893) verifies these numbers.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // sessions/<id>.json
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // capture-queue.jsonl entries
const QUEUE_MAX_LINES = 500; // capture-queue.jsonl overflow cap
const LOG_MAX_BYTES = 256 * 1024; // breadcrumb logs
const LOG_KEEP_LINES = 200; // lines retained when a log is trimmed
const DEBRIS_TTL_MS = 60 * 60 * 1000; // orphaned .lock / .tmp.* files
const BREADCRUMB_LOGS = Object.values(LOG_FILES);

/** Lock and atomic-write temp files, which are never legitimately old. */
const isDebris = (f) => f.endsWith(".lock") || f.includes(".tmp.");

/**
 * The R37 sweep: every artifact in the state contract gets bounded here, at the
 * one event that is guaranteed to fire before any of them are read.
 *
 * Each step is independently guarded — a corrupt queue file must not stop the
 * session sweep, and neither may abort the hook.
 */
function ttlSweep() {
  const step = (name, fn) => guard("SessionStart", `ttl sweep (${name})`, fn);

  step("sessions", () =>
    sweep(statePath("sessions"), {
      maxAgeMs: SESSION_TTL_MS,
      match: (f) => f.endsWith(".json"),
    })
  );

  // Lock and temp files are siblings of the records, not records themselves, so
  // the `.json` match above never reclaims them. A hook killed mid-write leaves
  // one behind, and since session ids are never reused nothing ever contends for
  // that lock again to trigger stale reclamation — it would sit there forever.
  // Their TTL is short: no legitimate lock is held for more than a few hundred
  // milliseconds, and no atomicWrite temp outlives its own call.
  step("session-debris", () =>
    sweep(statePath("sessions"), {
      maxAgeMs: DEBRIS_TTL_MS,
      match: isDebris,
    })
  );

  // config.json's lock lives at the data root rather than in sessions/.
  step("root-debris", () => sweep(statePath(), { maxAgeMs: DEBRIS_TTL_MS, match: isDebris }));

  // Retired marker format: `<session_id>.lessons-prompted` now lives as a field
  // in the session JSON. Nothing writes these any more, so any left on disk are
  // an upgrade leftover — drop them on sight (maxAgeMs 0).
  step("legacy-markers", () =>
    sweep(statePath(), { maxAgeMs: 0, match: (f) => f.endsWith(".lessons-prompted") })
  );

  // Entries that survived a week of SessionStarts are never going to be drained.
  // The TTL is deliberately far longer than the drain interval so this can never
  // race GP-873's queue consumer.
  step("capture-queue", () =>
    pruneJsonl(statePath("capture-queue.jsonl"), {
      maxAgeMs: QUEUE_TTL_MS,
      maxLines: QUEUE_MAX_LINES,
    })
  );

  step("logs", () => {
    for (const name of BREADCRUMB_LOGS) {
      trimLog(statePath(name), { maxBytes: LOG_MAX_BYTES, keepLines: LOG_KEEP_LINES });
    }
  });

  step("snooze", () => clearExpiredSnooze());
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let sessionId = "unknown";
  let source = null;
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    sessionId = data.session_id || "unknown";
    source = data.source || null;
  } catch {
    // Unparseable payload — still open a session record under the default id.
  }
  init(sessionId);

  // Sweep before writing: the record this hook is about to create is fresh, so
  // ordering it first would only make the sweep stat a file it can never expire.
  ttlSweep();

  guard("SessionStart", "begin session", () => beginSession(sessionId, source));

  // exitCode over process.exit() so any buffered output flushes.
  process.exitCode = 0;
});
