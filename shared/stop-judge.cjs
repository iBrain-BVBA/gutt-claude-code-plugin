/**
 * The Stop capture judge: the prompt, the turn excerpt it reads, and the child
 * `claude -p` that answers it.
 *
 * ## Why this is a command hook and not `type: "prompt"`
 *
 * It was a prompt hook until GP-866, and the move was forced by two measured facts
 * rather than chosen (`docs/hook-platform-capabilities.md` §6, §7):
 *
 * 1. A prompt hook's `prompt` field takes exactly one substitution, `$ARGUMENTS`, and
 *    no shell expansion. So it cannot read `config.json`, which means it cannot honour
 *    `/gutt off` or `mode` — it dispatches unconditionally or not at all.
 * 2. Siblings on one event cannot gate each other. A command hook returning
 *    `continue: false` suppresses the turn's final answer, not a prompt sibling's
 *    dispatch. So "add a command hook that decides whether the prompt hook runs" is not
 *    available either.
 *
 * The judgement itself is still made by a model, which is what R11 asks for — it just
 * runs in a child process now instead of in the platform's evaluator. Nothing here
 * scores a turn with a regex.
 *
 * ## What the move bought and cost
 *
 * Bought: the judge can be silenced (`/gutt off`, a snooze) and varied (`mode`), and the
 * judge prompt is no longer echoed into the conversation as Stop feedback — which was the
 * whole mechanism of the JUDGE PROTOCOL LEAKED incident, where a `type: "prompt"`
 * template reached the main agent as instructions to itself and 3 of 5 fires returned a
 * bare `{"ok": true}` in place of the user's answer.
 *
 * What it did **not** buy: GP-921 records two routes to "the user gets a verdict instead
 * of an answer", and this move closes only the first. The template no longer has two
 * readers, but the *reason* still does — `stop-capture.cjs` feeds it back as
 * `decision: "block"`, so a judge that quotes the response format inside its reason still
 * reaches the user, which is what commit 46bd22f fixed in prose. That clause is therefore
 * still load-bearing and is **not** one of the ones this conversion stranded. It is also
 * now defended in code: the reason is screened before it is emitted.
 *
 * Cost: a process spawn on every Stop, and an authentication dependency. The child is
 * deliberately **not** `--bare`: bare never reads OAuth or the keychain, so on a
 * subscription install it cannot authenticate at all
 * (`docs/headless-cli-reference.md` §2). Non-bare means the child loads this plugin and
 * re-enters these hooks, which is why `nested-run.cjs` exists and why the child gets
 * both the env guard and `--settings '{"disableAllHooks": true}'` — belt and braces,
 * since either alone is a single point of failure for an infinite regress.
 *
 * Note the model lives in the argv here, not in a manifest field, and that retires a
 * hazard rather than moving it. A prompt hook's `model` is handed to the API unmodified,
 * so `"sonnet"` answered 404 and killed the judge silently. `--model sonnet` is resolved
 * by the CLI and works — measured 2026-07-30, both the alias and the full id returning a
 * clean reply. See `docs/hook-platform-capabilities.md` §5.
 */

const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { childEnv } = require("./nested-run.cjs");

/** Full id rather than the `sonnet` alias — see the header. Both work on argv; this is
 *  reproducible across CLI versions, which an alias that follows the platform is not. */
const JUDGE_MODEL = "claude-sonnet-5";

/** The child gets 30s. A judge that has not answered by then has already cost more than
 *  the capture is worth, and Stop sits between the user and their answer. */
const JUDGE_TIMEOUT_MS = 30_000;

/**
 * How much of the transcript tail to read, in bytes.
 *
 * The judge is deliberately not given the whole turn. It reads the closing assistant
 * message, which is where a durable finding is stated — the `memory-capture` pointer
 * asks the closing summary to name Insights and Incidents precisely so that this is
 * sufficient. Reading the whole transcript would also mean re-reading a file that grows
 * without bound for the length of a session, on every Stop.
 */
const TAIL_BYTES = 192 * 1024;

