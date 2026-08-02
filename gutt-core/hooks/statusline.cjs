#!/usr/bin/env node
/**
 * gutt statusline — renders connection and configuration state into the HUD.
 *
 * Read-only, single-line, no subprocess. Everything it shows it already has: the
 * session record on disk, the runtime config, and the payload Claude Code hands it
 * on stdin. It never calls MCP, never reaches the network, and never writes — this
 * runs on a 300ms debounce, so anything expensive here is expensive hundreds of
 * times a session.
 *
 * How it gets invoked at all is a separate problem with its own module: a plugin
 * cannot ship a `statusLine`, so lib/statusline-install.cjs puts one in the user's
 * settings when they ask for it. Nothing in this file assumes it is running.
 *
 * The 2.x renderer chained to a user-supplied `passthroughCommand` via
 * `spawn(…, {shell: true})`, which made a config pointing back at this script
 * fork-bomb the machine. That whole mechanism is gone rather than guarded — there
 * is no subprocess left to recurse. Its counters are gone too: the hooks that fed
 * them were deleted, and a counter nobody increments renders a permanent zero,
 * which is worse than absent.
 *
 * Two later segments were cut for the harder reason: they worked and were still not
 * worth their width. Turns-since-recall counted correctly and told nobody anything
 * they acted on. Session cost was worse than useless — the figure is an API price,
 * so a subscription user was shown a bill they will never be charged, refreshed a
 * few times a second. The bar is narrow and every segment on it has to earn the
 * space by changing what the user does next.
 */

const { getState, init } = require("./lib/session-state.cjs");
const { getGroupId } = require("./lib/config.cjs");
const { readConfig, isSnoozed, snoozeDeadline } = require("./lib/runtime-config.cjs");

/**
 * Widths below which trailing segments start dropping.
 *
 * Claude Code captures stdout rather than attaching a terminal, so `tput cols` and
 * language-level width detection see nothing; `COLUMNS` is what it sets for us.
 * Absent (older CLI, or a non-terminal harness) means no constraint is known, and
 * guessing a narrow one would hide information from someone with a wide terminal —
 * so the default is to show everything.
 *
 * Ordered least-valuable-first. Only the two informational segments drop; everything
 * else on the line either reports a fault or names the fix, and none of that should
 * vanish because a window got smaller. Context usage goes before the group name,
 * because a user who has narrowed this far still needs to know *which graph* they are
 * writing to, and Claude Code reports context elsewhere in its own UI.
 */
const DROP_ORDER = ["context", "group"];
const MIN_WIDTH = { context: 60, group: 36 };

/**
 * Terminal width, or null when it cannot be determined.
 * @returns {number|null}
 */
