/**
 * Whether the gutt MCP server's tools are currently in the model's tool list.
 *
 * The third and most direct connection signal, and the only one that can see a
 * server nobody is talking to. The other two each have a blind spot: the
 * SessionStart probe reads settings files, so it establishes configuration and
 * never reachability; tool-response observation needs a call to have happened, and
 * when a server drops, its tools leave the tool list, so no call is ever made
 * again. A transcript delta is emitted by the platform at the moment availability
 * changes, whether or not anything was using it.
 *
 * Claude Code records those changes as `attachment` entries of subtype
 * `deferred_tools_delta`, carrying `addedNames` / `removedNames` / `readdedNames`
 * (tool names) and `pendingMcpServers` (servers mid-connection).
 *
 * **Present is not the same as usable.** A connector that has not been authenticated
 * still publishes its sign-in affordance — the tools that exist precisely so the user
 * can authenticate — and nothing else. Counting those as availability is the worst
 * available answer: the HUD goes green, and the hook that watches tool traffic never
 * corrects it, because the tools it matches on are the ones that are missing. So a
 * delta whose gutt tools are *all* sign-in affordances reports `auth`, which is the
 * state the user can actually act on.
 *
 * **Read backwards and stop at the first answer.** Availability changes repeatedly
 * within one session — a server drops and comes back, and both events are in the
 * file. The newest entry is the only one that describes now; an older one read
 * first would report a disconnect the user has already fixed.
 *
 * Two limits, both deliberate:
 *
 * - The transcript is written **asynchronously and lags the live conversation**, so
 *   a change from moments ago may not be on disk yet. That delays noticing by a
 *   turn; it does not make the reading wrong, and the staleness fallback covers the
 *   window. This is the same lag that cost `stop-judge.cjs` real captures, so it is
 *   assumed here rather than hoped away.
 * - Only the tail is read. A long session's transcript reaches tens of megabytes,
 *   and this runs on the prompt path.
 */

const fs = require("node:fs");

const { debugLog } = require("./debug.cjs");

/**
 * How much of the transcript to read at a time, walking back from the end.
 *
 * Chunked rather than one fixed tail, because a fixed tail cannot be sized: the
 * answer sits wherever availability last changed, which on a busy session is
 * hundreds of kilobytes of conversation ago and on a quiet one is the previous
 * line. A 256 KB tail measured against a real 4.3 MB session missed the answer by
 * 90 KB and reported "unknown" — the degradation looks honest and is useless, since
 * a signal that abstains on every long session is not a signal.
 *
 * So: start at the end, stop at the first answer. The common case still reads one
 * chunk; only a session that genuinely has not touched gutt in a long while pays
 * for more.
 */
const CHUNK_BYTES = 256 * 1024;

/**
 * The most this will read before giving up.
 *
 * A session with no gutt server at all has no answer anywhere in its transcript, so
 * without a cap that case walks the entire file on every prompt. Bounded, it costs
 * a fixed amount and returns "unknown", which is the right answer for it anyway.
 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** Matches a gutt MCP tool name, whatever prefix the deployment gives it. */
const GUTT_TOOL = /^mcp__.*gutt.*__./i;

/** Matches a gutt MCP server's display name in `pendingMcpServers`. */
const GUTT_SERVER = /gutt/i;

/**
 * Matches the bare name of a tool that exists only to get the user authenticated.
 *
 * Tested against the segment after the last `__`, so it is independent of whatever
 * server prefix a deployment gives its tools. Matching the whole name would let a
 * real tool that merely mentions authentication read as an affordance.
 */
const AUTH_AFFORDANCE = /^(?:authenticate|complete_authentication|authorize|log_?in|sign_?in)$/i;

/**
 * Is this tool a sign-in affordance rather than a capability?
 * @param {string} name
 * @returns {boolean}
 */
function isAuthAffordance(name) {
  return AUTH_AFFORDANCE.test(name.slice(name.lastIndexOf("__") + 2));
}

/**
 * The tool-name prefix Claude Code derives from a server's display name.
 *
 * `pendingMcpServers` and `needsAuthMcpServers` hold display names ("claude.ai
 * gutt-pro-memory") while the name lists hold tool ids
 * (`mcp__claude_ai_gutt-pro-memory__search`). Correlating the two is what lets a
 * server list be read as being about *this* server rather than any gutt-shaped one.
 *
 * @param {string} displayName
 * @returns {string}
 */
function serverToolPrefix(displayName) {
  return `mcp__${displayName.replace(/[^A-Za-z0-9-]/g, "_")}__`;
}

/**
 * Does `list` name a gutt server that owns one of `toolNames`?
 *
 * More than one gutt-named server can be connected at once — a memory server and an
 * unrelated one — and they authenticate separately. Matching `/gutt/i` alone would
 * let an unauthenticated sibling speak for the server the HUD is actually about,
 * which on a real machine means a permanently amber glyph over working memory.
 *
 * Falls back to the bare name match when no tool id correlates, so a shape we cannot
 * line up degrades to the older, looser reading rather than to silence.
 *
 * The remaining imprecision, stated rather than hidden: a delta that names servers but
 * carries no tool ids has nothing to correlate against, so a sibling's auth need can
 * speak for the memory server. Replaying every `deferred_tools_delta` on a real
 * machine — 4,775 records across 4,682 sessions — that costs 4 sessions a verdict of
 * `auth` where `pending` was the truer word, and both render the same amber glyph, so
 * nothing user-visible turns on it. Distinguishing them needs a server-identity model
 * built across records, which is not worth its failure modes for a cosmetic gain.
 *
 * @param {*} list
 * @param {string[]} toolNames
 * @returns {boolean}
 */
