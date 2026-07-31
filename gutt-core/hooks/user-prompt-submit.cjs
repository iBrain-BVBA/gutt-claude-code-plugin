#!/usr/bin/env node
/**
 * UserPromptSubmit — a router into the memory skills (GP-864) and the `/gutt-pro:*`
 * config commands (GP-866, GP-931).
 *
 * Two jobs, both deterministic. Usually it emits `additionalContext` naming a
 * skill and stops there: the behaviour lives in `skills/memory-search` and
 * `skills/memory-capture`, and this hook only decides *whether* to point at one,
 * from state, on fixed rows. The exception is row 0 — when the prompt is a
 * `/gutt-pro:*` config command, it applies the change through `lib/config-command.cjs` and emits
 * the outcome instead of a pointer.
 *
 * Row 0 lives on this event because the platform gives us nothing better: a
 * command's raw text (verified: including its arguments) arrives here before
 * expansion, and hooks are the only processes that get `CLAUDE_PLUGIN_DATA`, so
 * this is the one place that can find `config.json` without being told where it is.
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
const { init, advanceTurn, isRecallRecent } = require("./lib/session-state.cjs");
const { isSuppressed } = require("./lib/runtime-config.cjs");
const { configCommandResult } = require("./lib/config-command.cjs");
const { guard } = require("./lib/debug.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");

// Nothing to do inside a judge subprocess: its prompt is ours, not the user's, so a
// pointer would be injected into a conversation no human is reading, and
// `advanceTurn()` would spend the real session's first-prompt budget on it.
if (isNestedRun()) {
  process.exit(0);
}

/**
 * Skills are namespaced by their plugin at runtime, so the bare stem is not
 * invocable — `skill_listing` in a real session shows
 * `gutt-pro:memory-search`, not `memory-search`. Naming the stem
 * alone left the model to guess the prefix. Written without a leading slash
 * because this text is addressed to Claude, which resolves a skill by name; the
 * `/`-prefixed form is the human's way of typing it.
 *
 * `hook-architecture.test.cjs` asserts both halves of this really exist — that
 * the prefix matches the plugin's declared name and the stem matches a skill
 * directory — because a pointer at a skill that cannot be resolved is the
 * quietest failure this hook has.
 */
const SEARCH_SKILL = "gutt-pro:memory-search";

/**
 * Context for the first prompt of a new session.
 *
 * Firm, and deliberately more so than the first version, which closed with "it is
 * worth running before non-trivial work when history is likely to matter" and was
 * observed being read and skipped on a task where history plainly did matter. Two
 * stacked hedges ("worth running", "likely to matter") leave the agent deciding
 * whether history matters *before* it has looked — which is the one judgement it
 * cannot make without running the skill. So the default is inverted here: recall
 * unless the request visibly carries no history, with the exceptions named so the
 * out is concrete rather than a matter of taste.
 *
 * Firm is not the same as the framing R23/GP-868 rules out. What backfires is
 * *out-of-band command* framing — the 2.x "MANDATORY REQUIREMENT — YOU MUST" shape
 * that reads as an injected system directive and trips Claude's prompt-injection
 * defenses, surfacing the text to the user instead of acting on it. Plain
 * imperative sentences addressed to Claude are not that; the hooks reference asks
 * for factual statements over pseudo-system commands, not for hedged ones.
 *
 * The closing line is the load-bearing part: it does not add pressure, it makes an
 * unaccountable skip impossible. Silence was how the weak version failed.
 *
 * Note what that line is scoped to, because it is easy to widen by accident. It asks
 * for a visible reason only on work large enough to have history — so a trivial
 * prompt still gets a bare answer with no mention of memory in it. The fixture in
 * `tests/e2e/session-lifecycle.e2e.cjs` depends on exactly that: it sends "Reply with
 * exactly: pong" and asserts the reply matches none of /memory|gutt|skill|instruction/,
 * which is how it detects the injection being surfaced to the user instead of consumed.
 * Asking for a skip note unconditionally would make a compliant model fail that
 * assertion, and that assertion is the only live detector of the GP-868 failure mode.
 */
