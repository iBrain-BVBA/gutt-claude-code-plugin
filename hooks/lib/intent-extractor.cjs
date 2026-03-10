#!/usr/bin/env node
/**
 * GUTT Intent Extractor
 * Extracts keywords, entity references, and domain signals from a raw prompt string.
 * No LLM call — keyword/entity matching only. Graph semantic search handles the gap.
 *
 * @module intent-extractor
 */

// ---------------------------------------------------------------------------
// Domain signal map: keyword cluster → domain label
// Built from actual agent seeds in agents/
// ---------------------------------------------------------------------------

const DOMAIN_SIGNAL_MAP = [
  // Finance (cfo-analyst)
  {
    domain: "finance",
    keywords: [
      "runway",
      "burn",
      "mrr",
      "arr",
      "revenue",
      "costs",
      "budget",
      "cash",
      "finance",
      "financial",
      "forecast",
      "projection",
      "expenses",
      "headcount",
      "unit economics",
      "p&l",
      "profit",
      "loss",
      "invoice",
      "payment",
      "subscription",
      "churn",
    ],
  },
  // Sales (sales-advisor)
  {
    domain: "sales",
    keywords: [
      "pipeline",
      "deal",
      "prospect",
      "opportunity",
      "crm",
      "hubspot",
      "close",
      "discovery",
      "demo",
      "proposal",
      "pricing",
      "negotiation",
      "contract",
      "renewal",
      "upsell",
      "churn",
      "quota",
      "forecast",
      "sales",
    ],
  },
  // Marketing (marketing-strategist, gtm-engineer)
  {
    domain: "marketing",
    keywords: [
      "campaign",
      "gtm",
      "go-to-market",
      "positioning",
      "brand",
      "lead",
      "funnel",
      "conversion",
      "landing page",
      "seo",
      "content",
      "email",
      "newsletter",
      "linkedin",
      "social",
      "ads",
      "marketing",
      "growth",
      "acquisition",
      "nurture",
      "analytics",
      "a/b test",
      "automation",
    ],
  },
  // Product (product-owner)
  {
    domain: "product",
    keywords: [
      "backlog",
      "sprint",
      "roadmap",
      "feature",
      "user story",
      "epic",
      "jira",
      "prioritization",
      "acceptance criteria",
      "release",
      "mvp",
      "product",
      "stakeholder",
      "requirements",
      "scope",
    ],
  },
  // Backend development (be-developer)
  {
    domain: "backend",
    keywords: [
      "api",
      "endpoint",
      "python",
      "fastapi",
      "cloud run",
      "gcp",
      "database",
      "migration",
      "service",
      "integration",
      "webhook",
      "microservice",
      "backend",
      "server",
      "graphiti",
      "memory",
      "data pipeline",
    ],
  },
  // Frontend development (fe-developer)
  {
    domain: "frontend",
    keywords: [
      "react",
      "component",
      "ui",
      "ux",
      "css",
      "typescript",
      "nextjs",
      "tailwind",
      "accessibility",
      "responsive",
      "design system",
      "frontend",
      "web app",
      "dashboard",
      "interface",
    ],
  },
  // Infrastructure / DevOps (devops-engineer)
  {
    domain: "devops",
    keywords: [
      "ci/cd",
      "github actions",
      "terraform",
      "kubernetes",
      "k8s",
      "docker",
      "deployment",
      "infrastructure",
      "monitoring",
      "alerting",
      "logs",
      "cloud run",
      "gcp",
      "devops",
      "git",
      "pr",
      "pull request",
      "commitlint",
      "release",
    ],
  },
  // Quality (qa-engineer)
  {
    domain: "quality",
    keywords: [
      "test",
      "testing",
      "qa",
      "bug",
      "regression",
      "automation",
      "e2e",
      "unit test",
      "integration test",
      "quality",
      "coverage",
      "flaky",
      "security audit",
      "audit",
      "vulnerability",
      "pen test",
      "pentest",
    ],
  },
  // Content / Writing (blog-writer, copywriter, linkedin-writer)
  {
    domain: "content",
    keywords: [
      "blog",
      "post",
      "article",
      "copy",
      "linkedin",
      "write",
      "writing",
      "content",
      "social media",
      "newsletter",
      "draft",
      "publish",
    ],
  },
  // Strategy (ceo-advisor)
  {
    domain: "strategy",
    keywords: [
      "strategy",
      "vision",
      "mission",
      "narrative",
      "positioning",
      "alignment",
      "market",
      "competitive",
      "organizational",
      "leadership",
      "board",
    ],
  },
  // Investor (investor-advisor)
  {
    domain: "investor",
    keywords: [
      "investor",
      "pitch",
      "deck",
      "board",
      "fundraise",
      "round",
      "term sheet",
      "due diligence",
      "cap table",
      "equity",
      "valuation",
    ],
  },
  // Meeting prep (cross-cutting)
  {
    domain: "meeting-prep",
    keywords: [
      "meeting",
      "prep",
      "deck",
      "agenda",
      "presentation",
      "briefing",
      "stakeholder update",
      "slides",
    ],
  },
  // Architecture (architect-advisor)
  {
    domain: "architecture",
    keywords: [
      "architecture",
      "design decision",
      "adr",
      "system design",
      "scalability",
      "pattern",
      "refactor",
      "technical debt",
      "microservice",
      "monolith",
    ],
  },
  // Business analysis (business-analyst)
  {
    domain: "analysis",
    keywords: [
      "analyze",
      "analysis",
      "report",
      "data",
      "metrics",
      "kpi",
      "insight",
      "research",
      "benchmark",
      "trends",
      "business requirements",
      "brd",
      "requirements doc",
      "process map",
      "gap analysis",
    ],
  },
];

