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
 * How long a round trip speaks for the connection when nothing corroborates it.
 *
 * Applies only to a green reading with no tool-list answer behind it — see
 * `connectionState`. With an answer this is never consulted, so a healthy quiet
 * session stays green indefinitely, which is why the old unconditional expiry went.
 */
const UNCORROBORATED_TTL_MS = 10 * 60 * 1000;

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
 *    `absent` is suppressed only when the probe positively reported *no* server
 *    configured — there is then nothing to be disconnected from, and `!` says that.
 *    A probe that could not tell (`null`) does not suppress it, which is why the test
 *    is `!== false` rather than a truthiness check: a probe that threw would otherwise
 *    silence a real disconnection, and the round-trip rung below would then answer from
 *    the last successful call, painting a dead server green.
 * 2. **The last round trip**, from an observed tool response — the only thing that
 *    can distinguish working from authenticated-but-refusing.
 *
 * The round trip does not age out **while the tool list corroborates it**. It used to
 * expire after ten minutes unconditionally, which meant a session that had simply not
 * touched memory for a while reported itself as unknown — the HUD going neutral on a
 * healthy setup, with nothing wrong and nothing for the user to do about it. That
 * expiry was carrying the whole burden of "is this still true" back when a remembered
 * call was the only liveness signal there was. It no longer is: the tool list above is
 * a statement about the present, it is rewritten every prompt, and it is ranked higher,
 * so a server that has gone is reported as gone regardless of how recently something
 * last worked.
 *
 * **When the tool list abstains, that burden falls back — for green alone.** An
 * `unknown` availability means the transcript could not be read, or was read to the
 * scan cap without finding an answer, and the latter is not hypothetical: past the cap
 * a long session answers `unknown` on every prompt, which overwrites a stored `absent`.
 * Without a floor here the pre-drop success would then speak for the server for the
 * rest of the session, leaving the HUD confidently green over a connection that is
 * gone. So an uncorroborated `ok` that nobody has refreshed inside the window lapses to
 * neutral, which is the true statement there: nothing can currently establish anything.
 *
 * @param {Object} state
 * @param {number} [now]
 * @returns {"ok"|"auth"|"error"|"unknown"}
 */
