#!/usr/bin/env node
/**
 * UserPromptSubmit — a thin router into the memory skills (GP-864).
 *
 * Emits `additionalContext` naming a skill and stops there. The behaviour lives
 * in `skills/memory-search` and `skills/memory-capture`; this hook only decides
 * *whether* to point at one, from state, on deterministic rows.
 *
 * Why a command hook and not `type: "prompt"`: a prompt hook cannot inject
 * context. Its only lever on this event is `decision: "block"`, which "prevents
 * the prompt from being processed and erases it from context", with the reason
 * shown to the user rather than to Claude — and UserPromptSubmit ends the turn on
 * block "regardless of `continue`". So a model judge here can stay silent or
 * destroy the user's prompt, and nothing in between. The judgement therefore
 * belongs to the main agent, which reads the pointer below with the whole
 * conversation in hand — strictly more context than a fast model gets from one
 * prompt string.
 *
 * Phrasing is deliberate. The hooks reference warns that text "framed as
 * out-of-band system commands can trigger Claude's prompt-injection defenses,
 * which causes Claude to surface the text to you instead of treating it as
 * context", and asks for factual statements instead. The 2.x version of this
 * hook opened with "MANDATORY REQUIREMENT — YOU MUST FOLLOW THIS INSTRUCTION",
 * which is precisely the shape that backfires (GP-868, R23).
 */

const { statePath, appendLine } = require("./lib/plugin-state.cjs");
const { LOG_FILES } = require("./lib/debug.cjs");
const { init, consumeFirstPromptPending, consumeCompacted } = require("./lib/session-state.cjs");
const { isSnoozed } = require("./lib/runtime-config.cjs");
const { guard } = require("./lib/debug.cjs");

/** Context for the first prompt of a new session. */
const SEARCH_CONTEXT =
  "This session has organizational memory available through gutt. " +
  "The `memory-search` skill recalls prior decisions, lessons, and past work on a topic; " +
  "it is worth running before non-trivial work when history is likely to matter.";

/** Context for the first prompt after a compaction, where the recap is lossy. */
const REGROUND_CONTEXT =
  "This conversation was just compacted, so earlier detail is summarized rather than complete. " +
  "The `memory-search` skill can re-ground specifics that the summary dropped.";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  let prompt = "unknown";
  let sessionId = "unknown";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    prompt = String(data.prompt || data.message || "unknown").slice(0, 200);
    sessionId = data.session_id || "unknown";
  } catch {
    // Unparseable stdin still exits 0 — this hook must never block a prompt.
  }

  init(sessionId);

  guard("UserPromptSubmit", "route", () => {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendLine(statePath(LOG_FILES.invocations), `[${timestamp}] Prompt: ${prompt}`);

    // Row 1: snoozed → silent. Checked first and before any flag is consumed, so
    // a snooze doesn't burn the one-shot flags it suppressed.
    if (isSnoozed(sessionId)) {
      return;
    }

    // Rows 2 and 3. Both flags are consumed-on-read, so each fires exactly once
    // per session start / compaction and cannot re-trigger on later prompts.
    // Compaction wins when both are set: it is the more specific situation.
    const compacted = consumeCompacted();
    const firstPrompt = consumeFirstPromptPending();
    const context = compacted ? REGROUND_CONTEXT : firstPrompt ? SEARCH_CONTEXT : null;

    // Row 4: every other prompt → silent. Saying nothing is the common case.
    if (!context) {
      return;
    }

    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
      })}\n`
    );
  });

  process.exitCode = 0;
});
