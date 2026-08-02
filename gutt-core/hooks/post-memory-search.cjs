#!/usr/bin/env node
/**
 * PostToolUse — reset the recall-recency counter (GP-864, trigger-matrix row 4).
 *
 * The one thing the UserPromptSubmit guard cannot observe for itself: whether the
 * agent actually recalled anything. `isRecallTool()` decides which tools count as
 * recall — gutt reads do, writes and schema introspection don't.
 *
 * **Matched on every tool, not just gutt's**, which is a deliberate widening. This is
 * the only hook that fires while the assistant is working, so it is the only place a
 * connection change can be noticed without waiting for the user's next prompt — and a
 * server that has dropped produces no gutt calls to be matched on, which is precisely
 * why a gutt-only matcher could never see it. The cost of that reach is paid back two
 * ways: every gutt-specific action is gated on `isGuttTool()` so a Bash response is
 * never mistaken for evidence about the memory server, and the transcript walk is
 * debounced so a hot path does not become an expensive one.
 *
 * It emits nothing: PostToolUse runs after the tool has already returned, so there is
 * no decision left to influence, and anything printed here would land in the
 * transcript as unexplained noise.
 *
 * Why the counter is reset here rather than counted here: only the turn boundary
 * knows a turn happened, and that is `user-prompt-submit.cjs`. This hook supplies
 * the zero; that one supplies the increments.
 */

const {
  init,
  noteMemorySearch,
  isRecallTool,
  isGuttTool,
  classifyToolResponse,
  noteConnection,
  noteToolAvailability,
  availabilityIsFresh,
  getState,
} = require("./lib/session-state.cjs");
const { guttToolAvailability } = require("./lib/mcp-availability.cjs");
const { guard } = require("./lib/debug.cjs");
const { isNestedRun } = require("./lib/nested-run.cjs");

// The judge holds no tools, so this should never fire in a child — but the guard is
// here anyway: were it to fire, it would zero the real session's recall-recency
// counter and make the next prompt look like recall had just happened.
if (isNestedRun()) {
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  let toolName = "";
  let sessionId = "unknown";
  let toolResponse;
  let transcriptPath = null;
  let parsed = false;
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    // Coerced inside the try: String() is itself fallible on a value whose
    // toString has been shadowed, and this runs before any guard.
    toolName = String(data.tool_name ?? "");
    sessionId = data.session_id || "unknown";
    toolResponse = data.tool_response;
    transcriptPath = data.transcript_path || null;
    parsed = true;
  } catch {
    // Unparseable stdin still exits 0. A tool call must never fail because the
    // bookkeeping after it did.
  }

  init(sessionId);

  guard("PostToolUse", "note recall", () => {
    if (isRecallTool(toolName)) {
      noteMemorySearch();
    }
  });

  // Every gutt call is evidence about the connection, not just the recall ones \u2014
  // a write that comes back authenticated proves as much as a search does, and
  // this hook is matched at the server rather than at any particular tool. The
  // SessionStart probe cannot produce this: it reads settings files and a hook has
  // no way to open a socket, so "configured" was the strongest thing the HUD could
  // previously say while showing a glyph everyone reads as "connected".
  //
  // Only on a parsed payload, and only for a gutt tool. This hook is matched on
  // every tool now, so the name check is what keeps an ordinary Bash or Read
  // response from being classified as evidence about the memory connection —
  // it would come back clean and paint the glyph green on no evidence at all.
  // Unparseable stdin says nothing about the server either.
  guard("PostToolUse", "note connection", () => {
    if (parsed && isGuttTool(toolName)) {
      noteConnection(classifyToolResponse(toolResponse));
    }
  });

  // Tool-list presence, refreshed here so a change is picked up mid-turn rather
  // than waiting for the user's next prompt. This is the one hook that fires while
  // the assistant is working, which is exactly when a connection drops or a
  // just-completed sign-in takes effect.
  //
  // Debounced, because "every tool call" is a hot path and walking the transcript is
  // the only expensive thing here. The hold is asymmetric: a healthy reading stands
  // for ten minutes, anything else for five seconds. So the frequent checking happens
  // only while something is wrong and the user is watching for it to clear, and a
  // working session pays almost nothing. The per-turn hook ignores the hold entirely,
  // which is what stops a healthy reading licensing ten minutes of stale green.
  guard("PostToolUse", "tool availability", () => {
    if (!parsed || availabilityIsFresh(getState())) {
      return;
    }
    noteToolAvailability(guttToolAvailability(transcriptPath));
  });

  process.exitCode = 0;
});
