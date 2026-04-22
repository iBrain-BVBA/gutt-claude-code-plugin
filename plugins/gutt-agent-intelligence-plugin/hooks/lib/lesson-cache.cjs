#!/usr/bin/env node
/**
 * On-disk cache for the lessons we ground each session with.
 *
 * Writer: `post-lesson-scrape.cjs` (PostToolUse). It piggybacks on the
 * fetch_lessons_learned MCP call that Claude itself makes in response to
 * the ACTION REQUIRED directive, and persists the result here.
 * Reader: `user-prompt-submit.cjs`. It injects the rendered lessons into
 * the session's additionalContext on the first prompt, so prompt latency
 * never pays for a remote fetch.
 *
 * Storage location:
 *   1. $CLAUDE_PLUGIN_DATA/agent-intelligence/       (survives plugin updates)
 *   2. <PROJECT_STATE_DIR>/hooks/.state/agent-intelligence/  (fallback)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { PROJECT_STATE_DIR } = require("./env.cjs");
const { debugLog } = require("./debug.cjs");

const SUBDIR = "agent-intelligence";

/**
 * Resolve the directory we persist caches into. Accepts a test-only
 * override so specs can run against a throwaway tmpdir.
 */
function resolveCacheDir(override) {
  if (override) {
    return override;
  }
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const base = pluginData || path.join(PROJECT_STATE_DIR, "hooks", ".state");
  return path.join(base, SUBDIR);
}

/**
 * File name for a given agent_id. The caller is responsible for
 * passing an already-sanitized id (e.g. from agent-identity.cjs).
 */
function cacheFileFor(agentId, override) {
  return path.join(resolveCacheDir(override), `lessons-${agentId}.json`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Read the cached lessons for an agent.
 * @returns {{agentId: string, updatedAt: number, lessons: Array} | null}
 */
function read(agentId, opts = {}) {
  const file = cacheFileFor(agentId, opts.cacheDir);
  try {
    if (!fs.existsSync(file)) {
      return null;
    }
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      debugLog("lesson-cache", `read ${file}: not an object`);
      return null;
    }
    if (parsed.agentId !== agentId) {
      debugLog(
        "lesson-cache",
        `read ${file}: agentId mismatch (wanted ${agentId}, got ${parsed.agentId})`
      );
      return null;
    }
    if (!Array.isArray(parsed.lessons)) {
      debugLog("lesson-cache", `read ${file}: lessons is not an array`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err.code !== "ENOENT") {
      debugLog("lesson-cache", `read ${file}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Write lessons atomically (tmp-file + rename) so a concurrent read
 * never sees a half-written file.
 */
function write(agentId, lessons, opts = {}) {
  const dir = resolveCacheDir(opts.cacheDir);
  ensureDir(dir);
  const file = path.join(dir, `lessons-${agentId}.json`);
  const payload = {
    agentId,
    updatedAt: Date.now(),
    lessons: Array.isArray(lessons) ? lessons : [],
  };
  const tmp = `${file}.${process.pid}.tmp`;
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmp, serialized, "utf8");

  // Cross-platform safe rename: on Windows, renameSync cannot always
  // overwrite an existing destination (file locks, AV, network drives).
  // Mirror the pattern in session-state.updateState — unlink-then-rename
  // with a direct-write fallback, and best-effort tmp cleanup.
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    fs.renameSync(tmp, file);
  } catch (renameErr) {
    debugLog("lesson-cache", `atomic write failed, falling back: ${renameErr.message}`);
    fs.writeFileSync(file, serialized, "utf8");
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/** Remove the cache file for an agent. No-op if missing. */
function clear(agentId, opts = {}) {
  const file = cacheFileFor(agentId, opts.cacheDir);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") {
      debugLog("lesson-cache", `clear ${file}: ${err.message}`);
    }
  }
}

/**
 * True if the cache is missing or older than `maxAgeMs`.
 * Treats unreadable/malformed caches as stale.
 */
function isStale(agentId, maxAgeMs, opts = {}) {
  const cached = read(agentId, opts);
  if (!cached || typeof cached.updatedAt !== "number") {
    return true;
  }
  return Date.now() - cached.updatedAt > maxAgeMs;
}

module.exports = {
  read,
  write,
  clear,
  isStale,
  resolveCacheDir,
  cacheFileFor,
};
