#!/usr/bin/env node
/**
 * PostToolUse — reset the recall-recency counter (GP-864, trigger-matrix row 4).
 *
 * The one thing the UserPromptSubmit guard cannot observe for itself: whether the
 * agent actually recalled anything. `hooks.json` matches this at the gutt MCP
 * server, and `isRecallTool()` decides which of that server's tools count as
 * recall — reads do, writes and schema introspection don't.
 *
 * Deliberately narrow. It writes one field and emits nothing: PostToolUse runs
 * after the tool has already returned, so there is no decision left to influence,
 * and anything printed here would land in the transcript as unexplained noise.
 *
 * Why the counter is reset here rather than counted here: only the turn boundary
 * knows a turn happened, and that is `user-prompt-submit.cjs`. This hook supplies
 * the zero; that one supplies the increments.
 */

const { init, noteMemorySearch, isRecallTool } = require("./lib/session-state.cjs");
const { guard } = require("./lib/debug.cjs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  let toolName = "";
  let sessionId = "unknown";
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, "").trim() || "{}");
    // Coerced inside the try: String() is itself fallible on a value whose
    // toString has been shadowed, and this runs before any guard.
    toolName = String(data.tool_name ?? "");
    sessionId = data.session_id || "unknown";
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

  process.exitCode = 0;
});
