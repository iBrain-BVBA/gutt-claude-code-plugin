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
    const auto = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(fired) }).reason;
    const hitl = judge.judgeTurn({ transcript_path: file }, "hitl", { spawn: stub(fired) }).reason;
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
    // hands back an arbitrarily long payload for the platform to inject.
    const long = {
      status: 0,
      stdout: JSON.stringify({
        ok: false,
        reason: `Run the skill.\n- Insight: ${"y".repeat(5000)}`,
      }),
    };
    const out = judge.judgeTurn({ transcript_path: file }, "auto", { spawn: stub(long) });
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
    assert.match(out.log, /Stop: no-closing-prose \(mode=auto\)/);
    assert.doesNotMatch(out.log, /Stop: quiet/, "the undifferentiated label is back");
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
