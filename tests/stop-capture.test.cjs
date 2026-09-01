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

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const judge = require("../gutt-core/hooks/lib/stop-judge.cjs");
const { NESTED_ENV_VAR } = require("../gutt-core/hooks/lib/nested-run.cjs");

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

  it("carries stderr into the detail, where a quota wall announces itself", () => {
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub({ status: 1, stdout: "", stderr: "quota exceeded: limit reached" }),
    });
    assert.match(out.detail, /quota exceeded/);
    assert.match(out.detail, /stderr:/, "the log must name which stream answered");
  });

  it("falls back to stdout, where a child that cannot authenticate announces itself", () => {
    // The reason a judge died is not always on stderr. An unauthenticated child prints its
    // login prompt on stdout and exits 1, so tailing stderr alone logged the exit code and
    // threw away the message sitting beside it — which is how this failure stayed unread.
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub({ status: 1, stdout: "Not logged in \u00b7 Please run /login", stderr: "" }),
    });
    assert.equal(out.outcome, judge.OUTCOMES.EXIT_NONZERO);
    assert.equal(out.reason, null, "a dead judge must still not block the turn");
    assert.match(out.detail, /Not logged in/);
    assert.match(out.detail, /stdout:/, "the log must name which stream answered");
  });

  it("prefers stderr when both streams carry something", () => {
    // Whatever wrote to an error stream is likelier to be the error than whatever the run
    // happened to print, and a detail carrying both would be mostly noise.
    const out = judge.judgeTurn({ transcript_path: file }, "auto", {
      spawn: stub({ status: 1, stdout: "usage: claude [options]", stderr: "quota exceeded" }),
    });
    assert.match(out.detail, /quota exceeded/);
    assert.doesNotMatch(out.detail, /usage/);
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
        `${judge.OUTCOMES.NO_SUMMARY} is outside BROKEN_OUTCOMES again, so a turn the hook ` +
          `could not read is filed with turns that had nothing worth capturing — the ` +
          `misclassification that hid this for 6 invocations`
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
    // `__dirname` puts the lib under hooks/lib/, so `../..` is the plugin root — but only
    // when the plugin is laid out the way it ships. The env var is the candidate that
    // survives a host resolving the hook from somewhere else, hence the order — and the
    // fallbacks have to work, because a wrong root must not cost the style.
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

  it("resolves the block from a plugin root elsewhere on disk", () => {
    // The checkout and the install now have the same shape (GP-933), so the in-repo
    // candidate would satisfy this test without the resolution being exercised at all —
    // corrupting the copy under test would fail nothing. Building the tree somewhere else
    // makes the `../..` walk the only thing that can find the block.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-installed-"));
    const before = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const lib = path.join(root, "hooks", "lib");
      fs.mkdirSync(lib, { recursive: true });
      const srcLib = path.join(__dirname, "..", "gutt-core", "hooks", "lib");
      for (const entry of fs.readdirSync(srcLib).filter((e) => e.endsWith(".cjs"))) {
        fs.copyFileSync(path.join(srcLib, entry), path.join(lib, entry));
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
        JSON.stringify({ name: "gutt-pro" })
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

// The real-file assertion that used to sit here now runs over every lib in every
// plugin, in tests/hook-architecture.test.cjs.

// ---------------------------------------------------------------------------
// The e2e capture observer.
//
// `tests/e2e/hook-routing.e2e.cjs` asserts that a fire reaches a capture attempt.
// That assertion costs a paid session to run, so its own discrimination is proved
// here instead, for free and deterministically: the observer must come back empty on
// a session that fired and captured nothing, and must not be satisfied by a capture
// the fire had nothing to do with. An observer that answered "captured" either way
// would leave the e2e assertion green while asserting nothing — which is the state
// GP-924 found the previous one in.
// ---------------------------------------------------------------------------

const { captureAttempts, captureOutcomes } = require("./e2e/lib/claude-run.cjs");

/** The fired reason as the CLI injects it into the conversation. */
function firedMessage(reason = "Run the `gutt-pro:memory-capture` skill.\n- Insight: x") {
  return {
    type: "user",
    isMeta: true,
    message: { role: "user", content: `Stop hook feedback:\n${reason}` },
  };
}

/**
 * The sibling attachment the CLI records for the same fire.
 *
 * Shaped from a real record rather than from the fields the assertion reads: the
 * nested `blockingError` is what distinguishes a fire from the other three attachment
 * types that also carry `hookName: "Stop"`. The previous fixture omitted it, which is
 * why no test in this file could see that quiet outcomes were being scored as fires.
 */
function firedAttachment(
  reason = "Run the `gutt-pro:memory-capture` skill.",
  command = 'node "stop-capture.cjs"'
) {
  return {
    type: "attachment",
    attachment: {
      type: "hook_blocking_error",
      hookName: "Stop",
      hookEvent: "Stop",
      toolUseID: "8518c32f-67ed-47c2-a91f-dab7c0ab468c",
      blockingError: { blockingError: reason, command },
    },
  };
}

/** A Stop hook that ran and fed nothing back. Not a fire. */
function quietAttachment(type) {
  return { type: "attachment", attachment: { type, hookName: "Stop", hookEvent: "Stop" } };
}

/** A fire delivered over the non-blocking channel: no blockingError, real content. */
function contextAttachment(reason = "Run the `gutt-pro:memory-capture` skill.") {
  return {
    type: "attachment",
    attachment: { type: "hook_additional_context", hookName: "Stop", content: [reason] },
  };
}

function assistantCalls(...calls) {
  return { type: "assistant", message: { role: "assistant", content: calls } };
}

function assistantSays(text) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

const skill = (name) => ({ type: "tool_use", name: "Skill", input: { skill: name } });

describe("stop-capture: the e2e capture observer (GP-924)", () => {
  it("sees the skill invoked after a fire", () => {
    const found = captureAttempts([
      firedMessage(),
      firedAttachment(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(found.length, 1);
  });

  it("counts a direct graph write, not only the skill", () => {
    const found = captureAttempts([
      firedMessage(),
      assistantCalls({ type: "tool_use", name: "mcp__gutt-pro-memory__add_memory", input: {} }),
    ]);
    assert.equal(found.length, 1, "an agent that wrote the episode itself did the thing asked");
  });

  // The mutation the AC names: this is the session the old assertion passed on.
  it("comes back empty when the fire was answered with a fresh verdict and no tool", () => {
    const found = captureAttempts([
      firedMessage(),
      firedAttachment(),
      assistantSays('{"ok": false, "reason": "Run the `gutt-pro:memory-capture` skill."}'),
    ]);
    assert.deepEqual(found, [], "a reply that merely restates the verdict is not a capture");
  });

  it("comes back empty when the fire drew no tool call at all", () => {
    const found = captureAttempts([firedMessage(), assistantSays("Done.")]);
    assert.deepEqual(found, []);
  });

  it("is not satisfied by unrelated tool calls after a fire", () => {
    const found = captureAttempts([
      firedMessage(),
      assistantCalls({ type: "tool_use", name: "Bash", input: {} }, skill("gutt-pro:health")),
    ]);
    assert.deepEqual(found, []);
  });

  it("ignores a capture that predates the fire", () => {
    const found = captureAttempts([
      assistantCalls(skill("gutt-pro:memory-capture")),
      firedMessage(),
      assistantSays("Nothing further."),
    ]);
    assert.deepEqual(found, [], "a capture the routing path cannot have caused is not evidence");
  });

  it("reports nothing when the hook never fed anything back", () => {
    const found = captureAttempts([assistantCalls(skill("gutt-pro:memory-capture"))]);
    assert.deepEqual(found, [], "a spontaneous capture must not stand in for a fire");
  });

  it("finds the fire from either signal alone", () => {
    const viaAttachment = captureAttempts([
      firedAttachment(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    const viaMessage = captureAttempts([
      firedMessage(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(viaAttachment.length, 1, "the attachment alone did not register as a fire");
    assert.equal(viaMessage.length, 1, "the injected message alone did not register as a fire");
  });

  // The case the test above cannot make, because both its fixtures carry the pinned
  // wording: it proves either *channel* works, not that either *signal* does. The
  // attachment's claim is that a recorded command identifies the fire without reading
  // the reason — so the reason has to be wrong for the assertion to mean anything.
  //
  // What it guards is not hypothetical. The judge prompt is still being retuned for
  // fire rate, and a reason gate applied to both arms at once would take the structural
  // arm down on the same rewrite as the text arm — leaving `captureOutcomes` empty and
  // the e2e failing about transcript plumbing rather than about the wording.
  it("still sees our fire from the recorded command when the reason has been reworded", () => {
    const found = captureAttempts([
      firedAttachment(
        "Please invoke the capture skill now.",
        'node "/p/gutt-core/hooks/stop-capture.cjs"'
      ),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(found.length, 1, "a command-attributed fire was vetoed by the reason wording");
  });

  // The other half: with no command to attribute it, the wording is all there is, so
  // the same reworded reason must *not* register. Without this, the case above could be
  // satisfied by dropping the reason gate altogether.
  it("does not accept a reworded reason on the arm that carries no command", () => {
    const found = captureAttempts([
      firedMessage("Please invoke the capture skill now."),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.deepEqual(found, [], "an unattributable message was accepted on wording alone");
  });

  it("finds the fire on the non-blocking channel too", () => {
    const found = captureAttempts([
      contextAttachment(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(found.length, 1, "a fire delivered as additionalContext did not register");
  });

  // The 22 rows in the local corpus that name the Stop hook and carry no feedback.
  // Scoring these as fires opens a window on a quiet turn; nothing follows, because
  // the turn ended, and the observer reports the defect it exists to detect out of
  // entirely correct behaviour.
  for (const type of ["hook_success", "hook_cancelled"]) {
    it(`does not treat a ${type} attachment as a fire`, () => {
      assert.deepEqual(
        captureOutcomes([quietAttachment(type), assistantSays("Done.")]),
        [],
        "the hook ran and fed nothing back — there is no fire to score"
      );
    });
  }

  it("does not treat a blocking attachment with no reason as a fire", () => {
    const empty = {
      type: "attachment",
      attachment: { type: "hook_blocking_error", hookName: "Stop" },
    };
    assert.deepEqual(captureOutcomes([empty, assistantSays("Done.")]), []);
  });

  it("still scores a quiet outcome sitting beside a real fire", () => {
    // A session that passed on one turn and fired on the next. The quiet row must not
    // consume the fire, nor open one of its own.
    const outcomes = captureOutcomes([
      quietAttachment("hook_success"),
      assistantSays("First turn."),
      firedMessage(),
      firedAttachment(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(outcomes.length, 1, "expected exactly the one real fire");
    assert.equal(outcomes[0].acted.length, 1);
  });

  it("does not claim a near-name foreign hook as ours", () => {
    // The command is the discriminator, so it must match as a path component: a
    // foreign `custom-stop-capture.cjs` whose reason happens to name memory capture
    // is somebody else's hook, and claiming its fire makes our observer report an
    // ignored fire the moment the agent answers ours instead.
    const outcomes = captureOutcomes([
      firedAttachment("Run the `gutt-pro:memory-capture` skill.", 'node "custom-stop-capture.cjs"'),
      assistantSays("Done."),
    ]);
    assert.deepEqual(outcomes, [], "a near-name foreign Stop hook was scored as ours");
  });

  it("does not claim a suffixed lookalike script as ours", () => {
    // The boundary has to hold on both sides: `stop-capture.cjs.backup` shares our
    // prefix the way `custom-stop-capture.cjs` shares our suffix.
    const outcomes = captureOutcomes([
      firedAttachment("Run the `gutt-pro:memory-capture` skill.", 'node "stop-capture.cjs.backup"'),
      assistantSays("Done."),
    ]);
    assert.deepEqual(outcomes, [], "a suffixed lookalike script was scored as ours");
  });

  it("needs the contract's opening line, not just the words memory-capture", () => {
    // The reason gate matches the sentence the judge contract pins, so a foreign
    // hook that merely talks about memory capture cannot open a phantom window.
    const outcomes = captureOutcomes([
      firedMessage("Before finishing, review your memory-capture hygiene."),
      assistantSays("Done."),
    ]);
    assert.deepEqual(outcomes, [], "a mention of memory-capture was scored as our fire");
  });

  // "Opening line" is the contract's word, not a description of the gate — the judge
  // template says the reason opens with the line. Unanchored, the gate enforced only
  // "contains it somewhere", so a foreign hook that put a sentence of its own in front
  // of ours was claimed as our fire and opened a window on somebody else's turn.
  it("needs that line at the opening, not merely somewhere in the reason", () => {
    const outcomes = captureOutcomes([
      firedMessage("Foreign preface from another plugin. Run the `gutt-pro:memory-capture` skill."),
      assistantSays("Done."),
    ]);
    assert.deepEqual(
      outcomes,
      [],
      "a foreign reason with our sentence buried in it was scored as ours"
    );
  });

  it("closes a fire's window at the next user prompt, not only at the next fire", () => {
    // The ignored-fire shape a window bounded only by fires cannot see: the fire drew
    // nothing, the user moved on, and the next turn did organic memory work before its
    // own Stop ever fired. Sliced to the next fire alone, that work is credited
    // backwards and the ignored fire reads as answered.
    const outcomes = captureOutcomes([
      firedMessage(),
      firedAttachment(),
      { type: "user", message: { role: "user", content: "next question" } },
      assistantCalls({ type: "tool_use", name: "add_memory", input: {} }),
    ]);
    assert.equal(outcomes.length, 1);
    assert.deepEqual(
      outcomes[0].acted,
      [],
      "the next turn's own memory work was credited to an ignored fire"
    );
  });

  it("keeps two fires separate when no assistant turn divides them", () => {
    // The livelock shape: a turn that returned an empty answer fires twice with
    // nothing between. Merging them here would hide an ignored fire, which is the one
    // outcome this must never miss.
    const outcomes = captureOutcomes([
      firedMessage(),
      firedAttachment(),
      firedMessage("Run the `gutt-pro:memory-capture` skill.\n- Insight: second"),
      firedAttachment("Run the `gutt-pro:memory-capture` skill.\n- Insight: second"),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(outcomes.length, 2, "two fires with no reply between them were folded into one");
    assert.deepEqual(outcomes[0].acted, [], "the first fire drew nothing and must say so");
    assert.equal(outcomes[1].acted.length, 1);
  });

  // The shape a live session actually produces, and the one that caught this: the CLI
  // emits both signals for one fire, adjacent. Counting rows makes that two fires and
  // gives the first an empty window — a fire the agent appears to have ignored,
  // fabricated out of one it answered. `captureAttempts` cannot see it, because
  // flattening hides the empty window; only the per-fire split below does.
  it("treats the paired message and attachment as one fire, not two", () => {
    const outcomes = captureOutcomes([
      firedMessage(),
      firedAttachment(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(outcomes.length, 1, "one fire was counted twice, once per signal");
    assert.equal(outcomes[0].acted.length, 1);
  });

  it("pairs the signals in either order", () => {
    const outcomes = captureOutcomes([
      firedAttachment(),
      firedMessage(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].acted.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The two counts, and what separates them.
//
// Widening the observer to accept a decline is what stops a correct outcome reading
// as a dead routing path — and it is also how the assertion could go vacuous, by
// accepting anything at all. These cases pin both edges: a decline counts as acting
// and does *not* count as a write, and doing nothing still counts as nothing.
//
// The write count exists because the two questions asked of this observer have
// different answers. "Did the routing path work" tolerates a decline; "how often does
// a fire reach the graph" is the baseline a change of output channel gets measured
// against, and a decline is not a write.
// ---------------------------------------------------------------------------

const search = (name) => ({ type: "tool_use", name: `mcp__gutt-pro-memory__${name}`, input: {} });

describe("stop-capture: acting on a fire versus writing to the graph", () => {
  it("counts a bare dedup search as acting, with no Skill call in front of it", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls(search("search_memory_facts")),
    ]);
    assert.equal(outcome.acted.length, 1, "an inline dedup is the agent doing what was asked");
    assert.deepEqual(outcome.wrote, [], "a dedup that found a duplicate wrote nothing");
  });

  it("counts a confirmation prompt as acting, and not as a write", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls({ type: "tool_use", name: "AskUserQuestion", input: {} }),
    ]);
    assert.equal(outcome.acted.length, 1, "a hitl fire correctly ends at the question");
    assert.deepEqual(outcome.wrote, [], "the user had not answered yet, so nothing was written");
  });

  it("does not count the skill itself as a write", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(outcome.acted.length, 1);
    assert.deepEqual(outcome.wrote, [], "running the skill is not the same as reaching the graph");
  });

  it("counts a graph write as both", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls({ type: "tool_use", name: "mcp__gutt-pro-memory__add_memory", input: {} }),
    ]);
    assert.equal(outcome.acted.length, 1);
    assert.equal(outcome.wrote.length, 1);
  });

  // The vacuity guard. Widening must not make "acted" true of every session.
  it("still reports nothing acted when the fire drew only unrelated work", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls({ type: "tool_use", name: "Bash", input: {} }, skill("gutt-pro:health")),
      assistantSays('{"ok": false, "reason": "Run the `gutt-pro:memory-capture` skill."}'),
    ]);
    assert.deepEqual(outcome.acted, [], "unrelated tools are not the agent acting on the reason");
  });

  // The same vacuity guard, one step in: a name that *contains* a memory tool's name is
  // not that tool. These are the discriminator the outcome assertion turns on, so a
  // superset name slipping through does not merely blur a diagnostic — it reports a
  // dead routing path as live. The left end must stay open (a deployment prefixes its
  // MCP tools with a server name we cannot predict), which is exactly why the right end
  // has to be anchored.
  it("does not count a superset of a memory tool's name as acting or writing", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls(
        { type: "tool_use", name: "not_add_memory_dry_run", input: {} },
        { type: "tool_use", name: "search_memory_nodes_backup", input: {} },
        skill("gutt-pro:memory-capture-preview")
      ),
    ]);
    assert.deepEqual(outcome.acted, [], "a lookalike tool or skill name was scored as acting");
    assert.deepEqual(outcome.wrote, [], "a lookalike tool name was scored as a graph write");
  });

  // ... while the real ones still count, prefixed or bare. Without this the case above
  // is satisfied by a predicate that matches nothing at all.
  it("still counts the real memory tools, with or without a server prefix", () => {
    const [outcome] = captureOutcomes([
      firedMessage(),
      assistantCalls(
        { type: "tool_use", name: "add_personal_memory", input: {} },
        search("search_memory_nodes")
      ),
    ]);
    assert.equal(outcome.acted.length, 2, "a real memory tool stopped counting as acting");
    assert.equal(outcome.wrote.length, 1, "the bare-named write stopped counting as a write");
  });

  it("scores each fire in its own window, so a later capture cannot cover an earlier miss", () => {
    const outcomes = captureOutcomes([
      firedMessage(),
      assistantSays("Noted."),
      firedMessage(),
      assistantCalls({ type: "tool_use", name: "mcp__gutt-pro-memory__add_memory", input: {} }),
    ]);
    assert.equal(outcomes.length, 2, "two fires must produce two outcomes");
    assert.deepEqual(outcomes[0].acted, [], "the ignored fire was covered by the later capture");
    assert.equal(outcomes[1].wrote.length, 1);
  });

  it("returns nothing at all when the hook never fired", () => {
    assert.deepEqual(captureOutcomes([assistantCalls(skill("gutt-pro:memory-capture"))]), []);
  });
});

// ---------------------------------------------------------------------------
// Scoping the invocation log to one run.
//
// `hook-invocations.log` is append-only and shared by every run that ever used the
// same data dir, so reading it whole hands the current run months of someone else's
// history. That is not a small inaccuracy: it reported 78 judgements for a two-turn
// session, and failed a run by quoting a timeout from four weeks earlier. The run
// record carries the log's byte length from before it started, and everything before
// that offset belongs to somebody else.
// ---------------------------------------------------------------------------

const { stopOutcomes, stopJudgements } = require("./e2e/lib/claude-run.cjs");

describe("stop-capture: reading only this run's Stop lines", () => {
  let dir;
  // An em dash in the history, deliberately: it makes the byte length differ from the
  // string length, which is what the byte-offset case below turns on.
  const history =
    "[2026-08-03 15:13:05] Stop: timeout — ETIMEDOUT: spawnSync claude ETIMEDOUT (mode=auto)\n" +
    "[2026-08-05 14:18:03] Stop: pass (mode=auto)\n";
  const mine =
    "[2026-08-31 10:38:55] Stop: fired (mode=auto)\n[2026-08-31 10:40:55] Stop: skipped, already active\n";

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-stoplog-"));
    fs.writeFileSync(path.join(dir, "hook-invocations.log"), history + mine);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sees only what was appended after the offset", () => {
    const run = { dataDir: dir, logOffset: Buffer.byteLength(history, "utf8") };
    assert.deepEqual(
      stopOutcomes(run).map((o) => o.outcome),
      ["fired", "skipped, already active"]
    );
  });

  it("measures the offset in bytes, not in string indices", () => {
    // The history carries an em dash, so its byte length exceeds its length in UTF-16
    // code units. Slicing the decoded text by a byte offset therefore overshoots and
    // eats the start of the first line this run wrote. The outcome alone does not
    // catch it — a couple of missing leading characters still leave `Stop: fired`
    // matchable — so this asserts the whole line, which is where the damage shows.
    assert.notEqual(
      Buffer.byteLength(history, "utf8"),
      history.length,
      "fixture no longer contains a multibyte character, so it cannot prove this"
    );
    const run = { dataDir: dir, logOffset: Buffer.byteLength(history, "utf8") };
    assert.equal(stopOutcomes(run)[0].line, "[2026-08-31 10:38:55] Stop: fired (mode=auto)");
  });

  it("counts judgements over this run's lines, not the whole file", () => {
    assert.equal(
      stopJudgements({ dataDir: dir, logOffset: Buffer.byteLength(history, "utf8") }),
      1
    );
    assert.equal(stopJudgements({ dataDir: dir, logOffset: 0 }), 3, "offset 0 still reads it all");
  });

  it("does not report an older run's broken judge as this run's", () => {
    const run = { dataDir: dir, logOffset: Buffer.byteLength(history, "utf8") };
    assert.deepEqual(
      stopOutcomes(run).filter((o) => /timeout/.test(o.outcome)),
      [],
      "a four-week-old ETIMEDOUT was attributed to this run"
    );
  });

  it("returns nothing for a caller that still passes a bare path", () => {
    // The signature changed so this cannot be forgotten silently. Empty is the loud
    // direction: an assertion on it fails, where reading the whole log would let a
    // stale line pass or fail a run for reasons that predate it.
    assert.deepEqual(stopOutcomes(dir), []);
    assert.deepEqual(stopOutcomes(null), []);
    assert.deepEqual(stopOutcomes({ dataDir: null }), []);
  });

  it("treats a missing log as the hook never having run", () => {
    assert.deepEqual(stopOutcomes({ dataDir: path.join(dir, "nope"), logOffset: 0 }), []);
  });
});

// ---------------------------------------------------------------------------
// The observer's discriminators, each pinned on its own.
//
// Four of these were found by mutation rather than by review: breaking them left all
// 89 tests green, because a second check downstream happened to mask the first, or
// because the path had no test at all. Defence in depth is good; relying on it to
// notice a regression is not.
// ---------------------------------------------------------------------------

const { isStopFeedback, invocationLogSizes, realDir } = require("./e2e/lib/claude-run.cjs");

describe("stop-capture: telling our Stop fire from everyone else's", () => {
  /** Another plugin's Stop hook. Real shape, taken from a live transcript. */
  function foreignFire() {
    return {
      type: "attachment",
      attachment: {
        type: "hook_blocking_error",
        hookName: "Stop",
        blockingError: {
          blockingError:
            "Before completing, consider if this work warrants capturing lessons learned. " +
            "Session stats: 0 memory queries, 0 significant ops, 0 lessons captured.",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-lessons.cjs"',
        },
      },
    };
  }

  it("ignores a fire from another plugin's Stop hook", () => {
    // `hookName: "Stop"` is on every plugin's Stop hook. A session really did record
    // a 2.x stop-lessons fire immediately before ours, with no assistant turn between
    // — so counting it opens a window that our own fire then closes, and the foreign
    // fire reads as one we ignored.
    assert.equal(isStopFeedback(foreignFire()), false);
  });

  it("ignores a foreign fire even when its reason names our skill", () => {
    // The command is the definitive discriminator and has to stand on its own. Without
    // this case the reason check masks it: the 2.x hook's wording happens not to
    // mention the skill, so dropping the command test entirely still passes. A fork,
    // or another plugin in this family, would not be so convenient.
    const impostor = {
      type: "attachment",
      attachment: {
        type: "hook_blocking_error",
        hookName: "Stop",
        blockingError: {
          blockingError: "Run the `gutt-pro:memory-capture` skill.\n- Insight: not ours",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/some-other-stop.cjs"',
        },
      },
    };
    assert.equal(isStopFeedback(impostor), false, "attributed another plugin's fire to us");
  });

  it("still sees our fire when a foreign one precedes it", () => {
    const outcomes = captureOutcomes([
      foreignFire(),
      firedMessage(),
      firedAttachment(),
      assistantCalls(skill("gutt-pro:memory-capture")),
    ]);
    assert.equal(outcomes.length, 1, "the foreign fire was counted as one of ours");
    assert.equal(outcomes[0].acted.length, 1);
  });

  it("does not treat a blocking attachment with an empty reason as a fire", () => {
    const hollow = {
      type: "attachment",
      attachment: {
        type: "hook_blocking_error",
        hookName: "Stop",
        blockingError: { blockingError: "", command: 'node "hooks/stop-capture.cjs"' },
      },
    };
    assert.equal(isStopFeedback(hollow), false, "our hook, but it fed nothing back");
  });

  it("does not treat a quiet outcome as a fire even if its type is unfamiliar", () => {
    for (const type of ["hook_success", "hook_cancelled", "hook_something_new"]) {
      assert.equal(isStopFeedback(quietAttachment(type)), false, type);
    }
  });

  // The two text gates, each pinned on its own. Mutation showed either could be
  // deleted with every test in this file still green — and they carry the most
  // production load: over the local transcript corpus, 1,883 non-fire user rows name
  // the capture skill (the plugin's own SessionStart pointer first among them), and
  // without the prefix gate every one opens a phantom scoring window.
  it("does not treat an ordinary message naming the skill as a fire", () => {
    const pointer = {
      type: "user",
      message: {
        role: "user",
        content:
          "Organizational memory is available — run the `gutt-pro:memory-capture` " +
          "skill when the turn produces something durable.",
      },
    };
    assert.deepEqual(
      captureOutcomes([pointer, assistantCalls(skill("gutt-pro:memory-capture"))]),
      [],
      "a message that merely names the skill is not hook feedback"
    );
  });

  it("ignores another hook's feedback whose reason does not ask for our skill", () => {
    // The injected-message arm carries no recorded command to discriminate by, so the
    // reason text is the only gate on it. A 2.x lessons hook's feedback is the live case.
    const foreign = firedMessage(
      "Before completing, consider if this work warrants capturing lessons learned."
    );
    assert.deepEqual(
      captureOutcomes([foreign, assistantCalls(skill("gutt-pro:memory-capture"))]),
      [],
      "another plugin's feedback message was scored as our fire"
    );
  });
});

describe("stop-capture: the watermark's own guarantees", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gutt-watermark-"));
    fs.writeFileSync(path.join(dir, "hook-invocations.log"), "[t] Stop: fired (mode=auto)\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("throws when the log shrank below the watermark, rather than reporting silence", () => {
    // The TTL sweep in session-start.cjs trims breadcrumb logs past 256KB, and it runs
    // inside the child session a test spawns — after the watermark was taken. Reading
    // the empty tail would report "the hook left no record of running" on a healthy
    // run, and it self-heals next run, so it reads as flake rather than as a broken
    // premise.
    assert.throws(
      () => stopOutcomes({ dataDir: dir, logOffset: 999999 }),
      /shrank below this run's watermark/,
      "a trimmed log must not read as a hook that never ran"
    );
  });

  it("keys the sampled sizes by resolved path, so the lookup cannot miss on a prefix", () => {
    // On macOS the data and temp roots resolve through /private, and a symlinked HOME
    // does the same. If the two sides of the lookup normalise differently the offset
    // silently falls back to zero — which reads the whole log and restores the bug the
    // watermark exists to fix, with nothing to show it happened.
    const link = path.join(os.tmpdir(), `gutt-link-${process.pid}`);
    fs.symlinkSync(dir, link, "dir");
    try {
      assert.equal(realDir(link), fs.realpathSync(dir), "a symlinked dir did not resolve");
      assert.equal(realDir(dir), fs.realpathSync(dir));
    } finally {
      fs.rmSync(link, { force: true });
    }
    for (const key of invocationLogSizes().keys()) {
      assert.equal(key, realDir(key), `sampled key is not in canonical form: ${key}`);
    }
  });

  it("returns the path unchanged when it cannot be resolved", () => {
    const missing = path.join(dir, "no-such-dir");
    assert.equal(realDir(missing), missing, "an unresolvable dir must not throw");
  });
});
