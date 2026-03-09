#!/usr/bin/env node
/**
 * GUTT Routing Decision Engine
 *
 * Stateless logic that turns a ranked agent list + intent into a RoutingDecision.
 * Does NOT write to memory — routing decisions are system plumbing, not org knowledge.
 *
 * See PLAN.md Decision 2 and ROUTING.md for design rationale.
 */

const fs = require("fs");
const path = require("path");
const { PROJECT_STATE_DIR } = require("./env.cjs");
const { debugLog } = require("./debug.cjs");

// ---------------------------------------------------------------------------
// Confidence thresholds — tune here, not buried in logic
// ---------------------------------------------------------------------------

/** Top score must be below this to treat as passthrough (no domain signals either) */
const PASSTHROUGH_MAX_SCORE = 0.3;

/** Top score must exceed this for single-agent routing */
const SINGLE_AGENT_MIN_SCORE = 0.7;

/** Gap between top and second agent required for single-agent confidence */
const SINGLE_AGENT_MIN_GAP = 0.2;

/** All agents in a team must score above this floor */
const TEAM_MIN_SCORE = 0.4;

/** Max score spread allowed for agents to be considered a team */
const TEAM_MAX_SPREAD = 0.2;

/** Maximum number of supporting agents in a team */
const TEAM_MAX_SIZE = 3;

/** Number of memory/context excerpts to pass to selected agent(s) */
const CONTEXT_EXCERPT_COUNT = 5;

// ---------------------------------------------------------------------------
// Session state path
// ---------------------------------------------------------------------------

const SESSION_STATE_DIR = path.join(PROJECT_STATE_DIR, "hooks", ".state");
const SESSION_STATE_PATH = path.join(SESSION_STATE_DIR, "gutt-routing-session.json");

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Load current routing session state.
 * Returns a fresh session if none exists or the file is unreadable.
 *
 * @returns {object} Session state object
 */
