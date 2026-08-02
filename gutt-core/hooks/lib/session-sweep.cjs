#!/usr/bin/env node
/**
 * The R37 SessionStart sweep — bounding every artifact in the state contract
 * (GP-863, S3.2; extracted in GP-895).
 *
 * This lived inside `gutt-core/hooks/session-start.cjs` until the 2.x migration
 * gate needed a few lines there and the file had none to give: the thin-router cap
 * had been calibrated to its then-current size, leaving no headroom for anything.
 * The cap was the right signal — a table of retention policy is not routing, and
 * the hook is smaller and clearer for having handed it off. Every other piece of
 * R37 policy already lives in `shared/`.
 *
 * Latency (R25): this runs on the synchronous SessionStart path, which must stay
 * ≤50ms p95, so every step is a directory stat-and-unlink or a bounded tail read —
 * no parsing of anything large, no network, no MCP inspection.
 */
"use strict";

const { statePath, sweep, trimLog } = require("./plugin-state.cjs");
const { clearExpiredSnooze } = require("./runtime-config.cjs");
const { LOG_FILES, guard } = require("./debug.cjs");

// R37 TTL policy. One place, because E8-S8.4 (GP-893) verifies these numbers.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // sessions/<id>.json
const LOG_MAX_BYTES = 256 * 1024; // breadcrumb logs
const LOG_KEEP_LINES = 200; // lines retained when a log is trimmed
const DEBRIS_TTL_MS = 60 * 60 * 1000; // orphaned .lock / .tmp.* files
const BREADCRUMB_LOGS = Object.values(LOG_FILES);

/** Lock and atomic-write temp files, which are never legitimately old. */
const isDebris = (f) => f.endsWith(".lock") || f.includes(".tmp.");

/**
 * Every artifact in the state contract gets bounded here, at the one event
 * guaranteed to fire before any of them are read.
 *
 * Each step is independently guarded: a step that throws is logged and skipped, so
 * it can neither abort the hook nor stop the remaining steps from running. Note the
 * isolation is per step, not per file — `logs` trims both breadcrumb logs inside one
 * guard, and relies on `trimLog` catching its own errors to reach the second.
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

  step("logs", () => {
    for (const name of BREADCRUMB_LOGS) {
      trimLog(statePath(name), { maxBytes: LOG_MAX_BYTES, keepLines: LOG_KEEP_LINES });
    }
  });

  step("snooze", () => clearExpiredSnooze());
}

module.exports = {
  ttlSweep,
  SESSION_TTL_MS,
  LOG_MAX_BYTES,
  LOG_KEEP_LINES,
  DEBRIS_TTL_MS,
};
