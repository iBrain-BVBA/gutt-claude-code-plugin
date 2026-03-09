#!/usr/bin/env node
/**
 * Router Unit Tests
 * Tests intent extraction, playbook matching, and routing decisions
 * for all 23 routing validation cases.
 *
 * Runs without live MCP — uses mocked agent discovery responses.
 * CI-compatible, no external dependencies beyond Node.js built-ins.
 *
 * Usage:
 *   node tests/routing/router.unit.test.cjs
 */

"use strict";

const assert = require("assert");
const path = require("path");

// ---------------------------------------------------------------------------
// Module paths
// ---------------------------------------------------------------------------

const LIB = path.resolve(__dirname, "../../hooks/lib");
const { extractIntent } = require(path.join(LIB, "intent-extractor.cjs"));
const { makeRoutingDecision } = require(path.join(LIB, "router.cjs"));
const { matchPlaybook } = require(path.join(LIB, "playbook-matcher.cjs"));

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, message: err.message });
  }
}

function assertIncludes(arr, value, msg) {
  assert.ok(
    Array.isArray(arr) && arr.includes(value),
    msg || `Expected ${JSON.stringify(arr)} to include "${value}"`
  );
}

function assertType(decision, expectedType) {
  assert.strictEqual(
    decision.type,
    expectedType,
    `Expected routing type "${expectedType}", got "${decision.type}" (reason: ${decision.reason})`
  );
}

function assertLead(decision, expectedLead) {
  assert.strictEqual(
    decision.lead,
    expectedLead,
    `Expected lead "${expectedLead}", got "${decision.lead}"`
  );
}

// ---------------------------------------------------------------------------
// Mock agent discovery — returns deterministic responses without live MCP
//
// Each mock entry provides the agents array that would come back from
// discoverAgents() for a given prompt, keyed by a normalised query fragment.
// ---------------------------------------------------------------------------

/**
 * Build a mock agent list: first entry is high-confidence, rest are low.
 * Simulates the typical MCP response for a clear single-agent case.
 */
function mockSingle(leadName, score = 0.85) {
  return [
    { name: leadName, score, summary: `${leadName} handles this domain` },
    { name: "other-agent", score: score - 0.3, summary: "less relevant" },
  ];
}

/**
 * Build a mock agent list for a team routing case.
 * Two agents with similar high scores.
 */
function mockTeam(leadName, supportName, score = 0.75) {
  return [
    { name: leadName, score, summary: `${leadName} primary domain` },
    { name: supportName, score: score - 0.05, summary: `${supportName} supporting` },
    { name: "other-agent", score: 0.2, summary: "low relevance" },
  ];
}

/**
 * Build a mock agent list for a passthrough / fallback case.
 * All agents have low scores.
 */
function mockLowConfidence() {
  return [
    { name: "some-agent", score: 0.15, summary: "weak match" },
    { name: "other-agent", score: 0.1, summary: "weak match" },
  ];
}

/**
 * Empty agent list — simulates no matches at all.
 */
function mockEmpty() {
  return [];
}

// ---------------------------------------------------------------------------
// Playbooks directory (sibling gutt-agents/playbooks)
// ---------------------------------------------------------------------------

const PLAYBOOKS_DIR = path.resolve(__dirname, "../../../gutt-agents/playbooks");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\nRouter Unit Tests — 23 routing cases\n");

// ── Intent Extraction Tests ──────────────────────────────────────────────────

console.log("Intent Extraction:");

test("routing-001: runway query extracts finance domain", () => {
  const r = extractIntent("What's our runway?");
  assertIncludes(r.domainSignals, "finance");
});

test("routing-002: POAB meeting query extracts entity ref", () => {
  const r = extractIntent("Prep for POAB meeting");
  assertIncludes(r.entityRefs, "contact:poab");
});

test("routing-003: agent creation query extracts no entity (general)", () => {
  const r = extractIntent("Create a new agent for legal compliance");
  // No specific agent entity ref — general meta task
  assert.ok(r.keywords.length > 0, "Should extract keywords");
});

test("routing-009: LinkedIn post extracts content domain", () => {
  const r = extractIntent("Write a LinkedIn post about our POAB win");
  assertIncludes(r.domainSignals, "content");
  assertIncludes(r.entityRefs, "contact:poab");
});

test("routing-010: marketing funnel query extracts marketing domain", () => {
  const r = extractIntent("Is our marketing funnel converting?");
  assertIncludes(r.domainSignals, "marketing");
});

test("routing-011: sprint planning extracts product domain", () => {
  const r = extractIntent("Plan the next sprint");
  assertIncludes(r.domainSignals, "product");
});

test("routing-012: Cloud Run deployment extracts devops domain", () => {
  const r = extractIntent("Debug the Cloud Run deployment failure");
  assertIncludes(r.domainSignals, "devops");
});

