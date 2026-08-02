/**
 * Reading gutt tool availability out of the session transcript.
 *
 * The signal that survives a server nobody is calling: when a connection drops,
 * its tools leave the model's tool list and no hook that watches tool traffic will
 * ever fire again. The platform records the change either way.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, beforeEach, afterEach } = require("node:test");

const { guttToolAvailability, verdictFor, TAIL_BYTES } = require(
  path.join(__dirname, "..", "gutt-core", "hooks", "lib", "mcp-availability.cjs")
);

let sandbox;
let transcript;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-availability-"));
  transcript = path.join(sandbox, "session.jsonl");
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** One `deferred_tools_delta` record, in the shape Claude Code writes. */
function delta({ added = [], removed = [], readded = [], pending = [] }) {
  return JSON.stringify({
    type: "attachment",
    attachment: {
      type: "deferred_tools_delta",
      addedNames: added,
      addedLines: [],
      removedNames: removed,
      readdedNames: readded,
      pendingMcpServers: pending,
    },
  });
}

/** An ordinary conversation line, the overwhelming majority of any transcript. */
function chatter(text) {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

function write(lines) {
  fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
}

const GUTT_TOOLS = [
  "mcp__claude_ai_gutt-pro-memory__search_memory_facts",
  "mcp__claude_ai_gutt-pro-memory__search_memory_nodes",
];

describe("reading gutt tool availability from a transcript", () => {
  it("reports available when the tools were added", () => {
    write([chatter("hello"), delta({ added: GUTT_TOOLS })]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("reports pending when the tools went away and the server is reconnecting", () => {
    write([
      delta({ added: GUTT_TOOLS }),
      delta({ removed: GUTT_TOOLS, pending: ["claude.ai gutt-pro-memory"] }),
    ]);
    assert.equal(guttToolAvailability(transcript), "pending");
  });

  it("reports absent when the tools went away with nothing pending", () => {
    write([delta({ added: GUTT_TOOLS }), delta({ removed: GUTT_TOOLS })]);
    assert.equal(guttToolAvailability(transcript), "absent");
  });

  it("takes the newest answer, so a reconnect beats the disconnect before it", () => {
    // The whole reason this reads backwards. Availability changes repeatedly within
    // one session, and both events stay in the file forever; reading forwards would
    // report a drop the user has already fixed.
    write([
      delta({ added: GUTT_TOOLS }),
      chatter("working"),
      delta({ removed: GUTT_TOOLS, pending: ["claude.ai gutt-pro-memory"] }),
      chatter("user reconnects it"),
      delta({ added: GUTT_TOOLS, readded: GUTT_TOOLS }),
    ]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("treats a reconnect's readded tools as present, not as silence", () => {
    // A reconnect reports restored tools under `readdedNames`. Ignoring that key
    // would leave the preceding removal as the newest answer — reporting the server
    // as gone at the exact moment it came back.
    write([
      delta({ removed: GUTT_TOOLS, pending: ["claude.ai gutt-pro-memory"] }),
      delta({ readded: GUTT_TOOLS }),
    ]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("ignores deltas about other servers entirely", () => {
    write([
      delta({ added: GUTT_TOOLS }),
      delta({ removed: ["mcp__claude_ai_Atlassian__search"], pending: ["claude.ai Atlassian"] }),
    ]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("says unknown rather than guessing when there is nothing to go on", () => {
    write([chatter("no deltas here at all")]);
    assert.equal(guttToolAvailability(transcript), "unknown");
  });

  it("says unknown for a missing or unnamed transcript", () => {
    assert.equal(guttToolAvailability(path.join(sandbox, "nope.jsonl")), "unknown");
    assert.equal(guttToolAvailability(null), "unknown");
    assert.equal(guttToolAvailability(undefined), "unknown");
    assert.equal(guttToolAvailability(""), "unknown");
  });

  it("survives a transcript full of unparseable lines", () => {
    write(["{ not json", "", "also not json", delta({ added: GUTT_TOOLS })]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("reads only the tail, and is not defeated by the truncated first line", () => {
    // Byte-slicing the end of a large file usually cuts a line in half. That line
    // must be discarded without taking the walk down with it.
    const filler = Array.from({ length: 4000 }, (_, i) => chatter(`padding line ${i} `.repeat(20)));
    write([delta({ removed: GUTT_TOOLS }), ...filler, delta({ added: GUTT_TOOLS })]);
    assert.ok(fs.statSync(transcript).size > TAIL_BYTES, "fixture must exceed the tail window");
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("says unknown when the only answer is older than the tail window", () => {
    // Honest degradation: the answer exists but is out of reach, and inventing one
    // would be worse than admitting the window was too small.
    const filler = Array.from({ length: 4000 }, (_, i) => chatter(`padding line ${i} `.repeat(20)));
    write([delta({ added: GUTT_TOOLS }), ...filler]);
    assert.equal(guttToolAvailability(transcript), "unknown");
  });
});

describe("classifying a single delta", () => {
  it("prefers presence over absence within one record", () => {
    // A reconnect emits both at once, so the order inside the check is load-bearing.
    assert.equal(
      verdictFor({
        type: "deferred_tools_delta",
        addedNames: GUTT_TOOLS,
        removedNames: GUTT_TOOLS,
      }),
      "available"
    );
  });

  it("says nothing about records it does not recognise", () => {
    for (const attachment of [
      null,
      undefined,
      {},
      { type: "something_else", addedNames: GUTT_TOOLS },
      { type: "deferred_tools_delta" },
      { type: "deferred_tools_delta", addedNames: "not an array" },
    ]) {
      assert.equal(verdictFor(attachment), null, `should abstain on ${JSON.stringify(attachment)}`);
    }
  });
});
