/**
 * Runtime filesystem-hygiene watch for the e2e tier (R37).
 *
 * `tests/check-state-location.cjs` proves statically that no hook code matches an
 * `fs.<write>` call pattern outside a small sanctioned-writer allowlist. This
 * proves dynamically that a real run *behaved* — including runs where a hook died
 * mid-flight, which no grep can see. One watermark when the suite loads, one diff
 * when it ends.
 *
 * What is watched:
 *
 * - `~/.claude`, recursively — files **and directory nodes**, so an empty leftover
 *   tree (mkdir succeeded, the write after it did not — canonical crash residue)
 *   is visible. Every creation or deletion outside the allowlist below fails the
 *   suite. Modifications to files under this root are out of scope: creations and
 *   deletions are AC1's subject, and the one user file with byte-level stakes
 *   (`settings.json`) has dedicated byte- and key-level assertions in
 *   session-lifecycle.e2e.cjs.
 * - The repo working tree, via `git status --porcelain -uall --ignored=matching`
 *   equality. `-uall` stops an untracked directory from collapsing to one line
 *   (a second file inside it would otherwise be invisible), and
 *   `--ignored=matching` lists ignored files — which is load-bearing: the
 *   breadcrumb names debug.cjs writes (`hook-errors.log`,
 *   `hook-invocations.log`, `config.json`) are all gitignored, and under
 *   `--plugin-dir` the plugin root *is* this repo, so a regression that loses the
 *   CLAUDE_PLUGIN_DATA routing would land exactly there. Equality also catches
 *   edits to tracked files, which a create/delete walk cannot.
 *
 * What is NOT watched, so nobody reads more into a green run than it proves:
 * `$HOME` outside `~/.claude` (`~/.claude.json` lives there), `/tmp`, the targets
 * of symlinks under the root (symlinks are recorded as entries, never followed),
 * a file created and deleted entirely inside the window, new files inside a
 * directory that was already wholly gitignored before the run, and the throwaway
 * project dirs — those are asserted per-suite where a suite asserts them
 * (session-lifecycle and state-hygiene do; the other suites create and remove
 * theirs without walking them).
 *
 * Concurrent sessions: the developer's own live sessions write while the tier
 * runs. The surfaces they were measured touching are allowlisted with their
 * reasons below — per-plugin data dirs, CLI session artifacts, the ponytail
 * toggle, plan handoffs — so a quiet machine is not a precondition. One deliberate
 * exception: `plugins/marketplaces/` and `plugins/cache/` are CLI-refreshed git
 * trees and stay watched, because an install is exactly what this tier must never
 * perform — so a CLI marketplace refresh landing mid-tier reds the run, and the
 * remedy is to rerun after it settles. Any other stray is a real finding for
 * whichever process wrote it; the failure message names the path so it can be
 * attributed rather than guessed at.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { REPO_ROOT } = require("./claude-run.cjs");

/**
 * Paths under the watched root where creations are sanctioned. Three entry
 * shapes, each with its one-line reason so the list cannot rot silently (the
 * check-state-location.cjs discipline):
 *
 * - a string ending in "/" names a directory subtree that is both allowed and
 *   **pruned** — never recorded, never descended into. Only CLI-owned dirs whose
 *   entire contents are theirs belong here.
 * - a bare string names one file, matched exactly.
 * - a RegExp is filter-only: matching paths are not flagged, but directories are
 *   still walked, because a pattern cannot promise anything about a whole
 *   subtree. Use it when a subtree is only partially sanctioned.
 * @returns {Array<string|RegExp>}
 */
