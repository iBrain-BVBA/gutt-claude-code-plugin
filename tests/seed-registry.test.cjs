#!/usr/bin/env node
/**
 * Tests for seed-registry.cjs — agent seed scanning, parsing, and matching.
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: node --test tests/seed-registry.test.cjs
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const CFO_ANALYST_SEED = `# cfo-analyst

**Type**: capability

## Grounding Protocol

1. \`search_memory_nodes(query="revenue costs margins", group_id="gutt_pro_v1")\`
2. \`search_memory_facts(query="financial analysis", group_id="gutt_pro_v1")\`
3. \`fetch_lessons_learned(group_id="gutt_pro_v1")\`

## Learning Protocol

### Outcomes
- **name**: "CFO Analyst: outcome for [task]"
- **episode_body**: "result summary"

### Surprises
- **name**: "CFO Analyst: surprise in [task]"
- **episode_body**: "unexpected finding"

## Trust Protocol

Standard trust.
`;

const CONTACT_POAB_SEED = `# contact:poab

**Type**: relationship

## Grounding Protocol

1. \`search_memory_nodes(query="poab contact history", group_id="gutt_pro_v1")\`

## Learning Protocol

### Outcomes
- **name**: "Contact POAB: outcome for [task]"

### Surprises
- **name**: "Contact POAB: surprise in [task]"
`;

// ---------------------------------------------------------------------------
// Temp directory setup & module loading helpers
// ---------------------------------------------------------------------------

let tmpDir;
let agentsDir;
let getAgentSeed;
let scanSeeds;
let clearSeedCache;

/**
 * Bust the require cache for all hooks/lib modules so they re-read env vars.
 */
function bustRequireCache() {
  const libDir = path.join(__dirname, "..", "gutt-core", "hooks", "lib");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir)) {
      delete require.cache[key];
    }
  }
}

