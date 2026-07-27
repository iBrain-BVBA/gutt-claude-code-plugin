#!/usr/bin/env node
/**
 * gutt statusline — renders connection status into the Claude Code HUD.
 *
 * Read-only and single-line by design. The 2.x statusline could chain to a
 * user-supplied `passthroughCommand` via `spawn(…, {shell: true})`, which made a
 * config pointing back at this script fork-bomb the machine; the mitigation was
 * a `GUTT_STATUSLINE_DEPTH` counter threaded through the child environment.
 * GP-844 defers every statusline extra (passthrough chaining, ticker,
 * multi-line), so the whole mechanism is gone rather than guarded — there is no
 * subprocess left to recurse.
 *
 * Counters (`mem:` / `lessons:`) are also gone: the PostToolUse hooks that fed
 * them were dropped with the HUD-counter scope, and a counter no one increments
 * renders a permanent zero, which is worse than absent.
 */

const { getState, init } = require("./lib/session-state.cjs");
const { getGroupId, isConfigured } = require("./lib/config.cjs");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  let data = {};
  try {
    // The BOM strip matters: some shells prepend one, and a bare JSON.parse then
    // throws on otherwise valid input.
    const trimmed = input.replace(/^\uFEFF/, "").trim();
    if (trimmed !== "") {
      data = JSON.parse(trimmed);
    }
  } catch {
    // Unparseable stdin still gets a status segment — the HUD should degrade,
    // not vanish.
    data = {};
  }

  init(data.session_id || "unknown");

  const state = getState();
  const groupId = getGroupId();
  const displayGroupId = groupId.length > 15 ? `${groupId.slice(0, 12)}...` : groupId;

  const statusIcon =
    state.connectionStatus === "ok" ? "🟢" : state.connectionStatus === "error" ? "🔴" : "⚪";
  const configWarning = isConfigured() ? "" : "!";
  const groupPart = displayGroupId ? ` ${displayGroupId}` : "";
  const guttSegment = `[gutt${statusIcon}${configWarning}${groupPart}]`;

  let claudeSegment = "";
  if (data.model?.display_name || data.cost?.total_cost_usd !== undefined) {
    const model = data.model?.display_name || "unknown";
    const cost =
      data.cost?.total_cost_usd !== undefined ? ` ~$${data.cost.total_cost_usd.toFixed(2)}` : "";
    claudeSegment = ` | [${model}]${cost}`;
  }

  console.log(guttSegment + claudeSegment);
  process.exitCode = 0;
});
