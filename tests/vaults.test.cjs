#!/usr/bin/env node
/**
 * The gutt-vaults plugin: its rules, its Console, its page templates and the vault-pages
 * script agree with each other.
 *
 * - Settings: vault-config.md and the Console's Settings tab list the same keys, defaults and
 *   ranges; no rule carries a threshold that moved to settings; every key a rule names exists.
 * - Vault-agnostic: skills and agents name no real vault, even as an example, there is no
 *   default vault, and no person is named.
 * - The reviewer's tool allowlist is read-only and covers every known memory server prefix.
 * - The Console reads only what its data contract defines and never writes HTML.
 * - Skill evals parse and point at files that exist.
 * - vault-pages: the export is deterministic, keeps last week's layout, and its fixtures are
 *   what the script produces; every data contract rejects a broken file; the templates load
 *   only what an artifact may load.
 * - Headless Chrome, when there is one (set CHROME to point at it): the Console, the Brief and
 *   the Timelapse render from their fixtures, and the Console's review flows still work.
 *
 * Run: node --test tests/vaults.test.cjs
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLUGIN = path.join(ROOT, "gutt-vaults");
const SKILLS = path.join(PLUGIN, "skills");
const AGENTS = path.join(PLUGIN, "agents");
const TEMPLATES = path.join(PLUGIN, "templates");
const CONFIG_REF = path.join(SKILLS, "vault-curate", "references", "vault-config.md");
const CONTRACT = path.join(SKILLS, "vault-curate", "references", "console-data.md");
const MEMORY_TOOLS = path.join(SKILLS, "vault-curate", "references", "memory-tools.md");
const CONSOLE = path.join(TEMPLATES, "console", "index.html");
const SCRIPT = path.join(SKILLS, "vault-pages", "scripts", "vault-pages.cjs");
const RAW = path.join(SKILLS, "vault-pages", "fixtures", "raw-export.json");
const FIXTURE_NOW = "2026-11-06T13:00:00Z";

const pages = require(SCRIPT);

const read = (p) => fs.readFileSync(p, "utf8");

/**
 * A page file with its layout coordinates zeroed. The force layout runs hundreds of steps of
 * Math.sin/cos/sqrt, whose last bits differ between V8 releases, so the exact positions differ
 * between Node versions (CI runs the .nvmrc floor). Everything else must match byte for byte;
 * `assertLayout` checks the positions themselves.
 */
function withoutLayout(text, kind) {
  const doc = JSON.parse(text);
  const at = kind === "graph" ? [5, 6] : [0, 1];
  for (const node of doc.nodes) {
    for (const i of at) {
      node[i] = 0;
    }
  }
  return JSON.stringify(doc);
}

function assertLayout(text, kind) {
  const doc = JSON.parse(text);
  const at = kind === "graph" ? [5, 6] : [0, 1];
  for (const node of doc.nodes) {
    for (const i of at) {
      assert.ok(
        Number.isInteger(node[i]) && Math.abs(node[i]) <= 1000,
        `${kind} node ${JSON.stringify(node).slice(0, 80)}`
      );
    }
  }
}
const relp = (p) => path.relative(ROOT, p);
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vaults-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function walk(dir, pred) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, pred) : pred(full) ? [full] : [];
  });
}

/** Skill bodies, their references and the agents: everything a run reads as rules. */
function ruleFiles() {
  return [
    ...walk(SKILLS, (f) => f.endsWith(".md")),
    ...walk(AGENTS, (f) => f.endsWith(".md")),
  ].filter((f) => !f.split(path.sep).includes("evals"));
}

/** Lines outside an "Example" section and not marked as an example themselves. */
function* outsideExamples(file) {
  let inExample = false;
  const lines = read(file).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^#+\s+(.*)/);
    if (heading) {
      inExample = /example/i.test(heading[1]);
    }
    if (inExample || /\bexample\b|\be\.g\./i.test(lines[i])) {
      continue;
    }
    yield [i + 1, lines[i]];
  }
}

// ── settings ────────────────────────────────────────────────────────────────────

