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

const { test, describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

  it("stops at the turn boundary instead of scoring the previous turn", () => {
    // The walk used to skip every non-assistant record, user prompts included, so a turn
    // whose closing record carried no prose returned the *previous* turn's answer — judged
    // a second time, with stop_hook_active false because it is a different turn. That is
    // the duplicate-fire shape next door to the livelock.
    const file = transcript(dir, [
      { role: "assistant", text: "the previous turn's answer" },
      { role: "user", text: "a new prompt, whose turn produced no prose" },
    ]);
    assert.equal(judge.lastAssistantMessage(file), "");
  });

  it("does not treat a tool result as a turn boundary", () => {
    // Tool results arrive as `user` records too. Stopping on them would make every turn
    // that ran a tool after its last prose unjudgeable.
    const file = transcript(dir, [
      { role: "assistant", text: "the prose worth judging" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]);
    assert.equal(judge.lastAssistantMessage(file), "the prose worth judging");
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
    assert.equal(out.outcome, judge.OUTCOMES.FIRED);
    assert.match(out.reason, /- Insight: x/);
  });

  it("reports a healthy pass distinctly from a broken judge", () => {
    // The whole point of the outcome label: `pass` and every failure used to log the same
    // word, so a judge dead since an expired token looked like a quiet month.
    const passed = { status: 0, stdout: '{"ok": true}' };
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(passed) });
    assert.equal(out.outcome, judge.OUTCOMES.PASS);
    assert.equal(out.reason, null);
    assert.ok(!judge.BROKEN_OUTCOMES.has(out.outcome), "a pass must not read as a failure");
  });

  it("appends the confirmation instruction only in hitl", () => {
    // `styleBlock: ""` isolates the mode difference. GP-927 appends the output-style block
    // *after* HITL_TAIL, so with it present the two reasons share a head and a tail and
    // differ only in the middle — and `startsWith` would stop asserting anything.
    const deps = { spawn: stub(fired), styleBlock: "" };
    const auto = judge.judgeTurn({ transcript_path: file }, "auto", deps).reason;
    const hitl = judge.judgeTurn({ transcript_path: file }, "hitl", deps).reason;
    assert.doesNotMatch(auto, /AskUserQuestion/, "auto must be what shipped before hitl existed");
    assert.match(hitl, /AskUserQuestion/);
    assert.ok(hitl.startsWith(auto), "hitl must add to the verdict, not rewrite it");
  });

  it("stays quiet on every child failure, and says which one in the outcome", () => {
    const cases = [
      ["non-zero exit", { status: 1, stdout: '{"ok": false, "reason": "x"}' }, "EXIT_NONZERO"],
      ["killed by signal", { status: null, signal: "SIGTERM", stdout: "" }, "TIMEOUT"],
      ["no stdout", { status: 0, stdout: "" }, "NO_OUTPUT"],
      ["unparseable stdout", { status: 0, stdout: "the model rambled" }, "UNPARSEABLE"],
      // spawnSync reports a missing binary in `error`, not by throwing. Reading only
      // `status` classified the likeliest production failure as a generic bad exit and
      // threw the diagnostic away.
      [
        "claude not on PATH",
        { status: null, error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }) },
        "SPAWN_FAILED",
      ],
      [
        "timeout via error code",
        { status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
        "TIMEOUT",
      ],
    ];
    for (const [label, result, expected] of cases) {
      const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(result) });
      assert.equal(out.reason, null, `${label} must not block the turn`);
      assert.equal(out.outcome, judge.OUTCOMES[expected], label);
      assert.ok(judge.BROKEN_OUTCOMES.has(out.outcome), `${label} must reach the error log`);
    }
  });

  it("stays quiet when the spawn itself throws", () => {
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: () => {
        throw new Error("bad argv");
      },
    });
    assert.equal(out.reason, null);
    assert.equal(out.outcome, judge.OUTCOMES.SPAWN_FAILED);
    assert.match(out.detail, /bad argv/, "a developer bug must leave a trace");
  });

  it("carries stderr into the detail, where auth and quota failures announce themselves", () => {
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub({ status: 1, stdout: "", stderr: "authentication_failed: token expired" }),
    });
    assert.match(out.detail, /authentication_failed/);
  });

  it("drops a reason that restates the verdict format", () => {
    // GP-921 route 1: the reason is fed back and surfaces to the user as the assistant's
    // answer. The prompt asks the judge not to quote the format; this enforces it.
    const leaky = {
      status: 0,
      stdout: JSON.stringify({
        ok: false,
        reason: 'Respond exactly {"ok": true} and no other field.',
      }),
    };
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(leaky) });
    assert.equal(out.reason, null, "a verdict-shaped reason must never reach the user");
    assert.equal(out.outcome, judge.OUTCOMES.RESTATED_FORMAT);
  });

  it("truncates an over-long reason rather than injecting it whole", () => {
    // The ten-words-per-bullet bound lives only in the prompt, so a judge that ignores it
    // hands back an arbitrarily long payload for the platform to inject. `styleBlock: ""`
    // keeps this on the judge's half, which is what MAX_REASON_CHARS bounds; the composed
    // total has its own cap, measured in the suite below.
    const long = {
      status: 0,
      stdout: JSON.stringify({
        ok: false,
        reason: `Run the skill.\n- Insight: ${"y".repeat(5000)}`,
      }),
    };
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub(long),
      styleBlock: "",
    });
    assert.equal(out.outcome, judge.OUTCOMES.FIRED);
    assert.ok(
      out.reason.length <= judge.MAX_REASON_CHARS + 1,
      `reason was ${out.reason.length} chars`
    );
    assert.match(out.reason, /^Run the skill\./, "the actionable first line must survive");
  });

  it("stays quiet on ok:false with an empty reason", () => {
    // Blocking with nothing to say re-enters the turn carrying no instruction, which is
    // the livelock shape with none of the benefit.
    const empty = { status: 0, stdout: '{"ok": false, "reason": "   "}' };
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(empty) });
    assert.equal(out.reason, null);
    assert.equal(out.outcome, judge.OUTCOMES.NO_REASON);
  });

  it("does not spawn at all when there is no turn to score", () => {
    let spawned = false;
    const out = judge.judgeTurn({ transcript_path: path.join(dir, "absent.jsonl") }, "auto", {
      spawn: () => {
        spawned = true;
        return fired;
      },
    });
    assert.equal(out.outcome, judge.OUTCOMES.NO_SUMMARY);
    assert.equal(out.reason, null);
    assert.equal(spawned, false, "spawned a judge for a turn it could not read");
  });

  /**
   * Where the closing message comes from (the transcript-lag fix).
   *
   * `transcript_path` is written asynchronously, so at the moment Stop fires it can still be
   * missing the turn that just ended — which is why the platform puts the text on stdin as
   * `last_assistant_message` and documents that as the source to use. Reading the file first
   * cost `no-closing-prose` on 6 of 53 real invocations; the field is now preferred and the
   * walk is the fallback for CLIs that predate it.
   */
  describe("the closing message comes from the payload before the transcript", () => {
    const capture = () => {
      const seen = {};
      const spawn = (_cmd, _args, opts) => {
        seen.input = opts.input;
        return fired;
      };
      return { seen, spawn };
    };

    it("judges a turn the transcript has not caught up with yet", () => {
      // The regression, stated as its own case: the file is not there at all and the turn is
      // still judged, because the text never depended on the file.
      const { seen, spawn } = capture();
      const out = judge.judgeTurn(
        {
          transcript_path: path.join(dir, "not-flushed-yet.jsonl"),
          last_assistant_message: "the turn the transcript is missing",
        },
        "auto",
        { spawn, styleBlock: "" }
      );
      assert.equal(out.outcome, judge.OUTCOMES.FIRED, "a lagging transcript still costs the turn");
      assert.match(seen.input, /the turn the transcript is missing/);
    });

    it("prefers the field when both are present and they disagree", () => {
      // Both readable, different text. The field wins, so a stale tail cannot outrank the
      // copy the platform handed over for this turn.
      const { seen, spawn } = capture();
      judge.judgeTurn(
        { transcript_path: file, last_assistant_message: "from the payload" },
        "auto",
        { spawn, styleBlock: "" }
      );
      assert.match(seen.input, /from the payload/);
      assert.doesNotMatch(
        seen.input,
        /a turn that found something/,
        "the transcript was read even though the payload carried the message"
      );
    });

    it("falls back to the transcript when the field is absent", () => {
      // The pre-field CLI path. Deleting the walk would silently stop judging on those.
      const { seen, spawn } = capture();
      judge.judgeTurn({ transcript_path: file }, "auto", { spawn, styleBlock: "" });
      assert.match(seen.input, /a turn that found something/);
    });

    it("treats a blank field as absent rather than as an empty turn", () => {
      // A field present but whitespace is not a closing message. Returning early on it would
      // report `no-closing-prose` for a turn whose text the transcript has.
      const { seen, spawn } = capture();
      judge.judgeTurn({ transcript_path: file, last_assistant_message: "   \n  " }, "auto", {
        spawn,
        styleBlock: "",
      });
      assert.match(seen.input, /a turn that found something/);
    });

    it("names which source failed when neither has anything", () => {
      const out = judge.judgeTurn({ transcript_path: "/nope/missing.jsonl" }, "auto", {
        spawn: stub(fired),
      });
      assert.equal(out.outcome, judge.OUTCOMES.NO_SUMMARY);
      assert.match(out.detail, /last_assistant_message absent/);
      assert.match(out.detail, /transcript unreadable|transcript \d+B/);
      assert.ok(
        judge.BROKEN_OUTCOMES.has(out.outcome),
        "an unreadable turn reads as a negative result rather than a failure to read"
      );
    });
  });

  it("runs the child outside the user's project", () => {
    // Non-bare discovers CLAUDE.md from the cwd upward, so judging from the repo hands the
    // judge this project's instructions on top of the prompt under test — the bias
    // evals/lib/runner.py avoids with a temp dir.
    let seen;
    judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: (cmd, args, opts) => {
        seen = opts;
        return fired;
      },
    });
    assert.equal(seen.cwd, os.tmpdir());
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

