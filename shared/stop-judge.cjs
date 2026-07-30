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
 * The stopping condition, verbatim from the `type: "prompt"` entry it replaces.
 *
 * Kept byte-identical on purpose: the mechanism changed in this commit and the wording
 * did not, so a behaviour change here would be indistinguishable from a mechanism
 * regression. Several clauses now defend against something that can no longer happen —
 * "do not restate this response format inside the reason" existed because the template
 * was echoed to the main agent, and a command hook never echoes it — but pruning them is
 * a separate change with its own eval round (`evals/` suite `stop-judge`).
 *
 * `$ARGUMENTS` is gone with the prompt hook that interpolated it; `buildJudgePrompt`
 * substitutes the payload explicitly.
 */
const JUDGE_CONDITION = [
  'Nothing from this finished turn needs to be written to the team\'s long-term memory — that is the condition, satisfied ({"ok": true}) when there is nothing to record. Score the turn, do not continue it: capture nothing yourself, call no tool, and output one JSON verdict on the conversation above. Read `stop_hook_active` from the payload; ignore the rest.',
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
 * Run the judge. Returns `null` for "stay quiet" — including every failure, since a
 * judge that cannot answer must not block the user's turn.
 *
 * @param {object} payload
 * @param {string} mode one of runtime-config's MODES
 * @param {{ spawn?: Function, cwd?: string }} [deps] seam for tests; nothing else injects
 * @returns {string|null} the reason to feed back, or null to allow the stop
 */
function judgeTurn(payload, mode, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const summary = lastAssistantMessage(payload?.transcript_path);
  if (!summary) {
    return null; // nothing to score
  }

  const args = [
    "-p",
    "--model",
    JUDGE_MODEL,
    "--strict-mcp-config",
    // Platform-level recursion guard, alongside the env var. Measured in
    // evals/lib/runner.py: zero hook dispatches with it, one without.
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
      cwd: deps.cwd,
    });
  } catch {
    return null;
  }
  if (!result || result.status !== 0 || !result.stdout) {
    return null;
  }

  const verdict = parseVerdict(result.stdout);
  if (!verdict || verdict.ok !== false) {
    return null;
  }
  const reason = String(verdict.reason || "").trim();
  if (!reason) {
    // ok:false with no reason is not actionable — there is nothing to tell the agent to
    // capture, and blocking on it would re-enter the turn with an empty instruction.
    return null;
  }
  return mode === "hitl" ? `${reason}${HITL_TAIL}` : reason;
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
  lastAssistantMessage,
  buildJudgePrompt,
  parseVerdict,
  judgeTurn,
};
