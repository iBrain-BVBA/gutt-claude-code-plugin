#!/usr/bin/env node
/**
 * GUTT Session State Utility
 * Shared state management for statusline and hooks
 */

const crypto = require("crypto");
const { statePath, readJson, updateJson } = require("./plugin-state.cjs");

// Runtime state lives under ${CLAUDE_PLUGIN_DATA} (R37, GP-855) — never the
// project tree. Per-session files under sessions/<session_id>.json keep
// concurrent Claude Code sessions from corrupting each other's state; falls
// back to sessions/default.json when init() was never called.
let _sessionId = null;

function getStatePath() {
  return _sessionId
    ? statePath("sessions", `${_sessionId}.json`)
    : statePath("sessions", "default.json");
}

/**
 * Sanitize a session ID for safe use in file paths.
 * Strips anything that isn't alphanumeric, underscore, or hyphen.
 *
 * Coerces rather than assuming a string. The three lifecycle hooks call init()
 * outside their guard(), so a payload with a non-string `session_id` used to
 * throw here and take the whole hook down with an uncaught TypeError — exit 1,
 * against a contract that promises exit 0 no matter what arrives on stdin.
 * Claude Code always sends a string, so this is a contract hole rather than an
 * observed failure, but it is the one input every hook touches before any guard.
 *
 * @param {*} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  let raw;
  try {
    raw = String(sessionId ?? "unknown");
  } catch {
    // String() is itself fallible. `{"toString": "x"}` is ordinary JSON, and it
    // shadows Object.prototype.toString with something not callable — ToPrimitive
    // then falls through to valueOf, which returns the object, and throws
    // "Cannot convert object to primitive value". Coercing without this catch
    // leaves exactly the uncaught TypeError the coercion was added to prevent.
    raw = "unknown";
  }
  // Trailing `|| "unknown"` catches inputs that sanitize down to nothing (""),
  // which would otherwise produce a bare ".json" state file.
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

/**
 * Initialise per-session file path.
 * Must be called early in every hook that reads/writes session state.
 * @param {string} sessionId - The session_id from Claude Code hook input
 */
function init(sessionId) {
  if (sessionId && sessionId !== "unknown") {
    _sessionId = sanitizeSessionId(sessionId);
  }
}

/**
 * A fresh session record. Built per call rather than shared, so no caller can
 * mutate a literal that every later getState() fallback would then hand out.
 * @returns {Object}
 */
function defaultState() {
  return {
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    connectionStatus: "unknown",
    lastUpdated: new Date().toISOString(),
    // Monotonic write counter — the compare-and-swap token in applyUpdate().
    rev: 0,
    // GP-863 session lifecycle. `source` is the SessionStart matcher that last
    // (re)started this session; the two flags are produced here and consumed by
    // the UserPromptSubmit command guard (GP-864).
    source: null,
    firstPromptPending: false,
    compacted: false,
    endedAt: null,
    endReason: null,
    // GP-864 row 4. `null` means "no recall call has been seen in this session",
    // which is not the same as 0 ("one just happened") and must not gate anything
    // — a fresh session has to be free to inject. Only noteMemorySearch() turns it
    // into a number.
    turnsSinceSearch: null,
    // What the last real gutt round trip came back with, and when. Distinct from
    // `mcpConfigured`, which only says a server is named in a settings file: a hook
    // cannot open a socket, so configuration is all the SessionStart probe can ever
    // establish, and a configured server that is down or unauthenticated looks
    // identical to a healthy one from there. Only an actual tool response is
    // evidence about the connection, so only an actual tool response writes these.
    connectionObservedAt: null,
    // Whether gutt's tools are in the model's tool list right now, from the
    // transcript. The one signal that survives a server nobody is calling.
    mcpToolsAvailable: "unknown",
    // When that reading was taken. Null means never, which is why the per-tool
    // path always walks once before it starts debouncing.
    mcpToolsAvailableAt: null,
  };
}

