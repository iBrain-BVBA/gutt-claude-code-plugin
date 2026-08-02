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

const { guttToolAvailability, verdictFor, CHUNK_BYTES, MAX_SCAN_BYTES } = require(
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

  it("keeps reading back past the first chunk to reach the answer", () => {
    // The bug a fixed 256 KB tail actually shipped with: measured against a real
    // 4.3 MB session, the last availability change sat 340 KB from the end and the
    // reader reported "unknown". A signal that abstains on every long session is
    // not a signal, so it now walks back until it finds something.
    const filler = Array.from({ length: 4000 }, (_, i) => chatter(`padding line ${i} `.repeat(20)));
    write([delta({ added: GUTT_TOOLS }), ...filler]);
    assert.ok(
      fs.statSync(transcript).size > CHUNK_BYTES * 2,
      "fixture must span several chunks for this to prove anything"
    );
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("stitches a record that straddles a chunk boundary", () => {
    // Chunks are byte-sliced, so a record is routinely cut in half. Parsing the
    // fragment would silently drop the one answer in the file.
    const pad = (n) => Array.from({ length: n }, (_, i) => chatter(`line ${i} `.repeat(30)));
    // Enough filler either side that the delta cannot land neatly on a boundary.
    write([...pad(600), delta({ added: GUTT_TOOLS }), ...pad(600)]);
    assert.ok(fs.statSync(transcript).size > CHUNK_BYTES, "fixture must exceed one chunk");
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("is not fooled by conversation that merely discusses the record type", () => {
    // This plugin's own transcripts contain assistant messages and file edits about
    // `deferred_tools_delta`, which is why the string match is a filter and every
    // decision is made structurally.
    write([
      delta({ removed: GUTT_TOOLS, pending: ["claude.ai gutt-pro-memory"] }),
      chatter("the deferred_tools_delta attachment carries addedNames for gutt tools"),
      JSON.stringify({
        type: "attachment",
        attachment: { type: "edited_text_file", content: "deferred_tools_delta gutt addedNames" },
      }),
    ]);
    assert.equal(guttToolAvailability(transcript), "pending");
  });

  it("gives up rather than walking an unbounded file forever", () => {
    assert.ok(MAX_SCAN_BYTES > CHUNK_BYTES, "the cap has to leave room for real sessions");
    const pad = Array.from({ length: 3000 }, (_, i) => chatter(`line ${i} `.repeat(30)));
    write(pad);
    // No delta anywhere: the honest answer, reached without reading the file twice.
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