/**
 * The stopping condition, from the `type: "prompt"` entry it replaces.
 *
 * Held as close to the original as the new mechanism allows: the mechanism changed and
 * the wording should not, or a behaviour change here would be indistinguishable from a
 * mechanism regression. Two deliberate differences, both forced:
 *
 * 1. `$ARGUMENTS` is gone with the prompt hook that interpolated it. `buildJudgePrompt`
 *    substitutes `__PAYLOAD__` explicitly.
 * 2. "on the conversation above" is now "on the turn quoted below". A prompt hook was
 *    evaluated with the transcript genuinely above the condition; `buildJudgePrompt`
 *    puts the condition first and appends the turn, so "above" pointed the judge at
 *    nothing but the condition's own opening sentence. Retaining it verbatim would have
 *    been faithful to the bytes and wrong about the prompt — the one place where
 *    byte-identity and correctness disagreed.
 *
 * Beyond those two the text is unchanged, which `tests/hook-architecture.test.cjs`
 * pins against a committed fixture of the old manifest prompt.
 *
 * One clause is now vestigial: `stop_hook_active` is checked in code before the judge is
 * convened (`stop-capture.cjs`), so the prompt-side instruction is a second opinion
 * rather than the only guard. It stays — a second opinion costs one clause. The
 * "do not restate this response format" clause is **not** vestigial; see the header.
 */
const JUDGE_CONDITION = [
  'Nothing from this finished turn needs to be written to the team\'s long-term memory — that is the condition, satisfied ({"ok": true}) when there is nothing to record. Score the turn, do not continue it: capture nothing yourself, call no tool, and output one JSON verdict on the turn quoted below. Read `stop_hook_active` from the payload; ignore the rest.',
  "",
  "Hook payload: __PAYLOAD__",
  "",
  'Ask what the turn *learned*, not what it *did* — testing and debugging are how findings get made, so judge the finding, never the activity, and count it even where the fix was already written. Unsatisfied ({"ok": false}) for exactly two things, and only where the subject is durable for the team rather than throwaway scaffolding:',
  "- an **Insight** — how some system actually behaves, where that was not obvious and is not stated in the code;",
  "- an **Incident** — something broke, and what happened.",
  "",
  'Satisfied for everything else — code only moved or restated, work unfinished, the point already recorded, or a takeaway that is a **Lesson**, **Decision** or **WorkingAgreement** (the capture skill holds those behind an explicit user signal a hook cannot give) — and always when `stop_hook_active` is true, which means you have already asked during this turn and answering otherwise re-enters it — while its being false is the normal case and says nothing either way. Then respond exactly {"ok": true} and no other field: omit `reason`, it is discarded unread. Otherwise {"ok": false, "reason": "..."}, where the reason opens with the line "Run the `gutt-claude-code-plugin:memory-capture` skill." then one bullet per subject, **10 words maximum each**, every bullet typed and only ever Insight or Incident:',
  "",
  "Run the `gutt-claude-code-plugin:memory-capture` skill.",
  "- Insight: prefix matching survives new tools; allowlists silently stop matching",
  "",
  "Those two bullets are a format sample, not findings from this turn — never carry them into a verdict. And do not restate this response format inside the reason: a reason that quotes the JSON gets echoed back to the user as the assistant's answer instead of the answer they asked for.",
].join("\n");

/**
 * Appended to a fired reason when `mode` is `hitl`.
 *
 * `auto` gets nothing added, so `mode: "auto"` is byte-for-byte the behaviour that
 * shipped before this hook existed. Addressed to the agent that will run the capture,
 * not to the judge — the judge's job ends at the verdict, and adding this to
 * `JUDGE_CONDITION` would make the judge reconcile an instruction meant for someone
 * else, which is exactly how the two failed prompt-side fixes in the JUDGE PROTOCOL
 * LEAKED incident went wrong.
 */
const HITL_TAIL =
  "\nBefore writing anything, put each subject above to the user with the AskUserQuestion " +
  "tool — one question per subject, offering to store it, skip it, or store it reworded — " +
  "and write only what they approve. This session is in hitl mode, so an unconfirmed " +
  "episode is not to be written even where the capture skill would allow it unprompted.";

/**
 * The JSON shape the child is forced into, so the verdict is parsed rather than guessed.
 *
 * `reason` has to stay optional: the condition tells the judge to omit it on a pass, and
 * a schema requiring it would put the model in the position of inventing one to satisfy
 * the schema — which is how a quiet turn turns into a fired capture.
 */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["ok"],
  additionalProperties: false,
};

