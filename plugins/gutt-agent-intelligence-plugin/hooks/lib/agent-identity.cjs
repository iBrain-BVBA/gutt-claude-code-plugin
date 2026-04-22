#!/usr/bin/env node
/**
 * Agent identity resolution for session-scoped memory operations.
 *
 * Produces a stable `gutt-agent-<slug>` identifier so lessons captured
 * in one session can be retrieved in the next, across clones and
 * worktrees, without colliding with unrelated projects that happen to
 * share a folder name.
 *
 * Fallback chain (first non-empty wins):
 *   1. userConfig.agent_id override
 *   2. Git remote "origin" slug    → gutt-agent-<owner>-<repo>
 *   3. Git root directory basename → gutt-agent-<repo-name>
 *   4. cwd basename                → gutt-agent-<folder>
 */

"use strict";

const path = require("path");
const { execSync } = require("child_process");
const { debugLog } = require("./debug.cjs");

const PREFIX = "gutt-agent-";
const SANITIZE_PATTERN = /[^a-zA-Z0-9_-]/g;

/**
 * Replace anything outside [a-zA-Z0-9_-] with "_".
 * Collapse runs of "_" to a single "_", and strip leading/trailing.
 */
function sanitize(input) {
  if (typeof input !== "string") {
    return "";
  }
  const cleaned = input.replace(SANITIZE_PATTERN, "_").replace(/_+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "");
}

/**
 * Parse the path portion of a git remote URL into an "owner-repo" slug.
 * Handles https, ssh, and protocol-less forms; strips a trailing ".git".
 *
 * Returns null if the URL cannot be parsed into at least one non-empty
 * path segment.
 */
function extractOwnerRepoFromRemoteUrl(url) {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }

  let stripped = url.trim();

  // Drop protocol: https://, http://, ssh://, git://
  stripped = stripped.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

  // Drop user@ prefix for ssh-style URLs
  stripped = stripped.replace(/^[^@/:]+@/, "");

  // Normalize scp-style "host:path" to "host/path". For URLs that had an
  // explicit port ("host:9418/path" after the protocol was stripped), the
  // port must be DROPPED rather than merged into the slug — otherwise the
  // port digits leak into the agent id.
  const portMatch = stripped.match(/^([^:/]+):(\d+)(\/.*)?$/);
  if (portMatch) {
    stripped = portMatch[1] + (portMatch[3] || "");
  } else {
    stripped = stripped.replace(":", "/");
  }

  // Drop the host (first segment)
  const firstSlash = stripped.indexOf("/");
  if (firstSlash === -1) {
    return null;
  }
  let pathPart = stripped.slice(firstSlash + 1);

  // Trim ".git" suffix
  pathPart = pathPart.replace(/\.git\/*$/, "");

  // Trim leading/trailing slashes
  pathPart = pathPart.replace(/^\/+|\/+$/g, "");
  if (pathPart.length === 0) {
    return null;
  }

  return pathPart.replace(/\/+/g, "-");
}

/**
 * Run a short git command in `cwd` and return stdout, or null on error.
 * Bounded 2-second timeout so a misbehaving git doesn't hang the hook.
 */
function safeGit(args, cwd) {
  try {
    const out = execSync(`git ${args}`, {
      cwd,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    return typeof out === "string" ? out.trim() : null;
  } catch (err) {
    // git exits non-zero for expected "not a repo" / "no such remote" signals
    // (err.status is the exit code). Only log when git didn't run at all —
    // missing binary (ENOENT), timeout, permissions — since those indicate
    // a broken environment that a silent null would mask.
    if (!err.status) {
      debugLog("agent-identity", `git ${args}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Fetch the remote "origin" URL and reduce it to an owner-repo slug.
 * Returns null if the cwd is not a git repo, has no origin, or the
 * URL does not parse.
 */
function gitRemoteSlug(cwd) {
  const url = safeGit("remote get-url origin", cwd);
  if (!url) {
    return null;
  }
  return extractOwnerRepoFromRemoteUrl(url);
}

/**
 * Basename of the git repository root (toplevel). Null if cwd is not
 * inside a git repo.
 */
function gitRootBasename(cwd) {
  const toplevel = safeGit("rev-parse --show-toplevel", cwd);
  if (!toplevel) {
    return null;
  }
  return path.basename(toplevel);
}

/**
 * Resolve the project-scoped agent identity for the current session.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()] - override for the working directory
 * @param {string} [opts.userConfigOverride] - explicit user override (plugin userConfig.agent_id)
 * @returns {string|null} a non-empty identifier prefixed with "gutt-agent-",
 *   or `null` when every fallback in the chain produced an empty slug. A
 *   null return is a signal to the orchestrator that identity-dependent
 *   work must be skipped — do NOT substitute a sentinel, as that would
 *   cross-contaminate the memory graph across unrelated projects.
 */
function resolveProjectAgentId(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const override = typeof opts.userConfigOverride === "string" ? opts.userConfigOverride : "";

  const candidates = [override, gitRemoteSlug(cwd), gitRootBasename(cwd), path.basename(cwd)];

  for (const raw of candidates) {
    if (!raw) {
      continue;
    }
    const sanitized = sanitize(raw);
    if (sanitized.length === 0) {
      continue;
    }
    return PREFIX + sanitized;
  }

  return null;
}

module.exports = {
  PREFIX,
  resolveProjectAgentId,
  sanitize,
  extractOwnerRepoFromRemoteUrl,
  gitRemoteSlug,
  gitRootBasename,
};
