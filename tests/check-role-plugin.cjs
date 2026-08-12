#!/usr/bin/env node
/**
 * The role-plugin review step: the mechanically checkable half of the two gates in
 * `templates/role-plugin.md`, plus the structural rules a role plugin loads
 * correctly under.
 *
 * Scope. By default every plugin the marketplace lists is a role plugin except the
 * core one, identified by name — so registering a new role plugin in marketplace.json
 * is the only place it has to be named. Classifying by exclusion rather than by the
 * declared dependency is deliberate: selecting on the dependency meant that dropping
 * it removed a plugin from every gate here instead of failing the rule that requires
 * it, so the one manifest edit that most needs catching bought silence. Pass a
 * directory to check one plugin instead, which is how a freshly scaffolded copy gets
 * validated before it is registered anywhere:
 *
 *   node tests/check-role-plugin.cjs                 # every registered role plugin
 *   node tests/check-role-plugin.cjs ./gutt-newrole  # one directory
 *
 * Structural and zero-dep, like check-no-symlinks / check-state-location /
 * check-version-sync. It fails rather than passes when it finds nothing to inspect:
 * a guard that examined no files must not report success.
 *
 * What it deliberately does not check: whether a borrowing was adapted enough to be
 * an adaptation, and whether a governance step was really preserved. Those are the
 * judgement calls the human checklists keep.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MODELS = new Set(["haiku", "sonnet", "opus"]);
const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

const readJson = (abs) => JSON.parse(fs.readFileSync(abs, "utf8"));
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

/**
 * The core plugin's name. package.json is not the source of truth for it — plugin.json
 * is — but check-version-sync.cjs enforces that exactly one plugin manifest carries
 * package.json's name, which makes reading it here safe as long as that anchor holds.
 * It is load-bearing: every other plugin is classified as a role plugin by not matching
 * it, so a stale value here would silently reclassify the whole marketplace. The run
 * below re-checks the anchor rather than trusting it.
 */
const CORE_NAME = readJson(path.join(ROOT, "package.json")).name;

/**
 * Raw graph tool names, each with the core skill(s) that own its guidance. A skill naming
 * one of these owes the reader that owner specifically — a mention of any core skill used
 * to satisfy the rule, so a skill could restate register_agent guidance while pointing only
 * at output-style.
 */
const RAW_TOOL_OWNERS = new Map([
  ["search_memory_nodes", ["memory-search"]],
  ["search_memory_facts", ["memory-search", "graph-traversal"]],
  ["add_memory", ["memory-capture"]],
  ["fetch_lessons_learned", ["memory-search"]],
  ["register_agent", ["agent-memory-protocol"]],
]);

// ── frontmatter ────────────────────────────────────────────────────────────────

/**
 * Split leading YAML frontmatter off a markdown file.
 * @param {string} text
 * @returns {{body: string, lines: string[]} | null}
 */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? { body: m[1], lines: m[1].split(/\r?\n/) } : null;
}

/** Top-level `key: value` pairs, values as written (quotes intact). */
function fmPairs(lines) {
  const out = new Map();
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (m) {
      out.set(m[1], m[2].trim());
    }
  }
  return out;
}

