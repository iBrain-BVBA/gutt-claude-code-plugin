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

const { describe, it, after } = require("node:test");
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

  for (const skill of [
    "vault-curate",
    "vault-commit",
    "vault-brief",
    "vault-steer",
    "vault-routines",
  ]) {
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

  it("skill descriptions have no angle brackets (claude.ai strips them and flags a sync warning)", () => {
    const hits = [];
    for (const dir of fs.readdirSync(SKILLS)) {
      const file = path.join(SKILLS, dir, "SKILL.md");
      if (!fs.existsSync(file)) {
        continue;
      }
      const desc = read(file).match(/^description:\s*(.*)$/m);
      if (desc && /[<>]/.test(desc[1])) {
        hits.push(dir);
      }
    }
    assert.deepEqual(hits, []);
  });

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
  "get_node_edges",
  "list_writable_groups",
]);
// The reviewer reads by id only: a get_episodes list of the vault group runs to 80k-500k
// characters, saved to a file it has no shell to slice (12 and 24 Nov 2026: no charter, no
// precedent ids).
const REVIEWER_WITHOUT = new Set(["get_episodes"]);
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
      .flatMap((p) => [...READ_TOOLS].filter((t) => !REVIEWER_WITHOUT.has(t)).map((t) => p + t))
      .filter((t) => !tools.has(t));
    assert.deepEqual(missing, []);
  });

  it("has no whole-group episode list, and the rules never send it to one", () => {
    const listed = reviewerTools().filter((t) =>
      [...REVIEWER_WITHOUT].some((w) => t.endsWith("__" + w))
    );
    assert.deepEqual(listed, []);
    const skill = read(path.join(SKILLS, "vault-review", "SKILL.md"));
    const precedents = read(
      path.join(SKILLS, "vault-review", "references", "precedent-matching.md")
    );
    for (const [name, text] of [
      ["vault-review/SKILL.md", skill],
      ["precedent-matching.md", precedents],
    ]) {
      // Each mention of get_episodes( must be a rule against it, never a step that calls it.
      for (const m of text.matchAll(/[^\n]*`get_episodes(?:\([^`]*)?`[^\n]*/g)) {
        assert.match(
          m[0],
          /\bNo\b|never|n't/i,
          `${name} sends the reviewer to get_episodes: ${m[0]}`
        );
      }
    }
    assert.match(skill, /one `get_episode` per id/);
    assert.match(skill, /no `charter:` line/);
  });

  it("finds a Verdict's episode uuid through its own DECIDES edge, not a centred search", () => {
    const text = read(path.join(SKILLS, "vault-review", "references", "precedent-matching.md"));
    const steps = text.match(/## Finding the Verdict episodes([\s\S]*?)\n## /);
    assert.ok(steps, "precedent-matching.md lost §Finding the Verdict episodes");
    assert.match(steps[1], /get_node_edges\(node_id=<Verdict node id>, edge_type="DECIDES"\)/);
    assert.match(steps[1], /`get_episode\(<uuid>\)`/);
    // A centred search appears only as the thing not to do.
    for (const m of text.matchAll(/[^\n]*center_node_id[^\n]*/g)) {
      assert.match(m[0], /Never/, `a centred search is back as a step: ${m[0]}`);
    }
    assert.match(text, /group_ids=\["vault_<slug>"\]/);
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

  it("covers every connector a vault file or eval names, in at least one prefix form", () => {
    // The plugin ships no vault files (they live in the owner's repo), so the evals' vault
    // files stand in for them; any vault file added later is checked too. A memory_connector
    // whose prefixes are all off the list makes every curate run of that vault escalate everything.
    const prefixes = new Set(knownPrefixes());
    const named = [];
    for (const file of walk(PLUGIN, (f) => /[\\/]vaults[\\/][^\\/]+\.json$/.test(f))) {
      const c = JSON.parse(read(file)).memory_connector;
      for (const name of [].concat(c || [])) {
        named.push([relp(file), name]);
      }
    }
    for (const file of walk(SKILLS, (f) => f.endsWith("evals.json"))) {
      for (const m of read(file).matchAll(/memory_connector: ([\w-]+)/g)) {
        named.push([relp(file), m[1]]);
      }
    }
    assert.ok(named.length > 0, "no eval names a memory_connector any more");
    for (const [where, connector] of named) {
      const forms = [
        `mcp__claude_ai_${connector}__`,
        `mcp__${connector}__`,
        `mcp__plugin_gutt-pro_${connector}__`,
      ];
      assert.ok(
        forms.some((f) => prefixes.has(f)),
        `${where}: add ${connector}'s read tools to the reviewer's allowlist`
      );
    }
  });

  it("is checked before the spawn, and every fail-closed row carries prediction null", () => {
    const curate = read(path.join(SKILLS, "vault-curate", "SKILL.md"));
    const skill = read(path.join(SKILLS, "vault-review", "SKILL.md"));
    assert.match(
      curate,
      /\*\*Before spawning\*\*, check `memory_server` against the known prefixes/
    );
    assert.ok(curate.includes("`review.prediction: null`"));
    assert.ok(curate.includes("Always send `config:` and `stage_by_class:`"));
    assert.ok(curate.includes("Always send `charter:` too"));
    assert.match(curate, /\ncharter: <JSON array of episode ids/);
    for (const reason of [
      "no memory_server passed by vault-curate",
      "memory server not in reviewer allowlist: <prefix>",
      "memory unavailable: <prefix>",
    ]) {
      assert.ok(skill.includes(reason), `vault-review Step 1.0 lost the reason ${reason}`);
    }
    assert.match(skill, /`prediction: null`,\s+`confidence: null`/);
  });

  it("returns reviewer deltas with previous_episodes, and curate checks their provenance", () => {
    const skill = read(path.join(SKILLS, "vault-review", "SKILL.md"));
    const contract = skill.match(/## Output contract\s+[\s\S]*?```json([\s\S]*?)```/);
    assert.ok(contract, "vault-review lost its output contract");
    assert.match(contract[1], /"previous_episodes"/);
    const curate = read(path.join(SKILLS, "vault-curate", "SKILL.md"));
    for (const check of [
      "with `get_episode`",
      "its `group_id` is `vault_<slug>`",
      "`source_description` starts with `vault-reviewer`",
      "`Refines '<predecessor name>'`",
      "`source_description` = `<agent_id>, <run_id>`",
    ]) {
      assert.ok(curate.includes(check), `vault-curate Step 5 lost: ${check}`);
    }
  });
});

describe("finding the vault's memory server", () => {
  const flat = (t) => t.replace(/\s+/g, " ");

  it("no rule makes list_writable_groups the only confirmation", () => {
    // A vault on a server that starts groups on the first write (the shared gutt stage) is
    // named by the vault file's memory_connector and never appears in list_writable_groups.
    const hits = [];
    for (const file of ruleFiles()) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (/confirm the group exists in `list_writable_groups`/i.test(line)) {
            hits.push(`${relp(file)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    assert.deepEqual(hits, []);
    const tools = flat(read(MEMORY_TOOLS));
    assert.ok(tools.includes("Don't require `vault_<slug>` in its `list_writable_groups`"));
    for (const form of [
      "`mcp__claude_ai_<connector>__`",
      "`mcp__<connector>__`",
      "`mcp__plugin_gutt-pro_<connector>__`",
    ]) {
      assert.ok(tools.includes(form), `memory-tools.md step 2 lost ${form}`);
    }
    assert.ok(read(CONFIG_REF).includes("`memory_connector` is optional"));
  });

  it("an empty group on the named connector stops every workflow but a new vault's charter", () => {
    const tools = flat(read(MEMORY_TOOLS));
    assert.ok(
      tools.includes(
        "The read returning nothing is **None** below, for every workflow but one: vault-steer `--charter` for a new vault"
      )
    );
    assert.ok(!tools.includes("no episode is fine"));
    for (const skill of ["vault-curate", "vault-commit", "vault-brief"]) {
      const text = flat(read(path.join(SKILLS, skill, "SKILL.md")));
      assert.ok(
        text.includes("`vault_<slug> not writable on any memory server: <prefixes seen>`"),
        `${skill} Degradation lost the no-server report`
      );
      assert.match(text, /holds? no episode of the vault|must hold an episode of the vault/);
    }
  });

  it("vault-steer keeps both paths for a group that doesn't exist yet", () => {
    const steer = flat(read(path.join(SKILLS, "vault-steer", "SKILL.md")));
    assert.ok(steer.includes("**`memory_connector` set:**"));
    assert.ok(steer.includes("**Not set:**"));
    assert.ok(steer.includes("the group needs a gutt admin to create it"));
    assert.ok(steer.includes("must be created on, or granted to them on, the server"));
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

  // A merge that keeps both sides of a block leaves two definitions; the later one silently wins.
  it("defines each function once", () => {
    // Same name at the same indent is the same scope here; a nested helper may reuse a name.
    const counts = {};
    for (const m of read(CONSOLE).matchAll(
      /^( *)(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm
    )) {
      const k = `${m[2]} (indent ${m[1].length})`;
      counts[k] = (counts[k] || 0) + 1;
    }
    assert.deepEqual(
      Object.keys(counts).filter((k) => counts[k] > 1),
      []
    );
  });
});

// ── the Console's logic, in node against a stub DOM and a fake db ───────────────

const CONSOLE_HARNESS = String.raw`
const fs = require("fs");
const [scriptPath, fieldsPath, labelsPath, scenarioPath] = process.argv.slice(2);
const _st = setTimeout;
global.setTimeout = (f, ms) => { const t = _st(f, Math.min(ms || 0, 5)); if (t.unref) t.unref(); return t; };
global.setInterval = () => 0;
function fake() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined;
      if (prop in target) return target[prop];
      return proxy;
    },
    set(target, prop, value) { target[prop] = value; return true; },
    apply() { return proxy; },
  });
  return proxy;
}
const blocks = { "config-fields": fs.readFileSync(fieldsPath, "utf8"), "console-labels": fs.readFileSync(labelsPath, "utf8") };
global.document = {
  getElementById(id) { return id in blocks ? { textContent: blocks[id] } : fake(); },
  createElement() { return fake(); },
  createTextNode() { return fake(); },
  activeElement: null,
  addEventListener() {},
};
global.location = { hash: "" };
let api = null;
global.window = { addEventListener() {}, scrollTo() {}, __vaultConsoleTest(x) { api = x; } };
const realError = console.error;
console.error = () => {};
console.warn = () => {};
new Function(fs.readFileSync(scriptPath, "utf8"))();
const scenario = require(scenarioPath);
Promise.resolve(scenario(api)).then(
  (out) => { process.stdout.write(JSON.stringify(out === undefined ? null : out)); },
  (err) => { realError(err); process.exit(1); }
);
`;

let consoleDir = null;
let scenarioCount = 0;
/** Runs `scenario` (a module exporting `(api) => result`) against the Console's script in a fresh node. */
function runConsole(scenario) {
  if (!consoleDir) {
    consoleDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-console-"));
    const html = read(CONSOLE);
    const block = (id) =>
      html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`))[1];
    fs.writeFileSync(path.join(consoleDir, "fields.json"), block("config-fields"));
    fs.writeFileSync(path.join(consoleDir, "labels.json"), block("console-labels"));
    fs.writeFileSync(path.join(consoleDir, "console.js"), consoleScript());
    fs.writeFileSync(path.join(consoleDir, "harness.js"), CONSOLE_HARNESS);
  }
  const file = path.join(consoleDir, `scenario${scenarioCount++}.js`);
  fs.writeFileSync(file, scenario);
  const out = spawnSync(
    process.execPath,
    ["harness.js", "console.js", "fields.json", "labels.json", file].map((f) =>
      path.resolve(consoleDir, f)
    ),
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

const TICKS = `const ticks = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };`;

const FAKE_SETTINGS_DB = String.raw`
${TICKS}
function makeDb(opts) {
  const docs = Object.assign({}, opts.docs || {}), calls = [];
  let failCfgSet = opts.failCfgSet || 0, acquires = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + (opts.slowWrite && calls.includes("set " + opts.slowWrite) ? 31000 : 0);
  const doc = (path) => ({
    acquire: opts.noLease ? undefined : (a) => {
      calls.push("acquire " + path + " " + a.holder.slice(0, 5)); holders.add(a.holder); acquires++;
      return Promise.resolve({ acquired: !(opts.busy || (opts.renewBusy && acquires > 1)) });
    },
    get: () => { calls.push("get " + path); const d = docs[path]; return Promise.resolve({ exists: d !== undefined, data: () => d }); },
    set: (v) => {
      calls.push("set " + path);
      if (path === "meta/config" && failCfgSet) {
        failCfgSet--;
        if (opts.landAnyway) docs[path] = v;
        const e = new Error("write failed"); e.code = opts.failCode || "unavailable"; return Promise.reject(e);
      }
      docs[path] = v; return Promise.resolve();
    },
    delete: () => { calls.push("delete " + path); delete docs[path]; return Promise.resolve(); },
  });
  const holders = new Set();
  return { doc, calls, docs, holders };
}
async function save(api, opts) {
  const db = makeDb(opts);
  api.S.db = db; api.S.me = "viewer-1"; api.S.readOnly = false; api.S.busy = {};
  api.S.cfgDraft = { "run.pending_cap": "20" };
  api.saveSettings();
  // The harness's timers are unref'd, so wait on setImmediate, bounded by the clock.
  const t0 = performance.now();
  while (api.S.busy.settings && performance.now() - t0 < 2000) await ticks(1);
  await ticks(20);
  return {
    calls: db.calls, config: db.docs["meta/config"] || null, holders: [...db.holders],
    log: Object.keys(db.docs).filter((k) => k.startsWith("config_changes/")),
    draftCleared: !("run.pending_cap" in api.S.cfgDraft),
  };
}
`;

after(() => {
  if (consoleDir) {
    fs.rmSync(consoleDir, { recursive: true, force: true });
  }
});

const saveWith = (opts) =>
  runConsole(FAKE_SETTINGS_DB + `module.exports = (api) => save(api, ${JSON.stringify(opts)});`);
const sets = (calls) => calls.filter((c) => c.startsWith("set "));

describe("the Console's Settings save", () => {
  it("opens Settings only when user.canEdit() resolved true", () => {
    const out = runConsole(`module.exports = (api) => {
      api.S.db = {}; api.S.readOnly = false;
      return [null, undefined, false, "yes", true].map((v) => { api.S.canAdmin = v; return api.canSettings(); });
    };`);
    assert.deepEqual(out, [false, false, false, false, true]);
  });

  it("takes the lease as this page load, renews it before each write, then writes the log and the config", () => {
    const out = saveWith({});
    assert.deepEqual(out.calls, [
      "acquire meta/config_lock page-",
      "get meta/config",
      "get config_changes/v1",
      "acquire meta/config_lock page-",
      "set config_changes/v1",
      "acquire meta/config_lock page-",
      "set meta/config",
    ]);
    assert.equal(out.holders.length, 1, "one holder for the page load");
    assert.notEqual(out.holders[0], "viewer-1", "the holder is the page load, not the viewer");
    assert.equal(out.config.config_version, 1);
    assert.deepEqual(out.config.values, { "run.pending_cap": 20 });
    assert.deepEqual(out.log, ["config_changes/v1"]);
    assert.ok(out.draftCleared);
  });

  it("refuses when the version moved, the lease is busy, or the runtime has no lease", () => {
    for (const opts of [
      { docs: { "meta/config": { config_version: 3, values: {} } } },
      { busy: true },
      { noLease: true },
    ]) {
      const out = saveWith(opts);
      assert.deepEqual(sets(out.calls), [], JSON.stringify(opts));
      assert.ok(!out.draftCleared, JSON.stringify(opts));
    }
  });

  it("replaces a leftover log row from a save that never landed", () => {
    const out = saveWith({ docs: { "config_changes/v1": { version: 1, changes: [] } } });
    assert.equal(out.config.config_version, 1);
    assert.deepEqual(out.log, ["config_changes/v1"]);
  });

  it("rolls the log row back only when meta/config didn't land", () => {
    const failed = saveWith({ failCfgSet: 1, failCode: "internal" });
    assert.ok(failed.calls.includes("delete config_changes/v1"));
    assert.equal(failed.config, null);
    assert.deepEqual(failed.log, []);
    assert.ok(!failed.draftCleared);

    const landed = saveWith({ failCfgSet: 1, failCode: "internal", landAnyway: true });
    assert.ok(!landed.calls.includes("delete config_changes/v1"));
    assert.equal(landed.config.config_version, 1);
    assert.deepEqual(landed.log, ["config_changes/v1"]);
    assert.ok(landed.draftCleared);
  });

  it("a retry after `unavailable` finishes the save once", () => {
    const out = saveWith({ failCfgSet: 1 });
    assert.equal(out.config.config_version, 1);
    assert.deepEqual(out.log, ["config_changes/v1"]);
    assert.ok(out.draftCleared);
  });

  it("stops, sending nothing more, when a write settles after the lease could have lapsed", () => {
    const lateLog = saveWith({ slowWrite: "config_changes/v1" });
    assert.equal(lateLog.calls.at(-1), "set config_changes/v1");
    assert.equal(lateLog.config, null);
    assert.ok(!lateLog.draftCleared);

    const lateConfig = saveWith({ slowWrite: "meta/config" });
    assert.equal(lateConfig.calls.at(-1), "set meta/config");
    assert.ok(!lateConfig.draftCleared, "a late config write is never reported saved");
  });

  it("sends no write when a renewal is refused", () => {
    const out = saveWith({ renewBusy: true });
    assert.deepEqual(sets(out.calls), []);
    assert.ok(!out.draftCleared);
  });
});

describe("the Console's Reviewer numbers", () => {
  it("a class's latest override includes overrides of auto calls made after the Calibration", () => {
    const out = runConsole(`module.exports = (api) => {
      const row = (id, cls, decision, human, at) => ({ id, review: { "class": cls, decision }, human: { decision: human, at } });
      api.S.findings = [
        row("a", "finding/x", "auto_approve", "rejected", "2026-11-20T10:00:00Z"),
        row("b", "finding/x", "auto_approve", "approved", "2026-11-22T10:00:00Z"),
        row("c", "finding/x", "escalate", "rejected", "2026-11-23T10:00:00Z"),
        row("d", "finding/y", "auto_reject", "approved", "2026-11-21T10:00:00Z"),
      ];
      const iso = (t) => (t ? new Date(t).toISOString() : null);
      return {
        newer: iso(api.lastOverride("finding/x", { last_override: "2026-11-01" })),
        older: iso(api.lastOverride("finding/y", { last_override: "2026-11-22T00:00:00Z" })),
        none: api.lastOverride("finding/z", { last_override: "none" }),
      };
    };`);
    // Confirmations and escalations don't count; a later override of an auto call wins.
    assert.equal(out.newer, "2026-11-20T10:00:00.000Z");
    assert.equal(out.older, "2026-11-22T00:00:00.000Z");
    assert.equal(out.none, 0);
  });

  it("counts live calls after counted_through, or after the Calibration's time without it", () => {
    const out = runConsole(`module.exports = (api) => {
      const row = (id, at) => ({ id, review: { "class": "finding/x", decision: "escalate", prediction: "approve" }, human: { decision: "approved", at } });
      api.S.findings = [row("before", "2026-11-17T10:00:00Z"), row("between", "2026-11-19T10:00:00Z"), row("after", "2026-11-21T10:00:00Z")];
      api.S.reviewer = { at: "2026-11-20T00:00:00Z", counted_through: "2026-11-18T00:00:00Z" };
      const watermark = api.liveSince("finding/x");
      api.S.reviewer = { at: "2026-11-20T00:00:00Z" };
      const fallback = api.liveSince("finding/x");
      return { watermark, fallback };
    };`);
    assert.deepEqual(out.watermark, { calls: 2, agree: 2 });
    assert.deepEqual(out.fallback, { calls: 1, agree: 1 });
  });

  it("flags a Calibration whose agree isn't a whole count instead of guessing", () => {
    const out = runConsole(`module.exports = (api) => [
      api.dirStats({ n: 10, agree: 9 }, "finding/x"),
      api.dirStats({ n: 10, agree: 0.9 }, "finding/x"),
      api.dirStats({ n: 10, agree: "many" }, "finding/x"),
    ];`);
    assert.deepEqual(out[0], { n: 10, k: 9, share: 0.9 });
    assert.equal(out[1].bad, true);
    assert.equal(out[2].bad, true);
  });

  it("lists what each allowed direction needs and then the cap, and names malformed data", () => {
    const out = runConsole(`module.exports = (api) => {
      api.S.config = {
        values: { "ladder.ceiling": 3, "ladder.stage1_calls": 10, "ladder.stage1_agreement": 0.9,
          "ladder.stage2_approve_calls": 20, "ladder.stage2_agreement": 0.9 },
        class_ceilings: { "finding/capped1": 1, "finding/shadow": 0, "finding/capped2": 2 },
      };
      api.S.reviewer = { at: "2026-11-20T00:00:00Z", stage_by_class: {
        "finding/capped1": { stage: 0, reject: { n: 4, agree: 4 }, approve: { n: 2, agree: 2 } },
        "finding/shadow": { stage: 0, reject: { n: 4, agree: 4 } },
        "finding/capped2": { stage: 2, auto_reject: true, auto_approve: true, approve: { n: 30, agree: 29 } },
        "finding/bad": { stage: 0, reject: { n: 12, agree: 0.95 }, approve: { n: 25, agree: "many" } },
      } };
      const w = (c) => api.classStatus(c).wait;
      return { capped1: w("finding/capped1"), shadow: w("finding/shadow"), capped2: w("finding/capped2"), bad: w("finding/bad") };
    };`);
    assert.deepEqual(out.capped1, ["6 more reject predictions", "Capped at stage 1 in Settings"]);
    assert.deepEqual(out.shadow, ["Held in shadow in Settings"]);
    assert.deepEqual(out.capped2, ["Capped at stage 2 in Settings"]);
    // A malformed count is never read as an accuracy shortfall, and is named once.
    assert.deepEqual(out.bad, ["Calibration data malformed"]);
  });

  it("reads each row's class off its type and beat, so old feature keys add no classes", () => {
    const out = runConsole(`module.exports = (api) => {
      const row = (id, type, beat, cls) => ({ id, type, beat, review: { "class": cls, decision: "escalate", prediction: "approve" } });
      api.S.findings = [
        row("a", "finding", "pricing", "finding|pricing|pricing|zendesk.com|3"),
        row("b", "finding", "pricing", "finding+pricing+pricing+lindy.ai+sig3"),
        row("c", "finding", "failures", "finding/failures/failure/legal500.com/sig1-2"),
        row("d", "card_update", "outcomes", "card_update|outcomes|card_update|arxiv.org|5"),
        row("e", "card_update", "pricing", "card_update/pricing"),
        row("f", "reverify", "outcomes", "reverify+outcomes+outcome+arxiv.org+sig4"),
        row("g", undefined, undefined, "finding/x"),
        row("h", undefined, undefined, "finding|launches|launch|convoso.com|3"),
      ];
      api.S.reviewer = { at: "2026-11-22T00:00:00Z", stage_by_class: { "finding/pricing": { stage: 0 } } };
      return { each: api.S.findings.map(api.rowClass), classes: api.reviewerClasses() };
    };`);
    assert.deepEqual(out.each, [
      "finding/pricing",
      "finding/pricing",
      "finding/failures",
      "card_update",
      "card_update",
      "reverify",
      "finding/x",
      "finding/launches",
    ]);
    for (const k of out.classes) {
      assert.match(k, /^(finding\/[^/|+\s]+|card_update|reverify)$/, k);
    }
    assert.ok(out.classes.includes("finding/failures") && out.classes.includes("card_update"));
  });

  it("waits for the next Calibration when the last one has no reject and approve split", () => {
    const out = runConsole(`module.exports = (api) => {
      api.S.config = { values: { "ladder.ceiling": 3, "ladder.stage1_calls": 10, "ladder.stage2_approve_calls": 20 }, class_ceilings: {} };
      api.S.reviewer = { at: "2026-11-22T00:00:00Z", stage_by_class: {
        "finding/prerequisites": { stage: 0, predictions: 27, agreement: 0.63 },
        "finding/pricing": { stage: 0, predictions: 14, agreement: 0.86, reject: { n: 4, agree: 4 } },
      } };
      const s = (c) => { const x = api.classStatus(c); return { wait: x.wait, nosplit: x.nosplit }; };
      return { total: s("finding/prerequisites"), split: s("finding/pricing") };
    };`);
    assert.deepEqual(out.total, {
      wait: ["The next calibration's reject and approve counts"],
      nosplit: true,
    });
    assert.equal(out.split.nosplit, false);
    assert.equal(out.split.wait[0], "6 more reject predictions");
  });
});

describe("the Console's Inbox writes", () => {
  const FAKE_ROWS_DB = String.raw`
${TICKS}
function rowsDb(docs, failCode) {
  const calls = [], gates = [];
  const doc = (path) => ({
    get: () => Promise.resolve({ exists: path in docs, data: () => docs[path] }),
    update: (change) => {
      calls.push({ path, change });
      if (failCode) { const e = new Error("write failed"); e.code = failCode; return Promise.reject(e); }
      return new Promise((resolve) => gates.push(() => { Object.assign(docs[path] || {}, change); resolve(); }));
    },
  });
  return { doc, calls, open: () => { while (gates.length) gates.shift()(); } };
}
`;

  it("calls a row blind only when there was a prediction, and reveals it only once the write landed", () => {
    const out = runConsole(
      FAKE_ROWS_DB +
        `module.exports = async (api) => {
      const blindRow = { id: "r1", type: "finding", status: "escalated", review: { "class": "finding/x", decision: "escalate", prediction: "approve", confidence: 0.8, stage: 0 } };
      const bare = { id: "r2", type: "finding", status: "escalated", review: { "class": "finding/x", decision: "escalate", stage: 0 } };
      const db = rowsDb({ "findings/r1": Object.assign({}, blindRow), "findings/r2": Object.assign({}, bare) });
      api.S.db = db; api.S.readOnly = false;
      api.decide(blindRow, "approved");
      await ticks(2);
      const pending = api.S.done.r1.text;
      db.open(); await ticks(10);
      const landed = api.S.done.r1.text;
      api.decide(bare, "approved"); await ticks(2); db.open(); await ticks(10);
      return { pending, landed, blindChange: db.calls[0].change, bareChange: db.calls[1].change };
    };`
    );
    assert.equal(out.pending, "Approved.");
    assert.match(out.landed, /^Approved\. The reviewer predicted approve at 80%: you agreed\.$/);
    assert.equal(out.blindChange.human.blind, true);
    assert.equal(out.blindChange.revealed, true);
    assert.equal(out.bareChange.human.blind, false);
    assert.ok(!("revealed" in out.bareChange));
  });

  it("deciding a left-open conflict clears left_open, and undo puts it back", () => {
    const out = runConsole(
      FAKE_ROWS_DB +
        `module.exports = async (api) => {
      const lo = { revisit: "2099-01-01", note: "", at: "2026-11-01T00:00:00Z" };
      const row = { id: "c1", type: "conflict", status: "escalated", left_open: lo, review: { decision: "escalate", prediction: "approve" } };
      const db = rowsDb({ "findings/c1": Object.assign({}, row) });
      api.S.db = db; api.S.readOnly = false;
      api.decide(row, "approved", { resolution: "a", msg: "Resolved: A stands." });
      await ticks(2); db.open(); await ticks(10);
      api.undoDone("c1"); await ticks(5); db.open(); await ticks(10);
      return db.calls.map((c) => c.change);
    };`
    );
    assert.equal(out[0].left_open, null);
    assert.deepEqual(out[1].left_open, {
      revisit: "2099-01-01",
      note: "",
      at: "2026-11-01T00:00:00Z",
    });
    assert.ok(!("revealed" in out[1]), "undo leaves revealed set");
  });

  it("a failed decision brings back the typed note, open sections and revisit date", () => {
    const out = runConsole(
      FAKE_ROWS_DB +
        `module.exports = async (api) => {
      const row = { id: "f1", type: "conflict", status: "escalated", review: { decision: "escalate" } };
      api.S.db = rowsDb({ "findings/f1": Object.assign({}, row) }, "internal");
      api.S.readOnly = false; api.S.busy = {};
      api.S.drafts["note-f1"] = "typed"; api.S.drafts["revisit-f1"] = "2099-01-01";
      api.S.ui.f1 = { note: true, open: true };
      api.decide(row, "approved", { resolution: "a", msg: "Resolved: A stands." });
      const cleared = !("note-f1" in api.S.drafts) && !api.S.ui.f1;
      await ticks(10);
      return { cleared, drafts: api.S.drafts, ui: api.S.ui.f1, done: "f1" in api.S.done };
    };`
    );
    assert.equal(out.cleared, true, "the card's drafts clear while the write is in flight");
    assert.equal(out.drafts["note-f1"], "typed");
    assert.equal(out.drafts["revisit-f1"], "2099-01-01");
    assert.deepEqual(out.ui, { note: true, open: true });
    assert.equal(out.done, false);
  });

  it("sorts parked conflicts last, and undo returns each card to where it was", () => {
    const out = runConsole(
      FAKE_ROWS_DB +
        `module.exports = async (api) => {
      const lo = { revisit: "2099-01-01", note: "", at: "2026-11-01T00:00:00Z" };
      const parked = { id: "p1", type: "conflict", status: "escalated", left_open: lo, review: { decision: "escalate" } };
      const due = { id: "d1", type: "conflict", status: "escalated", review: { decision: "escalate" } };
      const call = { id: "k1", type: "finding", status: "escalated", significance: 2, review: { "class": "finding/x", decision: "escalate" } };
      const docs = { "findings/p1": Object.assign({}, parked), "findings/d1": Object.assign({}, due), "findings/k1": Object.assign({}, call) };
      const db = rowsDb(docs);
      api.S.db = db; api.S.readOnly = false; api.S.busy = {};
      api.S.findings = [docs["findings/p1"], docs["findings/d1"], docs["findings/k1"]];
      const view = (id) => (api.inboxItems().find((it) => it.id === id) || {}).view;
      const order = api.inboxItems().map((it) => it.id);
      // Decide the parked conflict, then undo: it goes back to parked once the undo lands.
      api.decide(docs["findings/p1"], "approved", { resolution: "a", msg: "Resolved: A stands." });
      await ticks(2); db.open(); await ticks(10);
      api.undoDone("p1"); await ticks(5);
      const parkedUndoing = view("p1");
      db.open(); await ticks(10);
      const parkedBack = view("p1");
      // Leave the due conflict open, then undo: the card stays shown as undoing, never hidden.
      api.S.drafts["revisit-d1"] = "2099-02-01";
      api.leaveOpen(docs["findings/d1"]);
      await ticks(2); db.open(); await ticks(10);
      api.undoDone("d1"); await ticks(5);
      const leftUndoing = view("d1");
      db.open(); await ticks(10);
      return { order, parkedUndoing, parkedBack, leftUndoing, leftBack: view("d1") };
    };`
    );
    assert.deepEqual(out.order, ["d1", "k1", "p1"]);
    assert.equal(out.parkedUndoing, "undoing");
    assert.equal(out.parkedBack, "parked");
    assert.equal(out.leftUndoing, "undoing");
    assert.equal(out.leftBack, "open");
  });

  it("refuses to leave a conflict open until a past date", () => {
    const out = runConsole(
      FAKE_ROWS_DB +
        `module.exports = async (api) => {
      const row = { id: "c2", type: "conflict", status: "escalated", review: { decision: "escalate" } };
      const db = rowsDb({ "findings/c2": Object.assign({}, row) });
      api.S.db = db; api.S.readOnly = false; api.S.busy = {};
      for (const d of ["2020-01-01", "not a date"]) { api.S.drafts["revisit-c2"] = d; api.leaveOpen(row); }
      await ticks(5);
      api.S.drafts["revisit-c2"] = "2099-01-01"; api.leaveOpen(row);
      await ticks(2); db.open(); await ticks(10);
      return db.calls.map((c) => c.change.left_open.revisit);
    };`
    );
    assert.deepEqual(out, ["2099-01-01"]);
  });

  it("undo refuses a row that is no longer in the Console", () => {
    const out = runConsole(
      FAKE_ROWS_DB +
        `module.exports = async (api) => {
      const row = { id: "g1", type: "finding", status: "escalated", review: { "class": "finding/x", decision: "escalate" } };
      const docs = { "findings/g1": Object.assign({}, row) };
      const db = rowsDb(docs);
      api.S.db = db; api.S.readOnly = false;
      api.decide(row, "rejected", { reason: "stale" });
      await ticks(2); db.open(); await ticks(10);
      delete docs["findings/g1"];
      api.undoDone("g1"); await ticks(10); db.open(); await ticks(10);
      return db.calls.length;
    };`
    );
    assert.equal(out, 1, "no update after the row is gone");
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
    // Every eval but the one about a missing line sends the charter ids vault-curate sends.
    const without = data.evals
      .filter((e) => !/^charter: \[/m.test(e.prompt))
      .map((e) => e.eval_name);
    assert.deepEqual(without, ["no-charter-line-escalates-without-listing-the-group"]);
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

  for (const name of [
    "reject",
    "undo",
    "leave_open",
    "leave_open_past",
    "in_place",
    "undo_after_commit",
  ]) {
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
      } else if (name === "leave_open_past") {
        assert.deepEqual([r.left_open, r.writes], [null, 0], "a past revisit date writes nothing");
        assert.match(r.toast, /from tomorrow on/);
      } else if (name === "in_place") {
        assert.deepEqual(r, { same: true, value: "half typed", focused: true, added: true });
      } else {
        assert.equal(r.status, "committed");
        assert.match(r.toast, /can't be undone/);
      }
    });
  }
});
