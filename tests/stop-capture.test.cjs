/**
 * The Stop capture judge (GP-866).
 *
 * The hook became a command hook so it could read config, which means the judging,
 * the transcript read and the child process are now our code rather than the
 * platform's — and all three can fail in ways a prompt hook could not. These tests
 * cover them without spawning anything: `judgeTurn` takes a `spawn` seam, so the
 * verdict handling is exercised against stubbed child output.
 *
 * What is deliberately not here: whether the real judge fires on the right turns.
 * That is a prompt question, it costs money, and it belongs to `evals/` — suite
 * `stop-judge`.
 */

const { test, describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const judge = require("../shared/stop-judge.cjs");
const { NESTED_ENV_VAR } = require("../shared/nested-run.cjs");

/** Write a transcript of `[{role, text}]` and return its path. */
function transcript(dir, entries) {
  const file = path.join(dir, `t-${entries.length}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = entries.map((e) =>
    JSON.stringify({
      type: e.role,
      message: { content: e.content || [{ type: "text", text: e.text }] },
    })
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("stop-judge: reading the turn", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-stopjudge-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns the closing assistant message", () => {
    const file = transcript(dir, [
      { role: "user", text: "why is it slow?" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "and now?" },
      { role: "assistant", text: "the closing answer" },
    ]);
    assert.equal(judge.lastAssistantMessage(file), "the closing answer");
  });

  it("walks past an assistant record that carries only tool calls", () => {
    // A turn ending in a tool call is normal. Returning "" for it would make every
    // tool-terminated turn unjudgeable, which is most of the interesting ones.
    const file = transcript(dir, [
      { role: "assistant", text: "the prose worth judging" },
      { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
    ]);
    assert.equal(judge.lastAssistantMessage(file), "the prose worth judging");
  });

  it("ignores user records", () => {
    const file = transcript(dir, [
      { role: "assistant", text: "assistant prose" },
      { role: "user", text: "a later user message" },
    ]);
    assert.equal(judge.lastAssistantMessage(file), "assistant prose");
  });

  it("survives a truncated leading line, which the tail read normally produces", () => {
    const file = path.join(dir, "truncated.jsonl");
    fs.writeFileSync(
      file,
      `essage":{"content":[{"type":"text","text":"half a record"}]}}\n` +
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "whole record" }] } })}\n`
    );
    assert.equal(judge.lastAssistantMessage(file), "whole record");
  });

  it("reads only the tail of a large transcript", () => {
    // The guarantee that matters is cost: a session's transcript grows without bound and
    // this runs on every Stop. Padding beyond TAIL_BYTES must be invisible.
    const file = path.join(dir, "big.jsonl");
    const padding = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(4000) }] },
    })}\n`.repeat(Math.ceil(judge.TAIL_BYTES / 4000) + 20);
    fs.writeFileSync(
      file,
      padding +
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the newest message" }] } })}\n`
    );
    assert.ok(fs.statSync(file).size > judge.TAIL_BYTES, "fixture is not larger than the tail");
    assert.equal(judge.lastAssistantMessage(file), "the newest message");
  });

  it("returns empty for a missing or empty transcript rather than throwing", () => {
    assert.equal(judge.lastAssistantMessage(path.join(dir, "nope.jsonl")), "");
    assert.equal(judge.lastAssistantMessage(""), "");
    assert.equal(judge.lastAssistantMessage(undefined), "");
    const empty = path.join(dir, "empty.jsonl");
    fs.writeFileSync(empty, "");
    assert.equal(judge.lastAssistantMessage(empty), "");
  });
});

describe("stop-judge: assembling the prompt", () => {
  it("forwards stop_hook_active and nothing else from the payload", () => {
    const out = judge.buildJudgePrompt(
      { stop_hook_active: true, transcript_path: "/secret/path.jsonl", session_id: "abc123" },
      "summary"
    );
    assert.match(out, /"stop_hook_active":\s*true/);
    // The condition tells the judge to ignore the rest of the payload; not sending it is
    // stronger than asking.
    assert.doesNotMatch(out, /secret|abc123/);
  });

  it("coerces a missing stop_hook_active to false rather than omitting it", () => {
    // The condition reads the field. Absent, a judge has to invent a meaning — and the
    // one it invented last time ("false means the hook is inactive") suppressed every fire.
    assert.match(judge.buildJudgePrompt({}, "s"), /"stop_hook_active":\s*false/);
  });

  it("leaves no placeholder unsubstituted", () => {
    assert.doesNotMatch(judge.buildJudgePrompt({}, "s"), /__PAYLOAD__|\$ARGUMENTS/);
  });
});