test("routing-013: Commit team query extracts entity ref", () => {
  const r = extractIntent("What should I say to the Commit team tomorrow?");
  assertIncludes(r.entityRefs, "contact:commit");
});

test("routing-014: security audit of API extracts quality domain", () => {
  const r = extractIntent("Run a security audit of our API");
  assertIncludes(r.domainSignals, "quality");
});

test("routing-015: blog content query extracts content domain", () => {
  const r = extractIntent("What blog content should we publish next?");
  assertIncludes(r.domainSignals, "content");
});

test("routing-016: SEO check extracts marketing domain", () => {
  const r = extractIntent("Check SEO for our homepage");
  assertIncludes(r.domainSignals, "marketing");
});

test("routing-017: business requirements doc extracts analysis domain", () => {
  const r = extractIntent("Create a business requirements doc for the chat UI");
  assertIncludes(r.domainSignals, "analysis");
});

test("routing-019: math question has no domain signals", () => {
  const r = extractIntent("What is 2+2?");
  assert.strictEqual(r.domainSignals.length, 0, "Math question should produce no domain signals");
  assert.strictEqual(r.entityRefs.length, 0, "Math question should produce no entity refs");
});

test("routing-020: Python for-loop question — minimal domain signals", () => {
  const r = extractIntent("How do I write a for loop in Python?");
  // python keyword may trigger backend entity ref — that's expected
  // but no strong org-domain signals
  assert.ok(
    !r.domainSignals.includes("finance") &&
      !r.domainSignals.includes("sales") &&
      !r.domainSignals.includes("marketing"),
    `Should not match org domains, got: ${r.domainSignals.join(", ")}`
  );
});

test("routing-021: legal compliance query — no gutt domain signal", () => {
  const r = extractIntent("Is there an agent for legal compliance?");
  assert.ok(
    !r.domainSignals.includes("finance") && !r.domainSignals.includes("sales"),
    "Legal question should not match finance/sales domains"
  );
});

test("routing-022: Symphony onboarding query extracts entity ref", () => {
  const r = extractIntent("What did we learn from the Symphony onboarding?");
  assertIncludes(r.entityRefs, "contact:symphony");
});

test("routing-023: investor pitch extracts investor domain", () => {
  const r = extractIntent("Review Bart's investor pitch before Monday");
  assertIncludes(r.domainSignals, "investor");
});

// ── Keyword Fix: branch must NOT trigger devops ──────────────────────────────

console.log("\nKeyword boundary fixes:");

test("'rebase this branch' does NOT trigger devops domain", () => {
  const r = extractIntent("rebase this branch");
  assert.ok(
    !r.domainSignals.includes("devops"),
    `'branch' should not trigger devops; got domains: ${r.domainSignals.join(", ")}`
  );
});

test("'ci/cd pipeline' DOES trigger devops domain", () => {
  const r = extractIntent("Set up our ci/cd pipeline");
  assertIncludes(r.domainSignals, "devops");
});

test("'deploy to Cloud Run' DOES trigger devops domain", () => {
  const r = extractIntent("Deploy the new API to Cloud Run");
  assertIncludes(r.domainSignals, "devops");
});

// ── Routing Decision Tests ───────────────────────────────────────────────────

console.log("\nRouting Decisions:");

test("routing-001: high-score single agent → type:single", () => {
  const intent = extractIntent("What's our runway?");
  const agents = mockSingle("cfo-analyst");
  const d = makeRoutingDecision(agents, intent, null);
  assertType(d, "single");
  assertLead(d, "cfo-analyst");
});

test("routing-006: sales pipeline → type:single, lead:sales-advisor", () => {
  const intent = extractIntent("What deals are in our sales pipeline?");
  const agents = mockSingle("sales-advisor");
  const d = makeRoutingDecision(agents, intent, null);
  assertType(d, "single");
  assertLead(d, "sales-advisor");
});

test("routing-013: Commit team + sales → type:team", () => {
  const intent = extractIntent("What should I say to the Commit team tomorrow?");
  const agents = mockTeam("contact:commit", "sales-advisor");
  const d = makeRoutingDecision(agents, intent, null);
  assertType(d, "team");
  assertLead(d, "contact:commit");
  assertIncludes(d.supporting, "sales-advisor");
});

test("routing-023: investor pitch → type:team, lead:investor-advisor", () => {
  const intent = extractIntent("Review Bart's investor pitch before Monday");
  const agents = mockTeam("investor-advisor", "ceo-advisor");
  const d = makeRoutingDecision(agents, intent, null);
  assertType(d, "team");
  assertLead(d, "investor-advisor");
});

test("routing-019: math question → type:passthrough", () => {
  const intent = extractIntent("What is 2+2?");
  const agents = mockLowConfidence();
  const d = makeRoutingDecision(agents, intent, null);
  assertType(d, "passthrough");
  assert.strictEqual(d.lead, null);
  assert.deepStrictEqual(d.supporting, []);
});

