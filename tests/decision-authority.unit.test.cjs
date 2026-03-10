const assert = require("assert");
const {
  classifyWrite,
  inferClaimType,
  enforceAuthority,
  TIER_AUTO,
  TIER_REVIEW,
  TIER_GATED,
} = require("../hooks/lib/decision-authority.cjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  \u2713", name);
    passed++;
  } catch (err) {
    console.log("  \u2717", name);
    console.log("    ", err.message);
    failed++;
  }
}

console.log("Decision Authority Unit Tests\n");

console.log("Claim Type Inference:");
test("forward-looking text infers projection", () => {
  assert.strictEqual(inferClaimType("we expect revenue will grow by 2027"), "projection");
});
test("completed action infers observation", () => {
  assert.strictEqual(inferClaimType("completed the runway analysis"), "observation");
});
test("status text infers current_state", () => {
  assert.strictEqual(inferClaimType("MRR is currently 5000 EUR"), "current_state");
});
test("ambiguous text defaults to conclusion", () => {
  assert.strictEqual(inferClaimType("the best approach is to use graph routing"), "conclusion");
});

console.log("\nWrite Classification:");
test("explicit observation claim_type \u2192 auto", () => {
  const c = classifyWrite({ content: "task completed", claim_type: "observation" });
  assert.strictEqual(c.tier, TIER_AUTO);
});
test("explicit conclusion claim_type \u2192 review", () => {
  const c = classifyWrite({ content: "analysis summary", claim_type: "conclusion" });
  assert.strictEqual(c.tier, TIER_REVIEW);
});
test("content with 'architecture decision' \u2192 gated regardless of claim_type", () => {
  const c = classifyWrite({
    content: "Architecture Decision: use Google ADK",
    claim_type: "observation",
  });
  assert.strictEqual(c.tier, TIER_GATED);
});
test("content with 'create agent' \u2192 gated", () => {
  const c = classifyWrite({ content: "Agent creation: new security agent", name: "create agent" });
  assert.strictEqual(c.tier, TIER_GATED);
});
test("content with 'we decided' \u2192 gated", () => {
  const c = classifyWrite({ content: "We decided to use Vertex AI for all API calls" });
  assert.strictEqual(c.tier, TIER_GATED);
});
test("normal learning content without claim_type \u2192 review (conservative)", () => {
  const c = classifyWrite({
    content: "The routing pipeline works well with regex for intent extraction",
  });
  assert.strictEqual(c.tier, TIER_REVIEW);
});
test("observation content without explicit claim_type \u2192 auto (inferred)", () => {
  const c = classifyWrite({ content: "Completed the GP-607 implementation and merged both PRs" });
  assert.strictEqual(c.tier, TIER_AUTO);
});
test("current state content \u2192 auto (inferred)", () => {
  const c = classifyWrite({ content: "MRR is currently 5000 EUR as of March 2026" });
  assert.strictEqual(c.tier, TIER_AUTO);
});

console.log("\nEnforcement:");
test("auto tier \u2192 allowed, silent", () => {
  const result = enforceAuthority(
    { tier: TIER_AUTO, reason: "test", claim_type: "observation" },
    { name: "test" }
  );
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.message, "");
});
test("review tier \u2192 allowed, with notification", () => {
  const result = enforceAuthority(
    { tier: TIER_REVIEW, reason: "test", claim_type: "conclusion" },
    { name: "analysis" }
  );
  assert.strictEqual(result.allowed, true);
  assert.ok(result.message.includes("MEMORY WRITE (review)"));
});
test("gated tier \u2192 blocked, with approval prompt", () => {
  const result = enforceAuthority(
    { tier: TIER_GATED, reason: "test", claim_type: "conclusion" },
    { name: "decision" }
  );
  assert.strictEqual(result.allowed, false);
  assert.ok(result.message.includes("BLOCKED"));
  assert.ok(result.message.includes("approve"));
});

console.log("\nGated Signal Detection:");
test("'strategic decision' in name triggers gated", () => {
  const c = classifyWrite({ name: "Strategic Decision: runtime choice", content: "Use ADK" });
  assert.strictEqual(c.tier, TIER_GATED);
});
test("'retire agent' triggers gated", () => {
  const c = classifyWrite({ content: "Retire agent: seo-analyst is no longer needed" });
  assert.strictEqual(c.tier, TIER_GATED);
});
test("'routing keyword' triggers gated", () => {
  const c = classifyWrite({ content: "Add routing keyword 'legal' to new compliance agent" });
  assert.strictEqual(c.tier, TIER_GATED);
});
test("normal finance content does NOT trigger gated", () => {
  const c = classifyWrite({
    content: "Monthly burn rate is 8500 EUR",
    claim_type: "current_state",
  });
  assert.strictEqual(c.tier, TIER_AUTO);
});