const unquote = (v) => v.replace(/^["'](.*)["']$/s, "$1");

/**
 * The parse hazard that costs a whole frontmatter block: YAML rejects the document and the
 * component loads with every field silently dropped, with nothing at runtime reporting it.
 *
 * Three shapes reach that outcome, and opening a quote is not an escape from any of them —
 * a quote only helps when it actually terminates the value:
 *
 *   description: "phrases like "this one" here"    # inner quotes end the scalar early
 *   description: "the label": value               # quoted key, then a mapping
 *   description: ends with a colon:               # trailing colon, no following space
 *
 * So a value opening a quote must be a complete single-line quoted scalar and nothing
 * else, and the colon test accepts end-of-line as well as a following space. Block scalars
 * (`|`, `>`) carry their content past this line and are left alone; a flow collection has
 * to close on its opening line. Multi-line flow collections are legal YAML, but no
 * frontmatter here uses one, and flagging that rarity loudly beats waving through
 * `description: [unterminated`, which drops the block like the other three shapes.
 * @param {string[]} lines
 * @returns {string[]} offending keys, each with what is wrong
 */
function unquotedColonScalars(lines) {
  const bad = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w-]*):[ \t]+(.+)$/);
    if (!m) {
      continue;
    }
    const value = m[2].trim();
    if (!value || /^[>|]/.test(value)) {
      continue;
    }
    if (value.startsWith("[") || value.startsWith("{")) {
      if (!value.endsWith(value.startsWith("[") ? "]" : "}")) {
        bad.push(`${m[1]} (a flow collection that does not close on its line)`);
      }
      continue;
    }
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) {
        bad.push(`${m[1]} (a double-quoted value that does not close cleanly)`);
      }
      continue;
    }
    if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) {
        bad.push(`${m[1]} (a single-quoted value that does not close cleanly)`);
      }
      continue;
    }
    if (/:([ \t]|$)/.test(value)) {
      bad.push(`${m[1]} (an unquoted value holding a colon)`);
    }
  }
  return bad;
}

// ── discovery ──────────────────────────────────────────────────────────────────

/**
 * Every plugin the marketplace lists, as `{name, dir}`. A `source` that does not resolve
 * is an error rather than a quiet omission — dropping it would take the plugin out of
 * every gate below, which is the same silent-coverage-loss this file exists to avoid.
 */
function marketplacePlugins() {
  const file = path.join(ROOT, ".claude-plugin", "marketplace.json");
  const { plugins = [] } = readJson(file);
  const out = [];
  for (const p of plugins) {
    const source = String(p.source || "");
    if (!source || path.isAbsolute(source) || source.split(/[\\/]/).includes("..")) {
      err(".claude-plugin/marketplace.json", `entry "${p.name || "?"}" has an invalid "source"`);
      continue;
    }
    const dir = path.join(ROOT, source.replace(/^\.\//, ""));
    if (!fs.existsSync(dir)) {
      err(
        ".claude-plugin/marketplace.json",
        `entry "${p.name || "?"}" points at a missing directory (${source})`
      );
      continue;
    }
    out.push({ name: p.name, dir });
  }
  return out;
}

/** A plugin's manifest, or null if unreadable. */
function manifestOf(dir) {
  try {
    return readJson(path.join(dir, ".claude-plugin", "plugin.json"));
  } catch {
    return null;
  }
}

const agentFiles = (dir) => {
  const d = path.join(dir, "agents");
  return fs.existsSync(d)
    ? fs
        .readdirSync(d)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join(d, f))
    : [];
};

const skillDirs = (dir) => {
  const d = path.join(dir, "skills");
  return fs.existsSync(d)
    ? fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(d, e.name))
    : [];
};

// ── the checks ─────────────────────────────────────────────────────────────────

function checkManifest(dir, manifest) {
  const file = rel(path.join(dir, ".claude-plugin", "plugin.json"));
  if (!manifest) {
    err(file, "missing or unparseable plugin manifest");
    return;
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(manifest.name || ""))) {
    err(file, `"name" must be kebab-case (got ${JSON.stringify(manifest.name)})`);
  }
  // Omit the version and the git SHA becomes it, so every commit reads as an update.
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ""))) {
    err(file, `"version" must be semver (got ${JSON.stringify(manifest.version)})`);
  }
  const deps = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  if (!deps.some((d) => String(d).split(/[@\s]/)[0] === CORE_NAME)) {
    err(file, `"dependencies" must name "${CORE_NAME}" — the skills degrade without it`);
  }
  if (!manifest.license) {
    err(file, '"license" must be stated per plugin, not inherited by assumption');
  }
  // `true` is also the platform default, so this is about uniformity rather than behaviour:
  // the suite is on as soon as it is installed, and one plugin shipping `false` would make
  // half of it opt-in without anyone deciding that.
  if (manifest.defaultEnabled !== true) {
    err(
      file,
      `"defaultEnabled" must be true (got ${JSON.stringify(manifest.defaultEnabled)}) — ` +
        "every plugin in this suite is on as soon as it is installed"
    );
  }
  // The core plugin owns the hook surface; a second plugin writing hook state is how
  // sessions break.
  if (fs.existsSync(path.join(dir, "hooks"))) {
    err(
      rel(path.join(dir, "hooks")),
      "a role plugin ships no hooks — the core plugin owns that surface"
    );
  }
  for (const comp of ["agents", "skills", "commands"]) {
    if (fs.existsSync(path.join(dir, ".claude-plugin", comp))) {
      err(
        rel(path.join(dir, ".claude-plugin", comp)),
        `"${comp}/" belongs at the plugin root, not inside .claude-plugin/`
      );
    }
  }
}

