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
 * @param {*} attachment
 * @returns {"available"|"pending"|"absent"|null}
 */
function verdictFor(attachment) {
  if (!attachment || attachment.type !== "deferred_tools_delta") {
    return null;
  }
  const named = (key) => (Array.isArray(attachment[key]) ? attachment[key] : []);
  const gutt = (key) => named(key).some((name) => typeof name === "string" && GUTT_TOOL.test(name));

  if (gutt("addedNames") || gutt("readdedNames")) {
    return "available";
  }
  if (gutt("removedNames")) {
    const pending = Array.isArray(attachment.pendingMcpServers) ? attachment.pendingMcpServers : [];
    // Pending is the actionable one: a remote connector whose tools have gone and
    // which is waiting to come back is, in practice, waiting on the user.
    return pending.some((s) => typeof s === "string" && GUTT_SERVER.test(s)) ? "pending" : "absent";
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
