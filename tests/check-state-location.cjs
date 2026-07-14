#!/usr/bin/env node
// GP-855 guard (R37): all runtime state routes through shared/plugin-state.cjs,
// which writes only under ${CLAUDE_PLUGIN_DATA}. Any other hook/lib that calls an
// fs write API directly is how state escapes to the project tree — so it's banned
// outside a tiny, reasoned allowlist. Structural + zero-dep, like check-shared-libs.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Dirs whose .cjs files ship as plugin hooks/libs. shared/ holds the canonical
// libs; hooks/lib/* are symlinks into it (skipped during the walk, scanned here).
const SCAN_DIRS = [
  "shared",
  "gutt-core/hooks",
  "auto-lint-plugin/hooks",
  "plugins/gutt-subagent-hooks-plugin/hooks",
];

// Sanctioned direct writers, each with a one-line reason (kept short so the list
// can't rot silently). Everything else must go through shared/plugin-state.cjs.
const ALLOW = {
  "shared/plugin-state.cjs":
    "the single sanctioned state writer (writes only under ${CLAUDE_PLUGIN_DATA})",
  "shared/debug.cjs":
    "low-level error log under ${CLAUDE_PLUGIN_DATA}; can't depend on plugin-state (require cycle)",
  "gutt-core/hooks/sessionstart-setup.cjs":
    "one-time IDE setup: edits the user's ~/.claude/settings.json, not runtime state (R37 exempt)",
};

const WRITE_RE =
  /\bfs\.(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|createWriteStream|cpSync|copyFileSync|truncateSync|writeSync)\b/;

const errors = [];

function scanFile(absFile) {
  const rel = path.relative(ROOT, absFile);
  if (rel in ALLOW) {
    return;
  }
  const lines = fs.readFileSync(absFile, "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip comment lines (JSDoc `*`, block/line comments) to avoid matching prose.
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      return;
    }
    const code = line.replace(/\/\/.*$/, "");
    const m = code.match(WRITE_RE);
    if (m) {
      errors.push(
        `${rel}:${i + 1} direct fs.${m[1]} — route runtime-state writes through shared/plugin-state.cjs (R37)`
      );
    }
  });
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      continue; // hooks/lib/* symlink into shared/ — scanned there, not twice
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".state") {
        continue;
      }
      walk(abs);
    } else if (name.endsWith(".cjs")) {
      scanFile(abs);
    }
  }
}

for (const d of SCAN_DIRS) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) {
    walk(abs);
  }
}

if (errors.length) {
  console.error(
    "State-location check FAILED (R37 — runtime state must stay under ${CLAUDE_PLUGIN_DATA}):\n  " +
      errors.join("\n  ")
  );
  process.exit(1);
}
console.log(
  `State-location check OK: runtime-state writes route through shared/plugin-state.cjs (${Object.keys(ALLOW).length} sanctioned direct writers).`
);