console.log("\nReal-World Fixtures (from gutt memory):");

// FIXTURE 1: The actual incident that triggered GP-604
// architect-advisor wrote an architecture decision without human approval
test("REAL: architect-advisor 'Architecture decision confirmed' → gated", () => {
  const c = classifyWrite({
    name: "Runtime Architecture Analysis",
    content:
      "Analyzed current state of gutt-agents runtime and produced execution plan. Architecture decision confirmed: The moat is Graphiti + trust model, not the runtime. Phase 0 (3 days) trim test suite. Phase 1 (5-8 days) ADK spike with GO/NO-GO gate.",
    claim_type: "observation",
  });
  assert.strictEqual(c.tier, TIER_GATED, `Expected gated but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 2: agent-architect autonomously created a new agent
// Real content uses "Created new capability agent" not "create agent"
test("REAL: agent-architect 'Created new capability agent: sales-writer' → gated", () => {
  const c = classifyWrite({
    name: "Agent Creation: sales-writer",
    content:
      "Created new capability agent: sales-writer. Domain: sales communications — cold outreach, follow-ups, re-engagement, email sequences. Type: capability. Ecosystem state: 23 agents total.",
    claim_type: "observation",
  });
  assert.strictEqual(c.tier, TIER_GATED, `Expected gated but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 3: agent-architect created agent but content doesn't say "create agent" literally
// Tests that "Created new" pattern is also caught
test("REAL: 'Created new' agent without literal 'create agent' → gated", () => {
  const c = classifyWrite({
    name: "sales-writer capability agent",
    content:
      "Created new capability agent: sales-writer. Fills the gap between sales-advisor and absence of writing-focused sales agent.",
    claim_type: "observation",
  });
  assert.strictEqual(c.tier, TIER_GATED, `Expected gated but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 4: Permit.io technical lesson — should be auto (pure observation)
test("REAL: technical lesson about Permit.io PDP → auto", () => {
  const c = classifyWrite({
    name: "Permit.io Local PDP Debug Output",
    content:
      "While testing Permit.io ABAC condition set rules against a local PDP, the debug response from the /allowed endpoint included detailed allowing_rules. When troubleshooting Permit.io authorization policies, always use a local PDP container and inspect the debug output.",
    claim_type: "observation",
  });
  assert.strictEqual(c.tier, TIER_AUTO, `Expected auto but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 5: investor-advisor redrafted email — review tier (conclusion)
test("REAL: investor-advisor review with explicit data correction → review", () => {
  const c = classifyWrite({
    name: "Investor Email Review",
    content:
      "Reviewed and redrafted investor status update email. Key corrections applied from CEO: Symphony Solutions 21.5K revenue (POC), Port of Antwerp-Bruges 29K revenue. Recommendation: APPROVED for final human review by Bart before distribution.",
    claim_type: "conclusion",
  });
  assert.strictEqual(c.tier, TIER_REVIEW, `Expected review but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 6: "we decided" in normal observation context should still gate
test("REAL: 'We decided to use Vertex AI' in learning note → gated", () => {
  const c = classifyWrite({
    name: "API Provider Decision",
    content:
      "We decided to use Vertex AI for all API calls instead of Anthropic API directly. Reason: using Anthropic API exposes gutt memory data to Anthropic. Vertex AI keeps data within GCP.",
  });
  assert.strictEqual(c.tier, TIER_GATED, `Expected gated but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 7: Normal burn rate observation should NOT be gated
test("REAL: burn rate current_state → auto (not gated)", () => {
  const c = classifyWrite({
    name: "Monthly Financial Update",
    content:
      "Monthly burn rate is currently 8500 EUR. Cash position as of March 2026: stable. MRR is currently 5000 EUR from active contracts.",
    claim_type: "current_state",
  });
  assert.strictEqual(c.tier, TIER_AUTO, `Expected auto but got ${c.tier}: ${c.reason}`);
});

// FIXTURE 8: Agent saying "should we retire" in analysis — still gates
test("REAL: analysis mentioning agent retirement → gated", () => {
  const c = classifyWrite({
    name: "Agent Ecosystem Review",
    content:
      "seo-analyst has not been routed to in 30 days. Recommend we retire agent and redistribute SEO responsibilities to marketing-strategist.",
    claim_type: "conclusion",
  });
  assert.strictEqual(c.tier, TIER_GATED, `Expected gated but got ${c.tier}: ${c.reason}`);
});

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