/** A gutt MCP tool, whatever prefix the deployment gives its server. */
const GUTT_TOOL_NAME = /^mcp__.*gutt.*__./i;

/**
 * Is this the name of a gutt MCP tool?
 *
 * Load-bearing now that the PostToolUse hook is matched on every tool rather than
 * on gutt's alone: without this gate, an ordinary Bash or Read response would be
 * classified and recorded as evidence about the memory connection.
 *
 * @param {*} toolName
 * @returns {boolean}
 */
function isGuttTool(toolName) {
  return GUTT_TOOL_NAME.test(typeof toolName === "string" ? toolName : "");
}

/**
 * How long a tool-availability reading stands before the hot path re-walks the
 * transcript, which is the only expensive thing either of these hooks does.
 *
 * Asymmetric on purpose. A reading of `available` is the steady state and costs
 * nothing to be slightly late about, so it is held for a long time. Every other
 * reading is a problem the user is waiting to see resolve — a sign-in they just
 * completed, a server coming back — so those re-check quickly, and the recovery
 * shows up almost immediately.
 *
 * This governs the per-tool path only. The per-turn hook ignores it and always
 * reads, so the asymmetry can never delay noticing a drop beyond the next prompt:
 * without that, a healthy reading would license ten minutes of stale green.
 */
const AVAILABILITY_HOLD_OK_MS = 10 * 60 * 1000;
const AVAILABILITY_HOLD_MS = 5 * 1000;

/**
 * Is the stored availability reading recent enough to reuse?
 *
 * @param {Object} state
 * @param {number} [now]
 * @returns {boolean}
 */
function availabilityIsFresh(state, now = Date.now()) {
  const at = Date.parse(state?.mcpToolsAvailableAt ?? "");
  if (!Number.isFinite(at) || now - at < 0) {
    return false;
  }
  const hold =
    state.mcpToolsAvailable === "available" ? AVAILABILITY_HOLD_OK_MS : AVAILABILITY_HOLD_MS;
  return now - at < hold;
}

/** Error text that names an authentication or authorization problem. */
const AUTH_PATTERN =
  /\b(unauthori[sz]ed|not authori[sz]ed|unauthenticated|authentication|re-?authenticate|access denied|forbidden|invalid (?:token|credentials|api key)|token (?:expired|invalid)|401|403)\b/i;

/**
 * The error text of a tool response, or null when it is not an error at all.
 *
 * Deliberately conservative, because the alternative is worse than useless here:
 * this runs on memory search results, and the graph itself contains episodes about
 * authentication failures. Pattern-matching the whole response body would let a
 * *successfully recalled* memory describing an auth incident flip the HUD to
 * "auth needed" — a false alarm generated by the very feature working correctly.
 *
 * So an error has to announce itself structurally: the MCP `isError` flag, an
 * explicit error field, or text that *begins* with an error marker. Anything else
 * counts as a successful round trip, which is the safe direction — a missed error
 * costs one stale glyph, a false one sends the user to re-authenticate a working
 * server.
 *
 * @param {*} toolResponse
 * @returns {string|null}
 */
function responseErrorText(toolResponse) {
  if (typeof toolResponse === "string") {
    return /^\s*(error\b|access denied|unauthori[sz]ed|forbidden)/i.test(toolResponse)
      ? toolResponse
      : null;
  }
  if (!toolResponse || typeof toolResponse !== "object") {
    return null;
  }
  const text = flattenContent(toolResponse);
  if (toolResponse.isError === true || toolResponse.is_error === true) {
    return text || "error";
  }
  if (typeof toolResponse.error === "string" && toolResponse.error.trim() !== "") {
    return toolResponse.error;
  }
  return /^\s*(error\b|access denied|unauthori[sz]ed|forbidden)/i.test(text) ? text : null;
}

