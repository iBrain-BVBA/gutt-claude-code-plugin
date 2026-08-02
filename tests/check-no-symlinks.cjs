#!/usr/bin/env node
// GP-933 guard: nothing in this repository may be a symlink.
//
// Replaces the GP-853 guard, which enforced the opposite — that each plugin's
// hook libs were symlinks into a marketplace-root shared/ directory. That design
// shipped gutt-pro 3.0.0 broken on Windows: git defaults to core.symlinks=false
// there, and rather than creating a link it writes the link *target path* as the
// file's contents. Every hook then died at require() trying to parse
// "../../../shared/debug.cjs" as JavaScript. The links also pointed outside the
// plugin root, which installed plugins are not allowed to do.
//
// So the invariant is now the inverse: each plugin owns its code as real files,
// and a symlink anywhere is a build error rather than a field report.
//
// Reads the git index rather than the working tree on purpose. Mode 120000 is
// what actually gets committed and cloned, and it is recorded identically on
// every platform — on a Windows checkout the working tree shows a regular file,
// so an lstat-based check would pass there while the repo stayed broken.
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

let indexed;
try {
  indexed = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (err) {
  console.error(`No-symlink check FAILED: could not read the git index (${err.message})`);
  process.exit(1);
}

// `git ls-files -s` emits "<mode> <object> <stage>\t<path>", NUL-separated with -z
// so paths containing whitespace survive intact.
const symlinks = indexed
  .split("\0")
  .filter(Boolean)
  .map((entry) => {
    const tab = entry.indexOf("\t");
    return { mode: entry.slice(0, entry.indexOf(" ")), file: entry.slice(tab + 1) };
  })
  .filter((e) => e.mode === "120000");

if (symlinks.length) {
  console.error(
    "No-symlink check FAILED — these are committed as symlinks (git mode 120000):\n  " +
      symlinks.map((e) => e.file).join("\n  ") +
      "\n\nReplace each with a real file. Windows git writes the link target as file " +
      "content instead of creating a link, so a committed symlink is a broken file " +
      "for every Windows user. Code needed by two plugins gets copied into both."
  );
  process.exit(1);
}

const count = indexed.split("\0").filter(Boolean).length;
console.log(`No-symlink check OK: ${count} tracked files, none committed as a symlink.`);
