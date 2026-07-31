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
const path = require("node:path");
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
 * The output-style skill, as the id the platform would invoke it by.
 *
 * Namespaced rather than a bare stem on purpose, and not only for correctness: the guard
 * in `tests/hook-architecture.test.cjs` reads a bare quoted literal matching a skill
 * directory as an unreachable pointer, because shipping one made the model guess the
 * prefix. The directory name is derived from the id rather than written twice.
 */
const STYLE_SKILL = "gutt-claude-code-plugin:output-style";
const STYLE_SKILL_DIR = STYLE_SKILL.split(":")[1];

/**
 * The markers delimiting the injected region of that skill's `SKILL.md`.
 *
 * ## Why the text is read from the skill instead of held here as a constant
 *
 * GP-927 had three homes to choose between, and the repo had been arguing two of them at
 * once. A hook-only constant loses the human-readable, user-invocable skill. A skill-only
 * rule never applies on the capture path, because the fired reason names `memory-capture`
 * and nothing loads the style skill — so the rule would be written down and inert exactly
 * when it matters. Reading a delimited region of the skill is the only option where the
 * bytes the agent receives and the bytes a human reads are the same bytes.
 *
 * That resolves the objection recorded in `memory-capture/SKILL.md`, which argued against
 * procedural text in the reason. The argument was about **duplication** — a rule stated in
 * the reason and again in a skill loaded moments later is paid for twice — and it holds
 * for anything `memory-capture` itself covers. It does not reach text that exists in one
 * place and is loaded on no other path, which is this. The capture *procedure* stays in
 * that file; the closing style is injected, because otherwise it arrives nowhere.
 *
 * The block earns that claim rather than merely asserting it: it used to also specify the
 * length of the capture account, in almost the words `memory-capture` uses, and
 * `memory-capture` is loaded on every path this block is injected on. That clause was the one
 * part genuinely paid for twice, so it was removed from the injected region — the account's
 * shape belongs to whichever skill owns the work, and the injected text only says where the
 * account goes.
 *
 * Cost is one small file read per fire. R25's latency budget is on the UserPromptSubmit
 * path, not this one — and note that the repo states it inconsistently, as 50ms in
 * `shared/runtime-config.cjs` against ≤2s in `docs/e2e-hook-test-plan.md` §R25, unresolved
 * either way. Stop is on neither reading the tight path, and this hook already spawns a
 * `claude -p` child, so a 1KB read is not the term that matters.
 */
const STYLE_BEGIN = "<!-- INJECTED:BEGIN -->";
const STYLE_END = "<!-- INJECTED:END -->";

/**
 * Candidate paths to that `SKILL.md`, in resolution order.
 *
 * `${CLAUDE_PLUGIN_ROOT}` first because it is what the platform sets for a hook process
 * and the only one that is right in every layout. The two fallbacks exist because
 * `__dirname` is not stable across them: installed, this file is a real file at
 * `<root>/hooks/lib/`, so `../..` is the plugin root (documented behaviour, not measured —
 * see `docs/plugin-platform-reference.md` §3 on symlink dereferencing at install); in local
 * development it is `shared/stop-judge.cjs` reached through a symlink, and Node resolves
 * `__dirname` to the realpath, which puts `../..` outside the repo entirely. Hence the
 * explicit `gutt-core` candidate, which names the directory instead of walking up to it.
 *
 * The `gutt-core` candidate is tried **before** `../..` even though only the installed
 * layout needs `../..`, because in the dev layout `../..` resolves to the parent of the
 * checkout — the directory every sibling repo also lives in. Tried first, any stray
 * `skills/output-style/SKILL.md` there would outrank this plugin's own copy. Ordered this
 * way the out-of-tree path is reachable only when nothing inside the plugin matched.
 *
 * @returns {string[]}
 */
function styleBlockPaths() {
  const rel = path.join("skills", STYLE_SKILL_DIR, "SKILL.md");
  const paths = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    paths.push(path.join(process.env.CLAUDE_PLUGIN_ROOT, rel));
  }
  paths.push(path.resolve(__dirname, "..", "gutt-core", rel));
  // The installed layout's candidate, admitted only when that directory really is a plugin
  // root. Ordering it last stops it *winning* over the plugin's own copy; it does not stop it
  // being read when nothing else matched, and in the dev layout it resolves to the parent of
  // the checkout — the directory every sibling repo shares. A stray
  // `skills/output-style/SKILL.md` there would be injected verbatim into a fired reason, so
  // the manifest check is what makes that structurally impossible rather than merely unlikely.
  const up = path.resolve(__dirname, "..", "..");
  if (fs.existsSync(path.join(up, ".claude-plugin", "plugin.json"))) {
    paths.push(path.join(up, rel));
  }
  return paths;
}