/**
 * The output-style block appended to a fired reason (GP-927).
 *
 * The judge decides *what* to capture; this decides what the user is left looking at once
 * the capture is done. The text is not held here — it is a delimited region of the
 * output-style skill, so that the bytes an agent receives on the capture path and the bytes
 * a human reads in the skill cannot drift apart. These tests cover the reading, the
 * composition order, the failure mode, and the budget the story asked to be measured rather
 * than assumed.
 */
describe("stop-judge: the injected output style", () => {
  let dir;
  let file;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-stopjudge-s-"));
    file = transcript(dir, [{ role: "assistant", text: "a turn that found something" }]);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stub = (result) => () => result;
  const REASON = "Run the skill.\n- Insight: x";
  const fired = { status: 0, stdout: JSON.stringify({ ok: false, reason: REASON }) };
  const STYLE_DIR = judge.STYLE_SKILL_DIR;

  it("reads the block out of the skill that owns it", () => {
    const block = judge.readStyleBlock();
    assert.ok(block.length > 0, "no style block — the markers or the skill file have moved");
    assert.doesNotMatch(
      block,
      /INJECTED:(BEGIN|END)/,
      "the markers are being injected along with the text they delimit"
    );
    assert.equal(block, block.trim(), "the slice carries the markers' surrounding whitespace");
  });

  it("prefers CLAUDE_PLUGIN_ROOT, and still resolves without it", () => {
    // `__dirname` is not stable across layouts: installed, this is a real file under
    // hooks/lib/, so `../..` is the plugin root; in local development it is reached through
    // a symlink and Node resolves `__dirname` to shared/, which puts `../..` outside the
    // repo. The env var is the only candidate that is right in both, hence the order — and
    // the fallbacks have to work, because a wrong root must not cost the style.
    const before = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = path.join(dir, "no-such-root");
    try {
      assert.equal(
        judge.styleBlockPaths()[0],
        path.join(dir, "no-such-root", "skills", STYLE_DIR, "SKILL.md"),
        "the plugin root is not consulted first"
      );
      assert.ok(judge.readStyleBlock().length > 0, "a wrong root must fall back, not give up");
    } finally {
      if (before === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = before;
      }
    }
  });

  it("closes a fired reason on the block, with the verdict still leading", () => {
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(fired) });
    assert.equal(out.outcome, judge.OUTCOMES.FIRED);
    assert.ok(out.reason.startsWith(REASON), "the verdict must still be read first");
    assert.ok(
      out.reason.endsWith(judge.readStyleBlock()),
      "the block must be last — it governs the end of the reply, and a middle position is " +
        "where an instruction in a system message gets lost"
    );
    assert.equal(out.detail, null, "a healthy fire logs no complaint");
  });

  it("puts the block after the hitl confirmation, in the order the two apply", () => {
    const out = judge.judgeTurn({ transcript_path: file }, "hitl", { spawn: stub(fired) });
    const ask = out.reason.indexOf("AskUserQuestion");
    const style = out.reason.indexOf(judge.readStyleBlock());
    assert.ok(ask > -1, "hitl lost its confirmation instruction");
    assert.ok(style > -1, "hitl lost the style block");
    assert.ok(ask < style, "confirm, then close on the work — the reverse reads as backwards");
  });

  it("still fires when the block cannot be read, and says so in the detail", () => {
    // Fail-open. This hook sits between the user and the end of their turn, so a deleted
    // marker or a moved skill costs the style and never the capture. Silent to the user,
    // not to the log: without the detail, a feature that had stopped working entirely would
    // be indistinguishable from one working fine.
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub(fired),
      styleBlock: "",
    });
    assert.equal(out.outcome, judge.OUTCOMES.FIRED);
    assert.equal(out.reason, REASON, "an empty block must not leave a dangling separator");
    assert.match(out.detail, /style block/i, "nothing in the log would name the failure");
    assert.ok(!judge.BROKEN_OUTCOMES.has(out.outcome), "a fire without the style is still a fire");
  });

  it("separates the verdict from the block, so the two never run together", () => {
    // `endsWith(block)` and an index comparison are both blind to a lost separator: dropping
    // the "\n\n" ships `- Insight: xThe reply ends in two parts…` and satisfies each of them.
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(fired) });
    assert.ok(
      out.reason.includes(`\n\n${judge.readStyleBlock()}`),
      "the block is glued to the text above it"
    );
  });

  it("screens the judge's half only, so a verdict-shaped constant cannot drop a fire", () => {
    // The screen runs before composition on purpose. Over the composed string it would also
    // test our own constants, where a match could only ever be our bug — and it would discard
    // a healthy verdict in order to report it.
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub(fired),
      styleBlock: '{"ok": false}',
    });
    assert.match(
      '{"ok": false}',
      judge.VERDICT_SHAPE,
      "this fixture no longer matches VERDICT_SHAPE, so the test below proves nothing"
    );
    assert.equal(
      out.outcome,
      judge.OUTCOMES.FIRED,
      "a verdict-shaped constant dropped a real fire"
    );
  });

  it("keeps the whole verdict, and the cap, when the block is oversized", () => {
    // The block's length is data, not a constant: it is read from a file at fire time, so an
    // edited cache or a CLAUDE_PLUGIN_ROOT on another version can hand this a block the
    // repo's guards never saw. Clamping the budget to fit one used to cut the verdict — skill
    // name and every bullet — down to a bare "…", and still overshoot the cap.
    const long = "s".repeat(3000);
    const out = judge.composeReason(REASON, "hitl", long);
    assert.ok(out.styleDropped, "the style must yield here, because the capture cannot");
    assert.ok(out.text.startsWith(REASON), "the verdict is the part the capture acts on");
    assert.ok(!out.text.includes(long), "the block was kept and the judge's half paid for it");
    assert.ok(
      out.text.length <= judge.MAX_COMPOSED_REASON_CHARS,
      `composed ${out.text.length} against a cap of ${judge.MAX_COMPOSED_REASON_CHARS}`
    );
  });

  it("charges the truncation ellipsis to the budget instead of adding it afterwards", () => {
    // At the cap's own boundary and every length above it, appending the ellipsis to a slice
    // already the budget's full width put the composed reason exactly one char over the cap.
    const boundary =
      judge.MAX_COMPOSED_REASON_CHARS - judge.MAX_REASON_CHARS - judge.HITL_TAIL.length - 2;
    const out = judge.composeReason("y".repeat(5000), "hitl", "s".repeat(boundary));
    assert.equal(out.styleDropped, false, "the boundary block still fits, so it must be kept");
    assert.equal(
      out.text.length,
      judge.MAX_COMPOSED_REASON_CHARS,
      "the widest composed reason must land on the cap, not one past it"
    );
    assert.equal(out.truncatedTo, judge.MAX_REASON_CHARS, "the judge did not keep its full cap");
  });

  it("reads past a root whose skill lost its markers, and names it in the detail", () => {
    // Returning early on a marker-less file lost the feature outright whenever
    // CLAUDE_PLUGIN_ROOT pointed at a copy predating the markers — while a good copy sat
    // further down the candidate chain, unconsulted. Still reported, no longer fatal.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-nomarkers-"));
    const skill = path.join(root, "skills", STYLE_DIR);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# Output style\n\nno markers here\n");
    const before = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = root;
    try {
      const result = judge.readStyleBlockResult();
      assert.ok(result.text.length > 0, "a marker-less root must not cost the block");
      assert.match(result.cause, /markers missing/i, "nothing names the root that was skipped");
      const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(fired) });
      assert.match(out.detail, /read past a defect/i, "the log would not show the broken root");
    } finally {
      if (before === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = before;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the block in the installed layout, where the lib is a real file", () => {
    // The candidate a marketplace install actually uses — a real `hooks/lib/stop-judge.cjs`,
    // so `../..` is the plugin root — is unreachable from this checkout: Node realpaths the
    // symlink to `shared/`, so an in-repo candidate always wins first. Corrupting that
    // candidate therefore failed no test, which is why the layout is built here explicitly.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-installed-"));
    const before = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const lib = path.join(root, "hooks", "lib");
      fs.mkdirSync(lib, { recursive: true });
      const shared = path.join(__dirname, "..", "shared");
      for (const entry of fs.readdirSync(shared).filter((e) => e.endsWith(".cjs"))) {
        fs.copyFileSync(path.join(shared, entry), path.join(lib, entry));
      }
      const skill = path.join(root, "skills", STYLE_DIR);
      fs.mkdirSync(skill, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, "..", "gutt-core", "skills", STYLE_DIR, "SKILL.md"),
        path.join(skill, "SKILL.md")
      );
      // A real install has its manifest, and `styleBlockPaths` now requires one before it will
      // read a `../..` candidate — that check is what keeps a stray sibling file in the dev
      // layout from being injected. Writing it here keeps the fixture an install rather than
      // just a directory shaped like one.
      fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "gutt-claude-code-plugin" })
      );
      delete process.env.CLAUDE_PLUGIN_ROOT;
      const installed = require(path.join(lib, "stop-judge.cjs"));
      assert.equal(
        installed.readStyleBlock(),
        judge.readStyleBlock(),
        "the installed layout cannot find its own skill without CLAUDE_PLUGIN_ROOT"
      );
    } finally {
      if (before === undefined) {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      } else {
        process.env.CLAUDE_PLUGIN_ROOT = before;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds the composed reason, and leaves the judge's half its full cap", () => {
    // MAX_REASON_CHARS was applied to the judge's reason before anything was appended to
    // it, so nothing bounded what the platform was actually asked to inject. Worst case is
    // `hitl`: an over-long verdict plus both constants.
    const long = {
      status: 0,
      stdout: JSON.stringify({
        ok: false,
        reason: `Run the skill.\n- Insight: ${"y".repeat(5000)}`,
      }),
    };
    const out = judge.judgeTurn({ transcript_path: file }, "hitl", { spawn: stub(long) });
    assert.ok(
      out.reason.length <= judge.MAX_COMPOSED_REASON_CHARS,
      `composed reason was ${out.reason.length} chars against a cap of ` +
        `${judge.MAX_COMPOSED_REASON_CHARS}`
    );
    assert.match(out.reason, /^Run the skill\./, "the actionable first line must survive");
    // Asserting the slack, not only the total. A total under the cap is also what you get
    // when the constants have grown enough to start eating the judge's bullets — the
    // composed length alone cannot tell those apart, and the second is a silent
    // regression in what the capture is told to record.
    const constants = judge.HITL_TAIL.length + judge.readStyleBlock().length + 2;
    const room = judge.MAX_COMPOSED_REASON_CHARS - constants;
    assert.ok(
      room >= judge.MAX_REASON_CHARS,
      `the constants total ${constants} chars, leaving the judge ${room} of its ` +
        `${judge.MAX_REASON_CHARS} — shorten the style block, or raise ` +
        `MAX_COMPOSED_REASON_CHARS deliberately`
    );
  });

  it("keeps the composed reason clear of the screen that drops a leaked verdict", () => {
    // GP-921 route 1 in reverse: VERDICT_SHAPE screens the judge's half before the
    // constants go on, so a constant that happened to be verdict-shaped would sail past it
    // and reach the user as the assistant's answer.
    for (const mode of ["auto", "hitl"]) {
      const out = judge.judgeTurn({ transcript_path: file }, mode, { spawn: stub(fired) });
      assert.doesNotMatch(
        out.reason,
        judge.VERDICT_SHAPE,
        `the composed ${mode} reason is verdict-shaped, which is the echo that screen exists for`
      );
    }
  });

  it("composes nothing unless the judge fired", () => {
    // The block is an instruction about how to close a reply that is about to continue. On
    // a pass the turn ends, so there is nothing to instruct and no reason to spend the
    // context — and emitting one would block a turn the judge cleared.
    const passed = { status: 0, stdout: '{"ok": true}' };
    const out = judge.judgeTurn({ transcript_path: file }, "hitl", { spawn: stub(passed) });
    assert.equal(out.outcome, judge.OUTCOMES.PASS);
    assert.equal(out.reason, null);
  });
});