function connectionState(state, now = Date.now()) {
  if (state.mcpToolsAvailable === "pending" || state.mcpToolsAvailable === "auth") {
    return "auth";
  }
  if (state.mcpToolsAvailable === "absent" && state.mcpConfigured !== false) {
    return "auth";
  }
  const status = state.connectionStatus;
  if (status !== "ok" && status !== "auth" && status !== "error") {
    return "unknown";
  }
  if (status !== "ok" || state.mcpToolsAvailable === "available") {
    // Either the tool list corroborates the server being there — in which case the
    // round trip only has to say *how* it is, and its age is irrelevant to that — or
    // the reading is a warning, and warnings are left standing.
    //
    // The asymmetry is deliberate, and it is the one the availability hold already
    // makes: a stale warning costs the user one needless check, while a stale green
    // costs them a memory system that stopped working behind a HUD still saying it
    // had not. Only the confident positive has to keep earning itself. Withdrawing an
    // `auth` or `error` on a timer would also delete the one instruction the user
    // could have acted on, and neither becomes untrue by going unattended.
    return status;
  }
  // A green with nothing corroborating it. The round trip is the only signal left, so
  // it has to carry its own staleness again.
  const observed = Date.parse(state.connectionObservedAt ?? "");
  return Number.isFinite(observed) && now - observed < UNCORROBORATED_TTL_MS ? status : "unknown";
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
 * The connection glyph, from the reconciled verdict `connectionState` produces.
 *
 * Not "from the last round trip" — that is only the lower-ranked of its two inputs.
 * The tool list outranks it, so a server whose tools have gone renders amber however
 * recently a call last succeeded.
 *
 * Green has to be *earned by a real call*. It used to be set from a settings-file
 * read at session start, which could only ever establish that a server was
 * configured — so a server that was down, or that had lost its authentication,
 * rendered exactly like a healthy one, indefinitely, and the one glyph a user reads
 * as "is memory working" was the one that could not tell them.
 *
 * ⚪ means nothing could be established: no round trip has been seen, or the only one
 * that has is both old and uncorroborated. It stays neutral rather than red, because
 * plenty of healthy sessions go a while without touching memory and crying wolf would
 * train the glyph to be ignored.
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

/**
 * A payload value as display text, or null when it is not usable as text.
 *
 * `String()` is itself fallible: `{"toString": "x"}` is ordinary JSON that shadows
 * `Object.prototype.toString` with something not callable, so ToPrimitive falls
 * through to `valueOf`, gets the object back, and throws. Interpolating such a value
 * into a template literal throws in exactly the same way — and a throw here prints
 * nothing at all. `session-state.cjs` defends its session-id read against this same
 * shape; every read of externally-supplied text needs the same care.
 *
 * Only strings and finite numbers are accepted. Anything else has no sensible
 * rendering — an object would have printed `[object Object]`, which is noise
 * occupying width a real segment could have used.
 *
 * @param {*} value
 * @returns {string|null}
 */
function text(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value !== "" ? value : null;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

/**
 * The stdin payload as an object, whatever actually arrived.
 * @param {string} raw
 * @returns {Object}
 */
function readPayload(raw) {
  let data = {};
  try {
    // The BOM strip matters: some shells prepend one, and a bare JSON.parse then
    // throws on otherwise valid input.
    const trimmed = raw.replace(/^\uFEFF/, "").trim();
    if (trimmed !== "") {
      // Checked for shape, not just for syntax. `JSON.parse("null")` *succeeds*, so a
      // catch around the parse never fires and the null flows into the render, where
      // the first property read throws, printing nothing at all several times a
      // second. Scalars and arrays parse just as happily and are equally not
      // something to read fields off.
      const value = JSON.parse(trimmed);
      data = value && typeof value === "object" ? value : {};
    }
  } catch {
    // Unparseable stdin still gets a status segment — the HUD should degrade,
    // not vanish.
    data = {};
  }
  return data;
}

/**
 * The whole line, from a payload.
 * @param {Object} data
 * @returns {string}
 */
function render(data) {
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
  const mode = text(config.mode);
  if (mode && mode !== "auto") {
    parts.push(mode);
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

  const groupId = text(getGroupId());
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
  const model = text(data.model?.display_name);
  if (model) {
    tail.push(`[${model}]`);
  }
  const contextUsed = visible.has("context") ? contextPercent(data.context_window) : null;
  if (contextUsed !== null) {
    tail.push(`ctx ${contextUsed}%`);
  }
  if (tail.length > 0) {
    line += ` | ${tail.join(" ")}`;
  }

  return line;
}

/**
 * The last resort, and the reason this file has one at all.
 *
 * A status line that throws prints *nothing* — not a degraded line, no line — and it
 * is re-run on a 300ms debounce, so one bad field blanks the whole HUD many times a
 * second. That happened once: a cost figure arriving as a string threw on a numeric
 * call, and the only try/catch in the file was around the JSON parse, which had
 * succeeded.
 *
 * The lesson was not "validate cost". It was that a safety net belongs around the
 * whole unit of work whose output is contractually required, not around whichever
 * operation looked risky at the time. Every field above is validated at the point of
 * read, which is what keeps the *content* honest; this is what keeps the line present
 * on the day a validation is missed. It renders the neutral glyph, which is the true
 * statement when nothing could be established.
 */
process.stdin.on("end", () => {
  let line;
  try {
    line = render(readPayload(input));
  } catch {
    line = `[gutt ${connectionGlyph("unknown")}]`;
  }
  console.log(line);
  process.exitCode = 0;
});