/**
 * The closing assistant message from a transcript, or `""` when there isn't one.
 *
 * Reads a bounded tail rather than the file, and parses lines from the end backwards, so
 * cost is independent of session length. A partial first line is expected — the tail
 * almost always begins mid-record — and is discarded by the per-line try/catch rather
 * than special-cased, because a truncated JSON line and a malformed one want the same
 * treatment.
 *
 * @param {string} transcriptPath
 * @returns {string}
 */
function lastAssistantMessage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return "";
  }
  let text = "";
  try {
    const { size } = fs.statSync(transcriptPath);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }

  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated head of the tail, or a line we do not understand
    }
    // Stop at the turn boundary. A genuine user prompt ends the current turn, so
    // walking past it returns the *previous* turn's answer — which would be judged
    // again, with `stop_hook_active` false because it is a different turn, i.e. the
    // duplicate-fire shape next door to the livelock. Tool results also arrive as
    // `user` records and must not stop the walk.
    if (record?.type === "user") {
      const content = record?.message?.content;
      const parts = Array.isArray(content) ? content : [];
      if (!parts.some((part) => part?.type === "tool_result")) {
        return "";
      }
      continue;
    }
    if (record?.type !== "assistant") {
      continue;
    }
    const content = record?.message?.content;
    const parts = Array.isArray(content) ? content : [];
    const prose = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (prose) {
      return prose;
    }
    // An assistant record carrying only tool calls is not the closing message; keep
    // walking back. Returning "" here would make every tool-terminated turn unjudgeable.
  }
  return "";
}

/**
 * @param {object} payload the Stop hook's stdin, already parsed
 * @param {string} summary the closing assistant message
 * @returns {string}
 */
function buildJudgePrompt(payload, summary) {
  // Only `stop_hook_active` is passed through, because that is the only field the
  // condition is told to read. Handing over the whole payload would put a transcript
  // path and a session id in front of a judge instructed to ignore them.
  const forwarded = JSON.stringify({ stop_hook_active: Boolean(payload?.stop_hook_active) });
  const condition = JUDGE_CONDITION.replace("__PAYLOAD__", forwarded);
  return `${condition}\n\nThe turn to score, as the assistant's closing message:\n\n${summary}`;
}

/**
 * Background task types that mean an *agent* is still working, and could still produce
 * something worth capturing.
 *
 * `shell`, `monitor` and `MCP task` are deliberately absent: a background build, a log
 * tail or an MCP monitor will not add a finding to the turn, and some of them run for the
 * length of the session, so waiting on one would mean never judging.
 *
 * An allowlist rather than a denylist, on purpose. `type` falls back to the raw
 * discriminant for a type this CLI version does not name, so a denylist would defer the
 * judge on anything new — potentially for the whole session, invisibly. An unrecognised
 * agent type instead judges early and may score partial work, which is the recoverable
 * failure of the two, and the same fail-open choice `judgeTurn` makes everywhere else.
 */
const AGENT_TASK_TYPES = new Set(["subagent", "workflow", "teammate", "cloud session"]);

/**
 * The in-flight agent tasks a Stop payload names (Claude Code ≥ 2.1.145).
 *
 * An absent array is **not** an empty one. Both arrays are present whenever the task
 * registry is reachable and empty when nothing is in flight, so absent means the registry
 * could not be read or the CLI predates the field — and both of those must judge rather
 * than defer.
 *
 * `session_crons` is deliberately not consulted. A `recurring: true` entry — any `/loop`,
 * any `CronCreate` — never drains, so gating on it would silence capture for the rest of
 * the session; even a one-shot `ScheduleWakeup` can be an hour out.
 *
 * @param {object} payload the Stop hook's stdin, already parsed
 * @returns {Array<Object>} the entries worth waiting for, in payload order
 */
function pendingAgentTasks(payload) {
  const tasks = payload?.background_tasks;
  if (!Array.isArray(tasks)) {
    return [];
  }
  return tasks.filter((task) => AGENT_TASK_TYPES.has(task?.type));
}

