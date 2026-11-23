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
 *
 * It is also the READMEs' drift check. Docs drift in both directions — a component
 * ships that no README mentions, or a README goes on listing one that was removed —
 * and the install commands a reader copies drift from the onboarding guide that is
 * kept working. So, besides the slash references:
 *
 *  - every marketplace plugin has a row in the main README's plugin table, linked to
 *    its own `README.md`, with its install command, and every linked row names a
 *    plugin the marketplace lists;
 *  - every skill, command and agent a plugin ships is listed in its README's Skills,
 *    Commands or Agents table, and every name those tables list is shipped;
 *  - every `claude plugin …` command in a README is written exactly as
 *    `docs/team-onboarding.md` writes it.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// The config verbs answer to their bare form on purpose — `config-command.cjs`
// accepts them unprefixed and the README documents both spellings. They are the
// one measured exception, listed rather than pattern-matched so that adding to
// this set is a deliberate act.
const BARE_BY_DESIGN = new Set(["on", "off", "disable", "mode"]);

// Claude Code's own commands that share a stem with one of ours. A bare `/config` in
// prose means the host's (it wins the bare form), so it is not a dropped plugin name.
const HOST_OWNED = new Set(["config"]);

const ONBOARDING = path.join("docs", "team-onboarding.md");

// The READMEs and the docs moved out of them. Each is read only if it exists; the
// per-plugin READMEs are required separately, so a missing one is reported by name.
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "docs/hooks.md", "docs/statusline.md"];

// The plugin-README sections whose tables list shipped components, keyed by heading.
const SECTION_KIND = {
  Skills: "skills",
  Skill: "skills",
  Agents: "agents",
  Agent: "agents",
  Commands: "commands",
  Command: "commands",
};

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

function readMarketplace() {
  return readJson(path.join(ROOT, ".claude-plugin", "marketplace.json"));
}

function pluginDirs(marketplace = readMarketplace()) {
  return marketplace.plugins.map((p) => {
    const dir = path.join(ROOT, p.source);
    return { name: readJson(path.join(dir, ".claude-plugin", "plugin.json")).name, dir };
  });
}

/** What one plugin ships, by kind: skill directories, command files, agent files. */
function componentsOf(dir) {
  const list = (sub, keep) => {
    const base = path.join(dir, sub);
    if (!fs.existsSync(base)) {
      return [];
    }
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => keep(base, e))
      .map((e) => e.name.replace(/\.md$/, ""))
      .sort();
  };
  const mdFile = (_base, e) => e.isFile() && e.name.endsWith(".md");
  return {
    skills: list(
      "skills",
      (base, e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, "SKILL.md"))
    ),
    commands: list("commands", mdFile),
    agents: list("agents", mdFile),
  };
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
  files.push(path.join(ROOT, ONBOARDING));
  for (const { dir } of plugins) {
    files.push(path.join(dir, "README.md"));
  }
  for (const doc of ROOT_DOCS) {
    files.push(path.join(ROOT, doc));
  }
  return files.filter((f) => fs.existsSync(f));
}

/**
 * The names a README table lists, per section. Only the first cell of a row counts, and
 * only its first backticked token, reduced to the bare name: `/gutt-pro:mode auto|hitl`
 * lists `mode`. Lines inside a fenced code block are neither headings nor rows.
 */
function tableListings(text) {
  const listed = { skills: [], commands: [], agents: [] };
  let kind = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      kind = SECTION_KIND[heading[1]] || null;
      continue;
    }
    if (!kind || !line.startsWith("|")) {
      continue;
    }
    const firstCell = line.split(/(?<!\\)\|/)[1] || "";
    const token = firstCell.match(/`([^`]+)`/);
    if (token) {
      const word = token[1].trim().split(/\s+/)[0];
      listed[kind].push(word.replace(/^\//, "").split(":").pop());
    }
  }
  return listed;
}

function checkPluginReadmes(plugins) {
  const problems = [];
  for (const { name, dir } of plugins) {
    const readme = path.join(dir, "README.md");
    const rel = path.relative(ROOT, readme);
    if (!fs.existsSync(readme)) {
      problems.push(`${rel}: missing — every marketplace plugin has its own README`);
      continue;
    }
    const shipped = componentsOf(dir);
    const listed = tableListings(fs.readFileSync(readme, "utf8"));
    for (const kind of ["skills", "commands", "agents"]) {
      for (const component of shipped[kind]) {
        if (!listed[kind].includes(component)) {
          problems.push(
            `${rel}: ${name} ships ${kind.slice(0, -1)} \`${component}\`, but its ${kind} table does not list it`
          );
        }
      }
      for (const component of listed[kind]) {
        if (!shipped[kind].includes(component)) {
          problems.push(
            `${rel}: lists ${kind.slice(0, -1)} \`${component}\`, which ${name} does not ship`
          );
        }
      }
    }
  }
  return problems;
}