function loadSession() {
  try {
    if (fs.existsSync(SESSION_STATE_PATH)) {
      const raw = fs.readFileSync(SESSION_STATE_PATH, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    debugLog("router", `Failed to load session: ${err.message}`);
  }
  return _freshSession();
}

/**
 * Persist session state to disk.
 * Uses temp-file + rename for safe writes (cross-platform).
 *
 * @param {object} session - Session state to persist
 */
function saveSession(session) {
  try {
    if (!fs.existsSync(SESSION_STATE_DIR)) {
      fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
    }
    const serialized = JSON.stringify(session, null, 2);
    const tempPath = SESSION_STATE_PATH + ".tmp";
    fs.writeFileSync(tempPath, serialized);
    // Windows: rename cannot overwrite existing file
    if (fs.existsSync(SESSION_STATE_PATH)) {
      fs.unlinkSync(SESSION_STATE_PATH);
    }
    fs.renameSync(tempPath, SESSION_STATE_PATH);
  } catch {
    // Fallback: direct write
    try {
      fs.writeFileSync(SESSION_STATE_PATH, JSON.stringify(session, null, 2));
    } catch (fallbackErr) {
      debugLog("router", `Failed to save session: ${fallbackErr.message}`);
    }
  }
}

function _freshSession() {
  return {
    sessionId: _uuid(),
    activeAgents: [],
    lastIntent: null,
    lastRoutingDecision: null,
    turnCount: 0,
  };
}

function _uuid() {
  try {
    return require("crypto").randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Pronoun / reference resolution
// ---------------------------------------------------------------------------

/**
 * Resolve pronoun references in the intent using session state.
 * Mutates intent in place — replaces generic references ("that", "it", "them")
 * with the last active agents / last intent from session.
 *
 * @param {object} intent - IntentResult from intent-extractor
 * @param {object} session - Current session state
 * @returns {object} Resolved intent (may be mutated)
 */
function _resolvePronouns(intent, session) {
  const PRONOUNS = /\b(that|it|them|this|those|the same|the previous)\b/i;
  const rawKeywords = (intent.keywords || []).join(" ");

  if (!PRONOUNS.test(rawKeywords)) {
    return intent;
  }

  // Inject last active agents as entity refs
  if (session.activeAgents && session.activeAgents.length > 0) {
    const existing = new Set(intent.entityRefs || []);
    for (const agent of session.activeAgents) {
      existing.add(agent);
    }
    intent.entityRefs = Array.from(existing);
  }

  // Augment keywords with last intent keywords to carry topic forward
  if (session.lastIntent && session.lastIntent.keywords) {
    const existing = new Set(intent.keywords || []);
    for (const kw of session.lastIntent.keywords) {
      existing.add(kw);
    }
    intent.keywords = Array.from(existing);
  }

  return intent;
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

/**
 * Extract readable context excerpts from raw agent match objects.
 * The agent discovery layer (T2) returns { name, score, summary } objects.
 * We pull the top N summaries and format them as bullet points.
 *
 * @param {Array<{name: string, score: number, summary: string}>} agents
 * @returns {string[]} Bullet-point excerpts
 */
function _extractContext(agents) {
  return agents
    .slice(0, CONTEXT_EXCERPT_COUNT)
    .map((a) => a.summary)
    .filter(Boolean)
    .map((s) => `• ${s.trim()}`);
}

// ---------------------------------------------------------------------------
// Decision logic
// ---------------------------------------------------------------------------

/**
 * Make a routing decision from a ranked agent list and intent.
 *
 * Decision precedence:
 *   1. passthrough  — no domain signals, no entity refs, low top score
 *   2. single       — clear winner (high score, large gap to next)
 *   3. team         — multiple agents with similar scores above floor
 *   4. fallback     — agents found but confidence too low
 *
 * Note: playbook matching (type "playbook") is resolved upstream (T4) before
 * this function is called. If a playbook matched, the caller bypasses this
 * function entirely.
 *
 * @param {Array<{name: string, score: number, summary: string}>} agents
 *   Ranked agent matches from agent-discovery (T2). May be empty.
 * @param {object} intent
 *   IntentResult from intent-extractor (T1):
 *   { keywords: string[], entityRefs: string[], domainSignals: string[] }
 * @param {object} [session]
 *   Current session state from loadSession(). Optional; fresh session used if omitted.
 *
 * @returns {object} RoutingDecision
 *   {
 *     type: "single"|"team"|"playbook"|"fallback"|"passthrough",
 *     lead: string|null,           // agent name
 *     supporting: string[],        // agent names
 *     playbook: string|null,
 *     confidence: number,          // 0..1
 *     context: string[],           // memory excerpts for the agent(s)
 *     reason: string,              // human-readable rationale
 *   }
 */
function makeRoutingDecision(agents, intent, session) {
  const resolvedSession = session || loadSession();

  // Resolve pronouns / carry-forward references from session
  const resolvedIntent = _resolvePronouns({ ...intent }, resolvedSession);

  const hasSignals =
    (resolvedIntent.domainSignals && resolvedIntent.domainSignals.length > 0) ||
    (resolvedIntent.entityRefs && resolvedIntent.entityRefs.length > 0);

  const topScore = agents.length > 0 ? agents[0].score : 0;
  const context = _extractContext(agents);

  // ── 1. Passthrough ───────────────────────────────────────────────────────
  // No domain signals, no entity refs, and graph found nothing relevant.
  // This is a normal coding question, git command, etc. — don't interrupt.
  if (!hasSignals && topScore < PASSTHROUGH_MAX_SCORE) {
    return {
      type: "passthrough",
      lead: null,
      supporting: [],
      playbook: null,
      confidence: 0,
      context: [],
      reason: "No domain signals or entity references detected; treating as general query.",
    };
  }

  // ── 2. Single agent ──────────────────────────────────────────────────────
  const secondScore = agents.length > 1 ? agents[1].score : 0;
  const gap = topScore - secondScore;

  if (topScore >= SINGLE_AGENT_MIN_SCORE && gap >= SINGLE_AGENT_MIN_GAP) {
    return {
      type: "single",
      lead: agents[0].name,
      supporting: [],
      playbook: null,
      confidence: topScore,
      context,
      reason: `${agents[0].name} is the clear best match (score ${topScore.toFixed(2)}, gap ${gap.toFixed(2)} over next candidate).`,
    };
  }

  // ── 3. Team ──────────────────────────────────────────────────────────────
  // Gather agents whose scores are within TEAM_MAX_SPREAD of the top score
  // and above the team floor.
  const teamCandidates = agents.filter(
    (a) => a.score >= TEAM_MIN_SCORE && topScore - a.score <= TEAM_MAX_SPREAD
  );

  if (teamCandidates.length >= 2) {
    const [lead, ...supporting] = teamCandidates.slice(0, TEAM_MAX_SIZE);
    return {
      type: "team",
      lead: lead.name,
      supporting: supporting.map((a) => a.name),
      playbook: null,
      confidence: topScore,
      context,
      reason: `Multiple agents match within ${TEAM_MAX_SPREAD} spread: ${teamCandidates.map((a) => a.name).join(", ")}.`,
    };
  }

  // ── 4. Fallback ──────────────────────────────────────────────────────────
  // We have signals but no confident match. Surface best candidate with caveat.
  if (agents.length > 0) {
    return {
      type: "fallback",
      lead: agents[0].name,
      supporting: [],
      playbook: null,
      confidence: topScore,
      context,
      reason: `Low-confidence match: ${agents[0].name} (score ${topScore.toFixed(2)}). May not be the best fit.`,
    };
  }

  // ── 5. No agents at all ──────────────────────────────────────────────────
  return {
    type: "fallback",
    lead: null,
    supporting: [],
    playbook: null,
    confidence: 0,
    context: [],
    reason: `No agent covers this domain. Consider creating one (Principle 9).`,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  makeRoutingDecision,
  loadSession,
  saveSession,
  // Export thresholds for testability
  PASSTHROUGH_MAX_SCORE,
  SINGLE_AGENT_MIN_SCORE,
  SINGLE_AGENT_MIN_GAP,
  TEAM_MIN_SCORE,
  TEAM_MAX_SPREAD,
  TEAM_MAX_SIZE,
  CONTEXT_EXCERPT_COUNT,
};