/**
 * The names the template ships its component file and directory under. Left in place they
 * pass the name-matches-filename rules tautologically, because both halves are still the
 * placeholder — the one case where those rules agree and are both wrong.
 */
const SENTINEL_NAMES = new Set(["AGENT_NAME", "SKILL_NAME"]);

function checkAgent(file, requireShape = true) {
  const name = path.basename(file, ".md");
  const text = fs.readFileSync(file, "utf8");
  const f = rel(file);
  const fm = frontmatter(text);
  if (!fm) {
    err(f, "no YAML frontmatter block");
    return;
  }
  for (const key of unquotedColonScalars(fm.lines)) {
    err(
      f,
      `frontmatter ${key} — YAML rejects the document, and the agent then loads with every ` +
        "field dropped and nothing reporting it. Quote the value, and close the quotes."
    );
  }
  const pairs = fmPairs(fm.lines);
  if (SENTINEL_NAMES.has(name)) {
    err(
      f,
      `still carries the template's placeholder filename (${name}.md) — rename the file and its \`name:\` together`
    );
  } else if (unquote(pairs.get("name") || "") !== name) {
    err(f, `frontmatter "name" (${pairs.get("name")}) must equal the filename (${name})`);
  }
  if (!pairs.get("description")) {
    err(f, 'frontmatter "description" is required');
  }
  const model = unquote(pairs.get("model") || "");
  if (model && !MODELS.has(model)) {
    err(f, `frontmatter "model" must be one of ${[...MODELS].join(", ")} (got ${model})`);
  }

  if (!/^## Agent identity$/m.test(text)) {
    err(
      f,
      "missing a `## Agent identity` section — every agent states its identity or its lack of one"
    );
  }
  // Template shape, so it binds the agents this scaffold produces. The core plugin's own
  // agents predate it and are allowed a specialist section that does the job more
  // specifically — `agent-creator` blesses that substitution by name. The identity rules
  // below are not shape, and bind everywhere.
  if (requireShape && !/^## Grounding Protocol$/m.test(text)) {
    err(f, "missing a `## Grounding Protocol` section (heading text is exact)");
  }

  const writes = /register_agent\s*\(/.test(text);
  if (writes) {
    // Identity merges on name + group, so a bare name pools with whatever else ever
    // registered under it and org writes cannot be reassigned afterwards. Every call is
    // checked, not just the first: a file can carry more than one — an agent that
    // documents the call it emits as well as the one it makes — and the second is exactly
    // where an un-suffixed example survives review.
    const calls = [...text.matchAll(/register_agent\s*\([\s\S]*?\)/g)].map((m) => m[0]);
    for (const call of calls) {
      const named = call.match(/name\s*=\s*["']([^"']+)["']/);
      if (!named) {
        err(f, "a register_agent(...) call has no literal name= argument to check");
      } else if (!named[1].includes("--")) {
        err(
          f,
          `registers as the bare name "${named[1]}" — the registered name must carry a ` +
            "`--<scope>` suffix, or it merges with every other instance in the group"
        );
      } else if (!named[1].includes("<scope>")) {
        err(
          f,
          `register_agent name "${named[1]}" bakes in a resolved scope — leave "<scope>" for ` +
            "the agent to resolve where it runs"
        );
      } else if (!/--<scope>$/.test(named[1])) {
        // Containing both tokens is not the convention; ending with them is. A reversed or
        // extended form still gets a unique merge key, so what this stops is shape drift,
        // not pooling — but one drifted name becomes the example the next agent copies.
        err(
          f,
          `register_agent name "${named[1]}" does not end with \`--<scope>\` — the scope ` +
            "suffix is terminal, nothing follows it"
        );
      }
    }
    if (!/^## Learning Protocol$/m.test(text)) {
      err(f, "registers an identity but has no `## Learning Protocol` section");
    }
    // Scoped calls carry the identity in one of two forms that both survive being
    // scaffolded elsewhere: this agent's own suffixed name, or an indirection back to the
    // registered one (a value opening `<`). A bare resolved literal pools this agent's
    // writes with every other instance in the group; a suffixed literal that names some
    // OTHER agent silently reads and writes the wrong scope, which containment alone
    // waved through.
    const ids = [...text.matchAll(/agent_id\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]);
    if (!ids.length) {
      err(
        f,
        "registers an identity but no call passes agent_id — the scoped recall pass is missing"
      );
    }
    for (const id of new Set(ids)) {
      if (id.startsWith("<")) {
        continue;
      }
      if (!id.includes("--")) {
        err(
          f,
          `agent_id="${id}" is a bare resolved name — pass the \`--<scope>\`-suffixed name, or ` +
            "refer to the registered name so there is one source of truth for it"
        );
      } else if (!id.startsWith(`${name}--`)) {
        err(
          f,
          `agent_id="${id}" names a different identity than this agent registers ` +
            `("${name}--<scope>") — scoped calls carry the agent's own registered name`
        );
      }
    }
    if (!/without\s+`?agent_id`?|[Gg]roup-wide/.test(text)) {
      err(f, "identity block never states the group-wide recall pass, which is never skipped");
    }
  } else if (/^## Learning Protocol$/m.test(text)) {
    err(
      f,
      "has a `## Learning Protocol` but registers no identity — a reader writes nothing org-side"
    );
  }

  // The server key varies per install, so a prefixed tool name is wrong everywhere but one.
  const prefixed = text.match(/mcp__[a-zA-Z0-9_-]+__/);
  if (prefixed) {
    err(f, `hardcodes the MCP server prefix "${prefixed[0]}" — the server key varies per install`);
  }
}

function checkSkill(dir) {
  const file = path.join(dir, "SKILL.md");
  const f = rel(file);
  if (!fs.existsSync(file)) {
    err(rel(dir), "skill directory has no SKILL.md");
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  const fm = frontmatter(text);
  if (!fm) {
    err(f, "no YAML frontmatter block");
    return;
  }
  for (const key of unquotedColonScalars(fm.lines)) {
    err(
      f,
      `frontmatter ${key} — YAML rejects the document, and the skill then loads with every ` +
        "field dropped and nothing reporting it. Quote the value, and close the quotes."
    );
  }
  const pairs = fmPairs(fm.lines);
  if (SENTINEL_NAMES.has(path.basename(dir))) {
    err(
      f,
      `still carries the template's placeholder directory name (${path.basename(dir)}/) — rename it and its \`name:\` together`
    );
  } else if (unquote(pairs.get("name") || "") !== path.basename(dir)) {
    err(
      f,
      `frontmatter "name" (${pairs.get("name")}) must equal the directory name (${path.basename(dir)})`
    );
  }
  if (!pairs.get("description")) {
    err(f, 'frontmatter "description" is required — it decides whether the skill loads at all');
  }

  // One owner per skill: each raw tool named owes the reader its own owner, not just any
  // core skill — an unrelated mention used to satisfy this.
  for (const [tool, owners] of RAW_TOOL_OWNERS) {
    if (text.includes(tool) && !owners.some((s) => text.includes(s))) {
      err(
        f,
        `names ${tool} without referencing the core skill that owns it (${owners.join(" or ")}) — ` +
          "reference it instead of restating tool guidance"
      );
    }
  }
  const prefixed = text.match(/mcp__[a-zA-Z0-9_-]+__/);
  if (prefixed) {
    err(f, `hardcodes the MCP server prefix "${prefixed[0]}" — the server key varies per install`);
  }
}

// Gate 1 — baseline-fork licensing.
const FORBIDDEN_SOURCE = [
  [
    /anthropics\/claude-code(?![a-z-])/,
    "Anthropic content must come from the official plugins repository, not the product repository",
  ],
  [/CC[ -]BY[ -]NC/i, "a non-commercial Creative Commons licence is not usable here"],
  [/BY[ -]NC[ -]ND|NoDerivatives/i, "a no-derivatives licence is not usable here"],
  [
    /\b(?:A?GPL|LGPL|SSPL|BUSL)\b|\bBusiness Source\b/i,
    "a copyleft or source-available upstream licence is not usable here — permissive only",
  ],
];

/**
 * Trademark renaming is about the name the plugin ships under, not about whether the
 * borrowing may be described. Applying it to ATTRIBUTION.md would make an honest
 * attribution impossible whenever the upstream repository's own name carries the mark,
 * while gate 1 simultaneously requires that repository to be named — so the two rules
 * would contradict each other and the recorded provenance would be the thing that gave
 * way. Everything in FORBIDDEN_SOURCE still applies there: those are about *where* a
 * baseline may come from, which is exactly what an attribution file should be checked on.
 */
const FORBIDDEN_SHIPPED_NAME = [
  [/\bBMAD\b/i, "content derived from a trademarked baseline must ship under a renamed identity"],
];

// Gate 2 — delivery context. The tracker and its wiki are the system of record, and a
// code-host issue tracker is the thing a forked baseline most reliably drags in with it.
//
// These match the phrase, not its sentiment, so a skill that mentions one only to rule it
// out trips the gate too. That is the intended trade: the patterns are narrow enough that
// the rewording costs a sentence, and a sentiment-aware version would be guesswork.
const FORBIDDEN_CONTEXT = [
  [
    /\bGitHub [Ii]ssues?\b/,
    "a code-host issue tracker is not the system of record — the ticket tracker and its wiki are",
  ],
  [/\bgh issue\b/, "a code-host issue tracker is not the system of record"],
];

/**
 * Every markdown file a plugin ships, including nested ones. `references/` and
 * `commands/` were previously outside the scans while the gates claimed to cover the
 * plugin — a forked baseline drags its habits into reference material as readily as into
 * a skill body, and reference material is the half nobody re-reads.
 */
function markdownFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) {
      return;
    }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(path.join(dir, "agents"));
  walk(path.join(dir, "skills"));
  walk(path.join(dir, "commands"));
  for (const root of ["ATTRIBUTION.md", "README.md"]) {
    const p = path.join(dir, root);
    if (fs.existsSync(p)) {
      out.push(p);
    }
  }
  return out;
}

