/**
 * Runtime filesystem-hygiene watch for the e2e tier (R37).
 *
 * `tests/check-state-location.cjs` proves statically that no hook *code* calls an
 * fs write API outside the sanctioned module. This proves dynamically that a real
 * run *behaved* — including runs where a hook died mid-flight, which no grep can
 * see. One watermark when the suite loads, one diff when it ends.
 *
 * What is watched, and what is not:
 *
 * - `~/.claude`, recursively. Every file **created or deleted** outside the
 *   allowlist below fails the suite. Modifications are deliberately out of scope:
 *   the one mutable file that matters (`settings.json`) has byte- and key-level
 *   assertions in session-lifecycle.e2e.cjs, and every plugin append routes
 *   through plugin-state.cjs, whose write locations the static guard pins.
 * - The repo working tree, via `git status --porcelain` equality — cheaper and
 *   stricter than walking it, since it also catches edits to tracked files.
 * - The throwaway project dirs are each suite's own job: they are created and
 *   removed per run, and the suites walk their own against an expected-file set.
 *
 * The machine running this may have other Claude sessions live (the developer's
 * own), and those legitimately write while we watch. That is why the allowlist
 * names CLI-owned surfaces rather than trying to attribute writes: what a
 * concurrent session creates lands in the same sanctioned places. A stray outside
 * them is a real finding about some plugin on this machine — the failure message
 * says so rather than pretending the case cannot exist.
 */

"use strict";

const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { pluginName, COMPANION_PLUGIN_NAME, REPO_ROOT } = require("./claude-run.cjs");

/**
 * Paths under the watched root where creations are sanctioned. Directory entries
 * end with "/". Each entry carries its one-line reason so the list cannot rot
 * silently (same discipline as check-state-location.cjs's allowlist).
 *
 * The CLI-owned set was read off a real `~/.claude` rather than imagined, and it
 * is deliberately an under-allowlist: a CLI version that grows a new directory
 * shows up as one named stray and earns its line here — one false red, once,
 * beats a masked finding forever. What stays watched on purpose: `hooks/`,
 * `plans/`, `CLAUDE.md`, `settings.json` and friends (user-owned surfaces no
 * plugin may touch), and all of `plugins/` beyond the two inline data dirs — an
 * e2e run must not install anything, and a write into another plugin's data dir
 * is cross-plugin contamination.
 * @returns {string[]}
 */
function defaultAllowed() {
  return [
    // The AC's own sanctioned root, per plugin: a --plugin-dir load stores under
    // `<name>-inline` (the lifecycle suite asserts the run really resolved there),
    // and the coexistence run's generated companion gets the same treatment.
    `plugins/data/${pluginName()}-inline/`,
    `plugins/data/${COMPANION_PLUGIN_NAME}-inline/`,
    // CLI-owned session artifacts — Claude Code's writes, not any plugin's.
    "projects/", // one transcript dir per session, including our children
    "shell-snapshots/", // Bash tool environment snapshots
    "debug/", // the CLI's own debug logs
    "backups/", // CLI-managed settings backups
    "cache/", // CLI response/asset cache
    "daemon/", // background daemon state
    "downloads/", // CLI-fetched artifacts
    "file-history/", // checkpoint copies for edited files
    "hud/", // HUD render state
    "ide/", // IDE-extension lock/handshake files
    "jobs/", // background job bookkeeping
    "paste-cache/", // pasted-content spool
    "session-env/", // per-session environment snapshots
    "sessions/", // CLI session bookkeeping
    "tasks/", // task/subagent bookkeeping
    "telemetry/", // telemetry spool
    "history.jsonl", // prompt history
    "stats-cache.json", // usage-stats cache the CLI rewrites on its own
    ".session-stats.json", // per-session counters, CLI-rolled
    ".last-cleanup", // CLI cleanup watermark
    ".last-update-result.json", // CLI updater breadcrumb
    // Per-session pid markers the CLI stamps into every *installed* plugin's
    // cache dir (measured: each e2e child creates one per installed plugin).
    // Only the marker is sanctioned — the rest of plugins/cache/ stays watched,
    // because a file appearing there is an install this tier must never do.
    /^plugins\/cache\/.+\/\.in_use\//,
  ];
}

