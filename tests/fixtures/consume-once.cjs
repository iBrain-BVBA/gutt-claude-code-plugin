#!/usr/bin/env node
/**
 * Test fixture: one process that runs a turn and tries to take
 * `firstPromptPending` with it.
 *
 * Spawned N-up by tests/session-lifecycle.test.cjs. Prints "consumed" only if
 * this process is the one that took the flag, so the test can count winners —
 * the contract is exactly one across every racing process, which is what makes
 * GP-864's guard inject a single time per session start.
 *
 * argv: <sessionId>
 */
"use strict";

const { init, advanceTurn } = require("../../gutt-core/hooks/lib/session-state.cjs");

init(process.argv[2]);

if (advanceTurn().firstPrompt) {
  console.log("consumed");
}
