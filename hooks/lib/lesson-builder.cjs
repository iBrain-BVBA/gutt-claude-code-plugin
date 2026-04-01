#!/usr/bin/env node
/**
 * Builds platform-appropriate lesson capture output.
 *
 * Consolidates the 3 platform-specific code paths (Cursor, CLI, Cowork)
 * into a single function that returns the correct JSON output shape.
 */

/**
 * Build lesson capture output for the detected platform.
 *
 * @param {object} opts
 * @param {"cursor"|"cli"|"cowork"} opts.platform - Detected platform
 * @param {boolean} opts.supportsBlock - Whether decision:block is supported
 * @param {object} [opts.classifierResult] - Result from classifySignal (optional)
 * @param {object} opts.context - Platform-agnostic content
 * @param {string} opts.context.capturePrompt - The capture instruction text
 * @param {string} [opts.context.blockReason] - Extra text for CLI block reason
 * @param {string} [opts.context.coworkPrefix] - Prefix for cowork output (e.g. "[Cowork] Session ending.")
 * @param {number} [opts.context.lessonsCaptured] - Number of lessons already captured
 * @returns {object} JSON-serializable output for console.log
 */
function buildLessonOutput({
  platform,
  supportsBlock,
  classifierResult: _classifierResult,
  context,
}) {
  const { capturePrompt } = context;

  if (platform === "cursor") {
    return {
      followup_message: `Capture session lessons before finishing.\n\n${capturePrompt}`,
    };
  }

  if (supportsBlock) {
    // CLI: block stop and force capture
    const blockReason = context.blockReason || capturePrompt;
    return {
      decision: "block",
      reason: blockReason,
    };
  }

  // Cowork: best-effort non-blocking output
  const lessonsCaptured = context.lessonsCaptured || 0;
  const coworkPrefix = context.coworkPrefix || "[Cowork] Session ending.";
  const coworkDetail =
    lessonsCaptured === 0
      ? ` WARNING: No lessons captured this session. ${capturePrompt}`
      : " Periodic capture handled lesson collection.";

  return {
    hookSpecificOutput: {
      additionalContext: `${coworkPrefix} ${lessonsCaptured} lessons captured during session.${coworkDetail}`,
    },
  };
}

/**
 * Build plan feedback output for the detected platform.
 *
 * @param {object} opts
 * @param {"cursor"|"cli"|"cowork"} opts.platform - Detected platform
 * @param {boolean} opts.supportsBlock - Whether decision:block is supported
 * @param {string} opts.captureInstruction - The plan feedback capture instruction
 * @returns {object} JSON-serializable output for console.log
 */
function buildPlanFeedbackOutput({ platform, supportsBlock, captureInstruction }) {
  if (platform === "cursor") {
    return {
      followup_message: captureInstruction,
    };
  }

  if (supportsBlock) {
    return {
      decision: "block",
      reason: captureInstruction,
    };
  }

  // Cowork
  return {
    hookSpecificOutput: {
      additionalContext: `[Cowork] Session ending with uncaptured plan feedback. ${captureInstruction}`,
    },
  };
}

module.exports = {
  buildLessonOutput,
  buildPlanFeedbackOutput,
};