before(() => {
  // Create a temp project directory with agents/ subfolder
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-reg-test-"));
  agentsDir = path.join(tmpDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  // Write fixture seed files
  fs.writeFileSync(path.join(agentsDir, "cfo-analyst.md"), CFO_ANALYST_SEED);
  fs.writeFileSync(path.join(agentsDir, "contact-poab.md"), CONTACT_POAB_SEED);

  // Point env.cjs at our temp directory BEFORE requiring any lib modules
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  delete process.env.CURSOR_PROJECT_DIR;

  // Bust any previously-cached requires so env.cjs picks up the new env var
  bustRequireCache();

  // Now require the module under test
  const registry = require("../gutt-core/hooks/lib/seed-registry.cjs");
  getAgentSeed = registry.getAgentSeed;
  scanSeeds = registry.scanSeeds;
  clearSeedCache = registry.clearSeedCache;

  // Clear any stale disk cache so every test starts fresh
  clearSeedCache();
});

after(() => {
  // Restore env and clean up temp dir
  delete process.env.CLAUDE_PROJECT_DIR;
  bustRequireCache();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. parseSeedFile (tested via scanSeeds)
// ---------------------------------------------------------------------------

describe("parseSeedFile (via scanSeeds)", () => {
  it("parses a well-formed seed file with all sections", () => {
    clearSeedCache();
    const reg = scanSeeds();
    const seed = reg["cfo-analyst"];

    assert.ok(seed, "cfo-analyst should be in the registry");
    assert.equal(seed.name, "cfo-analyst");
    assert.equal(seed.type, "capability");
    assert.ok(seed.groundingQueries.length > 0, "should have grounding queries");
    assert.ok(seed.learningProtocol, "should have learning protocol");
  });

  it("extracts grounding queries correctly (tool + query, no group_id)", () => {
    clearSeedCache();
    const reg = scanSeeds();
    const queries = reg["cfo-analyst"].groundingQueries;

    assert.equal(queries.length, 3);

    assert.equal(queries[0].tool, "search_memory_nodes");
    assert.equal(queries[0].query, "revenue costs margins");

    assert.equal(queries[1].tool, "search_memory_facts");
    assert.equal(queries[1].query, "financial analysis");

    assert.equal(queries[2].tool, "fetch_lessons_learned");
    assert.equal(queries[2].query, null);

    // group_id must never appear in the parsed output
    for (const q of queries) {
      assert.ok(!("group_id" in q), "group_id must not be stored in grounding queries");
    }
  });

  it("extracts learning protocol outcome/surprise name templates", () => {
    clearSeedCache();
    const reg = scanSeeds();
    const lp = reg["cfo-analyst"].learningProtocol;

    assert.equal(lp.outcomeName, "CFO Analyst: outcome for [task]");
    assert.equal(lp.surpriseName, "CFO Analyst: surprise in [task]");
  });

  it("learning protocol regex respects ### subsection boundaries", () => {
    // The bug: a lazy regex could leak from Outcomes into Surprises,
    // returning the surprise name as the outcome name.
    clearSeedCache();
    const reg = scanSeeds();
    const lp = reg["cfo-analyst"].learningProtocol;

    // Outcome name must NOT contain "surprise"
    assert.ok(
      !lp.outcomeName.toLowerCase().includes("surprise"),
      "Outcome name must not leak into Surprises section"
    );
    // Surprise name must NOT contain "outcome"
    assert.ok(
      !lp.surpriseName.toLowerCase().includes("outcome"),
      "Surprise name must not leak into Outcomes section"
    );
  });
});

// ---------------------------------------------------------------------------
// 2. getAgentSeed matching
// ---------------------------------------------------------------------------

describe("getAgentSeed matching", () => {
  before(() => {
    clearSeedCache();
  });

  it("exact match: 'cfo-analyst' finds seed named cfo-analyst", () => {
    const seed = getAgentSeed("cfo-analyst");
    assert.ok(seed);
    assert.equal(seed.name, "cfo-analyst");
  });

  it("case insensitive: 'CFO-Analyst' finds cfo-analyst", () => {
    const seed = getAgentSeed("CFO-Analyst");
    assert.ok(seed);
    assert.equal(seed.name, "cfo-analyst");
  });

  it("plugin prefix stripping: 'gutt-claude-code-plugin:cfo-analyst' finds cfo-analyst", () => {
    const seed = getAgentSeed("gutt-claude-code-plugin:cfo-analyst");
    assert.ok(seed);
    assert.equal(seed.name, "cfo-analyst");
  });

  it("multi-colon prefix: 'plugin:contact:poab' finds contact:poab (indexOf fix)", () => {
    const seed = getAgentSeed("plugin:contact:poab");
    assert.ok(seed, "should find contact:poab via first-colon stripping");
    assert.equal(seed.name, "contact:poab");
  });

  it("hyphen-to-colon: 'contact-poab' finds contact:poab", () => {
    const seed = getAgentSeed("contact-poab");
    assert.ok(seed, "should find contact:poab via hyphen-to-colon conversion");
    assert.equal(seed.name, "contact:poab");
  });

  it("returns null for unknown agents", () => {
    const seed = getAgentSeed("nonexistent-agent");
    assert.equal(seed, null);
  });

  it("returns null for empty/null input", () => {
    assert.equal(getAgentSeed(null), null);
    assert.equal(getAgentSeed(""), null);
    assert.equal(getAgentSeed(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// 3. constants.cjs
// ---------------------------------------------------------------------------

describe("constants.cjs exports", () => {
  let constants;

  before(() => {
    constants = require("../gutt-core/hooks/lib/constants.cjs");
  });

  it("MEMORY_AGENTS is a non-empty array of strings", () => {
    assert.ok(Array.isArray(constants.MEMORY_AGENTS));
    assert.ok(constants.MEMORY_AGENTS.length > 0);
    for (const a of constants.MEMORY_AGENTS) {
      assert.equal(typeof a, "string");
    }
  });

  it("LESSON_SKIP_AGENTS is a non-empty array of strings", () => {
    assert.ok(Array.isArray(constants.LESSON_SKIP_AGENTS));
    assert.ok(constants.LESSON_SKIP_AGENTS.length > 0);
    for (const a of constants.LESSON_SKIP_AGENTS) {
      assert.equal(typeof a, "string");
    }
  });

  it("PLAN_AGENT_TYPES is a Set", () => {
    assert.ok(constants.PLAN_AGENT_TYPES instanceof Set);
    assert.ok(constants.PLAN_AGENT_TYPES.size > 0);
  });
});