describe("stop-judge: waiting for background agents", () => {
  it("defers on an in-flight agent task", () => {
    const pending = judge.pendingAgentTasks({
      background_tasks: [{ id: "1", type: "subagent", agent_type: "code-reviewer" }],
    });
    assert.equal(pending.length, 1);
  });

  it("ignores background work that cannot add a finding", () => {
    // A build, a log tail or an MCP monitor will not contribute to the turn, and some run
    // for the whole session — waiting on one would mean never judging.
    const pending = judge.pendingAgentTasks({
      background_tasks: [
        { id: "1", type: "shell", command: "npm run watch" },
        { id: "2", type: "monitor", server: "sentry", tool: "issues" },
        { id: "3", type: "MCP task", server: "linear", tool: "sync" },
      ],
    });
    assert.deepEqual(pending, []);
  });

  it("judges when the arrays are absent, rather than deferring forever", () => {
    // Absent is not empty: it means the task registry was unreachable or the CLI predates
    // the field. Deferring on absence would disable capture on every older install.
    assert.deepEqual(judge.pendingAgentTasks({}), []);
    assert.deepEqual(judge.pendingAgentTasks({ background_tasks: null }), []);
    assert.deepEqual(judge.pendingAgentTasks(undefined), []);
    assert.deepEqual(judge.pendingAgentTasks({ background_tasks: [] }), []);
  });

  it("never defers on a scheduled wakeup", () => {
    // A recurring cron never drains, so gating on session_crons would silence capture for
    // the rest of the session.
    const pending = judge.pendingAgentTasks({
      background_tasks: [],
      session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "/loop" }],
    });
    assert.deepEqual(pending, []);
  });

  it("treats an unrecognised task type as not worth waiting for", () => {
    // Fail open. A denylist would defer on any type a future CLI adds, potentially for the
    // life of the session and with nothing saying so.
    assert.deepEqual(
      judge.pendingAgentTasks({ background_tasks: [{ type: "something-new" }] }),
      []
    );
  });

  it("names only agent-shaped types in the allowlist", () => {
    for (const type of ["shell", "monitor", "MCP task"]) {
      assert.ok(!judge.AGENT_TASK_TYPES.has(type), `${type} must not gate the judge`);
    }
    assert.ok(judge.AGENT_TASK_TYPES.has("subagent"));
  });
});

