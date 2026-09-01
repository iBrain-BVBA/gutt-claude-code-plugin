/**
 * Unit tier for the e2e filesystem-hygiene watch (tests/e2e/lib/fs-snapshot.cjs).
 *
 * The watch's job is to fail when a run creates or deletes a file outside the
 * sanctioned roots, and to fail when it could not actually look — so every red
 * path is exercised against throwaway directories, the same discipline as
 * check-no-symlinks.test.cjs: a broken git, an unreadable subtree, a root that
 * yielded nothing, and a relocated config root all throw rather than pass.
 *
 * The real allowlist is under test too, not just the mechanism: defaultAllowed()
 * is the one function that decides red from green in production, and a widened
 * entry there must fail here, not only on the next paid e2e run.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  beginStateWatch,
  defaultAllowed,
  isAllowed,
  walkSet,
  repoStatus,
} = require("./e2e/lib/fs-snapshot.cjs");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-"));
  fs.mkdirSync(path.join(root, "allowed"), { recursive: true });
  fs.mkdirSync(path.join(root, "watched"), { recursive: true });
  fs.writeFileSync(path.join(root, "watched", "preexisting.txt"), "old");
  return root;
}

/** A real git repo with one clean, committed file. */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-repo-"));
  const git = (...args) => {
    const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "committed");
  fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  git("add", ".");
  git("commit", "-qm", "seed");
  return repo;
}