function referenceKeys() {
  const block = read(CONFIG_REF).match(
    /<!-- config-keys:begin -->([\s\S]*?)<!-- config-keys:end -->/
  );
  assert.ok(block, "vault-config.md lost its config-keys block");
  const keys = {};
  for (const line of block[1].split("\n")) {
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length >= 6 && cells[0].startsWith("`")) {
      keys[cells[0].replace(/`/g, "")] = { def: cells[1], min: cells[2], max: cells[3] };
    }
  }
  assert.ok(Object.keys(keys).length, "no keys parsed from vault-config.md");
  return keys;
}

function consoleFields() {
  const block = read(CONSOLE).match(
    /<script type="application\/json" id="config-fields">([\s\S]*?)<\/script>/
  );
  assert.ok(block, "the Console lost its config-fields block");
  const out = {};
  for (const s of JSON.parse(block[1]).sections) {
    for (const f of s.fields) {
      out[f.key] = f;
    }
  }
  return out;
}

const TEXT_KEYS = new Set(["brief.linkedin_series", "brief.linkedin_cta"]);

describe("settings", () => {
  it("the Console's Settings tab and vault-config.md list the same keys, defaults and ranges", () => {
    const ref = referenceKeys();
    const fields = consoleFields();
    assert.deepEqual(Object.keys(fields).sort(), Object.keys(ref).sort());
    for (const [key, r] of Object.entries(ref)) {
      const f = fields[key];
      if (TEXT_KEYS.has(key)) {
        assert.equal(f.kind, "text", key);
        assert.equal(r.max, `${f.max} chars`, key);
        continue;
      }
      for (const [a, b] of [
        [r.def, f.default],
        [r.min, f.min],
        [r.max, f.max],
      ]) {
        assert.ok(Math.abs(Number(a) - b) < 1e-9, `${key}: ${a} vs ${b}`);
      }
      assert.ok(f.min <= f.default && f.default <= f.max, key);
    }
  });

  // Literals that lived in skill rules before the settings existed. Each now has a key.
  const RETIRED = [
    [/pending_cap`?\s*\(\s*\d/, "run.pending_cap"],
    [/\bbelow 2\b/, "run.significance_floor"],
    [/\(default 8\)|default 8\b/, "run.scout_max_items"],
    [/\bN\s*=\s*\d|\bN\s*≥\s*\d/, "review.precedents_min"],
    [/≥\s*0?\.?\d+\s*%|≥\s*0\.\d/, "review.precedent_agreement / ladder thresholds"],
    [/age_days\s*\/\s*\d/, "review.precedent_half_life_days"],
    [/(last|in|within) 30 days/, "review.override_cooloff_days"],
    [/under 7 days|newer than 7 days/, "review.recent_steering_days"],
    [/\b10% of\b|at least 2 when/, "review.audit_rate / review.audit_min"],
    [/≥\s*\d+\s*\*\*(reject|approve)/, "ladder.stage1_calls / ladder.stage2_approve_calls"],
    [/replay\s*≥\s*\d|\b17\/20\b/, "ladder.replay_pass"],
    [/Stage ceiling:\s*<?\s*[0-3]|ceiling \([0-3]\)/, "ladder.ceiling (Settings only)"],
    [/Fewer than 3 committed|20\+ human verdicts/, "brief.min_findings / ladder.replay_size"],
    [/seen 3\+|≥ 5 verdicts|≥ 80%/, "brief.steering_after_weeks / brief.pattern_*"],
  ];

  it("no rule carries a threshold that moved to settings", () => {
    const hits = [];
    for (const file of ruleFiles()) {
      if (file === CONFIG_REF) {
        continue;
      }
      for (const [n, line] of outsideExamples(file)) {
        for (const [re, key] of RETIRED) {
          if (re.test(line)) {
            hits.push(`${relp(file)}:${n}: ${line.trim()}  (use ${key})`);
          }
        }
      }
    }
    assert.deepEqual(hits, []);
  });

  it("every settings key a rule names exists", () => {
    const known = new Set([...Object.keys(referenceKeys()), "ladder.class_ceilings"]);
    const unknown = [];
    for (const file of ruleFiles()) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(/`((?:run|review|ladder|brief)\.[a-z0-9_]+)`/g)) {
            if (!known.has(m[1]) && !/\.(json|md|html)$/.test(m[1])) {
              unknown.push(`${relp(file)}:${i + 1}: ${m[1]}`);
            }
          }
        });
    }
    assert.deepEqual(unknown, []);
  });
});

// ── vault-agnostic ──────────────────────────────────────────────────────────────

const FLAGSHIP = /next[-_ ]agent[-_ ]to[-_ ]hire|\bhire vault\b/i;

