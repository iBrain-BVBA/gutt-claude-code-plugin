#!/usr/bin/env node
// GP-933 guard: nothing in this repository may be committed as a symlink.
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

const entries = indexed.split("\0").filter(Boolean);

// Inspecting nothing is not the same as finding nothing wrong. `git ls-files -s -z`
// exits 0 and prints nothing whenever the index is empty — a fresh init, a blown-away
// index, a ROOT that stopped resolving to the repository root — so without this the
// guard reports success on a repository it never read. tests/test-all-hooks.cjs fails
// on a zero-hook discovery for the same reason.
if (!entries.length) {
  console.error(
    "No-symlink check FAILED: `git ls-files -s -z` returned no entries, so nothing was " +
      `inspected. Check that ${ROOT} is the repository root and that its index is populated.`
  );
  process.exit(1);
}

// "<mode> <object> <stage>\t<path>", NUL-separated with -z so paths containing
// whitespace survive intact. Matched strictly rather than sliced at the first space:
// indexOf returns -1 on an entry in an unexpected shape, slice(0, -1) does not throw,
// and the garbage mode that comes back compares unequal to 120000 — so a lenient parse
// silently files everything it cannot read under "not a symlink". An entry this guard
// cannot classify has to fail instead.
const ENTRY_RE = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/;
const symlinks = [];
for (const entry of entries) {
  const parsed = ENTRY_RE.exec(entry);
  if (!parsed) {
    console.error(
      "No-symlink check FAILED: unparseable `git ls-files -s -z` entry. The guard cannot " +
        `classify it, so it will not assume it is safe:\n  ${JSON.stringify(entry)}`
    );
    process.exit(1);
  }
  if (parsed[1] === "120000") {
    symlinks.push(parsed[2]);
  }
}

if (symlinks.length) {
  console.error(
    "No-symlink check FAILED — these are committed as symlinks (git mode 120000):\n  " +
      symlinks.join("\n  ") +
      "\n\nReplace each with a real file. Windows git writes the link target as file " +
      "content instead of creating a link, so a committed symlink is a broken file " +
      "for every Windows user. Code needed by two plugins gets copied into both."
  );
  process.exit(1);
}

console.log(`No-symlink check OK: ${entries.length} tracked files, none committed as a symlink.`);
