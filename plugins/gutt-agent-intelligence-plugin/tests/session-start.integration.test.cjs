#!/usr/bin/env node
/**
 * SessionStart hook — integration tests.
 *
 * Spawns the hook as a child process with stdin, verifies:
 *   - Exit code 0 (non-blocking guarantee)
 *   - agent-identity.json persisted in CLAUDE_PLUGIN_DATA
 *   - No-MCP path skips register/warm gracefully
 *   - userConfig override for agent_id takes effect
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK = path.resolve(__dirname, "..", "hooks", "session-start.cjs");

function runHook(payload, env) {
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 8000,
  });
  return res;
}

function makeTmpDataDir(prefix = "session-start-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("SessionStart exits 0 even when no MCP is configured", () => {
  const dir = makeTmpDataDir();
  try {
    const res = runHook(
      { session_id: "test-session-1" },
      {
        CLAUDE_PLUGIN_DATA: dir,
        // deliberately unset GUTT_MCP_URL so the MCP path short-circuits
        GUTT_MCP_URL: "",
      }
    );
    assert.equal(res.status, 0, `non-zero exit: ${res.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart writes agent-identity.json into CLAUDE_PLUGIN_DATA", () => {
  const dir = makeTmpDataDir();
  try {
    runHook({ session_id: "test-session-2" }, { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" });
    const identityPath = path.join(dir, "agent-intelligence", "agent-identity.json");
    assert.ok(fs.existsSync(identityPath), "agent-identity.json should be written");
    const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    assert.ok(typeof parsed.agentId === "string");
    assert.ok(parsed.agentId.startsWith("gutt-agent-"), `unexpected prefix: ${parsed.agentId}`);
    assert.ok(typeof parsed.resolvedAt === "number");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart honors userConfig agent_id override", () => {
  const dir = makeTmpDataDir();
  try {
    runHook(
      { session_id: "test-session-3" },
      {
        CLAUDE_PLUGIN_DATA: dir,
        GUTT_MCP_URL: "",
        CLAUDE_PLUGIN_OPTION_AGENT_ID: "my-explicit-id",
      }
    );
    const identityPath = path.join(dir, "agent-intelligence", "agent-identity.json");
    const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    assert.equal(parsed.agentId, "gutt-agent-my-explicit-id");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart does NOT create registration marker when MCP unreachable", () => {
  const dir = makeTmpDataDir();
  try {
    runHook({ session_id: "test-session-4" }, { CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" });
    const markerFile = fs
      .readdirSync(path.join(dir, "agent-intelligence"))
      .find((f) => f.startsWith(".registered-"));
    assert.equal(markerFile, undefined, "no registration should happen without MCP");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart handles malformed stdin gracefully", () => {
  const dir = makeTmpDataDir();
  try {
    const res = spawnSync("node", [HOOK], {
      input: "{this is not valid json",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, GUTT_MCP_URL: "" },
      timeout: 8000,
    });
    assert.equal(res.status, 0, "malformed stdin must not crash the hook");
    // identity should still be written since we don't actually need the payload
    const identityPath = path.join(dir, "agent-intelligence", "agent-identity.json");
    assert.ok(fs.existsSync(identityPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