describe("vault-agnostic", () => {
  it("names no real vault in skills or agents, even as an example", () => {
    // A real slug or group in prompt text reads, on another deployment, as a scope that
    // exists: examples use example-vault / vault_example_vault.
    const hits = [];
    for (const file of ruleFiles()) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (FLAGSHIP.test(line) || /mcp__[0-9a-f]{8}-/.test(line)) {
            hits.push(`${relp(file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    assert.deepEqual(hits, [], "use example-vault and <connector-uuid> placeholders");
  });

  it("templates, fixtures and the plugin README name no real vault", () => {
    const files = [
      ...walk(TEMPLATES, () => true),
      ...walk(path.join(SKILLS, "vault-pages"), (f) => !f.endsWith(".md")),
      path.join(PLUGIN, "README.md"),
    ];
    const hits = files.filter((f) => FLAGSHIP.test(read(f))).map(relp);
    assert.deepEqual(hits, []);
  });

  it("names no person: rules say 'the owner'", () => {
    const hits = [];
    for (const file of [...ruleFiles(), ...walk(TEMPLATES, () => true)]) {
      if (/\bOleg\b|Chekan/.test(read(file))) {
        hits.push(relp(file));
      }
    }
    assert.deepEqual(hits, []);
  });

  for (const skill of ["vault-curate", "vault-commit", "vault-brief", "vault-steer"]) {
    it(`${skill} requires a slug and has no default vault`, () => {
      const text = read(path.join(SKILLS, skill, "SKILL.md"));
      const hint = text.match(/^argument-hint:\s*(["'])(.*)\1\s*$/m);
      assert.ok(hint && hint[2].startsWith("<slug>"), "argument-hint must start with <slug>");
      assert.ok(
        text.includes("references/routines.md"),
        "point at the missing-slug message in routines.md"
      );
      assert.ok(text.toLowerCase().includes("no default vault"), "say there is no default vault");
    });
  }

  it("prompts call the plugin's own skills by their namespaced names", () => {
    const bare = [];
    for (const file of walk(SKILLS, (f) => f.endsWith(".md") || f.endsWith(".json"))) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (/(^|[\s"`(])\/vault-(curate|commit|brief|steer|pages)\b/.test(line)) {
            bare.push(`${relp(file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    assert.deepEqual(bare, [], "use /gutt-vaults:vault-…");
  });
});

// ── reviewer ────────────────────────────────────────────────────────────────────

const READ_TOOLS = new Set([
  "search_memory_nodes",
  "search_memory_facts",
  "fetch_lessons_learned",
  "get_episodes_for_entity",
  "get_episode",
  "get_episodes",
  "get_entity_node",
  "list_writable_groups",
]);
const WRITE_MARKERS = [
  "add_memory",
  "confirm_memory",
  "submit_memory",
  "discard_draft",
  "register_agent",
  "delete",
  "clear",
];

function reviewerTools() {
  const m = read(path.join(AGENTS, "vault-reviewer.md")).match(/^tools:\s*(.+)$/m);
  assert.ok(m, "vault-reviewer.md has no tools: line");
  return m[1]
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function knownPrefixes() {
  const block = read(MEMORY_TOOLS).match(
    /<!-- known-prefixes:begin -->([\s\S]*?)<!-- known-prefixes:end -->/
  );
  assert.ok(block, "memory-tools.md lost its known-prefixes block");
  return [...block[1].matchAll(/`(mcp__[^`]+__)`/g)].map((m) => m[1]);
}

describe("the reviewer's allowlist", () => {
  it("covers every known prefix with the full read set, the gutt-pro plugin's server first", () => {
    const tools = new Set(reviewerTools());
    const prefixes = knownPrefixes();
    assert.equal(prefixes[0], "mcp__plugin_gutt-pro_gutt-mcp-remote__");
    const missing = prefixes
      .flatMap((p) => [...READ_TOOLS].map((t) => p + t))
      .filter((t) => !tools.has(t));
    assert.deepEqual(missing, []);
  });

  it("holds only known read tools, under known prefixes, with no wildcard", () => {
    const prefixes = knownPrefixes();
    for (const tool of reviewerTools()) {
      assert.ok(!tool.includes("*"), `a server wildcard would grant write tools: ${tool}`);
      assert.ok(
        !WRITE_MARKERS.some((w) => tool.includes(w)),
        `vault-reviewer must stay read-only: ${tool}`
      );
      if (tool.startsWith("mcp__")) {
        const prefix = prefixes.find((p) => tool.startsWith(p));
        assert.ok(prefix, `add this prefix to memory-tools.md or drop it: ${tool}`);
        assert.ok(READ_TOOLS.has(tool.slice(prefix.length)), `not a known read tool: ${tool}`);
      }
    }
  });

  it("refuses another group before any memory call", () => {
    const agent = read(path.join(AGENTS, "vault-reviewer.md"));
    const skill = read(path.join(SKILLS, "vault-review", "SKILL.md"));
    for (const [name, text] of [
      ["vault-reviewer.md", agent],
      ["vault-review/SKILL.md", skill],
    ]) {
      assert.ok(
        text.includes("no memory call"),
        `${name}: the vault check comes before any memory call`
      );
      assert.ok(
        text.includes('"error"'),
        `${name}: a failed vault check returns error and no decisions`
      );
    }
    assert.ok(
      read(path.join(SKILLS, "vault-curate", "SKILL.md")).includes(
        "refuses a group that isn't `vault_<slug>`"
      )
    );
  });

  it("is spawned by its plugin-qualified name", () => {
    const curate = read(path.join(SKILLS, "vault-curate", "SKILL.md"));
    assert.ok(curate.includes('subagent_type="gutt-vaults:vault-reviewer"'));
    assert.ok(curate.includes('subagent_type="gutt-vaults:vault-scout"'));
  });
});

// ── Console ─────────────────────────────────────────────────────────────────────

function consoleScript() {
  const blocks = [...read(CONSOLE).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, "the Console should have one inline script");
  return blocks[0];
}

function collectionsBlock() {
  const m = read(CONTRACT).match(/## Collections\s+```([\s\S]*?)```/);
  assert.ok(m, "console-data.md lost its Collections block");
  return m[1];
}

function consoleLabels() {
  const m = read(CONSOLE).match(
    /<script type="application\/json" id="console-labels">([\s\S]*?)<\/script>/
  );
  assert.ok(m, "the Console lost its console-labels block");
  return JSON.parse(m[1]);
}

describe("the Console", () => {
  it("reads only collections and meta documents its contract defines", () => {
    const script = consoleScript();
    const names = new Set([...script.matchAll(/db\.collection\("(\w+)"\)/g)].map((m) => m[1]));
    const docs = new Set([...script.matchAll(/\bd\("(meta\/\w+)"/g)].map((m) => m[1]));
    assert.ok(names.has("findings") && names.has("calibrations") && docs.has("meta/reviewer"));
    const defined = new Set(
      collectionsBlock()
        .split("\n")
        .filter((l) => l && !/^\s/.test(l))
        .map((l) => l.split(/\s+/)[0])
    );
    assert.deepEqual(
      [...names, ...docs].filter((n) => !defined.has(n)),
      []
    );
  });

  it("keeps routine-written collections admin-only", () => {
    const rules = new Set(
      [...read(CONTRACT).matchAll(/\{path: "(\w+)", write: "admin"\}/g)].map((m) => m[1])
    );
    for (const c of ["meta", "runs", "config_changes", "calibrations"]) {
      assert.ok(rules.has(c), c);
    }
  });

  it("writes only human{} and left_open{} fields the contract lists", () => {
    const script = consoleScript();
    const written = new Set([...script.matchAll(/\bhuman\.(\w+) = /g)].map((m) => m[1]));
    const literal = script.match(/var human = \{(.*?)\};/);
    assert.ok(literal, "decide() no longer builds human{} as one literal");
    for (const m of literal[1].matchAll(/(\w+):/g)) {
      written.add(m[1]);
    }
    const human = collectionsBlock().match(/human\{([\s\S]*?)\}/);
    assert.ok(human, "findings.human{} is missing from the contract");
    const listed = new Set(
      [...human[1].matchAll(/(?:^|[\s,{])([a-z_]+)(?=\s*[\s(,]|$)/g)].map((m) => m[1])
    );
    assert.deepEqual(
      [...written].filter((w) => !listed.has(w)),
      []
    );
    assert.ok(collectionsBlock().includes("left_open{revisit (YYYY-MM-DD), note, at}"));
  });

  it("offers the rejection reasons the contract lists", () => {
    const block = read(CONTRACT).match(
      /<!-- reject-reasons:begin -->([\s\S]*?)<!-- reject-reasons:end -->/
    );
    assert.ok(block, "console-data.md lost its reject-reasons block");
    const contract = Object.fromEntries(
      [...block[1].matchAll(/\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|/g)].map((m) => [m[1], m[2]])
    );
    const page = Object.fromEntries(consoleLabels().reject_reasons.map((r) => [r.key, r.label]));
    assert.deepEqual(page, contract);
    const distill = read(path.join(SKILLS, "vault-brief", "references", "distillation.md"));
    for (const label of Object.values(contract)) {
      assert.ok(distill.includes(label), `distillation.md should name the reason ${label}`);
    }
  });

  it("labels every stage class and agent it can show", () => {
    const labels = consoleLabels();
    const ladder = read(path.join(SKILLS, "vault-review", "references", "autonomy-ladder.md"));
    const classes = new Set(
      [...ladder.matchAll(/\|\s*\w+\s*\|\s*`([a-z_]+(?:\/<beat>)?)`/g)].map((m) => m[1])
    );
    assert.deepEqual([...classes].sort(), [
      "card_update",
      "conflict",
      "finding/<beat>",
      "reverify",
    ]);
    for (const c of classes) {
      assert.ok(c.replace("<beat>", "*") in labels.class_labels, c);
    }
    assert.equal(labels.stages.length, 4);
    const list = consoleScript().match(/\["", ("vault-[^\]]+)\]/);
    assert.ok(list);
    for (const m of list[1].matchAll(/"(vault-[a-z]+)"/g)) {
      assert.ok(m[1] in labels.agents, m[1]);
    }
  });

  it("never writes HTML, and shows a brief's Markdown as built DOM", () => {
    const script = consoleScript();
    assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/);
    assert.match(script, /function mdView\(/);
    assert.match(script, /function linkedinCount\(/);
  });
});

// ── skill evals ─────────────────────────────────────────────────────────────────

describe("skill evals", () => {
  const files = walk(SKILLS, (f) => f.endsWith(path.join("evals", "evals.json")));

  it("every vault skill has evals", () => {
    const skills = fs
      .readdirSync(SKILLS)
      .filter((d) => fs.existsSync(path.join(SKILLS, d, "SKILL.md")));
    assert.deepEqual(
      skills.filter((s) => !fs.existsSync(path.join(SKILLS, s, "evals", "evals.json"))),
      []
    );
  });

  for (const file of files) {
    const skill = path.basename(path.dirname(path.dirname(file)));
    it(`${skill}: evals parse, ids are unique, and every file they name exists`, () => {
      const data = JSON.parse(read(file));
      assert.equal(data.skill_name, skill);
      const ids = data.evals.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, "duplicate eval ids");
      for (const e of data.evals) {
        assert.ok(
          e.prompt && e.assertions && e.assertions.length,
          `eval ${e.id} needs a prompt and assertions`
        );
        for (const f of e.files || []) {
          assert.ok(fs.existsSync(path.join(SKILLS, skill, f)), `eval ${e.id}: ${f} is missing`);
        }
      }
    });
  }

  it("the reviewer's evals send the vault lines vault-curate sends", () => {
    const data = JSON.parse(read(path.join(SKILLS, "vault-review", "evals", "evals.json")));
    for (const e of data.evals) {
      const head = e.prompt
        .split("\n")
        .slice(0, 3)
        .map((l) => l.split(":")[0]);
      assert.deepEqual(head, ["vault", "group", "run"], `eval ${e.id}`);
    }
  });
});

// ── vault-pages ─────────────────────────────────────────────────────────────────

const rawExport = () => JSON.parse(read(RAW));
const build = (raw, opts = {}) => pages.buildPages(raw, Object.assign({ now: FIXTURE_NOW }, opts));

describe("vault-pages export", () => {
  it("the page fixtures are exactly what the script makes of the raw export", () => {
    const { graph, timeline } = build(rawExport());
    assertLayout(JSON.stringify(graph), "graph");
    assertLayout(JSON.stringify(timeline), "timeline");
    assert.equal(
      withoutLayout(JSON.stringify(graph), "graph"),
      withoutLayout(read(path.join(TEMPLATES, "graph", "fixtures", "graph.json")), "graph")
    );
    assert.equal(
      withoutLayout(JSON.stringify(timeline), "timeline"),
      withoutLayout(
        read(path.join(TEMPLATES, "timelapse", "fixtures", "timeline.json")),
        "timeline"
      )
    );
  });

  it("gives the same output for the same memory, whatever order it was read in", () => {
    const raw = rawExport();
    const shuffled = Object.assign({}, raw, {
      nodes: raw.nodes.slice().reverse(),
      facts: raw.facts.slice().reverse(),
      episodes: raw.episodes.slice().reverse(),
    });
    assert.deepEqual(build(shuffled), build(raw));
  });

  it("keeps the same copy of a record read twice, whatever order the reads came in", () => {
    const raw = rawExport();
    const fact = raw.facts.find((f) => !f.invalid_at && !f.expired_at);
    const node = raw.nodes[0];
    // The same fact read before and after it was superseded, and the same node read twice
    // with equal-length summaries but different attributes.
    const twice = Object.assign({}, raw, {
      facts: [...raw.facts, Object.assign({}, fact, { invalid_at: "2026-11-05T10:00:00Z" })],
      nodes: [...raw.nodes, Object.assign({}, node, { attributes: { changed: "yes" } })],
    });
    const reversed = Object.assign({}, twice, {
      facts: twice.facts.slice().reverse(),
      nodes: twice.nodes.slice().reverse(),
    });
    const a = build(twice);
    assert.deepEqual(build(reversed), a);
    assert.equal(a.timeline.stats.invalidated, build(raw).timeline.stats.invalidated + 1);
    assert.equal(a.graph.facts.filter((f) => f[0] === fact.uuid).length, 1);
  });

  it("drops a fact whose endpoint is not in the export, and says so", (t) => {
    const raw = rawExport();
    raw.facts.push({
      uuid: "eeeeeeee-0000-4000-8000-000000000001",
      name: "RELATES_TO",
      fact: "Something points at a node nobody read",
      source_node_id: raw.facts[0].source_node_id,
      target_node_id: "vault_example_vault:Product:Never-Read",
      created_at: "2026-11-05T10:00:00Z",
    });
    const { graph, timeline } = build(raw);
    assert.equal(graph.stats.unresolved, 1);
    assert.equal(timeline.stats.unresolved, 1);
    assert.ok(!graph.facts.some((f) => f[0] === "eeeeeeee-0000-4000-8000-000000000001"));
    assert.ok(!timeline.facts.some((f) => f[6] === "Something points at a node nobody read"));
    assert.deepEqual(pages.checkData("graph", graph), []);
    assert.deepEqual(pages.checkData("timelapse", timeline), []);
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, "export.json"), JSON.stringify(raw));
    const out = spawnSync(
      process.execPath,
      [SCRIPT, "export", "--in", path.join(dir, "export.json"), "--out", path.join(dir, "out")],
      { encoding: "utf8" }
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1 facts dropped: an endpoint was not in the export/);
  });

  it("gives every fact its full id, keyed by uuid or id, so none hides another", () => {
    const raw = rawExport();
    const [a, b] = raw.facts.filter((f) => !f.invalid_at).slice(0, 2);
    // Two facts with no uuid, and two whose uuids share their first 8 characters.
    const byId = Object.assign({}, raw, {
      facts: [
        ...raw.facts,
        Object.assign({}, a, { uuid: undefined, id: "only-id-1" }),
        Object.assign({}, b, { uuid: undefined, id: "only-id-2" }),
        Object.assign({}, a, { uuid: "abcdef01-0000-4000-8000-000000000001" }),
        Object.assign({}, b, { uuid: "abcdef01-0000-4000-8000-000000000002" }),
      ],
    });
    const { graph } = build(byId);
    const ids = graph.facts.map((f) => f[0]);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ["only-id-1", "only-id-2", "abcdef01-0000-4000-8000-000000000001"]) {
      assert.ok(ids.includes(id), id);
    }
    assert.deepEqual(pages.checkData("graph", graph), []);
    const dup = JSON.parse(JSON.stringify(graph));
    dup.facts.push(dup.facts[0].slice());
    assert.match(pages.checkData("graph", dup).join("\n"), /repeats an earlier fact's/);
  });

  it("meets both contracts", () => {
    const { graph, timeline } = build(rawExport());
    assert.deepEqual(pages.checkData("graph", graph), []);
    assert.deepEqual(pages.checkData("timelapse", timeline), []);
  });

  it("keeps every node of last week's graph where it was", () => {
    const raw = rawExport();
    const lastWeek = build(raw).graph;
    const grown = JSON.parse(JSON.stringify(raw));
    const g = "vault_example_vault";
    grown.nodes.push({
      id: `${g}:Product:Newcomer`,
      name: "Newcomer",
      labels: ["Entity", "Product"],
      summary: "",
      attributes: {},
      created_at: "2026-11-07T01:43:00Z",
    });
    grown.facts.push({
      uuid: "ffffffff-0000-4000-8000-000000000001",
      name: "COVERED_BY",
      fact: "Newcomer is covered by the releases beat",
      source_node_id: `${g}:Product:Newcomer`,
      target_node_id: `${g}:Beat:Beat:-releases`,
      created_at: "2026-11-07T01:44:00Z",
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vaults-prev-"));
    try {
      const prevFile = path.join(dir, "graph.json");
      fs.writeFileSync(prevFile, JSON.stringify(lastWeek));
      const next = build(grown, { previous: pages.previousPositions(prevFile) }).graph;
      const before = new Map(lastWeek.nodes.map((n) => [n[0] + "\u0001" + n[1], [n[5], n[6]]]));
      let kept = 0;
      for (const n of next.nodes) {
        const p = before.get(n[0] + "\u0001" + n[1]);
        if (p) {
          assert.deepEqual([n[5], n[6]], p, n[1]);
          kept++;
        }
      }
      assert.equal(kept, lastWeek.nodes.length);
      assert.equal(next.nodes.length, lastWeek.nodes.length + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns Agent nodes into the Timelapse's agents and credits each fact to its episode's writer", () => {
    const { timeline } = build(rawExport());
    assert.deepEqual(
      timeline.agents.map((a) => a.name),
      [
        "vault-charter",
        "vault-scout",
        "vault-librarian",
        "vault-reviewer",
        "vault-curate",
        "vault-brief",
      ]
    );
    assert.ok(!timeline.types.includes("Agent"));
    const byText = (s) => timeline.facts.find((f) => f[6].startsWith(s));
    const agent = (f) => timeline.agents[f[4]].name;
    assert.equal(agent(byText("vault-charter defines")), "vault-charter");
    assert.equal(agent(byText("Acme Coder is made by")), "vault-scout");
    assert.equal(agent(byText("The verdict approved")), "vault-librarian");
    assert.equal(agent(byText("The week 45 brief")), "vault-brief");
    assert.ok(byText("vault-charter defines")[0] < 0, "an agent endpoint is negative");
    assert.equal(timeline.start, "2026-11-02T00:00:00Z");
    assert.equal(timeline.stats.invalidated, 1);
  });

  it("settles an endpoint shared by two nodes from the fact's words", () => {
    const { graph } = build(rawExport());
    const fact = graph.facts.find((f) => f[2].startsWith("The insight that pricing pages hide"));
    const node = graph.nodes.find(
      (n) => n[0] === fact[3] && n[1] === "Pricing pages hide seat minimums"
    );
    assert.ok(node, "the fact's source resolves to the node its words name");
    assert.ok(graph.stats.ambiguous > 0);
  });

  it("reads tool results as the server returned them", (t) => {
    const raw = rawExport();
    const dir = tmp(t);
    fs.writeFileSync(
      path.join(dir, "episodes.json"),
      JSON.stringify({ result: { episodes: raw.episodes } })
    );
    fs.writeFileSync(
      path.join(dir, "batch-1.json"),
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ nodes: raw.nodes, facts: raw.facts }) }],
      })
    );
    const read1 = pages.readExport(dir);
    assert.equal(read1.episodes.length, raw.episodes.length);
    assert.equal(read1.nodes.length, raw.nodes.length);
    const a = build(Object.assign(read1, { vault: raw.vault }));
    assert.deepEqual(a, build(raw));
  });

  it("says which saved files it could not read, and when memory held more episodes", (t) => {
    const raw = rawExport();
    const dir = tmp(t);
    fs.writeFileSync(
      path.join(dir, "episodes.json"),
      JSON.stringify({ episodes: raw.episodes, has_more: true })
    );
    fs.writeFileSync(
      path.join(dir, "batch-1.json"),
      JSON.stringify({ nodes: raw.nodes, facts: raw.facts })
    );
    fs.writeFileSync(path.join(dir, "batch-2.json"), "Error: the server timed out");
    const out = spawnSync(
      process.execPath,
      [SCRIPT, "export", "--in", dir, "--out", path.join(dir, "out")],
      {
        encoding: "utf8",
      }
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1 files skipped: .*batch-2\.json \(not JSON\)/);
    assert.match(out.stdout, /memory holds more episodes than were listed/);
    assert.equal(JSON.parse(read(path.join(dir, "out", "graph.json"))).stats.more_in_memory, true);
  });

  it("skips an error result, or one with an unreadable item, instead of reading it as empty", (t) => {
    const raw = rawExport();
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, "episodes.json"), JSON.stringify({ episodes: raw.episodes }));
    fs.writeFileSync(
      path.join(dir, "batch-1.json"),
      JSON.stringify({ nodes: raw.nodes, facts: raw.facts })
    );
    const text = (t2) => ({ type: "text", text: t2 });
    fs.writeFileSync(
      path.join(dir, "batch-2.json"),
      JSON.stringify({
        content: [text('{"error":"rate limited"}'), text('{"error":"retry later"}')],
        isError: true,
      })
    );
    fs.writeFileSync(
      path.join(dir, "batch-3.json"),
      JSON.stringify({ content: [text('{"nodes":[],"facts":[]}'), text("Error: timed out")] })
    );
    fs.writeFileSync(
      path.join(dir, "batch-4.json"),
      JSON.stringify({ content: [text('{"error":"no such episode"}')] })
    );
    const got = pages.readExport(dir);
    assert.deepEqual(
      got.skipped.map((s) => path.basename(s)),
      [
        "batch-2.json (an error result)",
        "batch-3.json (a text item is not JSON)",
        "batch-4.json (an error result)",
      ]
    );
    assert.equal(got.nodes.length, raw.nodes.length);
  });

  it("refuses an export with nothing to draw", (t) => {
    const dir = tmp(t);
    fs.writeFileSync(path.join(dir, "batch-1.json"), "Error: the server timed out");
    let out = spawnSync(process.execPath, [SCRIPT, "export", "--in", dir, "--out", dir], {
      encoding: "utf8",
    });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /no episodes, nodes or facts found/);
    fs.writeFileSync(path.join(dir, "batch-1.json"), JSON.stringify({ vault: { name: "x" } }));
    out = spawnSync(process.execPath, [SCRIPT, "export", "--in", dir, "--out", dir], {
      encoding: "utf8",
    });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /nothing to replay/);
    assert.ok(!fs.existsSync(path.join(dir, "graph.json")));
  });

  it("stops when --previous names no file, and keeps places from last week's timeline.json", (t) => {
    const dir = tmp(t);
    const out = spawnSync(
      process.execPath,
      [SCRIPT, "export", "--in", RAW, "--out", dir, "--previous", path.join(dir, "missing.json")],
      { encoding: "utf8" }
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /previous layout not found/);
    const bare = spawnSync(
      process.execPath,
      [SCRIPT, "export", "--in", RAW, "--out", dir, "--previous"],
      { encoding: "utf8" }
    );
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /--previous needs the path/);

    const raw = rawExport();
    const lastWeek = build(raw).timeline;
    const prevFile = path.join(dir, "timeline.json");
    fs.writeFileSync(prevFile, JSON.stringify(lastWeek));
    // Last week's places, moved so they can't be this week's own layout by chance.
    const shrink = (v) => Math.round(v * 0.9);
    const moved = lastWeek.nodes.map((n) => [n[3], shrink(n[0]), shrink(n[1])]);
    const shifted = JSON.parse(JSON.stringify(lastWeek));
    shifted.nodes.forEach((n) => {
      n[0] = shrink(n[0]);
      n[1] = shrink(n[1]);
    });
    fs.writeFileSync(prevFile, JSON.stringify(shifted));
    const next = build(raw, { previous: pages.previousPositions(prevFile) }).timeline;
    const where = new Map(next.nodes.map((n) => [n[3], [n[0], n[1]]]));
    for (const [name, x, y] of moved) {
      assert.deepEqual(where.get(name), [x, y], name);
    }
    const cli = spawnSync(
      process.execPath,
      [SCRIPT, "export", "--in", RAW, "--out", path.join(dir, "o"), "--previous", prevFile],
      { encoding: "utf8" }
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, new RegExp(`layout: ${lastWeek.nodes.length} nodes kept in place`));
  });

  it("names an episode's writer from the episode itself", () => {
    const cases = [
      [{ name: "Run: vault-scout curate-2026-11-05" }, "vault-scout"],
      [{ name: "Charter: X" }, "vault-charter"],
      [{ name: "Steering: never use X" }, "vault-charter"],
      [{ name: "Calibration: 2026-11-06" }, "vault-reviewer"],
      [{ name: "Brief: 2026-W45" }, "vault-brief"],
      [{ name: "Finding: X", content: "… Tagged vault-reviewer." }, "vault-reviewer"],
      [{ name: "Finding: X", agent_id: "vault-scout" }, "vault-scout"],
      [{ name: "Finding: X" }, "vault-librarian"],
    ];
    for (const [ep, who] of cases) {
      assert.equal(pages.episodeAgent(ep), who, JSON.stringify(ep));
    }
    // A fact whose episode names no writer is credited by default, and counted.
    const raw = rawExport();
    const ep = raw.episodes.find((e) => (e.entity_edges || []).length);
    Object.assign(ep, { name: "Finding: anonymous", content: "No writer named." });
    for (const k of ["agent", "agent_id", "agent_name", "episode_metadata", "metadata"]) {
      delete ep[k];
    }
    assert.ok(build(raw).graph.stats.by_default >= 1);
    assert.equal(build(rawExport()).graph.stats.by_default, 0);
  });
});

describe("vault-pages contracts", () => {
  const fixture = (page, file) => JSON.parse(read(path.join(TEMPLATES, page, "fixtures", file)));

  it("every page fixture meets its contract", () => {
    assert.deepEqual(pages.checkData("brief", fixture("brief", "brief.json")), []);
    assert.deepEqual(pages.checkData("graph", fixture("graph", "graph.json")), []);
    assert.deepEqual(pages.checkData("timelapse", fixture("timelapse", "timeline.json")), []);
  });

  it("rejects a brief change without a source, a bad week and a non-http link", () => {
    const b = fixture("brief", "brief.json");
    b.week = "week 45";
    b.changes[0].sources = [];
    b.changes[1].sources[0].url = "javascript:alert(1)";
    const problems = pages.checkData("brief", b).join("\n");
    assert.match(problems, /week must look like/);
    assert.match(problems, /changes\[0\]: at least one source/);
    assert.match(problems, /changes\[1\]\.sources\[0\]: a source needs an http\(s\) url/);
  });

  it("rejects a timeline whose rows point past their lists", () => {
    const tl = fixture("timelapse", "timeline.json");
    tl.nodes[0][2] = tl.types.length;
    tl.facts[0][1] = tl.nodes.length + 5;
    tl.facts[1][0] = -1 - tl.agents.length;
    const problems = pages.checkData("timelapse", tl);
    assert.equal(problems.length, 3, problems.join("\n"));
  });

  it("rejects a graph fact whose endpoint is not a node", () => {
    const g = fixture("graph", "graph.json");
    g.facts[0][4] = "Nowhere:at-all";
    assert.match(pages.checkData("graph", g).join("\n"), /endpoint not in nodes/);
  });

  it("prepare sets only the title, escapes it, and refuses data that breaks the contract", (t) => {
    const out = path.join(tmp(t), "brief");
    pages.prepare("brief", {
      title: "R&D <Vault> Brief",
      out,
      data: path.join(TEMPLATES, "brief", "fixtures", "brief.json"),
    });
    const html = read(path.join(out, "index.html"));
    assert.ok(html.startsWith("<title>R&amp;D &lt;Vault&gt; Brief</title>"));
    assert.equal(
      html.replace(/<title>[^<]*<\/title>/, ""),
      read(path.join(TEMPLATES, "brief", "index.html")).replace(/<title>[^<]*<\/title>/, "")
    );
    assert.ok(fs.existsSync(path.join(out, "brief.json")));

    const bad = path.join(path.dirname(out), "bad.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({
        vault: { name: "X" },
        week: "2026-W45",
        headline: "h",
        changes: [{ finding: "f", title: "t" }],
      })
    );
    assert.throws(
      () =>
        pages.prepare("brief", {
          title: "X Brief",
          out: path.join(path.dirname(out), "b2"),
          data: bad,
        }),
      /does not meet the brief contract/
    );
    assert.ok(
      pages
        .withTitle("<title>x</title>", "Costs $& more $1")
        .startsWith("<title>Costs $&amp; more $1</title>")
    );
    assert.throws(
      () => pages.prepare("graph", { title: "X Graph", out: path.join(path.dirname(out), "g2") }),
      /needs --data/
    );
  });

  it("the command line exits 1 on a broken file and 0 on a good one", (t) => {
    const dir = tmp(t);
    const bad = path.join(dir, "graph.json");
    fs.writeFileSync(bad, JSON.stringify({ nodes: [["a"]], facts: [] }));
    const r1 = spawnSync(process.execPath, [SCRIPT, "check", "graph", bad], { encoding: "utf8" });
    assert.equal(r1.status, 1, r1.stdout + r1.stderr);
    const r2 = spawnSync(
      process.execPath,
      [SCRIPT, "check", "graph", path.join(TEMPLATES, "graph", "fixtures", "graph.json")],
      { encoding: "utf8" }
    );
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    const r3 = spawnSync(
      process.execPath,
      [SCRIPT, "export", "--in", RAW, "--out", dir, "--now", FIXTURE_NOW],
      { encoding: "utf8" }
    );
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(
      withoutLayout(read(path.join(dir, "graph.json")), "graph"),
      withoutLayout(read(path.join(TEMPLATES, "graph", "fixtures", "graph.json")), "graph")
    );
  });
});

// ── templates ───────────────────────────────────────────────────────────────────

describe("page templates", () => {
  const PAGES = ["brief", "graph", "timelapse", "console"];

  for (const page of PAGES) {
    it(`${page}: starts with its <title>, loads scripts only from pinned cdnjs URLs, and never writes HTML`, () => {
      const html = read(path.join(TEMPLATES, page, "index.html"));
      assert.match(html, /^<title>[^<]+<\/title>\n/);
      for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
        assert.match(
          m[1],
          /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[\w.-]+\/\d+\.\d+\.\d+\//,
          m[1]
        );
      }
      for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) {
        assert.match(m[1], /^https:\/\/fonts\.(googleapis|gstatic)\.com/, m[1]);
      }
      const scripts = [
        ...html.matchAll(
          /<script(?![^>]*\ssrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g
        ),
      ]
        .map((m) => m[1])
        .join("\n");
      assert.doesNotMatch(
        scripts,
        /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write|eval\(/
      );
    });
  }

  it("the data pages fetch only their own data file", () => {
    for (const [page, file] of [
      ["brief", "brief.json"],
      ["graph", "graph.json"],
      ["timelapse", "timeline.json"],
    ]) {
      const fetches = [
        ...read(path.join(TEMPLATES, page, "index.html")).matchAll(/fetch\(([^)]*)\)/g),
      ].map((m) => m[1]);
      assert.deepEqual(fetches, [`"${file}"`], page);
    }
  });
});

