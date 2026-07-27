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
// GP-863 removed the last exemption (sessionstart-setup.cjs, which edited the
// user's ~/.claude/settings.json) — both remaining entries write only under
// ${CLAUDE_PLUGIN_DATA}, so the ban is now absolute.
const ALLOW = {
  "shared/plugin-state.cjs":
    "the single sanctioned state writer (writes only under ${CLAUDE_PLUGIN_DATA})",
  "shared/debug.cjs":
    "low-level error log under ${CLAUDE_PLUGIN_DATA}; can't depend on plugin-state (require cycle)",
};

// GP-863 AC3, as CI rather than a one-off grep: state locations that 3.0 retired.
// The fs-write ban above stops code from *writing* outside the data dir; this
// stops the retired paths from coming back at all, including via plugin-state
// (whose writers would silently no-op on them rather than fail loudly).
const BANNED = [
  {
    pattern: "PROJECT_STATE_DIR",
    reason: "repo-tree state dir — runtime state never lives in the project (R37)",
  },
  {
    pattern: ".gutt-statusline-configured",
    reason: "~/.claude marker from the retired statusline auto-setup (GP-863 removed it)",
  },
  {
    pattern: ".lessons-prompted",
    reason: "retired marker file — the record is a field in sessions/<id>.json (GP-863)",
    // The one legitimate mention: sweeping leftovers off disk after an upgrade.
    allow: ["gutt-core/hooks/session-start.cjs"],
  },
];

// Matches fs.<write> and fs.promises.<write>, sync and async forms. Bare
// destructured calls (no fs. prefix) aren't matched — the suite's convention is
// fs.*, and matching bare verb names would false-positive on local functions.
const WRITE_RE =
  /\bfs\.(promises\.)?(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|cp|cpSync|copyFile|copyFileSync|truncate|truncateSync|createWriteStream|write|writeSync|writev|writevSync)\b/;

const errors = [];

function scanFile(absFile) {
  const rel = path.relative(ROOT, absFile);
  const writesAllowed = rel in ALLOW;
  const lines = fs.readFileSync(absFile, "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip comment lines (JSDoc `*`, block/line comments) to avoid matching prose.
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      return;
    }
    const code = line.replace(/\/\/.*$/, "");

    if (!writesAllowed) {
      const m = code.match(WRITE_RE);
      if (m) {
        errors.push(
          `${rel}:${i + 1} direct ${m[0]} — route runtime-state writes through shared/plugin-state.cjs (R37)`
        );
      }
    }

    for (const banned of BANNED) {
      if (banned.allow?.includes(rel)) {
        continue;
      }
      if (code.includes(banned.pattern)) {
        errors.push(`${rel}:${i + 1} retired state path "${banned.pattern}" — ${banned.reason}`);
      }
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
  `State-location check OK: runtime-state writes route through shared/plugin-state.cjs ` +
    `(${Object.keys(ALLOW).length} sanctioned direct writers, ${BANNED.length} retired paths banned).`
);