describe("stop-judge: parsing the verdict", () => {
  it("reads structured_output, the --json-schema channel", () => {
    const raw = JSON.stringify({ structured_output: { ok: false, reason: "fire" } });
    assert.deepEqual(judge.parseVerdict(raw), { ok: false, reason: "fire" });
  });

  it("reads a bare verdict object", () => {
    assert.deepEqual(judge.parseVerdict('{"ok": true}'), { ok: true });
  });

  it("reads a verdict embedded in prose or a fence", () => {
    assert.deepEqual(judge.parseVerdict('Here you go:\n```json\n{"ok": true}\n```'), { ok: true });
  });

  it("returns null for output carrying no verdict", () => {
    // structured_output comes back null on a budget overrun with exit 1 — measured. A
    // null must not read as a verdict of any kind.
    assert.equal(judge.parseVerdict(JSON.stringify({ structured_output: null })), null);
    assert.equal(judge.parseVerdict(""), null);
    assert.equal(judge.parseVerdict("I could not determine that."), null);
    assert.equal(judge.parseVerdict('{"ok": "yes"}'), null, "ok must be a boolean");
  });
});

describe("stop-judge: deciding what to feed back", () => {
  let dir;
  let file;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-stopjudge-d-"));
    file = transcript(dir, [{ role: "assistant", text: "a turn that found something" }]);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stub = (result) => () => result;
  const fired = {
    status: 0,
    stdout: JSON.stringify({ ok: false, reason: "Run the skill.\n- Insight: x" }),
  };

  it("returns the reason on ok:false", () => {
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(fired) });
    assert.match(out, /- Insight: x/);
  });

  it("returns null on ok:true", () => {
    const passed = { status: 0, stdout: '{"ok": true}' };
    assert.equal(judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(passed) }), null);
  });

  it("appends the confirmation instruction only in hitl", () => {
    const auto = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(fired) });
    const hitl = judge.judgeTurn({ transcript_path: file }, "hitl", { spawn: stub(fired) });
    assert.doesNotMatch(auto, /AskUserQuestion/, "auto must be what shipped before hitl existed");
    assert.match(hitl, /AskUserQuestion/);
    assert.ok(hitl.startsWith(auto), "hitl must add to the verdict, not rewrite it");
  });

  it("stays quiet on every child failure", () => {
    const cases = {
      "non-zero exit": { status: 1, stdout: '{"ok": false, "reason": "x"}' },
      "timeout (null status)": { status: null, stdout: "" },
      "no stdout": { status: 0, stdout: "" },
      "unparseable stdout": { status: 0, stdout: "the model rambled" },
      "spawn threw": null,
    };
    for (const [label, result] of Object.entries(cases)) {
      const spawn =
        result === null
          ? () => {
              throw new Error("ENOENT");
            }
          : stub(result);
      assert.equal(
        judge.judgeTurn({ transcript_path: file }, "auto", { spawn }),
        null,
        `${label} must not block the turn`
      );
    }
  });

  it("stays quiet on ok:false with an empty reason", () => {
    // Blocking with nothing to say re-enters the turn carrying no instruction, which is
    // the livelock shape with none of the benefit.
    const empty = { status: 0, stdout: '{"ok": false, "reason": "   "}' };
    assert.equal(judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(empty) }), null);
  });

  it("does not spawn at all when there is no turn to score", () => {
    let spawned = false;
    const out = judge.judgeTurn({ transcript_path: path.join(dir, "absent.jsonl") }, "auto", {
      spawn: () => {
        spawned = true;
        return fired;
      },
    });
    assert.equal(out, null);
    assert.equal(spawned, false, "spawned a judge for a turn it could not read");
  });

  it("marks the child as nested and disables its hooks", () => {
    let seen;
    judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return fired;
      },
    });
    assert.equal(seen.cmd, "claude");
    assert.equal(seen.opts.env[NESTED_ENV_VAR], "1", "child would re-enter these hooks");
    const argv = seen.args.join(" ");
    assert.match(argv, /disableAllHooks/, "second recursion guard is missing");
    assert.match(argv, /--model claude-/, "the judge must not follow the CLI's default model");
    assert.match(argv, /--strict-mcp-config/, "the judge would load the user's MCP servers");
    assert.equal(seen.opts.timeout, judge.JUDGE_TIMEOUT_MS);
    // Not --bare: bare never reads OAuth or the keychain, so on a subscription install the
    // child cannot authenticate and the judge fails silently forever.
    assert.doesNotMatch(argv, /--bare/);
  });
});

test("the shared lib is symlinked, not copied", () => {
  assert.equal(
    fs.realpathSync(path.join(__dirname, "..", "gutt-core", "hooks", "lib", "stop-judge.cjs")),
    fs.realpathSync(path.join(__dirname, "..", "shared", "stop-judge.cjs"))
  );
});