// ── headless Chrome ─────────────────────────────────────────────────────────────

function chrome() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function dumpDom(t, url) {
  const bin = chrome();
  if (!bin) {
    t.skip("no Chrome or Chromium for the headless check (set CHROME)");
    return null;
  }
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${tmp(t)}`,
    "--virtual-time-budget=4000",
    "--dump-dom",
    url,
  ];
  if (process.platform === "linux") {
    args.unshift("--no-sandbox");
  }
  const out = spawnSync(bin, args, { encoding: "utf8", timeout: 90000 });
  return (out.stdout || "") + (out.stderr || "").slice(-500);
}

/**
 * Serve a template with its fixture (or `data`) through the script's own preview, for one
 * test. Port 0 lets the system pick a free port; the preview prints the one it bound.
 */
async function preview(t, page, data) {
  const extra = data ? ["--data", data] : [];
  const child = spawn(process.execPath, [SCRIPT, "preview", page, "--port", "0", ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview did not start")), 10000);
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      const m = out.match(/Previewing \w+ at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`preview exited ${code}`)));
  });
}

const text = (dom) => dom.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("pages in a headless browser", () => {
  it("the Brief page renders its fixture", async (t) => {
    if (!chrome()) {
      t.skip("no Chrome or Chromium (set CHROME)");
      return;
    }
    const dom = dumpDom(t, await preview(t, "brief"));
    const body = text(dom);
    for (const want of [
      "Acme Coder ships 2.0",
      "What changed this week",
      "One source says",
      "Every source this week",
      "Earlier briefs",
    ]) {
      assert.ok(body.includes(want), `${want}: ${body.slice(0, 400)}`);
    }
  });

  it("the Brief page links only http(s) URLs, whatever the data holds", async (t) => {
    if (!chrome()) {
      t.skip("no Chrome or Chromium (set CHROME)");
      return;
    }
    const brief = JSON.parse(read(path.join(TEMPLATES, "brief", "fixtures", "brief.json")));
    brief.changes[0].sources[0].url = "javascript:alert(1)";
    brief.past = [{ week: "2026-W40", url: "javascript:alert(2)", headline: "Old week" }];
    brief.vault.graph_url = "javascript:alert(3)";
    const file = path.join(tmp(t), "brief.json");
    fs.writeFileSync(file, JSON.stringify(brief));
    const dom = dumpDom(t, await preview(t, "brief", file));
    assert.ok(!/href="javascript:/i.test(dom), "a javascript: URL became a link");
    const body = text(dom);
    assert.ok(body.includes(brief.changes[0].title), "the change's title is still shown");
    assert.ok(body.includes("Old week"), "the past brief's headline is still shown as text");
  });

  it("the Graph page loads its fixture", async (t) => {
    if (!chrome()) {
      t.skip("no Chrome or Chromium (set CHROME)");
      return;
    }
    const graph = JSON.parse(read(path.join(TEMPLATES, "graph", "fixtures", "graph.json")));
    const dom = dumpDom(t, await preview(t, "graph"));
    const body = text(dom);
    assert.ok(!/didn't load|malformed|Loading the graph/.test(body), body.slice(0, 400));
    assert.ok(body.includes(graph.vault.name), "the vault's name");
    const old = graph.facts.filter((f) => f[6]).length;
    const counts = `${graph.nodes.length} nodes · ${graph.facts.length - old} current facts · ${old} superseded`;
    assert.ok(body.includes(counts), `${counts}: ${body.slice(0, 400)}`);
  });

  it("the Timelapse page loads its fixture and counts every node and fact", async (t) => {
    if (!chrome()) {
      t.skip("no Chrome or Chromium (set CHROME)");
      return;
    }
    const dom = dumpDom(t, await preview(t, "timelapse"));
    const body = text(dom);
    assert.match(body, /of 29 nodes · \d+ of 50 facts/);
    assert.ok(body.includes("Example Vault · gutt memory"));
  });

  for (const [query, tab, expect] of [
    [
      "seed=full",
      "inbox",
      [
        "hidden until you decide",
        "A stands",
        "Leave open",
        "Proposed steering",
        "Brief page",
        "characters",
      ],
    ],
    ["seed=full", "archive", ["Brief page published"]],
    [
      "seed=full&linkedin=long",
      "inbox",
      ["3,001 of 3,000 characters in the post · 1 over LinkedIn's limit"],
    ],
    ["seed=empty", "inbox", ["fills after the vault's first research run"]],
  ]) {
    it(`the Console renders #${tab} (${query})`, async (t) => {
      if (!chrome()) {
        t.skip("no Chrome or Chromium (set CHROME)");
        return;
      }
      const dom = dumpDom(t, `${await preview(t, "console")}?${query}#${tab}`);
      const main = dom.match(/<main class="wrap" id="main">([\s\S]*?)<\/main>/);
      assert.ok(main, `the page didn't render: ${dom.slice(-500)}`);
      const body = text(main[1]);
      for (const e of expect) {
        assert.ok(body.includes(e), `#${tab} lacks ${e}: ${body.slice(0, 400)}`);
      }
      for (const word of ["vault-librarian", "finding/pricing", "card_update"]) {
        assert.ok(!body.includes(word), `#${tab} shows the internal name ${word}`);
      }
      if (query.includes("linkedin=long")) {
        assert.match(main[1], /class="count over"/);
      }
      if (tab === "inbox" && query === "seed=full") {
        assert.ok(!/<img[^>]*onerror/i.test(main[1]), "Markdown in a brief must stay text");
        assert.ok(!/href="javascript:/i.test(main[1]), "only http(s) links in a brief preview");
        assert.match(main[1], /<a href="https:\/\/example\.com\/a"/);
      }
    });
  }

  for (const name of ["reject", "undo", "leave_open", "in_place", "undo_after_commit"]) {
    it(`the Console's ${name} flow still works`, async (t) => {
      if (!chrome()) {
        t.skip("no Chrome or Chromium (set CHROME)");
        return;
      }
      const dom = dumpDom(t, `${await preview(t, "console")}?seed=full&scenario=${name}#inbox`);
      const found = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
      assert.ok(found, `scenario ${name} printed nothing: ${dom.slice(-500)}`);
      const r = JSON.parse(
        found[1]
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
      );
      assert.ok(!("error" in r), JSON.stringify(r));
      if (name === "reject") {
        const [op, p, change] = r.write;
        assert.deepEqual([op, p, change.status], ["update", "findings/r1-1", "rejected"]);
        assert.equal(change.human.reason, "stale");
        assert.equal(change.human.blind, true);
        assert.match(r.toast, /Undo/);
      } else if (name === "undo") {
        assert.deepEqual(r, { status: "escalated", human: null });
      } else if (name === "leave_open") {
        assert.equal(r.status, "escalated");
        assert.deepEqual(Object.keys(r.left_open).sort(), ["at", "note", "revisit"]);
      } else if (name === "in_place") {
        assert.deepEqual(r, { same: true, value: "half typed", focused: true, added: true });
      } else {
        assert.equal(r.status, "committed");
        assert.match(r.toast, /can't be undone/);
      }
    });
  }
});