/**
 * Best-effort text of an MCP response, which is either a string or `{content:[…]}`.
 * @param {*} toolResponse
 * @returns {string}
 */
function flattenContent(toolResponse) {
  if (typeof toolResponse === "string") {
    return toolResponse;
  }
  const content = toolResponse?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
  }
  return typeof content === "string" ? content : "";
}

/**
 * What a gutt tool call proves about the connection.
 *
 * `ok` on anything that is not recognisably an error: a response of any shape came
 * back, which is the one thing a settings-file read can never establish.
 *
 * @param {*} toolResponse
 * @returns {"ok"|"auth"|"error"}
 */
function classifyToolResponse(toolResponse) {
  const error = responseErrorText(toolResponse);
  if (error === null) {
    return "ok";
  }
  return AUTH_PATTERN.test(error) ? "auth" : "error";
}

/**
 * Record what a real round trip established, with the time it established it.
 *
 * The timestamp is provenance, not an expiry. The HUD used to age this out after ten
 * minutes, because a remembered success was once the only liveness signal and traffic
 * observation cannot see a server nobody is calling — when a connection drops its tools
 * leave the tool list, so nothing calls them and nothing here fires again. The tool-list
 * reading now covers that, and it is ranked above this, so the age no longer decides
 * anything: it is kept because "when did this last work" is the first question asked of a
 * HUD nobody believes, and answering it costs one field.
 *
 * @param {"ok"|"auth"|"error"} status
 * @param {number} [now]
 * @returns {Object} the persisted state
 */
function noteConnection(status, now = Date.now()) {
  return updateState((state) => {
    state.connectionStatus = status;
    state.connectionObservedAt = new Date(now).toISOString();
    return state;
  });
}

/**
 * Record whether the gutt tools are currently in the model's tool list.
 *
 * Written every prompt — including when the answer is "unknown", which retires a
 * stale `available`: holding the previous value there would make a transcript that
 * can no longer be read look like a connection that had not changed.
 *
 * **But an abstention may only retire a green.** `unknown` is not a reading, it is
 * the absence of one — the transcript could not be read, or was read to the scan cap
 * without reaching an answer — and the cap is the case that matters, because past it
 * a long session answers `unknown` on every single prompt for the rest of its life.
 * Letting that overwrite a stored `absent` deleted the one actionable thing the HUD
 * had to say: the amber "auth needed" that a real `deferred_tools_delta` had
 * established earlier in the very same transcript, replaced by a neutral glyph
 * meaning "nothing observed yet" over a server known to be gone.
 *
 * This is the same asymmetry the renderer's uncorroborated-green expiry makes, and
 * it has to exist in both places: that one governs how long a positive round trip
 * speaks for itself, this one governs whether a warning survives at all. A stale
 * warning costs one needless check. A withdrawn warning costs the instruction that
 * would have fixed the problem.
 *
 * SessionStart writes it too, but only when it has an answer: at that point the
 * transcript is usually empty or still unwritten, and an abstention there would
 * overwrite the per-prompt writer's verdict on a resumed session for no gain.
 *
 * `auth` is distinct from `absent`: the tools are in the list, but the only ones
 * there exist to get the user signed in. Nothing that watches tool traffic can
 * discover that, because the tools it matches on are the missing ones.
 *
 * @param {"available"|"auth"|"pending"|"absent"|"unknown"} availability
 * @param {number} [now] when the reading was taken; injectable for tests
 * @returns {Object} the persisted state
 */
const HELD_AGAINST_UNKNOWN = ["absent", "auth", "pending"];

function noteToolAvailability(availability, now = Date.now()) {
  return updateState((state) => {
    if (availability === "unknown" && HELD_AGAINST_UNKNOWN.includes(state.mcpToolsAvailable)) {
      // Not even the timestamp: it exists to say when this reading was taken, and
      // no reading was taken.
      return state;
    }
    state.mcpToolsAvailable = availability;
    // Stamped so the per-tool path can debounce the transcript walk, and so this
    // reading — which outranks the round trip in the HUD — can be told apart from
    // one nobody has refreshed since the session began.
    state.mcpToolsAvailableAt = new Date(now).toISOString();
    return state;
  });
}