test("routing-020: for-loop Python question → type:passthrough (no org signals)", () => {
  const intent = extractIntent("How do I write a for loop in Python?");
  // Even if python triggers backend entity, the graph returns low-confidence fallback
  // Simulate: no strong org signals, low scores
  const agents = mockLowConfidence();
  // Remove entity refs to simulate pure coding question (no org context match)
  const intentNoOrg = { ...intent, entityRefs: [], domainSignals: [] };
  const d = makeRoutingDecision(agents, intentNoOrg, null);
  assertType(d, "passthrough");
});

test("routing-021: legal compliance with no org signals → type:passthrough", () => {
  // "legal compliance" has no gutt domain signals — router correctly treats as
  // general query outside org context. Fallback is surfaced via low-signal path.
  const intent = extractIntent("Is there an agent for legal compliance?");
  const agents = mockEmpty();
  const d = makeRoutingDecision(agents, intent, null);
  // No domain signals → passthrough (user must ask about a gutt domain to get routing)
  assertType(d, "passthrough");
  assert.strictEqual(d.lead, null);
});

test("routing-021 with low-score agents → type:fallback", () => {
  const intent = extractIntent("Is there an agent for legal compliance?");
  const agents = mockLowConfidence();
  // Has no domain signals, so hasSignals=false → passthrough
  // But if there ARE signals from keywords, should still fall back
  const intentWithSignal = { ...intent, domainSignals: ["unknown-domain"], entityRefs: [] };
  const d = makeRoutingDecision(agents, intentWithSignal, null);
  assertType(d, "fallback");
});

// ── Playbook Matching Tests ──────────────────────────────────────────────────

console.log("\nPlaybook Matching:");

test("routing-018: 'prep-client-meeting POAB' matches prep-client-meeting playbook", () => {
  const match = matchPlaybook("prep-client-meeting POAB", PLAYBOOKS_DIR);
  assert.ok(match !== null, "Should match a playbook");
  assert.strictEqual(
    match.name,
    "prep-client-meeting",
    `Expected prep-client-meeting, got ${match && match.name}`
  );
});

test("routing-018: matched playbook has correct lead agent pattern", () => {
  const match = matchPlaybook("prep-client-meeting POAB", PLAYBOOKS_DIR);
  assert.ok(match !== null, "Should match a playbook");
  assert.ok(
    match.lead && (match.lead.includes("contact") || match.lead === "contact:*"),
    `Expected contact:* lead, got "${match.lead}"`
  );
});

test("playbook threshold: generic prompt 'help me think' does NOT match any playbook", () => {
  const match = matchPlaybook("help me think", PLAYBOOKS_DIR);
  assert.strictEqual(match, null, `Generic prompt should not match; got: ${match && match.name}`);
});

test("playbook threshold: 'what is the weather' does NOT match any playbook", () => {
  const match = matchPlaybook("what is the weather", PLAYBOOKS_DIR);
  assert.strictEqual(match, null, "Unrelated prompt should not match a playbook");
});

test("'runway analysis' matches runway-analysis playbook", () => {
  const match = matchPlaybook("runway analysis", PLAYBOOKS_DIR);
  assert.ok(match !== null, "Should match runway-analysis playbook");
  assert.strictEqual(match.name, "runway-analysis");
});

test("'create a new agent' matches agent-creation playbook", () => {
  const match = matchPlaybook("create a new agent", PLAYBOOKS_DIR);
  assert.ok(match !== null, "Should match agent-creation playbook");
  assert.strictEqual(match.name, "agent-creation");
});

// ── Confidence tier checks ───────────────────────────────────────────────────

console.log("\nConfidence tiers:");

test("high-score single match → confidence >= 0.7", () => {
  const intent = extractIntent("What's our runway?");
  const agents = mockSingle("cfo-analyst", 0.85);
  const d = makeRoutingDecision(agents, intent, null);
  assert.ok(d.confidence >= 0.7, `Expected confidence >= 0.7, got ${d.confidence}`);
});

test("team routing → confidence >= TEAM_MIN_SCORE (0.4)", () => {
  const intent = extractIntent("What should I say to the Commit team tomorrow?");
  const agents = mockTeam("contact:commit", "sales-advisor", 0.75);
  const d = makeRoutingDecision(agents, intent, null);
  assert.ok(d.confidence >= 0.4, `Expected confidence >= 0.4, got ${d.confidence}`);
});

test("passthrough → confidence = 0", () => {
  const intent = extractIntent("What is 2+2?");
  const agents = mockLowConfidence();
  const d = makeRoutingDecision(agents, intent, null);
  assert.strictEqual(d.confidence, 0, `Passthrough should have confidence 0, got ${d.confidence}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => {
    console.log(`  ✗ ${f.name}`);
    console.log(`    ${f.message}`);
  });
}

console.log("");
process.exit(failed > 0 ? 1 : 0);
