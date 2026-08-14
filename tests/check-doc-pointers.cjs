#!/usr/bin/env node
/**
 * Every slash reference written in instructional prose must resolve to something
 * the reader has installed.
 *
 * `hook-architecture.test.cjs` already holds this rule — "names only skills that
 * exist" — but it reads hooks and never opens a SKILL.md, so the identical defect
 * one directory over passes CI. This widens the scan set to the prose a user is
 * actually told to follow: every plugin's skills and agents, plus the docs that
 * walk somebody through installing.
 *
 * The failure is silent by construction. A bare `/memory-search` resolves to
 * nothing, Claude Code reports no error, and the reader cannot tell a wrong
 * instruction from a broken install.
 *
 * Skills are reachable as `/<plugin>:<skill>`, so a skill directory satisfies a
 * reference the same way a command file does.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// The config verbs answer to their bare form on purpose — `config-command.cjs`
// accepts them unprefixed and the README documents both spellings. They are the
// one measured exception, listed rather than pattern-matched so that adding to
// this set is a deliberate act.
const BARE_BY_DESIGN = new Set(["on", "off", "disable", "mode"]);

// What this deliberately does not catch, so the limit is visible rather than
// mistaken for coverage: a bare reference whose stem nothing ships. In backticked
// prose that shape is far more often a filesystem path (`/tmp`, `/var`), a host
// command (`/mcp`), or another tool's (`/add-plugin`, which is Cursor's) than a
// dead pointer of ours — and nothing in the text distinguishes them. Flagging it
// produced four false positives and zero real findings.
//
// The defect this exists for always leaves a stem that IS shipped: a rename drops
// the plugin name and the bare remainder still names a real skill. That case is
// unambiguous, so it is the one enforced.

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function pluginDirs() {
  const marketplace = readJson(path.join(ROOT, ".claude-plugin", "marketplace.json"));
  return marketplace.plugins.map((p) => {
    const dir = path.join(ROOT, p.source);
    return { name: readJson(path.join(dir, ".claude-plugin", "plugin.json")).name, dir };
  });
}

/** What a reader can actually invoke: `<plugin>:<stem>` for every command and skill. */
function buildInventory(plugins) {
  const invocable = new Set();
  for (const { name, dir } of plugins) {
    for (const sub of ["commands", "skills"]) {
      const base = path.join(dir, sub);
      if (!fs.existsSync(base)) {
        continue;
      }
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (sub === "commands" && entry.isFile() && entry.name.endsWith(".md")) {
          invocable.add(`${name}:${entry.name.slice(0, -3)}`);
        }
        if (sub === "skills" && entry.isDirectory()) {
          if (fs.existsSync(path.join(base, entry.name, "SKILL.md"))) {
            invocable.add(`${name}:${entry.name}`);
          }
        }
      }
    }
  }
  return invocable;
}

function markdownUnder(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      markdownUnder(full, out);
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function filesToScan(plugins) {
  const files = [];
  for (const { dir } of plugins) {
    files.push(...markdownUnder(path.join(dir, "skills")));
    files.push(...markdownUnder(path.join(dir, "agents")));
  }
  files.push(path.join(ROOT, "docs", "team-onboarding.md"));
  return files.filter((f) => fs.existsSync(f));
}

/**
 * Only backticked references count. Prose naming a command without marking it as
 * code is describing it, not telling the reader to type it — and scanning
 * unmarked prose flags every sentence containing a slash.
 */
function referencesIn(text) {
  const found = [];
  for (const m of text.matchAll(/`\/([a-z][a-z0-9-]*)(?::([a-z][a-z0-9-]*))?`/g)) {
    found.push(m[2] ? { prefix: m[1], stem: m[2] } : { prefix: null, stem: m[1] });
  }
  return found;
}

function main() {
  const plugins = pluginDirs();
  const invocable = buildInventory(plugins);
  const files = filesToScan(plugins);

  if (invocable.size === 0 || files.length === 0) {
    console.error(
      `Doc-pointer check FAILED: scanned nothing (${invocable.size} invocable, ${files.length} files). ` +
        `A check that inspected nothing must not report success.`
    );
    process.exit(1);
  }

  const problems = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    for (const { prefix, stem } of referencesIn(text)) {
      if (prefix === null) {
        if (BARE_BY_DESIGN.has(stem)) {
          continue;
        }
        const owners = [...invocable].filter((i) => i.endsWith(`:${stem}`));
        if (owners.length) {
          problems.push(
            `${rel}: \`/${stem}\` is missing its plugin name — write \`/${owners[0]}\``
          );
        }
        continue;
      }
      if (!invocable.has(`${prefix}:${stem}`)) {
        problems.push(`${rel}: \`/${prefix}:${stem}\` resolves to nothing shipped`);
      }
    }
  }

  if (problems.length) {
    console.error(
      "Doc-pointer check FAILED — prose tells the reader to type these, and they do nothing:\n"
    );
    for (const p of problems) {
      console.error(`  ${p}`);
    }
    console.error(`\n${problems.length} unreachable reference(s) across ${files.length} file(s).`);
    process.exit(1);
  }

  console.log(
    `Doc-pointer check OK: ${files.length} file(s) scanned, every slash reference resolves ` +
      `(${invocable.size} invocable across ${plugins.length} plugin(s)).`
  );
}

main();