function defaultAllowed() {
  return [
    // The union of every plugin's data dir. A filesystem diff cannot attribute
    // a write to a process, so per-plugin attribution is not this instrument's
    // to enforce — cross-plugin containment lives in the static guard
    // (check-state-location.cjs) and the plugin-state unit tier, and which
    // install copy the run under test executed is pinned by the lifecycle
    // suite's execution-evidence tests. What forces the union: concurrent
    // developer sessions write their own installed plugins' dirs continuously
    // (measured: gutt-pro-gutt-plugins, ponytail-ponytail). Filter-only on
    // purpose: debris at the plugins/data/ root itself stays flagged.
    /^plugins\/data\/[^/]+\//,
    // Per-session pid markers the CLI stamps into every installed plugin's cache
    // dir. Only the marker is sanctioned — the rest of plugins/cache/ stays
    // watched, because anything else appearing there is an install this tier
    // must never perform.
    /^plugins\/cache\/.+\/\.in_use\//,
    // Transcript dirs: the CLI creates one per session (ours and any concurrent
    // one), and provisions an empty `memory/` node inside every one of them.
    // Only the suite's own projects keep their store *contents* watched — every
    // harness project is mkdtemp-named `gutt-e2e-*`, so its encoded dir carries
    // that marker. There the GP-922 suites plant and must fully remove store
    // files, and deleteVerified unlinks fact files, which is precisely the
    // delete AC1 polices. Real projects' stores are the user's live data —
    // memory-keeper writes and prunes them from any concurrent session — so
    // watching them reintroduces the quiet-machine precondition this allowlist
    // exists to remove.
    /^projects\/(?![^/]*-gutt-e2e-)[^/]+\//,
    /^projects\/[^/]*-gutt-e2e-[^/]*\/(memory\/$|(?!memory(\/|$)))/,
    // CLI-owned surfaces, wholly theirs — pruned for walk cost.
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
    // Developer-machine surfaces other actors write during a run.
    // Handoff notes only — filter-only, so anything else appearing in plans/
    // (a subdirectory, a non-markdown file) stays visible.
    /^plans\/[^/]+\.md$/,
    // Third-party statusline toggle, observed written and unlinked at this root
    // by the developer's own sessions. Hardcoding one product's marker is the
    // cost of watching the root it lives at; a machine without it never
    // exercises the entry, so it cannot mask anything there.
    ".ponytail-active",
    // CLI-rolled top-level files.
    "history.jsonl", // prompt history
    "stats-cache.json", // usage-stats cache the CLI rewrites on its own
    ".session-stats.json", // per-session counters, CLI-rolled
    ".last-cleanup", // CLI cleanup watermark
    ".last-update-result.json", // CLI updater breadcrumb
  ];
}

/**
 * @param {string} rel
 * @param {Array<string|RegExp>} allowed
 * @returns {boolean} true when `rel` must not be flagged
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
 * @param {string} rel
 * @param {Array<string|RegExp>} allowed
 * @returns {boolean} true when `rel` is a subtree safe to skip wholesale —
 *   string directory entries only; a RegExp match never justifies pruning
 */
function shouldPrune(rel, allowed) {
  return allowed.some(
    (entry) =>
      typeof entry === "string" &&
      entry.endsWith("/") &&
      (rel.startsWith(entry) || `${rel}/` === entry)
  );
}

/**
 * Every file and directory node under `root` outside the allowlist, as
 * root-relative paths — directories recorded with a trailing "/" so an empty
 * leftover tree diffs like anything else. Symlinks are recorded, never followed.
 *
 * Fail-closed: a subtree this walk cannot read is a red result, not a silent
 * pass — EACCES on a directory would otherwise hide every write inside it from
 * both walks, permanently, and the assertion would report clean. Only the two
 * vanish races (ENOENT/ENOTDIR: the entry was deleted or replaced between the
 * parent readdir and ours) are tolerated, because concurrent sessions delete
 * legitimately.
 * @param {string} root
 * @param {Array<string|RegExp>} allowed
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
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        continue;
      }
      throw new Error(`hygiene walk cannot read ${path.join(root, dirRel)}: ${err.code}`);
    }
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Directory nodes are keyed with a trailing slash, so a pattern written
        // for a subtree (`x/[^/]+\/`) matches the dir node itself but can never
        // accidentally sanction a bare file at the same level.
        const key = `${rel}/`;
        if (shouldPrune(key, allowed)) {
          continue;
        }
        if (!isAllowed(key, allowed)) {
          found.add(key);
        }
        stack.push(rel);
      } else if (!isAllowed(rel, allowed)) {
        found.add(rel);
      }
    }
  }
  return found;
}

/**
 * Porcelain status including every untracked file individually (`-uall`) and
 * ignored paths (`--ignored=matching`) — see the module header for why both
 * flags are load-bearing. Throws rather than returning on any git failure: a
 * broken git is a red result, not a clean tree (the check-no-symlinks rule).
 * @param {string} repoRoot
 * @returns {string}
 */