/**
 * Every way the judge can end, as a loggable label.
 *
 * The point of naming these is that the hook stays quiet to the *user* on all of them
 * while still saying which one happened in the log. Before this existed, nine failures
 * and one healthy pass all logged the single word `quiet`, so a judge that had been dead
 * since an OAuth token expired was indistinguishable from a month of unremarkable turns —
 * and this project's Stop defects have historically survived precisely by being
 * unmeasurable.
 */
const OUTCOMES = {
  NO_SUMMARY: "no-closing-prose",
  SPAWN_FAILED: "spawn-failed",
  TIMEOUT: "timeout",
  EXIT_NONZERO: "exit-nonzero",
  NO_OUTPUT: "no-output",
  UNPARSEABLE: "unparseable-verdict",
  RESTATED_FORMAT: "reason-restated-format",
  NO_REASON: "fired-without-reason",
  PASS: "pass",
  FIRED: "fired",
};

/** Outcomes that mean the judge did not answer, as opposed to answering "nothing here". */
const BROKEN_OUTCOMES = new Set([
  OUTCOMES.SPAWN_FAILED,
  OUTCOMES.TIMEOUT,
  OUTCOMES.EXIT_NONZERO,
  OUTCOMES.NO_OUTPUT,
  OUTCOMES.UNPARSEABLE,
  OUTCOMES.RESTATED_FORMAT,
  OUTCOMES.NO_REASON,
]);

/**
 * A reason that quotes the verdict format is dropped rather than fed back.
 *
 * This is GP-921 route 1 in code. The prompt asks the judge not to restate the response
 * format inside its reason, because the reason is fed back and surfaces to the user as
 * the assistant's answer; a prompt-side rule is the right first line but it is advice to
 * a model, and this one is cheap to enforce. Dropping beats sanitising: a reason that
 * came back shaped like a verdict is evidence the judge misunderstood its task, so its
 * content is not worth trusting either.
 */
const VERDICT_SHAPE = /"ok"\s*:\s*(?:true|false)/;

/**
 * Reasons are one line plus a few ten-word bullets, so this is generous. The bullet
 * bound lives only in the prompt, which means a judge that ignores it can hand back an
 * arbitrarily long payload for the platform to inject into the conversation.
 */
const MAX_REASON_CHARS = 800;

/** Last of stderr, for the log. Auth failures and quota walls announce themselves here. */
function stderrTail(result) {
  const text = String(result?.stderr || "")
    .trim()
    .replace(/\s+/g, " ");
  return text ? `stderr: ${text.slice(-300)}` : "";
}

/**
 * Run the judge. Never throws, and never asks the platform to block on a judge that
 * could not answer — a Stop hook sits between the user and the end of their turn.
 *
 * @param {object} payload
 * @param {string} mode one of runtime-config's MODES
 * @param {{ spawn?: Function, cwd?: string }} [deps] seam for tests; nothing else injects
 * @returns {{outcome: string, reason: string|null, detail: string|null}} `reason` is
 *   non-null only for `FIRED`; `detail` carries the diagnostic for the log
 */