function namesGuttServer(list, toolNames) {
  const named = (Array.isArray(list) ? list : []).filter(
    (s) => typeof s === "string" && GUTT_SERVER.test(s)
  );
  if (named.length === 0) {
    return false;
  }
  if (toolNames.length === 0) {
    return true;
  }
  return named.some((s) => toolNames.some((n) => n.startsWith(serverToolPrefix(s))));
}

/**
 * What one transcript line says about gutt, or null.
 *
 * The `includes` is a cheap reject before the parse — the overwhelming majority of
 * lines are conversation, and `JSON.parse` on each is the expensive way to learn
 * that. It is only a filter: this repo's own transcripts contain assistant messages
 * and file edits that *discuss* `deferred_tools_delta`, so the string matching
 * proves nothing and every decision below is made structurally.
 *
 * @param {string} line
 * @returns {"available"|"pending"|"absent"|null}
 */
function lineVerdict(line) {
  if (!line || !line.includes("deferred_tools_delta")) {
    return null;
  }
  try {
    return verdictFor(JSON.parse(line).attachment);
  } catch {
    // A chunk-boundary fragment, or a record shape we do not know.
    return null;
  }
}

/**
 * What one delta says about gutt, or null when it says nothing.
 *
 * `readdedNames` counts as present alongside `addedNames`: a reconnect reports the
 * tools it restored under that key, and treating it as silence would leave the
 * preceding removal as the newest answer — reporting a server as gone at the exact
 * moment it came back.
 *
 * Order matters within one entry. A single delta can both add and remove, and a
 * reconnect emits exactly that shape, so presence is checked before absence.
 *
 * Among the tools that *are* present, all-affordances means `auth` and anything else
 * means `available`. `every` rather than `some` on purpose: a server that publishes a
 * real capability is usable no matter what else it ships alongside it, and plenty of
 * authenticated servers keep a re-authentication tool in the list permanently.
 *
 * `needsAuthMcpServers` is the platform saying outright that a server wants signing in,
 * and it is checked **after** presence for a reason worth stating: real deltas routinely
 * name one gutt server there while another gutt server's tools arrive in the same
 * record. Letting the auth list win would put a permanent amber glyph over working
 * memory. Present-and-usable is the stronger claim, so it goes first.
 *
 * @param {*} attachment
 * @returns {"available"|"auth"|"pending"|"absent"|null}
 */
function verdictFor(attachment) {
  if (!attachment || attachment.type !== "deferred_tools_delta") {
    return null;
  }
  const named = (key) => (Array.isArray(attachment[key]) ? attachment[key] : []);
  const guttNamed = (key) =>
    named(key).filter((name) => typeof name === "string" && GUTT_TOOL.test(name));

  const present = [...guttNamed("addedNames"), ...guttNamed("readdedNames")];
  if (present.length > 0) {
    return present.every(isAuthAffordance) ? "auth" : "available";
  }
  const removed = guttNamed("removedNames");

  // Checked whether or not anything was removed. A server that has never been
  // authenticated publishes no tools to remove, so this is the only key that says
  // anything about it — the case the tool-traffic hook structurally cannot reach,
  // because there is no tool for it to observe a response from.
  if (namesGuttServer(attachment.needsAuthMcpServers, removed)) {
    return "auth";
  }

  if (removed.length > 0) {
    // Pending is the actionable one: a remote connector whose tools have gone and
    // which is waiting to come back is, in practice, waiting on the user.
    return namesGuttServer(attachment.pendingMcpServers, removed) ? "pending" : "absent";
  }
  return null;
}

/**
 * The most recent thing the transcript says about gutt tool availability.
 *
 * @param {string|undefined|null} transcriptPath
 * @returns {"available"|"pending"|"absent"|"unknown"}
 */
function guttToolAvailability(transcriptPath) {
  if (!transcriptPath) {
    return "unknown";
  }

  let fd;
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
    fd = fs.openSync(transcriptPath, "r");
  } catch (err) {
    debugLog("mcp-availability", `could not open transcript: ${err.message}`);
    return "unknown";
  }

  try {
    let end = size;
    let scanned = 0;
    // The head of the chunk read previously — which sits *after* this one in the
    // file — whose line began somewhere in the chunk about to be read.
    let carry = "";

    while (end > 0 && scanned < MAX_SCAN_BYTES) {
      const length = Math.min(CHUNK_BYTES, end);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, end - length);
      end -= length;
      scanned += length;

      const lines = `${buffer.toString("utf8")}${carry}`.split("\n");
      // The first line is a fragment unless this chunk reached the start of the
      // file; carry it into the next read rather than parsing half a record.
      carry = end > 0 ? lines.shift() : "";

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const verdict = lineVerdict(lines[i]);
        if (verdict !== null) {
          return verdict;
        }
      }
    }
    return "unknown";
  } catch (err) {
    debugLog("mcp-availability", `could not read transcript: ${err.message}`);
    return "unknown";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* nothing useful to do */
    }
  }
}

module.exports = {
  guttToolAvailability,
  verdictFor,
  lineVerdict,
  CHUNK_BYTES,
  MAX_SCAN_BYTES,
};