function getState() {
  // `|| defaultState()` rather than passing it as the fallback argument: JS
  // evaluates arguments eagerly, so the latter would mint a UUID and two
  // timestamps on every read for a value used only when the file is missing.
  return readJson(getStatePath(), null) || defaultState();
}

/**
 * Read-modify-write the session file, reporting whether the write landed.
 *
 * Concurrency: Claude Code runs sibling hooks on one event **in parallel**, so
 * this file is genuinely contended — the SessionStart pair (`session-start.cjs`
 * and the `async: true` `session-connectivity.cjs`) always writes it at once.
 * Confining each hook to disjoint fields is not enough on its own: an unguarded
 * read-then-write still drops the other process's update when the two interleave.
 * Observed for real — a `claude -p` session where the connectivity probe
 * demonstrably succeeded but its `connectionStatus: "ok"` never reached disk.
 *
 * Comparing revisions cannot fix this either: a writer can confirm its own write
 * landed and still be overwritten immediately afterwards by one that started
 * later. So the whole read-modify-write runs under an exclusive lock, which is
 * the only primitive that actually serialises it (see plugin-state.updateJson).
 *
 * @param {(state: Object) => Object} updater
 * @returns {{state: Object, written: boolean}}
 */
function applyUpdate(updater) {
  return updateJson(getStatePath(), (current) => {
    // Same eager-argument reason as getState(): build the default only on a miss.
    const newState = updater(current || defaultState());
    newState.rev = (current?.rev || 0) + 1;
    newState.lastUpdated = new Date().toISOString();
    return newState;
  });
}

function updateState(updater) {
  return applyUpdate(updater).state;
}

// ---------------------------------------------------------------------------
// Recall recency (GP-864, trigger-matrix row 4)
// ---------------------------------------------------------------------------

/**
 * How many turns a recall call keeps the memory pointer suppressed. A search
 * within this many turns makes another pointer redundant — the whole reason 3.0
 * exists is that 2.x "searched way too much" (GP-844).
 */
const RECENT_SEARCH_TURNS = 5;

/** SessionStart sources that keep the existing transcript, and with it any recall. */
const KEEPS_TRANSCRIPT = new Set(["resume", "compact"]);

/**
 * Advance the counter by one, leaving `null` as `null`. `null` means no recall has
 * been seen in this conversation, and no number of turns turns that into one.
 * @param {*} current
 * @returns {number|null}
 */
function bumpTurns(current) {
  return Number.isFinite(current) ? current + 1 : null;
}

/**
 * Row 4 of the trigger matrix: is the last recall recent enough to stay silent?
 *
 * Reads as a closed interval on purpose. `advanceTurn()` bumps before the row is
 * evaluated, so the turn immediately after a recall sees 1, and 1…5 are the five
 * turns the gate covers.
 *
 * @param {*} turnsSinceSearch
 * @returns {boolean}
 */
function isRecallRecent(turnsSinceSearch) {
  return Number.isFinite(turnsSinceSearch) && turnsSinceSearch <= RECENT_SEARCH_TURNS;
}

/**
 * Does this tool call put memory *content* into the conversation?
 *
 * Prefix-matched rather than enumerated: the gutt MCP surface gains read tools
 * regularly, and an allowlist of exact names silently stops recognizing recall as
 * soon as one is added. The failure direction matters — an unrecognized tool means
 * no reset, so the gate stays open and we risk one redundant pointer, which is far
 * cheaper than wrongly silencing the search directive.
 *
 * The server-name test is re-applied here even though `hooks.json` already matches
 * on it: the matcher is configuration and can drift, and this is the assertion the
 * unit test can actually pin down.
 *
 * @param {*} toolName
 * @returns {boolean}
 */