describe("stop-capture: the router", () => {
  // Every case here returns before the judge is convened, so nothing spawns `claude` and
  // nothing is billed. That is also the point: these four rows are the ones a
  // `type: "prompt"` hook could not have, and until now none of them had a test — the
  // suppression row in particular, which is the entire justification for the conversion.
  const hook = path.join(__dirname, "..", "gutt-core", "hooks", "stop-capture.cjs");
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-stoprouter-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(payload) {
    const result = spawnSync(process.execPath, [hook], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, GUTT_NESTED_RUN: "" },
    });
    const logFile = path.join(dir, "hook-invocations.log");
    return {
      status: result.status,
      stdout: result.stdout || "",
      log: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "",
    };
  }

  const plant = (config) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));

  it("short-circuits a turn that already fired, without judging it again", () => {
    // Layer 1 of the livelock guard, in code rather than in a prompt clause. The recorded
    // P1 re-fired 16 times on one turn.
    const out = run({ session_id: "s1", stop_hook_active: true, transcript_path: "/nope" });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
    assert.match(out.log, /Stop: skipped, already active/);
  });

  it("stays silent when the plugin is off, and never reaches the judge", () => {
    plant({ enabled: false });
    const out = run({ session_id: "s1", stop_hook_active: false, transcript_path: "/nope" });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "", "a suppressed plugin must not block the turn");
    assert.match(out.log, /Stop: suppressed/);
    assert.doesNotMatch(out.log, /pass|fired|no-closing-prose/, "the judge was still consulted");
  });

  it("defers while a background agent is still working", () => {
    const out = run({
      session_id: "s1",
      stop_hook_active: false,
      transcript_path: "/nope",
      background_tasks: [{ id: "1", type: "subagent", agent_type: "code-reviewer" }],
    });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
    assert.match(out.log, /Stop: deferred, 1 agent task\(s\) in flight: subagent:code-reviewer/);
  });

  it("does not defer for background shell work", () => {
    // Falls through to the judge, which finds no transcript and reports why — proving the
    // shell task did not gate it.
    const out = run({
      session_id: "s1",
      stop_hook_active: false,
      transcript_path: "/nope",
      background_tasks: [{ id: "1", type: "shell", command: "npm run watch" }],
    });
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.log, /deferred/);
    assert.match(out.log, /Stop: no-closing-prose/);
  });

  it("logs an outcome that distinguishes a broken judge from a quiet one", () => {
    const out = run({ session_id: "s1", stop_hook_active: false, transcript_path: "/nope" });
    assert.match(out.log, /Stop: no-closing-prose — /, "the outcome logged without a diagnostic");
    assert.match(out.log, /\(mode=auto\)/);
    assert.doesNotMatch(out.log, /Stop: quiet/, "the undifferentiated label is back");
  });

  it("routes an unreadable turn to the error log, and says which cause", () => {
    // `no-closing-prose` sat outside BROKEN_OUTCOMES and therefore outside this file, which
    // is how a transcript the hook could not read stayed indistinguishable from a turn with
    // nothing worth capturing for 6 invocations. The detail is the other half: without it
    // every occurrence in the log is equally unexplainable afterwards.
    const out = run({ session_id: "s1", stop_hook_active: false, transcript_path: "/nope" });
    assert.equal(out.status, 0, "a turn it cannot read must still not block");
    assert.equal(out.stdout, "");
    const errors = path.join(dir, "hook-errors.log");
    assert.ok(fs.existsSync(errors), "an unreadable turn left no diagnostic");
    const text = fs.readFileSync(errors, "utf8");
    assert.match(text, /no-closing-prose/);
    assert.match(
      text,
      /last_assistant_message absent/,
      "the diagnostic does not say whether the platform supplied the field"
    );
  });

  it("exits 0 on unparseable stdin, and leaves a trace of it", () => {
    // Exiting 0 is correct — this hook must never be why a turn cannot finish. Logging
    // nothing was not: a renamed payload field would kill the judge outright while every
    // artefact still read as healthy.
    const out = run("{not json");
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
    const errors = path.join(dir, "hook-errors.log");
    assert.ok(fs.existsSync(errors), "an unparseable payload left no diagnostic");
    assert.match(fs.readFileSync(errors, "utf8"), /stdin/i);
  });
});

test("the shared lib is symlinked, not copied", () => {
  assert.equal(
    fs.realpathSync(path.join(__dirname, "..", "gutt-core", "hooks", "lib", "stop-judge.cjs")),
    fs.realpathSync(path.join(__dirname, "..", "shared", "stop-judge.cjs"))
  );
});