const SEARCH_CONTEXT =
  "This session has organizational memory available through gutt, holding context this " +
  "repository does not: prior decisions and why they were made, lessons already learned, " +
  `and how earlier attempts went. Run the \`${SEARCH_SKILL}\` skill before starting ` +
  "substantive work on this request — recall first, then act. It is a fast read-only " +
  "lookup, and what it returns regularly changes what the right answer is. Going ahead " +
  "without it is reasonable only when the request carries no history to find: a greeting, " +
  "a self-contained factual question, or a purely mechanical edit. On anything larger, " +
  "decide against recalling only out loud — one short line saying why — never silently.";

/** Context for the first prompt after a compaction, where the recap is lossy. */
const REGROUND_CONTEXT =
  "This conversation was just compacted, so earlier detail is summarized rather than " +
  "complete — including anything recalled from memory before the compaction, which the " +
  `summary keeps only as conclusions. Run the \`${SEARCH_SKILL}\` skill before continuing ` +
  "this work to re-ground the specifics it dropped, rather than proceeding from the recap.";

/**
 * The hook's whole output channel. `additionalContext` lands alongside the
 * submitted prompt; this event cannot replace the prompt, and it must never set
 * `decision` — a block here erases the user's prompt and shows the reason to them
 * rather than to Claude (R23).
 * @param {string} context
 */
function emit(context) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
    })}\n`
  );
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  // Two forms of the same string, on purpose. `rawPrompt` is what the config
  // command parser reads: truncating first would turn a long prompt into a
  // half-command, and the parser requires the tail to be exact. `prompt` is the
  // bounded copy the breadcrumb log gets.
  let rawPrompt = "";
  let prompt = "unknown";
  let sessionId = "unknown";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    rawPrompt = String(data.prompt || data.message || "unknown");
    prompt = rawPrompt.slice(0, 200);
    sessionId = data.session_id || "unknown";
  } catch {
    // Unparseable stdin still exits 0 — this hook must never block a prompt.
  }

  init(sessionId);

  guard("UserPromptSubmit", "route", () => {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendLine(statePath(LOG_FILES.invocations), `[${timestamp}] Prompt: ${prompt}`);

    // Row 0: the user typed a `/gutt-pro:*` config command (GP-866, GP-931). Apply it and report
    // the outcome; the behaviour is in `lib/config-command.cjs`.
    //
    // Above row 1 because `/gutt-pro:on` has to work while the plugin is off. Gate this
    // on suppression and the off switch becomes one-way, with hand-editing
    // config.json the only way back.
    //
    // Above `advanceTurn()` for the same reason row 1 is: a config turn is
    // bookkeeping, not conversation. Burning `firstPromptPending` on `/gutt-pro:config`
    // would cost the session its one memory pointer.
    const commandResult = configCommandResult(rawPrompt, sessionId);
    if (commandResult) {
      emit(commandResult);
      return;
    }

    // Row 1: suppressed → silent, either turned off durably or snoozed. Checked
    // before the turn is advanced, so it neither burns the one-shot flags it
    // suppressed nor counts the turns it sat out. The counter therefore measures
    // turns the plugin actually saw, which makes the row-4 window slightly wider
    // across a snooze — accepted, because the alternative is a second locked write
    // on the hot path to count turns nobody will act on.
    if (isSuppressed(sessionId)) {
      return;
    }

    // One locked transaction: advance the recall counter, consume both one-shot
    // flags. Consumed-on-read means each fires exactly once per session start /
    // compaction and cannot re-trigger on a later prompt.
    const { firstPrompt, compacted, turnsSinceSearch } = advanceTurn();

    // Row 4: the agent recalled something within the last few turns, so another
    // pointer is redundant → silent.
    //
    // This row wins over rows 2 and 3, and the flags they read are already spent by
    // the time it fires — deliberately. Deferring them instead would mean injecting
    // "this conversation was just compacted" five turns after the compaction, and a
    // directive that describes a moment which has passed is worse than none.
    //
    // Known tension, flagged for GP-890: a compaction is itself what summarizes the
    // recalled results away, so search recency is weaker evidence of freshness
    // after a compaction than before one. `beginSession` advances the counter on
    // compaction to lean against this, but one step does not fully answer it.
    if (isRecallRecent(turnsSinceSearch)) {
      return;
    }

    // Rows 2 and 3. Compaction wins when both are set: it is the more specific
    // situation.
    const context = compacted ? REGROUND_CONTEXT : firstPrompt ? SEARCH_CONTEXT : null;

    // Every other prompt → silent. Saying nothing is the common case.
    if (!context) {
      return;
    }

    emit(context);
  });

  process.exitCode = 0;
});
