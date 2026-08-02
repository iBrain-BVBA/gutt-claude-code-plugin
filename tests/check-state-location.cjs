#!/usr/bin/env node
// GP-855 guard (R37): all runtime state routes through the plugin's
// plugin-state.cjs, which writes only under ${CLAUDE_PLUGIN_DATA}. Any other
// hook/lib that calls an fs write API directly is how state escapes to the project
// tree — so it's banned outside a tiny, reasoned allowlist. Structural + zero-dep,
// like check-no-symlinks.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Dirs whose .cjs files ship as plugin hooks/libs. Each plugin owns its libs
// outright (GP-933), so the walk sees every file exactly once.
const SCAN_DIRS = ["gutt-core/hooks"];

// Sanctioned direct writers, each with a one-line reason (kept short so the list
// can't rot silently). Everything else must go through plugin-state.cjs.
//
// GP-863 removed the previous ~/.claude/settings.json exemption
// (sessionstart-setup.cjs) and called the ban absolute. GP-895 re-opens it for
// migrations.cjs alone, and narrowly: that module only ever *deletes* a key a past
// version of this plugin wrote, only when the file it points at is already gone,
// once per machine, after backing the original up under ${CLAUDE_PLUGIN_DATA}.
//
// GP-867 re-opens it a second time, and this one *adds* a key, so the old wording
// ("no hook adds to settings.json") no longer holds and is not quietly left in
// place. What replaces it is narrower than "no adds" and is the property actually
// worth defending: **nothing writes settings.json unless the user asked for it.**
// statusline-install.cjs writes exactly one key, `statusLine`, and only from the
// explicit /gutt-pro:statusline command — because a plugin cannot ship a working
// status line, so the key lives in the user's own settings or nowhere. It re-asserts
// that key without being asked again in exactly one case: the user already consented
// and Claude Code dropped it mid-session (anthropics/claude-code#62486, closed as
// not planned). It never touches a status line it did not write, and it backs the
// whole file up first. A hook that configured settings unprompted would still be a
// violation; that is what GP-863 deleted and it stays deleted.
const ALLOW = {
  "gutt-core/hooks/lib/plugin-state.cjs":
    "the single sanctioned state writer (writes only under ${CLAUDE_PLUGIN_DATA})",
  "gutt-core/hooks/lib/debug.cjs":
    "low-level error log under ${CLAUDE_PLUGIN_DATA}; can't depend on plugin-state (require cycle)",
  "gutt-core/hooks/lib/migrations.cjs":
    "one-shot 2.x cleanup: deletes only provably-dead paths a past version wrote (GP-895)",
  "gutt-core/hooks/lib/builtin-memory-store.cjs":
    "migrates Claude Code's own memory store: removes only facts verified present in the graph, after backing the store up under ${CLAUDE_PLUGIN_DATA} (GP-922)",
  "gutt-core/hooks/lib/statusline-install.cjs":
    "writes only the `statusLine` key, only on explicit user command or to restore prior consent the platform dropped, after backing settings.json up under ${CLAUDE_PLUGIN_DATA} (GP-867)",
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
    // Same carve-out as .lessons-prompted below: naming a retired path in order to
    // delete it is the opposite of reintroducing it. Nothing else may mention it.
    allow: ["gutt-core/hooks/lib/migrations.cjs"],
  },
  {
    pattern: ".lessons-prompted",
    reason: "retired marker file — the record is a field in sessions/<id>.json (GP-863)",
    // The one legitimate mention: sweeping leftovers off disk after an upgrade.
    // Moved with the sweep itself out of session-start.cjs in GP-895.
    allow: ["gutt-core/hooks/lib/session-sweep.cjs"],
  },
];

// Matches fs.<write> and fs.promises.<write>, sync and async forms. Bare
// destructured calls (no fs. prefix) aren't matched — the suite's convention is
// fs.*, and matching bare verb names would false-positive on local functions.
const WRITE_RE =
  /\bfs\.(promises\.)?(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|cp|cpSync|copyFile|copyFileSync|truncate|truncateSync|createWriteStream|write|writeSync|writev|writevSync)\b/;

const errors = [];
let scanned = 0;

function scanFile(absFile) {
  scanned++;
  // Normalised to forward slashes: ALLOW and the per-path exemptions are keyed
  // that way, and path.relative yields backslashes on Windows — where this
  // otherwise fails deterministically on the one file the allowlist exists to
  // permit. CI is Linux-only, so it would only ever bite a contributor.
  const rel = path.relative(ROOT, absFile).split(path.sep).join("/");
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
          `${rel}:${i + 1} direct ${m[0]} — route runtime-state writes through hooks/lib/plugin-state.cjs (R37)`
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

// A missing scan dir used to be skipped quietly, which was survivable while the list
// had three entries and two were optional. With one entry it means the guard walks
// nothing and still prints OK — so a rename of the plugin directory would retire R37
// enforcement without failing anything. Same reasoning for the file floor below.
for (const d of SCAN_DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) {
    console.error(
      `State-location check FAILED: scan dir "${d}" does not exist, so the guard ` +
        "inspected nothing. Update SCAN_DIRS to match the tree."
    );
    process.exit(1);
  }
  walk(abs);
}

if (!scanned) {
  console.error(
    `State-location check FAILED: no .cjs files found under ${SCAN_DIRS.join(", ")}. ` +
      "Finding nothing to check is not the same as finding nothing wrong."
  );
  process.exit(1);
}

if (errors.length) {
  console.error(
    "State-location check FAILED (R37 — runtime state must stay under ${CLAUDE_PLUGIN_DATA}):\n  " +
      errors.join("\n  ")
  );
  process.exit(1);
}
console.log(
  `State-location check OK: ${scanned} files scanned, runtime-state writes route through ` +
    `hooks/lib/plugin-state.cjs (${Object.keys(ALLOW).length} sanctioned direct writers, ` +
    `${BANNED.length} retired paths banned).`
);