/**
 * The injected region of the style skill, with a diagnosis when something was wrong.
 *
 * Fails open and silently to the turn: a missing or malformed block must cost the style,
 * never the capture, because this sits between the user and the end of their turn. It is
 * not silent to the log — `judgeTurn` puts `cause` in the fired outcome's detail, so a
 * marker someone deleted shows up as a line in the invocations log rather than as replies
 * that quietly stopped closing on the work.
 *
 * `cause` exists because `""` alone was one channel for five failures with five different
 * fixes: reinstall, restore a deleted marker, `chmod`, correct `CLAUDE_PLUGIN_ROOT`, remove
 * a directory sitting at the path. `shared/plugin-state.cjs`'s `readJsonOrUnreadable` draws
 * the same distinction for the same reason, and this is the second caller that needs it.
 *
 * Two rules decide what is worth reporting. A candidate that is simply absent
 * (`ENOENT`/`ENOTDIR`) is a layout miss and says nothing — that is the mechanism by which
 * the fallbacks work. Any other errno is a defect at a path that was meant to resolve, so it
 * is named even when a later candidate then succeeds. Markers missing is likewise non-fatal
 * to the search: an install whose `SKILL.md` predates the markers should fall through to a
 * copy that has them rather than lose the feature while a good copy sits further down the
 * chain, which is what returning early here used to do.
 *
 * @returns {{text: string, cause: string|null}}
 */
function readStyleBlockResult() {
  const defects = [];
  for (const file of styleBlockPaths()) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
        defects.push(`${err.code || "read failed"} at ${file}`);
      }
      continue; // not this layout, or not readable; either way try the next candidate
    }
    const start = text.indexOf(STYLE_BEGIN);
    const end = start === -1 ? -1 : text.indexOf(STYLE_END, start + STYLE_BEGIN.length);
    if (end === -1) {
      defects.push(`markers missing in ${file}`);
      continue;
    }
    const block = text.slice(start + STYLE_BEGIN.length, end).trim();
    if (!block) {
      defects.push(`injected region empty in ${file}`);
      continue;
    }
    return { text: block, cause: defects.length ? defects.join("; ") : null };
  }
  return { text: "", cause: defects.length ? defects.join("; ") : "no candidate readable" };
}

/**
 * The injected region of the style skill, or `""` if it cannot be read.
 *
 * The text on its own, for callers that want the block rather than the diagnosis.
 *
 * @returns {string}
 */
function readStyleBlock() {
  return readStyleBlockResult().text;
}

/**
 * The bound on the whole reason the platform is asked to inject, constants included.
 *
 * `MAX_REASON_CHARS` bounds only the judge's half, and did so when that half was the
 * whole reason. With `HITL_TAIL` and the style block appended by this script there was no
 * guard on the total at all, so this caps what actually reaches the conversation.
 *
 * Enforced by dropping the style block whole, not by truncating it and not by chopping the
 * composed string: the block's last clause is the closing instruction — the one part of the
 * reason this story exists to deliver — so half a block is worse than none. The judge's
 * bullets are what the capture acts on, so they are never the half that yields.
 * `tests/stop-capture.test.cjs` measures the worst case (`hitl`, both constants present) and
 * asserts the slack is real, so growing the block past the budget fails a test instead of
 * silently costing the block at runtime.
 *
 * The value is the composed worst case — `HITL_TAIL`, the block, their separators and the
 * judge's full `MAX_REASON_CHARS`, with the truncation ellipsis charged against that cap
 * rather than added to it — plus room to reword the block by comfortably more than a third
 * of its length. Not a round number chosen first.
 *
 * **No character counts are quoted here on purpose.** They were, and they went stale inside
 * this very story: the block was shortened twice while this paragraph named the old length
 * each time, so the one number a maintainer would recompute from was the one that lied. The
 * counts are derived where they are enforced instead — `tests/stop-capture.test.cjs` composes
 * the real worst case and asserts the slack, and `tests/hook-architecture.test.cjs` derives
 * the largest block that fits from these constants. Both fail loudly rather than drift, which
 * is the property a comment cannot have.
 *
 * The cap was raised to 2800 partway through GP-927 and brought back down (`deaec86`, then
 * `eae3246`), and both moves are the same lesson. Set once so tightly that the slack was a few
 * dozen characters, every edit to the skill would have failed a test — the guard is meant to
 * catch a block that has doubled, not one that gained a clause. Then the whole-reply style
 * list moved out of the injected region, on `evals/suites/capture_close` measuring the block
 * as scoring *worse* with it than without, and the cap came back down with the block rather
 * than being left loose at 2800. A cap that no longer tracks what it bounds is not a cap.
 */
const MAX_COMPOSED_REASON_CHARS = 2400;