/**
 * `claude plugin …` commands as a reader would copy them: up to a backtick, a comment or
 * the line end. Any subcommand counts, so a made-up one (`claude plugin add`) is caught
 * as readily as a misspelt argument.
 */
function pluginCommandsIn(text) {
  const found = new Set();
  const re = /claude plugin [a-z][^`\n#]*/g;
  for (const m of text.matchAll(re)) {
    found.add(m[0].trim().replace(/\s+/g, " "));
  }
  return found;
}

function checkRootReadme(marketplace, plugins) {
  const problems = [];
  const readme = path.join(ROOT, "README.md");
  if (!fs.existsSync(readme)) {
    return ["README.md: missing"];
  }
  const text = fs.readFileSync(readme, "utf8");
  const rows = text.split(/\r?\n/).filter((l) => l.startsWith("|"));
  const commands = pluginCommandsIn(text);
  const linkedDirs = new Set();

  for (const row of rows) {
    for (const m of row.matchAll(/\]\(([^)\s]+)\/README\.md\)/g)) {
      linkedDirs.add(path.normalize(m[1]));
    }
  }

  for (const { name, dir } of plugins) {
    const relDir = path.relative(ROOT, dir);
    const link = `[${name}](${relDir.split(path.sep).join("/")}/README.md)`;
    if (!rows.some((r) => r.includes(link))) {
      problems.push(`README.md: the plugin table has no row linking ${link}`);
    }
    const install = `claude plugin install ${name}@${marketplace.name}`;
    if (!commands.has(install)) {
      problems.push(`README.md: does not give the install command \`${install}\``);
    }
  }

  const shippedDirs = new Set(plugins.map(({ dir }) => path.relative(ROOT, dir)));
  for (const linked of linkedDirs) {
    if (!shippedDirs.has(linked)) {
      problems.push(
        `README.md: the plugin table links ${linked}/README.md, which the marketplace does not list`
      );
    }
  }
  return problems;
}

function checkInstallCommands(plugins) {
  const onboardingPath = path.join(ROOT, ONBOARDING);
  if (!fs.existsSync(onboardingPath)) {
    return [`${ONBOARDING}: missing — install commands are checked against it`];
  }
  const known = pluginCommandsIn(fs.readFileSync(onboardingPath, "utf8"));
  const readmes = [path.join(ROOT, "README.md"), path.join(ROOT, "CONTRIBUTING.md")];
  for (const { dir } of plugins) {
    readmes.push(path.join(dir, "README.md"));
  }
  const problems = [];
  for (const file of readmes.filter((f) => fs.existsSync(f))) {
    for (const command of pluginCommandsIn(fs.readFileSync(file, "utf8"))) {
      if (!known.has(command)) {
        problems.push(
          `${path.relative(ROOT, file)}: \`${command}\` is not written this way in ${ONBOARDING}`
        );
      }
    }
  }
  return problems;
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
  const marketplace = readMarketplace();
  const plugins = pluginDirs(marketplace);
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
        if (BARE_BY_DESIGN.has(stem) || HOST_OWNED.has(stem)) {
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

  // Both halves run before either reports, so one failing run lists everything to fix
  // rather than revealing the drift only after the slash references are clean.
  const drift = [
    ...checkRootReadme(marketplace, plugins),
    ...checkPluginReadmes(plugins),
    ...checkInstallCommands(plugins),
  ];

  if (problems.length) {
    console.error(
      "Doc-pointer check FAILED — prose tells the reader to type these, and they do nothing:\n"
    );
    for (const p of problems) {
      console.error(`  ${p}`);
    }
    console.error(`\n${problems.length} unreachable reference(s) across ${files.length} file(s).`);
  }
  if (drift.length) {
    console.error(
      `${problems.length ? "\n" : ""}Doc-pointer check FAILED — the READMEs have drifted from what ships:\n`
    );
    for (const p of drift) {
      console.error(`  ${p}`);
    }
    console.error(`\n${drift.length} drift problem(s). Update the README in the same change.`);
  }
  if (problems.length || drift.length) {
    process.exit(1);
  }

  console.log(
    `Doc-pointer check OK: ${files.length} file(s) scanned, every slash reference resolves ` +
      `(${invocable.size} invocable across ${plugins.length} plugin(s)); ` +
      `READMEs match what ships and the onboarding guide's install commands.`
  );
}

main();