function repoStatus(repoRoot) {
  const res = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
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
 * Refuses to run under CLAUDE_CONFIG_DIR: that variable relocates `~/.claude`
 * wholesale (the plugin's own builtin-memory.cjs honours it), but the e2e
 * harness in claude-run.cjs resolves every artifact under the default root — so
 * with it set, this watch would either watch a quiescent stale root (vacuous
 * green) or disagree with the harness about where the run happened. Failing
 * loudly is the only answer that cannot lie.
 *
 * @param {Object} [opts] - injectable for the unit tier; e2e callers use defaults
 * @param {string} [opts.root] - directory to watch, default `~/.claude`
 * @param {Array<string|RegExp>} [opts.allowed] - allowlist, default `defaultAllowed()`
 * @param {string} [opts.repoRoot] - git tree that must come out untouched
 * @returns {{assertNoStrays: () => void, assertRepoUnchanged: () => void}}
 */
function beginStateWatch({
  root = path.join(os.homedir(), ".claude"),
  allowed = defaultAllowed(),
  repoRoot = REPO_ROOT,
} = {}) {
  // Gated on the default root: an injected root (the unit tier's throwaway
  // fixtures) is exactly where the run happens, variable or no variable — only
  // a watch pointed at the real config root can be pointed at the wrong one.
  if (root === path.join(os.homedir(), ".claude") && process.env.CLAUDE_CONFIG_DIR) {
    throw new Error(
      "CLAUDE_CONFIG_DIR is set, but the e2e harness resolves everything under ~/.claude — " +
        "the hygiene watch would watch the wrong root. Unset it to run this tier."
    );
  }
  const before = walkSet(root, allowed);
  // A watch that inspected nothing must not get the chance to report success —
  // a real config root always holds something (settings, projects, history).
  if (before.size === 0) {
    throw new Error(`hygiene watch inspected nothing under ${root} — wrong or empty root`);
  }
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
          "but the path above is a real escape for whichever process wrote it."
      );
    },

    assertRepoUnchanged() {
      const repoAfter = repoStatus(repoRoot);
      // Print the drift itself, by porcelain line: a bare "differs" forces
      // whoever hits this to re-derive it, and the commonest cause — editing the
      // repo while the tier runs — is obvious from the changed paths alone.
      const beforeLines = new Set(repoBefore.split("\n").filter(Boolean));
      const afterLines = new Set(repoAfter.split("\n").filter(Boolean));
      const drift = [...afterLines]
        .filter((line) => !beforeLines.has(line))
        .map((line) => `+ ${line}`)
        .concat(
          [...beforeLines].filter((line) => !afterLines.has(line)).map((line) => `- ${line}`)
        );
      assert.equal(
        repoAfter,
        repoBefore,
        `the run changed the repo working tree in ${repoRoot} —\n  ${drift.join("\n  ")}\n` +
          "(an edit made in the repo while the e2e tier was running trips this too)"
      );
    },
  };
}

module.exports = { beginStateWatch, defaultAllowed, isAllowed, shouldPrune, walkSet, repoStatus };