/**
 * Assemble the reason the platform will inject: the judge's verdict, then the constants.
 *
 * Order is chronological for the agent that reads it — capture these subjects, confirm
 * them if this session is `hitl`, then close the reply on the work. The style block goes
 * last because it governs the end of the reply and is the instruction most easily lost in
 * the middle of a system message.
 *
 * ## Which half yields, and why the ellipsis is charged to the budget
 *
 * Two things this got wrong while the shipped block was small enough that neither showed.
 *
 * The judge's half now keeps its full `MAX_REASON_CHARS` and the **block** is what gives way,
 * matching the policy stated throughout this file: the style may cost, the capture never
 * does. Clamping the budget instead let an oversized block drive it to zero, which reduced
 * the whole verdict — skill name and every subject bullet — to a bare `…`, leaving the agent
 * told to close a reply on subjects it could no longer see.
 *
 * The ellipsis is charged against the budget rather than appended after it. Adding it to a
 * slice already the budget's full width made the composed length `MAX_COMPOSED_REASON_CHARS
 * + 1` for every block from 1259 characters up, so the cap was not a bound in the one regime
 * it exists for.
 *
 * Both are diagnostics as well as fixes: a dropped block and a truncated verdict are each
 * reported back so they reach the invocations log instead of showing up only as a reply that
 * quietly stopped closing on the work.
 *
 * @param {string} reason the judge's reason, already screened
 * @param {string} mode one of runtime-config's MODES
 * @param {string} style the injected style block, or `""`
 * @returns {{text: string, styleDropped: boolean, truncatedTo: number|null}} `styleDropped`
 *   and `truncatedTo` are diagnostics for the fired outcome's detail, never content
 */
function composeReason(reason, mode, style) {
  const hitl = mode === "hitl" ? HITL_TAIL : "";
  const block = style ? `\n\n${style}` : "";
  // Measured against `MAX_REASON_CHARS`, not against this verdict's actual length, so the
  // decision does not turn on how verbose one judge call happened to be.
  const styleDropped =
    Boolean(style) && MAX_COMPOSED_REASON_CHARS - (hitl.length + block.length) < MAX_REASON_CHARS;
  const tail = styleDropped ? hitl : `${hitl}${block}`;
  const budget = Math.max(0, Math.min(MAX_REASON_CHARS, MAX_COMPOSED_REASON_CHARS - tail.length));
  const truncated = reason.length > budget;
  // `budget - 1` leaves room for the ellipsis, so a truncated head is at most `budget`.
  const head = truncated ? `${reason.slice(0, Math.max(0, budget - 1)).trimEnd()}…` : reason;
  return {
    text: `${head}${tail}`,
    styleDropped,
    truncatedTo: truncated ? head.length : null,
  };
}

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
 * The turn's closing assistant text, preferring the copy the platform hands us.
 *
 * `last_assistant_message` is on Stop and SubagentStop stdin, and it is the documented
 * source for exactly this: upstream says hooks needing the final assistant text should use
 * it *instead of* reading the transcript, because `transcript_path` is written
 * asynchronously and can lag the in-memory conversation.
 *
 * This hook read the transcript first for its whole life and paid for it — `no-closing-prose`
 * on 6 of 53 invocations, and in the one occurrence examined closely the assistant record
 * was in the file afterwards, 2377 chars of text, a few KB from EOF, with only skippable
 * metadata records after it and comfortably inside `TAIL_BYTES`. Nothing was wrong with the
 * walk. The read had simply happened before the write landed, which is the race this field
 * exists to remove.
 *
 * The walk stays as a fallback rather than being deleted: the field postdates this hook, so
 * an older CLI supplies none and the transcript is the only source there. Absent and empty
 * both fall through the same test on purpose — an empty string is not a closing message
 * either, and re-reading the transcript in that case costs one `stat` on a path that was
 * already going to fail.
 *
 * @param {object} payload the Stop hook's stdin, already parsed
 * @returns {string}
 */
function closingMessage(payload) {
  const handed = payload?.last_assistant_message;
  if (typeof handed === "string" && handed.trim()) {
    return handed.trim();
  }
  return lastAssistantMessage(payload?.transcript_path);
}

/**
 * Why there was nothing to score, in the terms that separate the causes.
 *
 * `NO_SUMMARY` logged bare until now, so every occurrence was equally unexplainable after
 * the fact: a missing `transcript_path`, a path that does not resolve, a transcript that had
 * not been flushed, and a genuinely text-less turn are four different defects with four
 * different fixes, and they shared one word. This is what makes a residual occurrence — now
 * that the payload field is preferred — a report rather than a mystery.
 *
 * Deliberately cheap and non-throwing: it runs on a path that is already failing, and a
 * diagnostic that can throw would convert a quiet outcome into a crashed hook.
 *
 * @param {object} payload
 * @returns {string}
 */