/**
 * @param {string} rel
 * @param {Array<string|RegExp>} allowed - strings match dirs ("x/") by prefix
 *   and files exactly; RegExps match wherever they say they do
 * @returns {boolean} true when `rel` is inside (or is) an allowlisted entry
 */
function isAllowed(rel, allowed) {
  return allowed.some((entry) => {
    if (entry instanceof RegExp) {
      return entry.test(rel);
    }
    return entry.endsWith("/") ? rel.startsWith(entry) || `${rel}/` === entry : rel === entry;
  });
}

/**
 * Every file under `root` outside the allowlist, as root-relative paths.
 * Allowlisted subtrees are pruned rather than filtered afterwards — `projects/`
 * alone can hold tens of thousands of transcripts, and none of them could ever
 * be flagged. Symlinks are recorded as entries and never followed.
 * @param {string} root
 * @param {string[]} allowed
 * @returns {Set<string>}
 */
function walkSet(root, allowed) {
  const found = new Set();
  const stack = [""];
  while (stack.length) {
    const dirRel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dirRel), { withFileTypes: true });
    } catch {
      continue; // vanished mid-walk, or the root does not exist yet
    }
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (isAllowed(rel, allowed)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(rel);
      } else {
        found.add(rel);
      }
    }
  }
  return found;
}

/**
 * `git status --porcelain`, or a throw. A broken git is a red result, not a
 * clean tree — a guard that inspected nothing must not report success (the
 * check-no-symlinks rule).
 * @param {string} repoRoot
 * @returns {string}
 */
function repoStatus(repoRoot) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  if (res.error || res.status !== 0) {
    throw new Error(
      `git status --porcelain failed in ${repoRoot}: ${res.error ? res.error.message : res.stderr}`
    );
  }
  return res.stdout;
}

/**
 * Take the watermark. Call at module load, before any suite plants bait or
 * launches a run, so everything a run does falls inside the watch window.
 *
 * @param {Object} [opts] - injectable for the unit tier; e2e callers use defaults
 * @param {string} [opts.root] - directory to watch, default `~/.claude`
 * @param {string[]} [opts.allowed] - allowlist, default `defaultAllowed()`
 * @param {string} [opts.repoRoot] - git tree that must come out untouched
 * @returns {{assertNoStrays: () => void, assertRepoUnchanged: () => void}}
 */
function beginStateWatch({
  root = path.join(os.homedir(), ".claude"),
  allowed = defaultAllowed(),
  repoRoot = REPO_ROOT,
} = {}) {
  const before = walkSet(root, allowed);
  const repoBefore = repoStatus(repoRoot);

  return {
    assertNoStrays() {
      const after = walkSet(root, allowed);
      const created = [...after].filter((rel) => !before.has(rel)).sort();
      const deleted = [...before].filter((rel) => !after.has(rel)).sort();
      const report = [];
      if (created.length) {
        report.push(`created outside the sanctioned roots:\n  ${created.join("\n  ")}`);
      }
      if (deleted.length) {
        report.push(`deleted outside the sanctioned roots:\n  ${deleted.join("\n  ")}`);
      }
      assert.ok(
        report.length === 0,
        `${root} changed during the run —\n${report.join("\n")}\n` +
          "If another Claude session was active on this machine it may be the writer, " +
          "but the path above is a real escape for whichever plugin wrote it."
      );
    },

    assertRepoUnchanged() {
      const repoAfter = repoStatus(repoRoot);
      // Print the drift itself: a bare "differs" forces whoever hits this to
      // re-derive it, and the commonest cause — editing the repo while the tier
      // runs — is obvious from the changed paths alone.
      const before = new Set(repoBefore.split("\n"));
      const drift = repoAfter
        .split("\n")
        .filter((line) => line && !before.has(line))
        .concat(repoBefore.split("\n").filter((line) => line && !repoAfter.includes(line)));
      assert.equal(
        repoAfter,
        repoBefore,
        `the run changed the repo working tree in ${repoRoot} —\n  ${drift.join("\n  ")}\n` +
          "(an edit made in the repo while the e2e tier was running trips this too)"
      );
    },
  };
}

module.exports = { beginStateWatch, defaultAllowed, isAllowed, walkSet, repoStatus };