function checkContent(dir) {
  const attribution = path.join(dir, "ATTRIBUTION.md");
  let borrows = false;

  for (const file of markdownFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    const f = rel(file);
    const patterns =
      file === attribution
        ? [...FORBIDDEN_SOURCE, ...FORBIDDEN_CONTEXT]
        : [...FORBIDDEN_SOURCE, ...FORBIDDEN_SHIPPED_NAME, ...FORBIDDEN_CONTEXT];
    for (const [re, why] of patterns) {
      const hit = text.match(re);
      if (hit) {
        err(f, `"${hit[0].trim()}" — ${why}`);
      }
    }
    checkPlaceholders(f, text);
    checkScaffoldNotes(f, text);
    if (/\b[Aa]dapted from\b|\b[Ff]orked from\b|\b[Bb]aselined? on\b/.test(text)) {
      borrows = true;
    }
  }

  // The manifest carries the description and keywords the marketplace shows a user, so a
  // placeholder surviving here is the most visible way an unfinished scaffold ships.
  const manifestPath = path.join(dir, ".claude-plugin", "plugin.json");
  if (fs.existsSync(manifestPath)) {
    checkPlaceholders(rel(manifestPath), fs.readFileSync(manifestPath, "utf8"));
  }

  const hasAttribution = fs.existsSync(attribution);
  if (borrows && !hasAttribution) {
    err(
      rel(dir),
      "text claims a borrowing but the plugin has no ATTRIBUTION.md naming the source and pinning its SHA"
    );
  }
  if (hasAttribution) {
    const text = fs.readFileSync(attribution, "utf8");
    const f = rel(attribution);

    // Per borrowing, not per file. The file's own shape is one `##` section per baseline, so
    // a whole-file scan lets any one section satisfy a rule on every other section's behalf:
    // one permissive licence anywhere covered a copyleft upstream added later, and one SHA
    // anywhere covered a borrowing that pinned nothing. The section is the unit because the
    // licence and the SHA sit in different paragraphs of it.
    const sections = text.split(/^## /m).filter((s) => /\bAdapted from\b/.test(s));
    if (!sections.length) {
      err(
        f,
        "describes no borrowing — an attribution file that names no source reads as a completed " +
          "check where none happened; delete it, or say what was borrowed"
      );
    }
    for (const section of sections) {
      const where = section.split("\n", 1)[0].trim() || "an unnamed section";
      // The licence is checked on the paragraph that names the upstream, narrower than the
      // section: a permissive token anywhere else in the same section — including prose about
      // this repository's own licence — would otherwise stand in for the upstream's.
      const paragraph = section.match(/[^\n]*\bAdapted from\b[\s\S]*?(?=\n[ \t]*\n|$)/);
      if (!paragraph || !/Apache[ -]?(License )?2\.0|\bMIT\b/.test(paragraph[0])) {
        err(
          f,
          `"${where}" does not name a permissive upstream licence (Apache-2.0 or MIT) where it ` +
            "names the upstream — state the upstream's own licence there, not this repository's"
        );
      }
      // The hex must sit in the pin statement itself. Anywhere-in-section let an unrelated
      // checksum satisfy the rule on behalf of a borrowing that tracks a branch.
      if (!/\bPinned at commit\b[^\n]*\b[0-9a-f]{40}\b/i.test(section)) {
        err(
          f,
          `"${where}" pins no 40-character commit SHA in a "Pinned at commit" statement — a ` +
            "named repository without one records that something was borrowed but not what"
        );
      }
      if (!/github\.com\//.test(section)) {
        err(f, `"${where}" names no upstream repository`);
      }
    }
  }
}

/**
 * Loud by design, so an unfinished scaffold cannot merge quietly. The template uses
 * `{{...}}` rather than the `__..__` form on purpose: double underscores are markdown
 * bold, and prettier rewrites them in prose — silently turning a placeholder that the
 * scan would have caught into ordinary emphasised text that it never will.
 */
function checkPlaceholders(f, text) {
  const ph = text.match(/\{\{[A-Z][A-Z0-9_]*\}\}/);
  if (ph) {
    err(f, `unreplaced template placeholder ${ph[0]}`);
  }
}

/**
 * Notes the template addresses to whoever is scaffolding — rename this, quote that. They
 * are guidance for one edit, and a skill or agent body is a prompt read at call time, so
 * leaving them in ships instructions to the wrong reader. Sentinel-marked so removing them
 * is mechanical rather than a judgement about which paragraphs were meant for whom.
 */
function checkScaffoldNotes(f, text) {
  if (/^SCAFFOLD NOTE\b/m.test(text)) {
    err(
      f,
      "still carries a `SCAFFOLD NOTE` paragraph — those are addressed to whoever fills the " +
        "template in, and a shipped body is read by the agent instead. Delete them."
    );
  }
}

/** Skill and agent names are global to a session; two plugins declaring one collide. */
function checkCollisions(plugins) {
  for (const [kind, lister] of [
    ["skill", (d) => skillDirs(d).map((s) => path.basename(s))],
    ["agent", (d) => agentFiles(d).map((a) => path.basename(a, ".md"))],
  ]) {
    const owners = new Map();
    for (const p of plugins) {
      for (const name of lister(p.dir)) {
        if (owners.has(name)) {
          err(
            rel(p.dir),
            `${kind} "${name}" is already declared by ${owners.get(name)} — one plugin owns it and ` +
              "the other wraps it; two definitions drift apart and disagree"
          );
        } else {
          owners.set(name, p.name);
        }
      }
    }
  }
}

// ── run ────────────────────────────────────────────────────────────────────────

const target = process.argv[2];
let rolePlugins;
// Agents outside the role plugins, checked for identity but not for template shape. Counted
// separately so the summary reports everything it actually read — an under-reported count is
// how a widened pass quietly becomes a no-op.
let identityOnly = 0;

/** Report everything collected so far, then stop. */
function fail(reason) {
  console.error(`Role-plugin check FAILED:\n  ${[reason, ...errors].join("\n  ")}`);
  process.exit(1);
}

if (target) {
  const dir = path.resolve(ROOT, target);
  if (!fs.existsSync(dir)) {
    fail(`${target}: no such directory`);
  }
  const name = (manifestOf(dir) || {}).name || path.basename(dir);
  rolePlugins = [{ name, dir }];
  // A scaffold is checked here precisely because it is not registered yet, which is also
  // when a name collision is still cheap to fix — so weigh it against what is registered.
  checkCollisions([...marketplacePlugins().filter((p) => p.dir !== dir), { name, dir }]);
} else {
  const all = marketplacePlugins();
  if (!all.some((p) => (manifestOf(p.dir) || {}).name === CORE_NAME)) {
    fail(
      `no plugin manifest is named "${CORE_NAME}" (from package.json), so the core plugin cannot ` +
        "be told apart from the role plugins and every classification below would be wrong"
    );
  }
  // Every plugin except the core one. Not "every plugin that declares the dependency" —
  // that made dropping the dependency remove a plugin from these gates rather than fail
  // the rule requiring it.
  rolePlugins = all.filter((p) => (manifestOf(p.dir) || {}).name !== CORE_NAME);

  // Collisions are a marketplace-wide property: the core plugin's names count too.
  checkCollisions(all);

  // So is agent identity. A bare registered name pools its writes wherever it lives, and
  // the core plugin's agents are the ones most likely to already have an anchor in the
  // graph — exempting the plugin that teaches the rule is how the rule stops being one.
  // Shape is not enforced here: see checkAgent.
  for (const p of all.filter((x) => !rolePlugins.some((r) => r.dir === x.dir))) {
    for (const a of agentFiles(p.dir)) {
      checkAgent(a, false);
      identityOnly++;
    }
    // The frontmatter parse hazard is not template shape either — it drops a component's
    // whole metadata block wherever it happens. The skills guard in hook-architecture
    // checks naming and presence, never whether the block parses, so nothing else covers
    // the core plugin's own skills for it.
    for (const s of skillDirs(p.dir)) {
      const file = path.join(s, "SKILL.md");
      if (!fs.existsSync(file)) {
        continue;
      }
      const fm = frontmatter(fs.readFileSync(file, "utf8"));
      for (const key of fm ? unquotedColonScalars(fm.lines) : []) {
        err(
          rel(file),
          `frontmatter ${key} — YAML rejects the document, and the skill then loads with every ` +
            "field dropped and nothing reporting it. Quote the value, and close the quotes."
        );
      }
    }
  }
}

if (!rolePlugins.length) {
  fail(`the marketplace lists no plugin other than "${CORE_NAME}" — nothing was inspected`);
}

let agents = 0;
let skills = 0;
for (const p of rolePlugins) {
  checkManifest(p.dir, manifestOf(p.dir));
  for (const a of agentFiles(p.dir)) {
    checkAgent(a);
    agents++;
  }
  for (const s of skillDirs(p.dir)) {
    checkSkill(s);
    skills++;
  }
  checkContent(p.dir);
}

if (!agents && !skills) {
  fail("the role plugins ship no agents and no skills — nothing was inspected");
}

if (errors.length) {
  console.error(`Role-plugin check FAILED:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Role-plugin check OK: ${rolePlugins.length} plugin(s), ${agents + identityOnly} agent(s)` +
    `${identityOnly ? ` (${identityOnly} identity-only)` : ""}, ${skills} skill(s).`
);
