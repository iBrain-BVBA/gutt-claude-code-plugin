#!/usr/bin/env node
/**
 * Test fixture: one process that tries to consume `firstPromptPending` once.
 *
 * Spawned N-up by tests/session-lifecycle.test.cjs. Prints "consumed" only if
 * this process is the one that took the flag, so the test can count winners —
 * the contract is exactly one across every racing process, which is what GP-864
 * will rely on to inject its guard a single time per session start.
 *
 * argv: <sessionId>
 */
"use strict";

const { init, consumeFirstPromptPending } = require("../../shared/session-state.cjs");

init(process.argv[2]);

if (consumeFirstPromptPending()) {
  console.log("consumed");
}
