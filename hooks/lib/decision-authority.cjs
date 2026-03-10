/**
 * GUTT Decision Authority Enforcement
 *
 * Classifies memory writes into authority tiers (auto/review/gated)
 * and determines if human approval is needed before the write executes.
 *
 * See docs/DECISION-AUTHORITY.md in gutt-agents for the full model.
 */

// Authority tiers
const TIER_AUTO = "auto"; // Agent writes freely
const TIER_REVIEW = "review"; // Agent writes, human notified
const TIER_GATED = "gated"; // Human must approve before write

// Claim types ordered by authority requirement
const CLAIM_TYPE_TIERS = {
  observation: TIER_AUTO,
  current_state: TIER_AUTO,
  conclusion: TIER_REVIEW,
  projection: TIER_REVIEW,
};

// Keywords that signal gated operations (agent lifecycle, routing changes)
const GATED_SIGNALS = [
  "architecture decision",
  "architectural decision",
  "strategic decision",
  "we decided",
  "agent creation",
  "create agent",
  "created new",
  "retire agent",
  "modify agent seed",
  "routing change",
  "routing keyword",
];

// Keywords that signal cross-domain writes (reserved for future use)
// eslint-disable-next-line no-unused-vars
const CROSS_DOMAIN_SIGNALS = [
  // These get checked against the calling agent's domain
  // For now, detect obvious cross-domain patterns
];

/**
 * Classify a memory write into an authority tier.
 *
 * @param {object} params - The add_memory tool call parameters
 * @param {string} params.name - Memory name/title
 * @param {string} params.content - Memory content
 * @param {string} [params.claim_type] - Explicit claim type if provided
 * @returns {{ tier: string, reason: string, claim_type: string }}
 */
function classifyWrite(params) {
  const content = (params.content || "").toLowerCase();
  const name = (params.name || "").toLowerCase();
  const episodeBody = (params.episode_body || "").toLowerCase();
  const combined = `${name} ${content} ${episodeBody}`;

  // Check for gated signals first (highest priority)
  for (const signal of GATED_SIGNALS) {
    if (combined.includes(signal.toLowerCase())) {
      return {
        tier: TIER_GATED,
        reason: `Contains gated signal: "${signal}"`,
        claim_type: params.claim_type || "conclusion",
      };
    }
  }

  // Use explicit claim_type if provided
  if (params.claim_type && CLAIM_TYPE_TIERS[params.claim_type]) {
    return {
      tier: CLAIM_TYPE_TIERS[params.claim_type],
      reason: `Claim type: ${params.claim_type}`,
      claim_type: params.claim_type,
    };
  }

  // Infer claim type from content
  const inferred = inferClaimType(combined);
  return {
    tier: CLAIM_TYPE_TIERS[inferred] || TIER_REVIEW,
    reason: `Inferred claim type: ${inferred}`,
    claim_type: inferred,
  };
}

/**
 * Infer claim type from content when not explicitly provided.
 * Conservative: defaults to "conclusion" (review tier) when uncertain.
 */
function inferClaimType(text) {
  // Projections: forward-looking, estimates, predictions
  if (/\b(will |should |expect|predict|forecast|estimate|project|by \d{4})\b/i.test(text)) {
    return "projection";
  }
  // Observations: factual records, completed actions
  if (/\b(completed|finished|observed|recorded|measured|counted|found that)\b/i.test(text)) {
    return "observation";
  }
  // Current state: status, current values
  if (/\b(currently|right now|as of|status:|is currently|are currently)\b/i.test(text)) {
    return "current_state";
  }
  // Default to conclusion (review tier) — conservative
  return "conclusion";
}

/**
 * Format the authority response for hook output.
 *
 * @param {{ tier: string, reason: string, claim_type: string }} classification
 * @param {object} params - Original add_memory params
 * @returns {{ allowed: boolean, message: string }}
 */
function enforceAuthority(classification, params) {
  const name = params.name || "(unnamed)";

  switch (classification.tier) {
    case TIER_AUTO:
      return {
        allowed: true,
        message: "", // Silent — no interruption
      };

    case TIER_REVIEW:
      return {
        allowed: true,
        message: `\u{1f4dd} MEMORY WRITE (review): "${name}" [${classification.claim_type}] \u2014 ${classification.reason}`,
      };

    case TIER_GATED:
      return {
        allowed: false,
        message: `\u{1f6ab} MEMORY WRITE BLOCKED (gated): "${name}" [${classification.claim_type}] \u2014 ${classification.reason}\n\nThis write requires human approval. Reply "approve" to allow this write, or "reject" to block it.`,
      };

    default:
      // Unknown tier — block conservatively
      return {
        allowed: false,
        message: `\u{1f6ab} MEMORY WRITE BLOCKED (unknown tier): "${name}" \u2014 classification failed. Blocking conservatively.`,
      };
  }
}

module.exports = {
  classifyWrite,
  inferClaimType,
  enforceAuthority,
  TIER_AUTO,
  TIER_REVIEW,
  TIER_GATED,
  GATED_SIGNALS,
};