function judgeTurn(payload, mode, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const summary = lastAssistantMessage(payload?.transcript_path);
  if (!summary) {
    return quiet(OUTCOMES.NO_SUMMARY);
  }

  const args = [
    "-p",
    "--model",
    JUDGE_MODEL,
    "--strict-mcp-config",
    // Platform-level recursion guard, alongside the env var. Recorded in
    // evals/lib/runner.py:40-42: zero hook dispatches with it, one without.
    "--settings",
    '{"disableAllHooks": true}',
    "--allowedTools",
    "",
    "--json-schema",
    JSON.stringify(VERDICT_SCHEMA),
  ];

  let result;
  try {
    result = spawn("claude", args, {
      input: buildJudgePrompt(payload, summary),
      encoding: "utf8",
      timeout: JUDGE_TIMEOUT_MS,
      env: childEnv(),
      // A neutral cwd, not the user's project. The child is non-bare, so it discovers
      // CLAUDE.md from the working directory upward — running it in the repo hands the
      // judge that project's instructions on top of the prompt under test, which is the
      // same bias `evals/lib/runner.py` avoids with a temp dir and the reason its scores
      // would otherwise not describe production. Everything the judge needs is passed
      // inline on stdin, so it wants nothing from the project tree.
      cwd: deps.cwd || os.tmpdir(),
    });
  } catch (err) {
    // Reached only for a developer bug — a malformed argv, a throw inside childEnv().
    // A missing binary does not come through here; see result.error below.
    return quiet(OUTCOMES.SPAWN_FAILED, `threw: ${err?.message ?? err}`);
  }
  if (!result) {
    return quiet(OUTCOMES.SPAWN_FAILED, "spawn returned nothing");
  }
  // spawnSync reports a missing binary and a killed child in `error`/`signal` rather
  // than by throwing, so reading `status` alone collapsed the two most likely
  // production failures — `claude` absent from a hook's PATH (ENOENT), and the 30s
  // timeout — into the generic non-zero branch, with the diagnostic discarded.
  if (result.error) {
    const code = result.error.code ?? "error";
    return quiet(
      code === "ETIMEDOUT" || result.signal ? OUTCOMES.TIMEOUT : OUTCOMES.SPAWN_FAILED,
      `${code}: ${result.error.message}`
    );
  }
  if (result.signal) {
    return quiet(OUTCOMES.TIMEOUT, `killed by ${result.signal}`);
  }
  if (result.status !== 0) {
    return quiet(
      OUTCOMES.EXIT_NONZERO,
      [`exit ${result.status}`, stderrTail(result)].filter(Boolean).join("; ")
    );
  }
  if (!result.stdout) {
    return quiet(OUTCOMES.NO_OUTPUT, stderrTail(result) || null);
  }

  const verdict = parseVerdict(result.stdout);
  if (!verdict) {
    return quiet(
      OUTCOMES.UNPARSEABLE,
      String(result.stdout).trim().replace(/\s+/g, " ").slice(0, 200)
    );
  }
  if (verdict.ok !== false) {
    return quiet(OUTCOMES.PASS);
  }
  let reason = String(verdict.reason || "").trim();
  if (!reason) {
    // ok:false with no reason is not actionable — there is nothing to tell the agent to
    // capture, and blocking on it would re-enter the turn with an empty instruction.
    return quiet(OUTCOMES.NO_REASON);
  }
  if (VERDICT_SHAPE.test(reason)) {
    return quiet(OUTCOMES.RESTATED_FORMAT, reason.slice(0, 200));
  }
  if (reason.length > MAX_REASON_CHARS) {
    reason = `${reason.slice(0, MAX_REASON_CHARS).trimEnd()}…`;
  }
  return {
    outcome: OUTCOMES.FIRED,
    reason: mode === "hitl" ? `${reason}${HITL_TAIL}` : reason,
    detail: null,
  };
}

/**
 * @param {string} outcome
 * @param {string|null} [detail]
 * @returns {{outcome: string, reason: null, detail: string|null}}
 */
function quiet(outcome, detail = null) {
  return { outcome, reason: null, detail };
}

/**
 * Pull `{ok, reason}` out of the child's stdout.
 *
 * `--json-schema` puts the object in `structured_output`, but the flag is not honoured on
 * every path — a budget overrun leaves it `null` with exit 1, measured — so the bare
 * object is accepted too rather than treated as a parse failure.
 *
 * @param {string} stdout
 * @returns {{ok: boolean, reason?: string}|null}
 */
function parseVerdict(stdout) {
  const text = String(stdout || "").trim();
  if (!text) {
    return null;
  }
  const candidates = [];
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer === "object") {
      candidates.push(outer.structured_output, outer.result, outer);
    }
  } catch {
    // not JSON at the top level; fall through to the embedded-object scan
  }
  const embedded = /\{[^{}]*"ok"\s*:\s*(?:true|false)[^{}]*\}/.exec(text);
  if (embedded) {
    try {
      candidates.push(JSON.parse(embedded[0]));
    } catch {
      // ignore
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && typeof candidate.ok === "boolean") {
      return candidate;
    }
  }
  return null;
}

module.exports = {
  JUDGE_MODEL,
  JUDGE_TIMEOUT_MS,
  JUDGE_CONDITION,
  HITL_TAIL,
  VERDICT_SCHEMA,
  TAIL_BYTES,
  OUTCOMES,
  BROKEN_OUTCOMES,
  MAX_REASON_CHARS,
  AGENT_TASK_TYPES,
  pendingAgentTasks,
  lastAssistantMessage,
  buildJudgePrompt,
  parseVerdict,
  judgeTurn,
};