function isRecallTool(toolName) {
  const name = typeof toolName === "string" ? toolName : "";
  if (!isGuttTool(name)) {
    return false;
  }
  const action = name.split("__").pop() || "";
  // Schema introspection reads the graph's shape, not anything remembered in it,
  // so it is the one `get_` that must not count as recall.
  if (/^get_(available_)?schemas?$/.test(action)) {
    return false;
  }
  return /^(search|fetch|find_|list_|get_)/.test(action);
}

/**
 * Record that a recall call just happened — the counter's reset, written by the
 * PostToolUse hook. 0 rather than 1: no turn has elapsed since it yet.
 * @returns {Object} the persisted state
 */
function noteMemorySearch() {
  return updateState((state) => {
    state.turnsSinceSearch = 0;
    return state;
  });
}

/**
 * Begin a turn: advance the recall counter and consume both one-shot lifecycle
 * flags in a **single** locked read-modify-write, returning everything the
 * UserPromptSubmit guard needs to pick its matrix row.
 *
 * One transaction rather than three calls for two reasons. It is the ≤50ms hot
 * path (R25) and each `consumeFlag()` took its own lock. And three separate
 * transactions can interleave with a concurrent SessionStart, burning one flag
 * against one revision of the record and reading the other against the next —
 * leaving the matrix to decide from a state that never existed.
 *
 * @returns {{firstPrompt: boolean, compacted: boolean, turnsSinceSearch: number|null}}
 */
