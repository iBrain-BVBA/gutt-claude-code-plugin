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

/** How much of the transcript's end to read. Bounded work on any session length. */
const TAIL_BYTES = 256 * 1024;

/** Matches a gutt MCP tool name, whatever prefix the deployment gives it. */
const GUTT_TOOL = /^mcp__.*gutt.*__./i;

/** Matches a gutt MCP server's display name in `pendingMcpServers`. */
const GUTT_SERVER = /gutt/i;

/**
 * Read the last `TAIL_BYTES` of a file as text, or null.
 *
 * Byte-sliced rather than line-read, so the first line is usually a fragment. That
 * is fine and expected: the caller parses per line and discards what will not
 * parse, and a truncated leading line is the oldest of them.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readTail(filePath) {
  let fd;
  try {
    const { size } = fs.statSync(filePath);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch (err) {
    debugLog("mcp-availability", `could not read transcript tail: ${err.message}`);
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
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
  const tail = readTail(transcriptPath);
  if (tail === null) {
    return "unknown";
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    // Cheap reject before the parse: the overwhelming majority of transcript lines
    // are conversation, and JSON.parse on each of them is the expensive way to
    // learn that.
    if (!line || !line.includes("deferred_tools_delta")) {
      continue;
    }
    let verdict = null;
    try {
      verdict = verdictFor(JSON.parse(line).attachment);
    } catch {
      // A truncated first line, or a record shape we do not know. Keep walking.
      continue;
    }
    if (verdict !== null) {
      return verdict;
    }
  }
  return "unknown";
}

module.exports = {
  guttToolAvailability,
  verdictFor,
  readTail,
  TAIL_BYTES,
};
