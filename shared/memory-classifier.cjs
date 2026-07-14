#!/usr/bin/env node
/**
 * Unified classifier for all memory capture types.
 *
 * Analyzes text for signals that indicate lesson-worthy, preference,
 * agreement, decision, or insight content. Returns a classification
 * with type, trust level, and priority.
 */

const CAPTURE_TYPES = {
  LESSON: "Lesson",
  USER_PREFERENCE: "UserPreference",
  WORKING_AGREEMENT: "WorkingAgreement",
  INSIGHT: "Insight",
  DECISION: "Decision",
};

const TRUST_LEVELS = {
  HUMAN: "human",
  AGENT: "agent",
};

// Signal detection patterns — checked in priority order
const LESSON_SIGNALS = [
  /no that'?s wrong/i,
  /don'?t do/i,
  /should have/i,
  /\bmistake\b/i,
  /\bincorrect\b/i,
  /fix this/i,
  /you keep doing/i,
];

const USER_PREFERENCE_SIGNALS = [
  /I prefer/i,
  /always do/i,
  /I like when/i,
  /don'?t use .+ for me/i,
  /my style/i,
];

const WORKING_AGREEMENT_SIGNALS = [
  /all PRs must/i,
  /we always/i,
  /rule is/i,
  /\bpolicy\b/i,
  /non-negotiable/i,
  /standard is/i,
];

const DECISION_SIGNALS = [
  /we decided/i,
  /\bdecision:/i,
  /go ahead/i,
  /\bapproved\b/i,
  /let'?s do/i,
  /chose to/i,
  /yes,? proceed/i,
];

const INSIGHT_SIGNALS = [
  /\bpattern:/i,
  /noticed that/i,
  /\btrend:/i,
  /correlates with/i,
  /\binteresting:/i,
];

// High-priority indicators
const HIGH_PRIORITY_PATTERNS = [/you keep doing/i, /\brecurring\b/i];

/**
 * Classify text for memory capture signals.
 *
 * Checks patterns in priority order:
 *   WorkingAgreement > Decision > Lesson > UserPreference > Insight
 *
 * @param {string} text - The text to classify
 * @returns {{ shouldCapture: boolean, type?: string, trust?: string, priority?: string }}
 */
function classifySignal(text) {
  if (!text || typeof text !== "string") {
    return { shouldCapture: false };
  }

  // Priority order: WorkingAgreement > Decision > Lesson > UserPreference > Insight
  const checks = [
    {
      patterns: WORKING_AGREEMENT_SIGNALS,
      type: CAPTURE_TYPES.WORKING_AGREEMENT,
      trust: TRUST_LEVELS.HUMAN,
    },
    { patterns: DECISION_SIGNALS, type: CAPTURE_TYPES.DECISION, trust: TRUST_LEVELS.HUMAN },
    { patterns: LESSON_SIGNALS, type: CAPTURE_TYPES.LESSON, trust: TRUST_LEVELS.HUMAN },
    {
      patterns: USER_PREFERENCE_SIGNALS,
      type: CAPTURE_TYPES.USER_PREFERENCE,
      trust: TRUST_LEVELS.HUMAN,
    },
    { patterns: INSIGHT_SIGNALS, type: CAPTURE_TYPES.INSIGHT, trust: TRUST_LEVELS.AGENT },
  ];

  for (const { patterns, type, trust } of checks) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        const priority = HIGH_PRIORITY_PATTERNS.some((hp) => hp.test(text)) ? "high" : "normal";
        return { shouldCapture: true, type, trust, priority };
      }
    }
  }

  return { shouldCapture: false };
}

// CLI self-test guard
if (require.main === module) {
  const testCases = [
    "no that's wrong, fix this",
    "I prefer tabs over spaces",
    "all PRs must have tests",
    "we decided to use PostgreSQL",
    "pattern: users always click here first",
    "just a normal message with nothing special",
  ];
  for (const tc of testCases) {
    const result = classifySignal(tc);
    console.log(`"${tc}" => ${JSON.stringify(result)}`);
  }
}

module.exports = {
  classifySignal,
  CAPTURE_TYPES,
  TRUST_LEVELS,
  LESSON_SIGNALS,
  USER_PREFERENCE_SIGNALS,
  WORKING_AGREEMENT_SIGNALS,
  DECISION_SIGNALS,
  INSIGHT_SIGNALS,
  HIGH_PRIORITY_PATTERNS,
};