function advanceTurn() {
  const idle = { firstPrompt: false, compacted: false, turnsSinceSearch: null };
  const snapshot = getState();
  if (
    !snapshot.firstPromptPending &&
    !snapshot.compacted &&
    !Number.isFinite(snapshot.turnsSinceSearch)
  ) {
    // Unlocked fast path, kept from consumeFlag(): no flag set and no recall yet
    // seen means there is nothing to write, which is the shape of every prompt in
    // a session that has not searched. Skipping cannot lose a flag a SessionStart
    // sets concurrently — that flag is simply consumed on the next turn instead.
    return idle;
  }
  let result = idle;
  applyUpdate((state) => {
    // Decided inside the lock. The snapshot above is unlocked, so it may be used
    // to skip work and never to report what this caller consumed: two hooks racing
    // would otherwise both read a flag as set and both claim it, and "true exactly
    // once" is the entire contract.
    result = {
      firstPrompt: Boolean(state.firstPromptPending),
      compacted: Boolean(state.compacted),
      turnsSinceSearch: bumpTurns(state.turnsSinceSearch),
    };
    state.firstPromptPending = false;
    state.compacted = false;
    state.turnsSinceSearch = result.turnsSinceSearch;
    return state;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Session lifecycle (GP-863) — SessionStart/SessionEnd own everything below.
// ---------------------------------------------------------------------------

/**
 * Record a SessionStart. `compact` is the only mid-session source, so it alone
 * sets `compacted`; every other source (startup, resume, clear, fork, and any
 * matcher Claude Code adds later) is a session (re)start and arms
 * `firstPromptPending`.
 *
 * Deliberately leaves `connectionStatus` untouched. Its sole writer is
 * `noteConnection()`, from the PostToolUse hook, because only an observed round trip
 * is evidence about a connection — the async connectivity hook runs in parallel and
 * writes the *configuration* fields, having stopped writing this one precisely so a
 * settings-file read could no longer render as a green light.
 *
 * @param {string} sessionId
 * @param {string} [source] - SessionStart matcher from the hook payload
 * @returns {Object} the persisted state
 */
function beginSession(sessionId, source) {
  const compacted = source === "compact";
  return updateState((state) => {
    state.sessionId = sessionId;
    state.source = source || null;
    if (compacted) {
      state.compacted = true;
      // A compaction is distance from the last recall in the same sense a turn is
      // — it is the event that summarizes those results away — so it advances the
      // counter rather than leaving it frozen where the last prompt left it.
      state.turnsSinceSearch = bumpTurns(state.turnsSinceSearch);
    } else {
      state.startedAt = new Date().toISOString();
      state.firstPromptPending = true;
      state.endedAt = null;
      state.endReason = null;
      if (!KEEPS_TRANSCRIPT.has(source)) {
        // `startup` and `clear` begin a conversation with no context, so whatever
        // was recalled before is not in it and must not gate the first prompt.
        // `resume` and `compact` keep the transcript, so a recent recall is still
        // there and the gate rightly applies. An unrecognized source resets, which
        // fails toward injecting a redundant pointer rather than toward silence.
        state.turnsSinceSearch = null;
      }
    }
    return state;
  });
}

/**
 * Record a SessionEnd. The file is finalized rather than deleted so the
 * statusline and the next SessionStart can still read the last known state; the
 * 24h sweep reclaims it.
 *
 * Ordering guard: `/clear` fires SessionEnd and SessionStart as two separate
 * processes with no completion ordering between them, both targeting this same
 * record. If the SessionEnd lands second it stamps `endedAt` on a session that
 * is already running — the HUD reads a dead session, and `firstPromptPending`
 * is cleared before the new session's first prompt ever arrives, so the memory
 * pointer never fires. The lock in applyUpdate() serialises the two writes but
 * says nothing about which one *should* win; mutual exclusion is not ordering.
 *
 * So compare against when this process was dispatched: a `startedAt` newer than
 * that belongs to a session which began after this SessionEnd was issued, and
 * is not ours to close.
 *
 * @param {string} [reason] - SessionEnd reason from the hook payload
 * @param {number} [dispatchedAt] - epoch ms at which this SessionEnd was issued
 * @returns {Object} the persisted state
 */
function finalizeSession(reason, dispatchedAt = Date.now()) {
  return updateState((state) => {
    // Compared inside the lock, against the same read the write is based on: an
    // unlocked pre-check could pass on a record that beginSession() replaces
    // before this updater ever runs.
    //
    // A missing or corrupt `startedAt` parses to NaN and every comparison with
    // NaN is false, so it falls through and finalizes — fail-open, matching the
    // ordinary case this guard is carving an exception out of.
    if (Date.parse(state.startedAt) > dispatchedAt) {
      return state;
    }
    state.endedAt = new Date().toISOString();
    state.endReason = reason || "other";
    state.firstPromptPending = false;
    state.compacted = false;
    return state;
  });
}

// The per-flag `consumeFlag` / `consumeFirstPromptPending` / `consumeCompacted`
// trio lived here until GP-864 row 4 landed. `advanceTurn()` above replaced all
// three: it has to write on every turn anyway to advance the recall counter, so
// consuming the flags in that same locked transaction is both cheaper than three
// separate ones and the only version that cannot read the two flags against two
// different revisions of the record. They are deleted rather than kept for
// symmetry — nothing called them, and a test suite that exercises code no hook
// reaches reports coverage of behaviour that cannot occur.

module.exports = {
  init,
  sanitizeSessionId,
  getState,
  updateState,
  applyUpdate,
  getStatePath,
  defaultState,
  // GP-863 session lifecycle
  beginSession,
  finalizeSession,
  // GP-864 recall recency (trigger-matrix row 4)
  advanceTurn,
  noteMemorySearch,
  isRecallRecent,
  isRecallTool,
  isGuttTool,
  availabilityIsFresh,
  AVAILABILITY_HOLD_OK_MS,
  AVAILABILITY_HOLD_MS,
  RECENT_SEARCH_TURNS,
  // GP-867 connection observation — what a real round trip proved, and when
  classifyToolResponse,
  responseErrorText,
  noteConnection,
  noteToolAvailability,
};
