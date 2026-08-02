#!/usr/bin/env node
/**
 * SessionStart — the single session-lifecycle hook (GP-863, S3.2).
 *
 * Replaces the 2.x pair `session-start.cjs` + `sessionstart-setup.cjs`. It is
 * matcher-aware (it branches on the payload's `source`) and deliberately narrow:
 * open the session record, run the R37 TTL sweep, decide whether this machine
 * still needs the one-time 2.x cleanup, exit. Nothing here touches the network.
 *
 * Latency (R25): this is the synchronous path and must stay ≤50ms p95, so it does
 * exactly one state write and no MCP inspection. The connectivity probe and cache
 * clears — the only heavy work — moved to session-connectivity.cjs, which
 * hooks.json runs with `async: true`. The GP-922 offer below adds one small JSON
 * read and one `readdir` and nothing else.
 *
 * Never blocks a session: every step is individually guarded and the exit code is
 * always 0.
 */

const { beginSession, init } = require("./lib/session-state.cjs");
const {
  ttlSweep,
  SESSION_TTL_MS,
  LOG_MAX_BYTES,
  DEBRIS_TTL_MS,
} = require("./lib/session-sweep.cjs");
const { needsMigration, announceMigration } = require("./lib/migrations.cjs");
const { migrationOffer } = require("./lib/builtin-memory.cjs");
const { guard } = require("./lib/debug.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");

// Only wire stdin when actually run as a hook. Requiring this file (the latency
// and sweep-coverage tests do, so they exercise the real ttlSweep instead of a
// copy of it that can drift) must not leave a stdin listener holding the test
// process open.
if (require.main === module) {
  // The nested-run guard sits *inside* this branch, unlike the other hooks, for
  // the same reason the branch exists: this module is required by tests, and a
  // top-level `process.exit(0)` would end the test run rather than the hook.
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
    let source = null;
    let payload = {};
    try {
      const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
      sessionId = data.session_id || "unknown";
      source = data.source || null;
      payload = data;
    } catch {
      // Unparseable payload — still open a session record under the default id. The
      // migration offer locates a store from `transcript_path`/`cwd`, so with neither
      // in hand it finds nothing and stays silent.
    }
    init(sessionId);

    // Sweep before writing: the record this hook is about to create is fresh, so
    // ordering it first would only make the sweep stat a file it can never expire.
    ttlSweep();

    guard("SessionStart", "begin session", () => beginSession(sessionId, source));

    // The one-time 2.x cleanup (GP-895), gated here rather than inside the
    // migration module and deliberately so. Migrating is a lifecycle decision, and
    // a sibling hook that decided for itself could never be told "not this
    // session" — siblings run in parallel with no channel between them, so the only
    // place the choice can actually be made is the script that owns startup.
    //
    // The gate is one small JSON read and an integer compare, which is all any
    // session after the first pays. It runs last so the state write above is
    // already durable before an upgrade session's filesystem work begins.
    if (guard("SessionStart", "migration gate", needsMigration)) {
      guard("SessionStart", "2.x cleanup", announceMigration);
    }

    // The built-in-memory migration offer (GP-922). Stdout on this event is added to
    // Claude's context, so this is the one place the hook speaks — and it stays
    // silent in every case but an unsettled decision over a non-empty store.
    //
    // Guarded like every other step, and the write happens only on a non-null return:
    // a detection failure must leave stdout untouched rather than emit half a JSON
    // object, because this hook's stdout is parsed.
    const offer = guard("SessionStart", "migration offer", () =>
      migrationOffer(payload, sessionId)
    );
    if (offer) {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: offer },
        })}\n`
      );
    }

    // exitCode over process.exit() so any buffered output flushes.
    process.exitCode = 0;
  });
}

// Re-exported for the tests that assert the sweep bounds every artifact and stays
// inside the R25 budget — they must measure the shipped sweep, not a copy. The
// implementation moved to ./lib/session-sweep.cjs in GP-895; this keeps the
// import path those tests already use.
module.exports = { ttlSweep, SESSION_TTL_MS, LOG_MAX_BYTES, DEBRIS_TTL_MS };
