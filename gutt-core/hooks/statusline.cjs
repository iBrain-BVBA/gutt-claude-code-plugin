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
 * which is worse than absent. The same rule governs every segment below.
 */

const { getState, init, isObservationFresh } = require("./lib/session-state.cjs");
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
 * Ordered least-valuable-first. Recall recency goes before the group name, because
 * a user who has narrowed their terminal that far still needs to know *which graph*
 * they are writing to.
 */
const DROP_ORDER = ["recall", "group"];
const MIN_WIDTH = { recall: 60, group: 36 };

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
 *    on the user. `absent` only counts against a server that is configured; with
 *    none configured there is nothing to be disconnected from, and `!` says that.
 * 2. **The last round trip**, from an observed tool response — the only thing that
 *    can distinguish working from authenticated-but-refusing.
 * 3. **Age.** An observation nobody has refreshed stops speaking.
 *
 * @param {Object} state
 * @returns {"ok"|"auth"|"error"|"unknown"}
 */
function connectionState(state) {
  if (state.mcpToolsAvailable === "pending") {
    return "auth";
  }
  if (state.mcpToolsAvailable === "absent" && state.mcpConfigured) {
    return "error";
  }
  if (!isObservationFresh(state.connectionObservedAt)) {
    return "unknown";
  }
  const status = state.connectionStatus;
  return status === "ok" || status === "auth" || status === "error" ? status : "unknown";
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

  // Spelled out rather than left to the colour. Amber alone says "something is
  // wrong"; the word says which thing, and this is the one connection state the
  // user can actually act on.
  if (connection === "auth") {
    parts.push("auth");
  }

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

  const segments = [`[gutt ${parts.join(" ")}]`];

  // `null` means nothing has been recalled in this conversation and gates nothing;
  // `0` means a recall just happened. Only the second is worth a glyph — showing
  // ↺ with no number, or a zero that never moves, is the permanent-zero mistake.
  if (typeof state.turnsSinceSearch === "number" && visible.has("recall")) {
    segments.push(`↺${state.turnsSinceSearch}`);
  }

  let line = segments.join("  ");

  if (data.model?.display_name || data.cost?.total_cost_usd !== undefined) {
    const model = data.model?.display_name || "unknown";
    const cost =
      data.cost?.total_cost_usd !== undefined ? ` ~$${data.cost.total_cost_usd.toFixed(2)}` : "";
    line += ` | [${model}]${cost}`;
  }

  console.log(line);
  process.exitCode = 0;
});