describe("fs-snapshot: the hygiene watch", () => {
  // Fresh fixtures per case: a failing case must not poison the ones after it.
  let root;
  let repo;
  const opts = () => ({ root, allowed: ["allowed/"], repoRoot: repo });

  beforeEach(() => {
    root = makeRoot();
    repo = makeRepo();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("passes when nothing changed", () => {
    const watch = beginStateWatch(opts());
    watch.assertNoStrays();
    watch.assertRepoUnchanged();
  });

  it("ignores creations inside an allowlisted subtree", () => {
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(root, "allowed", "sanctioned.json"), "{}");
    watch.assertNoStrays();
  });

  it("fails on a file created outside the allowlist, naming it", () => {
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(root, "watched", "stray.txt"), "leak");
    assert.throws(() => watch.assertNoStrays(), /created outside[\s\S]*watched\/stray\.txt/);
  });

  it("fails on a new directory's contents, not just top-level files", () => {
    const watch = beginStateWatch(opts());
    fs.mkdirSync(path.join(root, "fresh-dir"));
    fs.writeFileSync(path.join(root, "fresh-dir", "nested.txt"), "leak");
    assert.throws(() => watch.assertNoStrays(), /fresh-dir\/nested\.txt/);
  });

  it("fails on an empty leftover directory — the canonical crash residue", () => {
    // mkdir succeeded, the write after it did not: a hook killed mid-flight
    // leaves exactly this, and a files-only walk cannot see it.
    const watch = beginStateWatch(opts());
    fs.mkdirSync(path.join(root, "watched", "tmp-half-made"));
    assert.throws(() => watch.assertNoStrays(), /watched\/tmp-half-made\//);
  });

  it("fails on a deletion outside the allowlist, naming it", () => {
    const watch = beginStateWatch(opts());
    fs.rmSync(path.join(root, "watched", "preexisting.txt"));
    assert.throws(() => watch.assertNoStrays(), /deleted outside[\s\S]*watched\/preexisting\.txt/);
  });

  it("fails when the repo working tree changed, printing the drifted lines", () => {
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(repo, "untracked-leak.txt"), "leak");
    assert.throws(
      () => watch.assertRepoUnchanged(),
      /changed the repo working tree[\s\S]*untracked-leak\.txt/
    );
    fs.rmSync(path.join(repo, "untracked-leak.txt"));
    watch.assertRepoUnchanged();
  });

  it("catches modifications to tracked repo files, not only new ones", () => {
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(repo, "tracked.txt"), "tampered");
    assert.throws(() => watch.assertRepoUnchanged(), /changed the repo working tree/);
  });

  it("catches gitignored writes — the breadcrumb filenames are all ignored", () => {
    // hook-errors.log, hook-invocations.log, config.json all match .gitignore
    // patterns in the real repo; default porcelain omits them entirely.
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(repo, "hook-errors.log"), "leak");
    assert.throws(() => watch.assertRepoUnchanged(), /hook-errors\.log/);
  });

  it("catches a second file inside an already-untracked directory", () => {
    // Default porcelain collapses an untracked dir to one "?? dir/" line, so a
    // second file inside it changes nothing without --untracked-files=all.
    fs.mkdirSync(path.join(repo, "newdir"));
    fs.writeFileSync(path.join(repo, "newdir", "first.txt"), "1");
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(repo, "newdir", "second.txt"), "2");
    assert.throws(() => watch.assertRepoUnchanged(), /newdir\/second\.txt/);
  });

  it("goes red, not green, when git cannot answer", () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-norepo-"));
    try {
      assert.throws(() => repoStatus(notARepo), /git status --porcelain failed/);
      assert.throws(
        () => beginStateWatch({ root, allowed: [], repoRoot: notARepo }),
        /git status --porcelain failed/
      );
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("goes red, not green, when the watch root yields nothing", () => {
    // A missing or empty root means the watch inspected nothing — that must be
    // a refusal to run, never a clean report (the check-no-symlinks rule).
    assert.throws(
      () => beginStateWatch({ root: path.join(root, "never-made"), allowed: [], repoRoot: repo }),
      /inspected nothing/
    );
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-empty-"));
    try {
      assert.throws(
        () => beginStateWatch({ root: empty, allowed: [], repoRoot: repo }),
        /inspected nothing/
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("goes red, not green, on a subtree it cannot read", { skip: skipPermissionCase() }, () => {
    const sealed = path.join(root, "watched", "sealed");
    fs.mkdirSync(sealed);
    fs.chmodSync(sealed, 0o000);
    try {
      assert.throws(() => walkSet(root, []), /hygiene walk cannot read .*sealed: EACCES/);
    } finally {
      fs.chmodSync(sealed, 0o755);
    }
  });

  it("refuses the default root under CLAUDE_CONFIG_DIR, but injected roots still run", () => {
    // The refusal exists for the e2e tier, whose watch points at the real config
    // root. The unit tier's throwaway roots are exactly where their runs happen,
    // variable or no variable — an un-gated refusal here broke `npm test` on any
    // machine with the variable set.
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/somewhere/else";
    try {
      const watch = beginStateWatch(opts()); // injected root: must not throw
      watch.assertNoStrays();
      assert.throws(() => beginStateWatch({ repoRoot: repo }), /CLAUDE_CONFIG_DIR is set/);
    } finally {
      if (prior === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = prior;
      }
    }
  });
});

/** Permission-bit cases prove nothing where the reader bypasses permissions. */
function skipPermissionCase() {
  if (process.platform === "win32") {
    return "chmod 000 does not restrict reads on Windows";
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return "root bypasses permission bits";
  }
  return false;
}

describe("fs-snapshot: allowlist semantics", () => {
  it("matches directory entries by prefix and files exactly", () => {
    assert.equal(isAllowed("projects/a/b.jsonl", ["projects/"]), true);
    assert.equal(isAllowed("projects/", ["projects/"]), true); // the dir node itself
    assert.equal(isAllowed("projects-evil/x", ["projects/"]), false);
    assert.equal(isAllowed("history.jsonl", ["history.jsonl"]), true);
    assert.equal(isAllowed("history.jsonl.bak", ["history.jsonl"]), false);
  });

  it("prunes only string subtrees; a RegExp filters but never prunes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-walk-"));
    try {
      fs.mkdirSync(path.join(root, "allowed", "deep"), { recursive: true });
      fs.writeFileSync(path.join(root, "allowed", "deep", "skipped.txt"), "x");
      fs.mkdirSync(path.join(root, "patterned", "memory"), { recursive: true });
      fs.writeFileSync(path.join(root, "patterned", "ok.txt"), "x");
      fs.writeFileSync(path.join(root, "patterned", "memory", "fact.md"), "x");
      fs.writeFileSync(path.join(root, "seen.txt"), "x");
      // The pattern sanctions patterned/* except memory — the walk must still
      // descend through the sanctioned level (its dir node matches the pattern
      // too, via the lookahead at end-of-string) to find the watched store.
      const found = walkSet(root, ["allowed/", /^patterned\/(?!memory(\/|$))/]);
      assert.deepEqual([...found].sort(), [
        "patterned/memory/",
        "patterned/memory/fact.md",
        "seen.txt",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds the real defaultAllowed() to the boundary the e2e tier relies on", () => {
    // This is the one function that decides red from green in production; a
    // widened entry must fail here, not on the next paid run.
    const allowed = defaultAllowed();
    const suite = "projects/-tmp-T-gutt-e2e-lifecycle-abc"; // a harness-owned project
    const real = "projects/-Users-dev-some-repo"; // anyone's real project
    const sanctioned = [
      "plugins/data/gutt-pro-inline/", // the run under test
      "plugins/data/gutt-pro-gutt-plugins/sessions/x.json", // a concurrent session's install
      "plugins/cache/mkt/x/1.0.0/.in_use/81988", // CLI per-session pid marker
      `${suite}/`, // a harness session's transcript dir
      `${suite}/transcript.jsonl`,
      `${suite}/memory/`, // the CLI provisions the empty node per session
      `${real}/memory/fact.md`, // a real project's store is the user's live data
      `${real}/memory/`,
      "plans/handoff.md",
      ".ponytail-active",
      "history.jsonl",
    ];
    const watched = [
      "plugins/data/rogue.lock", // debris at the data root itself
      "plugins/data/", // the data root node
      "plugins/cache/mkt/x/1.0.0/payload.js", // an install this tier must never do
      `${suite}/memory/fact.md`, // a harness store's *contents* — GP-922 polices these
      `${suite}/memory/sub/`, // and anything nested in it
      "plans/evil-dir/x.bin", // plans/ sanctions only top-level handoff notes
      "plans/x.tmp",
      "hooks/evil.cjs", // user-owned hook surface
      "settings.json",
      "CLAUDE.md",
      "plugins/config.json",
      "history.jsonl.bak",
    ];
    for (const rel of sanctioned) {
      assert.equal(isAllowed(rel, allowed), true, `${rel} must be sanctioned`);
    }
    for (const rel of watched) {
      assert.equal(isAllowed(rel, allowed), false, `${rel} must stay watched`);
    }
  });
});

describe("fs-snapshot: the e2e tier carries the watch", () => {
  // Five hand-copied wiring blocks hold the AC1 invariant; this pins them so a
  // sixth suite (or a refactor of an existing one) cannot drop the watch or bury
  // its assertions above the runs they must follow. Textual heuristic on
  // purpose: lastIndexOf("describe(") can be misdirected by a commented or
  // nested describe below the real one — it is a wiring pin, not a parser, and
  // a false red here costs one look at the file.
  const e2eDir = path.join(__dirname, "e2e");
  const suites = fs.readdirSync(e2eDir).filter((name) => name.endsWith(".e2e.cjs"));

  it("finds the e2e suites at all", () => {
    assert.ok(suites.length >= 5, `expected at least 5 e2e suites, found ${suites.length}`);
  });

  for (const name of suites) {
    it(`${name} takes the watermark and closes with the AC1 hygiene describe`, () => {
      const src = fs.readFileSync(path.join(e2eDir, name), "utf8");
      assert.match(src, /beginStateWatch\(/, "no stateWatch watermark");
      assert.match(src, /assertNoStrays\(\)/, "never asserts on strays");
      assert.match(src, /assertRepoUnchanged\(\)/, "never asserts on the repo tree");
      const lastDescribe = src.lastIndexOf("describe(");
      assert.ok(lastDescribe >= 0, "no describe blocks at all");
      assert.match(
        src.slice(lastDescribe, lastDescribe + 200),
        /GP-893 AC1/,
        "the AC1 hygiene describe must be the file's last, so it runs after every run"
      );
    });
  }
});