function terminalWidth() {
  const raw = Number.parseInt(process.env.COLUMNS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Which optional segments fit.
 * @param {number|null} width
 * @returns {Set<string>}
 */
function visibleSegments(width) {
  const visible = new Set(DROP_ORDER);
  if (width === null) {
    return visible;
  }
  for (const name of DROP_ORDER) {
    if (width < MIN_WIDTH[name]) {
      visible.delete(name);
    }
  }
  return visible;
}

/**
 * `off`, a snooze with its deadline, or `on`.
 *
 * A durable `/gutt-pro:disable` is otherwise invisible: it survives restarts,
 * nothing else reports it, and a user who forgot they typed it just sees a plugin
 * that stopped working. The two suppressed states are distinguished because the
 * recovery differs — a snooze lapses on its own, a durable off waits for
 * `/gutt-pro:on` — and the snooze carries its deadline for the same reason, so
 * "when does this come back" is answered without running a command.
 *
 * One config read, unlike the 2.x version's two. That mattered less here than on
 * the prompt path, but this runs on every debounce tick and the read is not free.
 *
 * @param {{enabled: boolean, snoozeUntil: string|null, snoozeSessionId: string|null}} config
 * @param {string|null} sessionId
 * @returns {string}
 */
function suppressionLabel(config, sessionId) {
  if (config.enabled === false) {
    return "off";
  }
  if (!isSnoozed(sessionId, Date.now(), config)) {
    return "on";
  }
  const deadline = snoozeDeadline(config);
  if (!deadline) {
    // Session-scoped snooze: no clock to show, it ends when the session does.
    return "zzz";
  }
  const hh = String(deadline.getHours()).padStart(2, "0");
  const mm = String(deadline.getMinutes()).padStart(2, "0");
  return `zzz→${hh}:${mm}`;
}

/**
 * Reconcile the three connection signals into one answer.
 *
 * They are ranked by how directly each observes the thing the user is asking
 * about, and the order matters because they disagree:
 *
 * 1. **Tool availability**, from the transcript. The only signal that can see a
 *    server nobody is calling, so it outranks the others — once gutt's tools have
 *    left the tool list, the last successful call says nothing about now, however
 *    recent it was. `pending` is reported as `auth` because a remote connector
 *    whose tools have gone and which is waiting to return is, in practice, waiting
 *    on the user. `auth` is reported as itself: a server publishing only its sign-in
 *    affordance is reachable and unusable at once, and it is the one case the
 *    round-trip signal below structurally cannot reach — there is no tool to call, so
 *    no response to classify, so `connectionStatus` stays wherever it was.
 *    `absent` reports `auth` as well, for the same practical reason `pending` does. A
 *    remote connector whose authentication has lapsed does not announce it — Claude
 *    Code simply withdraws the tools and leaves `needsAuthMcpServers` empty — so a bare
 *    removal is what an expired connection actually looks like from here. Signing in is
 *    the action that fixes it, and naming that action beats a red light that only says
 *    something is broken. Red is left to mean what only a real call can establish: the
 *    server answered, and answered with a failure that signing in would not fix.
 *    `absent` only counts against a server that is configured; with
 *    none configured there is nothing to be disconnected from, and `!` says that.
 * 2. **The last round trip**, from an observed tool response — the only thing that
 *    can distinguish working from authenticated-but-refusing.
 *
 * There is deliberately no third rung ageing the round trip out. It used to expire
 * after ten minutes, which meant a session that had simply not touched memory for a
 * while reported itself as unknown — the HUD going neutral on a healthy setup, with
 * nothing wrong and nothing for the user to do about it. That expiry was carrying the
 * whole burden of "is this still true" back when a remembered call was the only
 * liveness signal there was. It no longer is: the tool list above is a statement about
 * the present, it is rewritten every prompt, and it is ranked higher, so a server that
 * has gone is reported as gone regardless of how recently something last worked.
 *
 * What that costs, stated plainly: when the tool list cannot be read at all, an old
 * success speaks for a server that may since have died. That window is the price of not
 * crying wolf on every quiet session, and it closes the moment the transcript becomes
 * readable again.
 *
 * @param {Object} state
 * @returns {"ok"|"auth"|"error"|"unknown"}
 */
function connectionState(state) {
  if (state.mcpToolsAvailable === "pending" || state.mcpToolsAvailable === "auth") {
    return "auth";
  }
  if (state.mcpToolsAvailable === "absent" && state.mcpConfigured) {
    return "auth";
  }
  const status = state.connectionStatus;
  return status === "ok" || status === "auth" || status === "error" ? status : "unknown";
}

/**
 * Context-window usage as a whole percentage, or null when the payload does not say it.
 *
 * Validated rather than trusted, which is the lesson the removed cost segment taught at
 * the user's expense: `toFixed` on a `total_cost_usd` that arrived as a string threw, and
 * a status line that throws prints nothing at all, so one malformed field blanked the
 * whole HUD several times a second. Every arithmetic read of this payload is now gated on
 * `Number.isFinite` first.
 *
 * Rounded, because a bar that refreshes on a 300ms debounce does not need decimals and
 * 38.4% and 38.6% are the same fact. Clamped, because a figure outside 0–100 reads as a
 * bug in the HUD rather than in the payload — while 0 is a real reading and prints.
 *
 * @param {*} contextWindow the payload's `context_window`, whatever it actually holds
 * @returns {number|null}
 */
function contextPercent(contextWindow) {
  const used = contextWindow?.used_percentage;
  return Number.isFinite(used) ? Math.min(100, Math.max(0, Math.round(used))) : null;
}

/**
 * The connection glyph, from the last observed round trip.
 *
 * Green has to be *earned by a real call*. It used to be set from a settings-file
 * read at session start, which could only ever establish that a server was
 * configured — so a server that was down, or that had lost its authentication,
 * rendered exactly like a healthy one, indefinitely, and the one glyph a user reads
 * as "is memory working" was the one that could not tell them.
 *
 * ⚪ covers both "nothing seen yet" and "nothing seen lately", and stays neutral
 * rather than red for the latter: plenty of healthy sessions go a while without
 * touching memory, and crying wolf would train the glyph to be ignored.
 *
 * @param {"ok"|"auth"|"error"|"unknown"} connection
 * @returns {string}
 */
function connectionGlyph(connection) {
  if (connection === "ok") {
    return "🟢";
  }
  if (connection === "auth") {
    return "🟡";
  }
  return connection === "error" ? "🔴" : "⚪";
}

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

  const sessionId = data.session_id || "unknown";
  init(sessionId);

  const state = getState();
  const config = readConfig();
  const visible = visibleSegments(terminalWidth());

  const connection = connectionState(state);
  const parts = [connectionGlyph(connection), suppressionLabel(config, sessionId)];

  // Mode is only worth the width when it is not the default. `hitl` changes what
  // happens at the end of every turn and the user needs to see it; `auto` is what
  // they already expect, and printing it on every session teaches nothing.
  if (config.mode && config.mode !== "auto") {
    parts.push(config.mode);
  }

  // The genuine "you have not set this up" signal. It used to be driven by
  // `isConfigured()`, which asks whether a group_id is set *locally* — but the
  // normal path resolves the group from MCP auth and leaves it empty, so a
  // correctly configured session was told it was broken. The probe's own verdict
  // is the honest source, and `mcpConfigured` is undefined until it lands, which
  // is not the same as false.
  if (state.mcpConfigured === false) {
    parts.push("!");
  }

  const groupId = getGroupId();
  if (groupId && visible.has("group")) {
    parts.push(groupId.length > 15 ? `${groupId.slice(0, 12)}...` : groupId);
  }

  // Spelled out rather than left to the colour, and last so it reads as a clause
  // rather than as one more label: amber alone says "something is wrong", this says
  // which thing and that the user is the one who can fix it. It sits after the group
  // deliberately — the group drops on a narrow terminal and this never does, so the
  // alert ends up terminal exactly where it matters most.
  if (connection === "auth") {
    parts.push("- auth needed!");
  }

  let line = `[gutt ${parts.join(" ")}]`;

  // What Claude Code knows about its own session, after the gutt block rather than
  // inside it: the model it is running and how much of the context window is spent.
  // Cost used to sit here and is now read by nobody — the figure is an API price, so a
  // subscription user was shown a bill they will never be charged. `turnsSinceSearch`
  // is still tracked, because the prompt-path recall pointer is gated on it; it is
  // simply no longer worth width on the bar.
  const tail = [];
  if (data.model?.display_name) {
    tail.push(`[${data.model.display_name}]`);
  }
  const contextUsed = visible.has("context") ? contextPercent(data.context_window) : null;
  if (contextUsed !== null) {
    tail.push(`ctx ${contextUsed}%`);
  }
  if (tail.length > 0) {
    line += ` | ${tail.join(" ")}`;
  }

  console.log(line);
  process.exitCode = 0;
});
