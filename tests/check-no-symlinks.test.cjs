#!/usr/bin/env node
/**
 * The no-symlink guard's own red paths.
 *
 * `tests/check-no-symlinks.cjs` runs against this repository in `npm run test:all` and
 * in CI, where it must always pass — so nothing else in the suite ever sees it fail. A
 * guard whose failure path has never been executed is not yet a guard: it can be broken
 * into a permanent no-op and every run stays green. These build throwaway repositories
 * and assert it goes red on each way it is supposed to.
 *
 * Run: node --test tests/check-no-symlinks.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { canSymlink } = require("./helpers/capabilities.cjs");

const GUARD = path.join(__dirname, "check-no-symlinks.cjs");

/**
 * A throwaway git repository with the guard copied in at the path it expects.
 *
 * The guard resolves its ROOT as its own parent directory, so it has to be copied into
 * the fixture rather than invoked from this checkout — otherwise every case would read
 * the real repository and pass.
 */
function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "no-symlink-guard-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "guard-test@example.invalid");
  git("config", "user.name", "Guard Test");
  git("config", "core.symlinks", "true");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.copyFileSync(GUARD, path.join(dir, "tests", "check-no-symlinks.cjs"));
  const run = () =>
    spawnSync(process.execPath, [path.join(dir, "tests", "check-no-symlinks.cjs")], {
      cwd: dir,
      encoding: "utf8",
    });
  return { dir, git, run };
}

describe("the no-symlink guard fails when it should", () => {
  // The premise is a committed symlink, so a host that cannot create one cannot pose
  // the question. Skipping is honest here; the guard itself is platform-independent
  // and CI runs this on Linux.
  it(
    "exits non-zero on a committed symlink, and names it",
    {
      skip: canSymlink() ? false : "this host does not permit creating symlinks",
    },
    (t) => {
      const { dir, git, run } = tempRepo();
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

      fs.mkdirSync(path.join(dir, "gutt-core", "hooks", "lib"), { recursive: true });
      fs.writeFileSync(path.join(dir, "shared.cjs"), "module.exports = {};\n");
      fs.symlinkSync("../../../shared.cjs", path.join(dir, "gutt-core/hooks/lib/debug.cjs"));
      git("add", "-A");

      const out = run();
      assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
      assert.match(out.stderr, /committed as symlinks/);
      assert.match(out.stderr, /gutt-core\/hooks\/lib\/debug\.cjs/);
    }
  );

  it("exits non-zero when the index is empty rather than reporting a clean repo", (t) => {
    // The failure this exists for: `git ls-files` exits 0 and prints nothing on an empty
    // index, so a guard without a floor check reports success on a repository it never
    // read. Inspecting nothing is not the same as finding nothing wrong.
    const { dir, run } = tempRepo();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const out = run();
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /nothing was inspected/i);
  });

  it("exits non-zero outside a git repository", (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "no-symlink-bare-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.copyFileSync(GUARD, path.join(dir, "tests", "check-no-symlinks.cjs"));

    const out = spawnSync(process.execPath, [path.join(dir, "tests", "check-no-symlinks.cjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
    });
    assert.equal(out.status, 1, `expected a failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /could not read the git index/);
  });
});

describe("the no-symlink guard passes when it should", () => {
  it("exits zero on a repository of real files, and counts them", (t) => {
    const { dir, git, run } = tempRepo();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(dir, "gutt-core", "hooks", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "gutt-core/hooks/lib/debug.cjs"), "module.exports = {};\n");
    git("add", "-A");

    const out = run();
    assert.equal(out.status, 0, `expected a pass, got:\n${out.stdout}${out.stderr}`);
    // Two files: the copied guard and the lib. The count is asserted rather than merely
    // printed, because "0 tracked files" was itself a passing state before the floor.
    assert.match(out.stdout, /No-symlink check OK: 2 tracked files/);
  });
});