function noSummaryDetail(payload) {
  // Only reachable when the field was absent, or present and blank — `closingMessage`
  // returns early on anything else, so there is no third case to report.
  const handed = payload?.last_assistant_message;
  const field =
    typeof handed === "string" ? "last_assistant_message blank" : "last_assistant_message absent";
  const file = payload?.transcript_path;
  if (!file) {
    return `${field}, no transcript_path`;
  }
  try {
    return `${field}, transcript ${fs.statSync(file).size}B`;
  } catch (err) {
    return `${field}, transcript unreadable (${err?.code || "unknown"})`;
  }
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

/**
 * Outcomes that mean the judge did not answer, as opposed to answering "nothing here".
 *
 * `NO_SUMMARY` belongs here and was missing, which is how the transcript-lag bug survived 6
 * invocations unnoticed. It reads like a negative result — "no closing prose, nothing to
 * score" — but the judge is never spawned on it, so it is the strongest form of not
 * answering: not even asked. Filed with the quiet outcomes it shared a bucket with a real
 * negative, and the one signal that would have exposed it was the one thing not being
 * written.
 *
 * The cost of the reclassification is a false entry in the error log for a turn that
 * genuinely ends with no assistant text. That is the right trade — such a turn is rare
 * enough that nobody has produced one, and `noSummaryDetail` names it (`blank` rather than
 * `absent`) if it happens.
 */
const BROKEN_OUTCOMES = new Set([
  OUTCOMES.NO_SUMMARY,
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
 * @param {{ spawn?: Function, cwd?: string, styleBlock?: string }} [deps] seam for tests;
 *   nothing else injects. `styleBlock` is honoured when present including as `""`, so a
 *   test can exercise the unreadable-block path without moving the skill file
 * @returns {{outcome: string, reason: string|null, detail: string|null}} `reason` is
 *   non-null only for `FIRED`; `detail` carries the diagnostic for the log
 */
function judgeTurn(payload, mode, deps = {}) {
  const spawn = deps.spawn || spawnSync;
  const summary = closingMessage(payload);
  if (!summary) {
    return quiet(OUTCOMES.NO_SUMMARY, noSummaryDetail(payload));
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
  const reason = String(verdict.reason || "").trim();
  if (!reason) {
    // ok:false with no reason is not actionable — there is nothing to tell the agent to
    // capture, and blocking on it would re-enter the turn with an empty instruction.
    return quiet(OUTCOMES.NO_REASON);
  }
  // Screened before the constants are appended, not after. The shape test is about what
  // the *judge* wrote; composing first would run it over our own text as well, where a
  // match could only ever be our bug, and would drop a healthy verdict to report it.
  if (VERDICT_SHAPE.test(reason)) {
    return quiet(OUTCOMES.RESTATED_FORMAT, reason.slice(0, 200));
  }
  const read =
    deps.styleBlock === undefined ? readStyleBlockResult() : { text: deps.styleBlock, cause: null };
  const style = read.text;
  const composed = composeReason(reason, mode, style);
  // A fire is not a failure, so none of these reach the error log. But each is the difference
  // between the capture path closing on the work and trailing off into bookkeeping, and this
  // log line is the only place any of them would show. Joined rather than ranked: they are
  // independent, and a fire that hit two of them should say so.
  const notes = [];
  if (!style) {
    notes.push(read.cause ? `style block unreadable: ${read.cause}` : "style block unreadable");
  } else if (read.cause) {
    // Read successfully, but not from the first candidate that should have worked. Worth a
    // line: it is how a broken `CLAUDE_PLUGIN_ROOT` shows up while the feature still works.
    notes.push(`style block read past a defect: ${read.cause}`);
  }
  if (composed.styleDropped) {
    notes.push(`style block over budget at ${style.length} chars, dropped`);
  }
  if (composed.truncatedTo !== null) {
    notes.push(`judge reason truncated to ${composed.truncatedTo} chars`);
  }
  return {
    outcome: OUTCOMES.FIRED,
    reason: composed.text,
    detail: notes.length ? notes.join("; ") : null,
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
  VERDICT_SHAPE,
  TAIL_BYTES,
  OUTCOMES,
  BROKEN_OUTCOMES,
  MAX_REASON_CHARS,
  MAX_COMPOSED_REASON_CHARS,
  STYLE_SKILL,
  STYLE_SKILL_DIR,
  STYLE_BEGIN,
  STYLE_END,
  AGENT_TASK_TYPES,
  pendingAgentTasks,
  lastAssistantMessage,
  closingMessage,
  buildJudgePrompt,
  parseVerdict,
  styleBlockPaths,
  readStyleBlock,
  readStyleBlockResult,
  composeReason,
  judgeTurn,
};
