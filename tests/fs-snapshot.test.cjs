/**
 * Unit tier for the e2e filesystem-hygiene watch (tests/e2e/lib/fs-snapshot.cjs).
 *
 * The watch's job is to fail when a run creates or deletes a file outside the
 * sanctioned roots, and to fail when git itself cannot answer — so every red
 * path here is exercised against throwaway directories, the same discipline as
 * check-no-symlinks.test.cjs. The e2e tier then uses the watch for real; this
 * tier proves the instrument would actually go red.
 */

"use strict";

const assert = require("node:assert");
const { describe, it, before, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { beginStateWatch, isAllowed, walkSet, repoStatus } = require("./e2e/lib/fs-snapshot.cjs");

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
  git("add", ".");
  git("commit", "-qm", "seed");
  return repo;
}

describe("fs-snapshot: the hygiene watch", () => {
  let root;
  let repo;
  const opts = () => ({ root, allowed: ["allowed/"], repoRoot: repo });

  before(() => {
    root = makeRoot();
    repo = makeRepo();
  });
  after(() => {
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
    fs.rmSync(path.join(root, "watched", "stray.txt"));
  });

  it("fails on a new directory's contents, not just top-level files", () => {
    const watch = beginStateWatch(opts());
    fs.mkdirSync(path.join(root, "fresh-dir"));
    fs.writeFileSync(path.join(root, "fresh-dir", "nested.txt"), "leak");
    assert.throws(() => watch.assertNoStrays(), /fresh-dir\/nested\.txt/);
    fs.rmSync(path.join(root, "fresh-dir"), { recursive: true });
  });

  it("fails on a deletion outside the allowlist, naming it", () => {
    const watch = beginStateWatch(opts());
    fs.rmSync(path.join(root, "watched", "preexisting.txt"));
    assert.throws(() => watch.assertNoStrays(), /deleted outside[\s\S]*watched\/preexisting\.txt/);
    fs.writeFileSync(path.join(root, "watched", "preexisting.txt"), "old");
  });

  it("fails when the repo working tree changed", () => {
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(repo, "untracked-leak.txt"), "leak");
    assert.throws(() => watch.assertRepoUnchanged(), /changed the repo working tree/);
    fs.rmSync(path.join(repo, "untracked-leak.txt"));
    watch.assertRepoUnchanged();
  });

  it("catches modifications to tracked repo files, not only new ones", () => {
    const watch = beginStateWatch(opts());
    fs.writeFileSync(path.join(repo, "tracked.txt"), "tampered");
    assert.throws(() => watch.assertRepoUnchanged(), /changed the repo working tree/);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "committed");
  });

  it("goes red, not green, when git cannot answer", () => {
    // The watch must refuse to exist rather than report a clean tree it never saw.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-norepo-"));
    try {
      assert.throws(() => repoStatus(notARepo), /git status --porcelain failed/);
      assert.throws(() => beginStateWatch({ root, allowed: [], repoRoot: notARepo }));
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("treats a missing watch root as empty rather than crashing", () => {
    const watch = beginStateWatch({
      root: path.join(root, "never-made"),
      allowed: [],
      repoRoot: repo,
    });
    watch.assertNoStrays();
  });
});

describe("fs-snapshot: allowlist semantics", () => {
  it("matches directory entries by prefix and files exactly", () => {
    assert.equal(isAllowed("projects/a/b.jsonl", ["projects/"]), true);
    assert.equal(isAllowed("projects", ["projects/"]), true); // the dir node itself
    assert.equal(isAllowed("projects-evil/x", ["projects/"]), false);
    assert.equal(isAllowed("history.jsonl", ["history.jsonl"]), true);
    assert.equal(isAllowed("history.jsonl.bak", ["history.jsonl"]), false);
  });

  it("matches RegExp entries where they say, and nowhere else", () => {
    const inUse = [/^plugins\/cache\/.+\/\.in_use\//];
    assert.equal(isAllowed("plugins/cache/mkt/x/1.0.0/.in_use/81988", inUse), true);
    assert.equal(isAllowed("plugins/cache/mkt/x/1.0.0/payload.js", inUse), false);
    assert.equal(isAllowed("plugins/cache/.in_use/81988", inUse), false);
  });

  it("prunes allowlisted subtrees out of the walk entirely", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-snapshot-walk-"));
    try {
      fs.mkdirSync(path.join(root, "allowed", "deep"), { recursive: true });
      fs.writeFileSync(path.join(root, "allowed", "deep", "skipped.txt"), "x");
      fs.writeFileSync(path.join(root, "seen.txt"), "x");
      const found = walkSet(root, ["allowed/"]);
      assert.deepEqual([...found], ["seen.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
