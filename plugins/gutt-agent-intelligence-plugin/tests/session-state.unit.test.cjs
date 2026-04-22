#!/usr/bin/env node
/**
 * session-state.sanitizeSessionId — unit tests.
 *
 * The UserPromptSubmit hook uses this to name a session-scoped marker
 * file. Any leakage of path-unsafe characters (/, :, ..) would either
 * produce ENOENT or cross-session collisions. Every input shape the
 * hook can encounter must collapse to a safe filename fragment.
 *
 * Run: node --test plugins/gutt-agent-intelligence-plugin/tests/session-state.unit.test.cjs
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeSessionId } = require("../hooks/lib/session-state.cjs");

test("sanitizeSessionId returns 'unknown' for undefined", () => {
  assert.equal(sanitizeSessionId(undefined), "unknown");
});

test("sanitizeSessionId returns 'unknown' for null", () => {
  assert.equal(sanitizeSessionId(null), "unknown");
});

test("sanitizeSessionId returns 'unknown' for empty string", () => {
  assert.equal(sanitizeSessionId(""), "unknown");
});

test("sanitizeSessionId passes through legal alphanumeric id", () => {
  assert.equal(sanitizeSessionId("abc123XYZ"), "abc123XYZ");
});

test("sanitizeSessionId preserves underscores and hyphens", () => {
  assert.equal(sanitizeSessionId("e2e-sess-A_1"), "e2e-sess-A_1");
});

test("sanitizeSessionId replaces forward slashes", () => {
  assert.equal(sanitizeSessionId("a/b/c"), "a_b_c");
});

test("sanitizeSessionId replaces colons (ssh-style leaks)", () => {
  assert.equal(sanitizeSessionId("host:path"), "host_path");
});

test("sanitizeSessionId replaces dots (path-traversal risk)", () => {
  assert.equal(sanitizeSessionId("../escape"), "___escape");
});

test("sanitizeSessionId replaces unicode characters", () => {
  // Only [a-zA-Z0-9_-] survives; emoji and accented chars become _.
  assert.equal(sanitizeSessionId("café-🔥"), "caf_-__");
});

test("sanitizeSessionId replaces whitespace", () => {
  assert.equal(sanitizeSessionId("with space"), "with_space");
});

test("sanitizeSessionId collapses mixed special characters", () => {
  assert.equal(sanitizeSessionId("a/b:c.d e"), "a_b_c_d_e");
});

test("sanitizeSessionId does not treat input with leading/trailing junk specially", () => {
  // Unlike agent-identity.sanitize, this helper does NOT trim — it's a
  // one-to-one replacement so filename fragments stay deterministic.
  assert.equal(sanitizeSessionId("/id/"), "_id_");
});
