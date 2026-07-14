#!/usr/bin/env node
// GP-853 guard: shared hook libs have exactly one source (shared/), and every
// plugin-side occurrence of a shared lib is a symlink into it — never a divergent
// real copy. Replaces the hand-maintained propagation table in CLAUDE.md.
// ponytail: one invariant, one loop, no deps.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SHARED = path.join(ROOT, "shared");
const LIB_DIRS = [
  "gutt-core/hooks/lib",
  "auto-lint-plugin/hooks/lib",
  "plugins/gutt-subagent-hooks-plugin/hooks/lib",
];

const errors = [];

if (!fs.existsSync(SHARED)) {
  console.error(`Shared-lib check FAILED: ${SHARED} does not exist`);
  process.exit(1);
}

const shared = new Set(fs.readdirSync(SHARED).filter((f) => f.endsWith(".cjs")));

// shared/ holds the canonical real files — none may itself be a symlink.
for (const f of shared) {
  if (fs.lstatSync(path.join(SHARED, f)).isSymbolicLink()) {
    errors.push(`shared/${f} must be a real file, not a symlink`);
  }
}

// Every plugin lib that shares a name with a shared/ lib must be a symlink to it.
// Plugin-local libs (no shared/ counterpart, e.g. text-utils.cjs) are allowed.
for (const dir of LIB_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) {
    continue;
  }
  for (const f of fs.readdirSync(abs)) {
    if (!f.endsWith(".cjs") || !shared.has(f)) {
      continue;
    }
    const p = path.join(abs, f);
    if (!fs.lstatSync(p).isSymbolicLink()) {
      errors.push(`${dir}/${f} duplicates shared/${f} — must be a symlink into shared/`);
      continue;
    }
    if (fs.realpathSync(p) !== fs.realpathSync(path.join(SHARED, f))) {
      errors.push(`${dir}/${f} resolves to ${fs.realpathSync(p)}, expected shared/${f}`);
    }
  }
}

if (errors.length) {
  console.error("Shared-lib check FAILED:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log(
  `Shared-lib check OK: ${shared.size} canonical libs in shared/, all plugin copies symlinked.`
);