// ---------------------------------------------------------------------------
// Entity reference map: agent name → trigger keywords/phrases (lowercased)
// Built from relationship agent seeds and capability agent names
// ---------------------------------------------------------------------------

const ENTITY_ALIAS_MAP = [
  // Contact agents
  {
    agent: "contact:poab",
    aliases: [
      "poab",
      "port of antwerp",
      "port of antwerp-bruges",
      "erwin",
      "karen",
      "b11319",
      "tender",
    ],
  },
  { agent: "contact:commit", aliases: ["commit", "comm-it", "slava", "nogah", "sdlc", "israel"] },
  { agent: "contact:symphony", aliases: ["symphony", "symphony solutions", "onboarding"] },

  // Capability agents
  { agent: "cfo-analyst", aliases: ["cfo", "financial", "finance", "runway", "burn rate", "mrr"] },
  { agent: "sales-advisor", aliases: ["sales", "pipeline", "deal", "prospect"] },
  { agent: "be-developer", aliases: ["backend", "api", "python", "cloud run"] },
  { agent: "fe-developer", aliases: ["frontend", "react", "ui", "component"] },
  {
    agent: "devops-engineer",
    aliases: ["devops", "ci/cd", "infrastructure", "terraform", "deployment"],
  },
  { agent: "product-owner", aliases: ["product", "backlog", "roadmap", "sprint"] },
  { agent: "qa-engineer", aliases: ["qa", "testing", "test", "quality"] },
  { agent: "marketing-strategist", aliases: ["marketing", "campaign", "gtm", "positioning"] },
  { agent: "gtm-engineer", aliases: ["analytics", "conversion", "funnel", "automation", "a/b"] },
  { agent: "ceo-advisor", aliases: ["strategy", "ceo", "vision", "narrative"] },
  { agent: "investor-advisor", aliases: ["investor", "pitch", "board", "fundraise"] },
  { agent: "architect-advisor", aliases: ["architect", "architecture", "system design", "adr"] },
  { agent: "blog-writer", aliases: ["blog", "article", "post"] },
  { agent: "copywriter", aliases: ["copy", "copywriting", "ad copy"] },
  { agent: "linkedin-writer", aliases: ["linkedin post", "linkedin content"] },
  { agent: "seo-analyst", aliases: ["seo", "search engine", "keyword ranking"] },
  { agent: "business-analyst", aliases: ["business analysis", "requirements", "process map"] },
];

// ---------------------------------------------------------------------------
// Stop words to skip during keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "i",
  "we",
  "you",
  "he",
  "she",
  "it",
  "they",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "please",
  "help",
  "me",
  "my",
  "our",
  "your",
  "need",
  "want",
  "get",
  "just",
  "like",
  "also",
  "there",
  "some",
  "any",
  "all",
  "more",
  "very",
  "new",
  "make",
  "use",
  "using",
  "used",
  "give",
  "put",
  "let",
  "know",
  "think",
  "look",
  "tell",
  "good",
  "well",
  "work",
  "here",
  "now",
]);

// ---------------------------------------------------------------------------
// extractIntent
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} IntentResult
 * @property {string[]} keywords     - Significant words from the prompt (deduped, lowercased)
 * @property {string[]} entityRefs   - Agent names matched from seed aliases
 * @property {string[]} domainSignals - Domain labels matched from keyword clusters
 */

/**
 * Extract intent signals from a raw user prompt.
 *
 * @param {string} prompt - Raw user prompt string
 * @returns {IntentResult}
 */
function extractIntent(prompt) {
  if (!prompt || typeof prompt !== "string") {
    return { keywords: [], entityRefs: [], domainSignals: [] };
  }

  const lower = prompt.toLowerCase();

  // --- Keywords: tokenize, filter stop words and short tokens ---
  const rawTokens = lower
    .replace(/[^a-z0-9\s\-/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const keywords = [...new Set(rawTokens)];

  // --- Entity refs: match against alias lists using word-boundary matching ---
  const entityRefs = [];
  for (const entry of ENTITY_ALIAS_MAP) {
    for (const alias of entry.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
      if (re.test(lower)) {
        if (!entityRefs.includes(entry.agent)) {
          entityRefs.push(entry.agent);
        }
        break;
      }
    }
  }

  // --- Domain signals: match keyword clusters ---
  // Use word-boundary matching for all keywords to avoid false positives
  // e.g. "pr" should not match "prep", "board" should not match "dashboard"
  const domainSignals = [];
  for (const entry of DOMAIN_SIGNAL_MAP) {
    let matched = false;
    for (const kw of entry.keywords) {
      // Build regex with word-boundary anchors
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
      if (re.test(lower)) {
        matched = true;
        break;
      }
    }
    if (matched && !domainSignals.includes(entry.domain)) {
      domainSignals.push(entry.domain);
    }
  }

  return { keywords, entityRefs, domainSignals };
}

module.exports = { extractIntent };
