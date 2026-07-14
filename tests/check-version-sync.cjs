#!/usr/bin/env node
// GP-854 guard: plugin versions stay in sync. Each plugin's plugin.json is the
// single source of truth — GP-852 dropped versions from marketplace.json on
// purpose, and the update mechanism reads plugin.json's version as its cache key.
// So the root plugin's version must equal package.json's, and no marketplace
// entry may reintroduce a version field. Structural + zero-dep, like
// check-shared-libs / check-state-location.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const errors = [];
const pkg = readJson("package.json");
const market = readJson(".claude-plugin/marketplace.json");

if (!Array.isArray(market.plugins)) {
  console.error(
    'Version-sync check FAILED:\n  .claude-plugin/marketplace.json: "plugins" must be an array'
  );
  process.exit(1);
}

// package.json holds the root/repo version; exactly one published plugin (gutt-core)
// has the same plugin.json `name` as package.json (`gutt-claude-code-plugin`) and must
// track it. Guard the anchor itself — a check that
// silently matches nothing is worse than one that fails loudly (this repo has a
// history of silent no-op guards).
let rootAnchored = false;

for (const entry of market.plugins) {
  // entry.source feeds a path read — keep it a repo-relative, non-escaping string
  // so a malformed manifest fails with an actionable message, not a stack trace.
  if (
    typeof entry.source !== "string" ||
    path.isAbsolute(entry.source) ||
    entry.source.split(/[\\/]/).includes("..")
  ) {
    errors.push(
      `.claude-plugin/marketplace.json: entry "${entry.name || "?"}" has an invalid "source" (${JSON.stringify(entry.source)}) — expected a repo-relative path`
    );
    continue;
  }
  const manifestRel = path.join(entry.source, ".claude-plugin", "plugin.json");
  let manifest;
  try {
    manifest = readJson(manifestRel);
  } catch (e) {
    errors.push(`${manifestRel}: cannot read plugin manifest (${e.message})`);
    continue;
  }

  // marketplace.json carries no versions by design (GP-852); plugin.json is the
  // single source of truth. A stray version here would drift silently.
  if ("version" in entry) {
    errors.push(
      `.claude-plugin/marketplace.json: entry "${entry.name || "?"}" must not carry a "version" — plugin.json is the single source of truth (GP-852)`
    );
  }

  if (manifest.name === pkg.name) {
    rootAnchored = true;
    if (manifest.version !== pkg.version) {
      errors.push(
        `${manifestRel} (${manifest.version}) != package.json (${pkg.version}) — root plugin and package.json must match`
      );
    }
  }
}

if (!rootAnchored) {
  errors.push(
    `no plugin manifest has name "${pkg.name}" (from package.json) — root version is unanchored; nothing verifies package.json's version`
  );
}

if (errors.length) {
  console.error("Version-sync check FAILED:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log(
  `Version-sync check OK: ${market.plugins.length} plugin(s), root "${pkg.name}" at ${pkg.version}.`
);
