#!/usr/bin/env node
/**
 * Test fixture: one process that increments a session counter once.
 *
 * Spawned N-up by tests/session-lifecycle.test.cjs to exercise the compare-and-
 * swap in session-state.applyUpdate() the way Claude Code exercises it — real
 * parallel OS processes contending for one session file, not a simulation.
 *
 * argv: <sessionId> [holdMs]
 * `holdMs` keeps the read open that much longer before the write, widening the
 * race window so an unguarded read-modify-write loses updates every run rather
 * than occasionally. Keep it small: it is time the lock is held, and a real
 * updater is microseconds (hooks do their slow work *before* calling in).
 */
"use strict";

const { init, applyUpdate } = require("../../shared/session-state.cjs");

const [sessionId, holdRaw] = process.argv.slice(2);
const holdMs = Number(holdRaw) || 0;

init(sessionId);

applyUpdate((state) => {
  state.memoryQueries = (state.memoryQueries || 0) + 1;
  if (holdMs > 0) {
    const until = Date.now() + holdMs;
    while (Date.now() < until) {
      /* spin — this is the window a sibling hook's write would slip into */
    }
  }
  return state;
});
