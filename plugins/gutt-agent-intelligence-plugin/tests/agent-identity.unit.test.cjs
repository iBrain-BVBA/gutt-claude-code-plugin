#!/usr/bin/env node
/**
 * Agent identity resolver — unit tests.
 *
 * Pure-logic coverage for sanitize() and extractOwnerRepoFromRemoteUrl().
 * Integration-style branch coverage for resolveProjectAgentId() uses a
 * throwaway temp dir so git lookups fall through the chain deterministically.
 *
 * Run: node --test plugins/gutt-agent-intelligence-plugin/tests/agent-identity.unit.test.cjs
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PREFIX,
  resolveProjectAgentId,
  sanitize,
  extractOwnerRepoFromRemoteUrl,
} = require("../hooks/lib/agent-identity.cjs");

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

test("sanitize passes through legal kebab-case", () => {
  assert.equal(
    sanitize("iBrain-BVBA-gutt-claude-code-plugin"),
    "iBrain-BVBA-gutt-claude-code-plugin"
  );
});

test("sanitize replaces illegal chars with underscore", () => {
  assert.equal(sanitize("owner/repo:feature"), "owner_repo_feature");
});

test("sanitize collapses runs of underscores", () => {
  assert.equal(sanitize("a///b"), "a_b");
});

test("sanitize strips leading and trailing underscores", () => {
  assert.equal(sanitize("///repo///"), "repo");
});

test("sanitize returns empty string for all-illegal input", () => {
  assert.equal(sanitize("///"), "");
});

test("sanitize returns empty for non-string input", () => {
  assert.equal(sanitize(undefined), "");
  assert.equal(sanitize(null), "");
  assert.equal(sanitize(42), "");
});

// ---------------------------------------------------------------------------
// extractOwnerRepoFromRemoteUrl
// ---------------------------------------------------------------------------

test("parses https github URL with .git suffix", () => {
  assert.equal(
    extractOwnerRepoFromRemoteUrl("https://github.com/iBrain-BVBA/gutt-claude-code-plugin.git"),
    "iBrain-BVBA-gutt-claude-code-plugin"
  );
});

test("parses https github URL without .git suffix", () => {
  assert.equal(
    extractOwnerRepoFromRemoteUrl("https://github.com/iBrain-BVBA/gutt-claude-code-plugin"),
    "iBrain-BVBA-gutt-claude-code-plugin"
  );
});

test("parses ssh git URL with .git suffix", () => {
  assert.equal(
    extractOwnerRepoFromRemoteUrl("git@github.com:iBrain-BVBA/gutt-claude-code-plugin.git"),
    "iBrain-BVBA-gutt-claude-code-plugin"
  );
});

test("parses ssh URL protocol form", () => {
  assert.equal(
    extractOwnerRepoFromRemoteUrl("ssh://git@github.com/iBrain-BVBA/gutt-claude-code-plugin.git"),
    "iBrain-BVBA-gutt-claude-code-plugin"
  );
});

test("parses gitlab subgroup URL", () => {
  assert.equal(
    extractOwnerRepoFromRemoteUrl("https://gitlab.com/group/subgroup/repo.git"),
    "group-subgroup-repo"
  );
});

test("parses URL with trailing slash", () => {
  assert.equal(extractOwnerRepoFromRemoteUrl("https://github.com/owner/repo/"), "owner-repo");
});

test("drops explicit port instead of merging it into the slug", () => {
  // Regression: `:9418` used to get rewritten to `/9418`, leaking the
  // port number into the agent id (e.g. "9418-owner-repo").
  assert.equal(extractOwnerRepoFromRemoteUrl("git://host:9418/owner/repo.git"), "owner-repo");
  assert.equal(extractOwnerRepoFromRemoteUrl("ssh://user@host:22/owner/repo"), "owner-repo");
});

test("returns null for empty string", () => {
  assert.equal(extractOwnerRepoFromRemoteUrl(""), null);
});

test("returns null for non-string input", () => {
  assert.equal(extractOwnerRepoFromRemoteUrl(null), null);
  assert.equal(extractOwnerRepoFromRemoteUrl(undefined), null);
  assert.equal(extractOwnerRepoFromRemoteUrl(42), null);
});

test("returns null for URL with no path segment", () => {
  assert.equal(extractOwnerRepoFromRemoteUrl("https://github.com"), null);
});

// ---------------------------------------------------------------------------
// resolveProjectAgentId — fallback chain
// ---------------------------------------------------------------------------

test("userConfig override wins over git lookups", () => {
  const id = resolveProjectAgentId({
    cwd: os.tmpdir(),
    userConfigOverride: "my-custom-id",
  });
  assert.equal(id, PREFIX + "my-custom-id");
});

test("userConfig override gets sanitized", () => {
  const id = resolveProjectAgentId({
    cwd: os.tmpdir(),
    userConfigOverride: "owner/repo:weird",
  });
  assert.equal(id, PREFIX + "owner_repo_weird");
});

test("empty userConfig override falls through to other sources", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-id-test-"));
  try {
    const id = resolveProjectAgentId({ cwd: tmp, userConfigOverride: "" });
    // No git in a fresh tmpdir; should land on the cwd-basename fallback.
    assert.ok(id.startsWith(PREFIX), `expected prefix on ${id}`);
    assert.ok(id.length > PREFIX.length, `expected non-empty slug on ${id}`);
    assert.equal(id, PREFIX + path.basename(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("result is always non-empty and prefixed", () => {
  const id = resolveProjectAgentId({ cwd: os.tmpdir() });
  assert.ok(id.startsWith(PREFIX));
  assert.ok(id.length > PREFIX.length);
});

test("result never contains a colon", () => {
  const id = resolveProjectAgentId({
    cwd: os.tmpdir(),
    userConfigOverride: "owner:repo",
  });
  assert.ok(!id.includes(":"), `colon leaked into ${id}`);
});

test("result never contains a slash", () => {
  const id = resolveProjectAgentId({
    cwd: os.tmpdir(),
    userConfigOverride: "owner/repo",
  });
  assert.ok(!id.includes("/"), `slash leaked into ${id}`);
});

test("PREFIX constant is exactly the agreed literal", () => {
  assert.equal(PREFIX, "gutt-agent-");
});
