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
function delta({ added = [], removed = [], readded = [], pending = [], needsAuth = [] }) {
  return JSON.stringify({
    type: "attachment",
    attachment: {
      type: "deferred_tools_delta",
      addedNames: added,
      addedLines: [],
      removedNames: removed,
      readdedNames: readded,
      pendingMcpServers: pending,
      needsAuthMcpServers: needsAuth,
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

/**
 * What an unauthenticated gutt connector publishes: the sign-in affordance, and
 * nothing that can answer a question.
 */
const GUTT_AUTH_TOOLS = [
  "mcp__claude_ai_gutt-poab-mcp__authenticate",
  "mcp__claude_ai_gutt-poab-mcp__complete_authentication",
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

  it("reports auth when the only gutt tools present are the sign-in affordance", () => {
    // The case that used to render green. An unauthenticated connector is reachable
    // and useless at once, and the PostToolUse hook cannot correct the HUD because
    // the tools it matches on are exactly the ones missing.
    write([chatter("session begins"), delta({ added: GUTT_AUTH_TOOLS })]);
    assert.equal(guttToolAvailability(transcript), "auth");
  });

  it("reports available when a real tool arrives alongside the sign-in affordance", () => {
    // Plenty of authenticated servers keep a re-authentication tool in the list
    // permanently; one real capability means the server is usable.
    write([delta({ added: [...GUTT_AUTH_TOOLS, ...GUTT_TOOLS] })]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("takes the newest answer when the user signs in", () => {
    write([
      delta({ added: GUTT_AUTH_TOOLS }),
      chatter("user authenticates"),
      delta({ added: GUTT_TOOLS }),
    ]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("reports auth when a session drops back to needing re-authentication", () => {
    // The shape a lapsed token produces: the real tools go, the affordance arrives.
    write([
      delta({ added: GUTT_TOOLS }),
      chatter("token expires"),
      delta({ removed: GUTT_TOOLS, added: GUTT_AUTH_TOOLS }),
    ]);
    assert.equal(guttToolAvailability(transcript), "auth");
  });

  it("reports auth when the platform says a gutt server needs signing in", () => {
    // `needsAuthMcpServers` is the only key that speaks for a server which has never
    // been authenticated: it published no tools, so there is nothing to remove and
    // nothing to call.
    write([delta({ needsAuth: ["claude.ai gutt-pro-memory"] })]);
    assert.equal(guttToolAvailability(transcript), "auth");
  });

  it("keeps memory green when a *different* gutt server is the one needing auth", () => {
    // Taken from real transcripts on a working machine: 73 deltas name
    // `gutt-poab-mcp` in needsAuthMcpServers while `gutt-pro-memory`'s tools arrive
    // in addedNames of the very same record. Letting the auth list win would pin the
    // HUD amber over memory that works perfectly — a worse bug than the one the
    // needsAuth check exists to fix.
    write([
      delta({
        added: GUTT_TOOLS,
        needsAuth: ["claude.ai Ahrefs", "claude.ai gutt-poab-mcp"],
      }),
    ]);
    assert.equal(guttToolAvailability(transcript), "available");
  });

  it("does not let a sibling gutt server explain this one's disappearance", () => {
    // Removal correlates by tool-id prefix: the server named must be the server whose
    // tools went away, or the verdict is about something the user did not lose.
    write([
      delta({ added: GUTT_TOOLS }),
      delta({ removed: GUTT_TOOLS, pending: ["claude.ai gutt-poab-mcp"] }),
    ]);
    assert.equal(guttToolAvailability(transcript), "absent");
  });

  it("does not mistake another server's sign-in affordance for gutt's", () => {
    write([
      delta({ added: GUTT_TOOLS }),
      delta({ added: ["mcp__claude_ai_Ahrefs__authenticate"] }),
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

  it("judges affordance-only presence on the bare name, whatever the server prefix", () => {
    // The prefix varies per deployment, so the decision has to be made on the segment
    // after the last `__` or it stops working the moment a server is renamed.
    for (const name of [
      "mcp__gutt__authenticate",
      "mcp__some_gutt_thing__complete_authentication",
      "mcp__GUTT_REMOTE__Authorize",
      "mcp__gutt__login",
      "mcp__gutt__sign_in",
    ]) {
      assert.equal(
        verdictFor({ type: "deferred_tools_delta", addedNames: [name] }),
        "auth",
        `${name} should read as a sign-in affordance`
      );
    }
  });

  it("does not treat a capability that merely mentions auth as an affordance", () => {
    // `search_auth_incidents` is a real tool. Substring matching would strand a
    // working server on the amber glyph.
    assert.equal(
      verdictFor({
        type: "deferred_tools_delta",
        addedNames: ["mcp__gutt__search_auth_incidents"],
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
