# Hook platform capabilities (upstream)

**Source:** <https://code.claude.com/docs/en/hooks.md>
**Read:** 2026-07-30 (§5; §1–§4 read 2026-07-29) · **Measured:** 2026-07-30 (§5 argv, §6, §7) ·
**Method:** `WebFetch` passes plus live CLI runs for §5–§7 (see [Provenance](#provenance))
**Why this file exists:** the upstream hook surface grew well past what this plugin's
docs, tests and recorded memory assume, and one of our recorded findings is now false.

This is a snapshot of what the platform offers, not a design. Nothing here has been
implemented; the [Implications](#implications-for-this-plugin) section marks what is
merely _now possible_ versus what we already rely on.

## 1. `additionalContext` is no longer a two-event field

Every event below is documented as accepting `hookSpecificOutput.additionalContext`,
grouped by **where the context lands**:

| Where it lands                                 | Events                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| At session start, before the first prompt      | `SessionStart`, `Setup`, `SubagentStart`                           |
| Alongside the submitted prompt                 | `UserPromptSubmit`, `UserPromptExpansion`                          |
| Next to the tool result                        | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` |
| At the end of the turn, conversation continues | `Stop`, `SubagentStop`                                             |

Not documented as accepting it: `Notification`, `SessionEnd`, `PreCompact`.

### What this falsifies

A recorded Insight in the gutt graph (created 2026-01-14) reads:

> "Stop hooks cannot use `hookSpecificOutput.additionalContext` to inject context —
> only UserPromptSubmit and PostToolUse support this."

**Both clauses are now false.** Stop hooks accept it, and the supported set is eleven
events rather than two. That Insight was true for the platform it was written against;
it is not true now, and it is exactly the kind of claim that silently steers a design
away from an option that has since opened up. It needs a correction episode — see
[Follow-ups](#follow-ups).

## 2. `initialUserMessage`: SessionStart only, `-p` only

`SessionStart` accepts four fields beyond `additionalContext`, quoted verbatim:

| Field                | Description                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `additionalContext`  | Context for Claude at session start                                                                   |
| `initialUserMessage` | Message to send to Claude automatically in non-interactive `-p` mode. **Ignored in interactive mode** |
| `watchPaths`         | Array of file paths to watch for changes. Fires `FileChanged` hooks when these paths change           |
| `sessionTitle`       | Custom title for the session, shown in session history                                                |
| `reloadSkills`       | If `true`, reloads skill definitions from disk                                                        |

This **confirms** the reasoning already inline at `shared/builtin-memory.cjs:224-225`:
the GP-922 migration offer could not have used `initialUserMessage`, because it is
ignored in interactive mode — the mode the offer exists for. The comment now has an
authoritative citation rather than an assertion.

Worth keeping in mind alongside the field's other property: `initialUserMessage`
_creates_ a turn rather than attaching to one. For a housekeeping offer in an
unattended `-p` run that is actively wrong — the offer would arrive as the user's own
first message with nobody present to decline it.

## 3. Stop: blocking and non-blocking are now separate channels

Verbatim:

| Field                                  | Description                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `decision: "block"`                    | Prevents Claude from stopping; continues the turn with stderr as a system message to Claude |
| `hookSpecificOutput.additionalContext` | Injects non-blocking feedback that Claude receives and may act on                           |
| `reason`                               | Message shown to Claude when blocking (pairs with `decision: "block"`)                      |

> "When you return `additionalContext` without blocking, Claude receives the context as
> a system reminder at the end of the turn. The conversation continues normally — Claude
> can respond to your feedback or let the turn complete."

**This is a channel we do not have today, and the distinction is subtle.** The GP-862
spike established that a native prompt hook's only output is `{ok, reason}` and that any
context it emits is stripped — that finding is about **prompt** hooks and is not
contradicted by the table above, which describes **command** hooks. Whether a command Stop
hook can give us a non-blocking context channel is therefore an open question, not a
settled capability.

Since GP-866 our Stop handler _is_ a command hook (§7), so the table above now describes
our own handler and the question is directly testable rather than hypothetical — but it is
still untested, and `gutt-core/hooks/stop-capture.cjs` deliberately uses `decision:
"block"` to reproduce the prompt hook's routing exactly. Swapping the channel is a separate
change, so that a regression in it cannot be confused with a regression in the conversion.

Why it matters: every current Stop fire is a `ok:false` that re-enters the turn. A
non-blocking channel would let a suggestion reach the model _without_ re-entering, which
is the failure mode that once produced 16 consecutive re-fires and an empty answer.

## 4. The event surface is ~30 events, not 9

As reported by the fetch, in document order: `SessionStart`, `Setup`,
`UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`,
`PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
`Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`,
`TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`,
`ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`,
`PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

Ones with plausible relevance here, and why — all speculative:

- **`CwdChanged`** — the built-in memory store is keyed per resolved cwd. Today the
  migration offer is evaluated once at `SessionStart`; a cwd change mid-session moves
  the store out from under that decision.
- **`SubagentStart`** — 2.x shipped subagent memory hooks that the 3.0 rebuild dropped.
  This is where they would go back, if they should.
- **`PostCompact`** — context survives compaction as a summary; a pointer injected
  pre-compact may not.
- **`InstructionsLoaded`**, **`ConfigChange`** — plausibly relevant to the snooze /
  enabled config surface.
- **`FileChanged`** + `watchPaths` — a store that changes on disk during a session.

## 5. `model` is a prompt-hook config field — and a bad value fails silently

The "Prompt and agent hook fields" table, quoted verbatim:

| Field    | Required | Description                                                           |
| -------- | -------- | --------------------------------------------------------------------- |
| `prompt` | yes      | Prompt text to send to the model. `$ARGUMENTS` is the hook input JSON |
| `model`  | no       | Model to use for evaluation. **Defaults to a fast model**             |

Plus the common fields: `type`, `if` (permission-rule filter, e.g. `"Bash(git *)"`),
`timeout` (**default 30s** for prompt hooks), `statusMessage`, `once` (skill frontmatter
only).

**The value must be a full model id, not a CLI alias — verified live 2026-07-30.**
`"model": "sonnet"` is passed straight through to the API, which answers `404
not_found_error {"message": "model: sonnet"}`. `"claude-sonnet-5"` works.

**The failure mode is silence, and it is the dangerous part.** With an unresolvable
model, the observed run gave: exit 0, `Hooks: Processing prompt hook` logged **once**,
**zero** `condition was (not )?met` lines, a normal answer to the user, and no
user-visible sign of any kind. The judge simply did not run. Retried 11 times, then
gave up:

```
[ERROR] Hooks: prompt-hook evaluator API error: There's an issue with the selected
model (sonnet). It may not exist or you may not have access to it.
```

That text reaches `--debug-file` only. So a typo in this field disables the Stop
judge outright while every unit test stays green — `tests/test-all-hooks.cjs` skips
the Stop entry (`type: prompt`), and the e2e verdict assertions only bite in a run
that got as far as producing a verdict. Worth a guard if we keep pinning a model.

### The hazard is confined to the manifest field — argv resolves aliases

**Measured 2026-07-30.** `claude -p --model sonnet` and `claude -p --model claude-sonnet-5`
both returned a clean reply, exit 0. So the 404 above is a property of the prompt hook's
`model` **field**, which is handed to the API unmodified — not of naming a model by alias.
On a command line the CLI resolves the alias before the API sees it.

This matters more than a footnote because of what it did to the guard. GP-866 moved the
Stop handler to a command hook (§6, §7), which put the model in argv and **retired** this
failure mode rather than relocating it. The old guard was written as:

```js
if (stop.model === undefined) {
  return; // unpinned is valid — the platform picks a fast default
}
```

A command hook has no `model` field, so that early return would have made the guard pass
while asserting nothing — the guard would have survived the change and the property it
stood for would not. It is now replaced by one asserting the judge is passed a model at
all, with no escape hatch (`tests/hook-architecture.test.cjs`). Note the shape rather than
the specifics: a guard with a "not applicable" branch silently becomes vacuous exactly
when the thing it guards is restructured, which is when you need it most.

## 6. The prompt `prompt` field takes one substitution, not shell expansion

**Measured 2026-07-30** against `claude` 2.1.220, prompted by the question "could the
judge read `config.json` if the field ran a script, the way a slash command body does?"

A throwaway plugin registered one Stop prompt hook whose field was
``!`cat <file>`\n\nHook payload: $ARGUMENTS``, with the entire judging instruction — and a
token appearing nowhere else — inside that file. The instruction was deliberately kept out
of `hooks.json` so that an instruction obeyed from literal text could not read as success.

Result: **the backtick call is not expanded.** It survived verbatim into the prompt the
judge received (visible on the `Hooks: Processing prompt hook with prompt: …` lines), the
token never appeared, and `cat` never ran. The judge instead read the literal text as the
condition it was asked to evaluate, answering `ok:false` with "the transcript contains no
evidence of executing `cat …`". Its fed-back reason then drove the main model to keep
_trying_ to run the command until the sandbox blocked it: **four evaluations in one turn,
16 turns, $0.13** — an incidental live reproduction of the re-fire failure mode in §3.

By contrast `$ARGUMENTS` **was** substituted: zero literal occurrences survived, and the
payload's `stop_hook_active` is present in the sent prompt. So the field goes through
exactly one narrow substitution and no shell. There is no route from a prompt hook to
anything on disk.

Consequence: a `type: "prompt"` hook cannot read plugin config, so it can be neither gated
on `enabled`/snooze nor varied in wording by `mode`. And `$ARGUMENTS` is no way in either —
the payload is constructed by the platform, with no plugin-facing field to add to it.

## 7. A command Stop hook cannot gate a prompt sibling

**Measured 2026-07-30**, same method. This is the sibling half of Follow-up 2. Our own
notes say siblings "run in parallel with no channel between them"
(`docs/runtime-state-convention.md:162`, `gutt-core/hooks/session-start.cjs:65`) — but that
sentence is about two hooks racing to write state, and says nothing about whether one
hook's output can suppress another's _dispatch_. Untested, and load-bearing.

One plugin, two Stop handlers — a command hook and a prompt hook — run twice, differing
only in what the command hook returned:

| Command hook returns     | Gate ran | Prompt-hook evaluations |
| ------------------------ | -------- | ----------------------- |
| exit 0, no output        | yes      | 1                       |
| `{"continue": false, …}` | yes      | 1                       |

**No suppression.** The prompt judge is evaluated regardless. `continue: false` is not
inert — it suppressed the turn's final answer, which came back empty — but it does not stop
the sibling. So the two hooks are independent in dispatch, not merely in state.

**Taken with §6 this closes the design space** for gating Stop on config: the handler cannot
stay a prompt hook (§6) and cannot be gated by a sibling (§7), so it must _become_ a command
hook. Recorded on GP-866, whose new ACs turn on exactly this.

> **Correction, 2026-07-30.** This section previously closed "and the dedicated
> `claude-sonnet-5` judge is removed rather than gated — a command hook cannot invoke a
> model." **That was wrong**, and it was inference rather than measurement: a command hook
> can invoke a model by shelling out to `claude -p`, which is what
> `shared/stop-judge.cjs` now does. The conversion therefore kept the model judge instead
> of dropping it, and R11 is intact.
>
> Worth noting how the error was made, since the shape recurs. Two things were measured
> here — a prompt hook cannot read config, a sibling cannot gate a sibling — and a third
> was appended in the same breath without being tested. It read as equally established
> because it sat in the same paragraph as two real results. The measured claims stand; only
> the unmeasured rider was false.

Still open from Follow-up 2: whether a command Stop hook's `additionalContext` reaches the
model **non-blocking**. Not tested here — these runs only counted dispatches, and the
converted handler deliberately uses `decision: "block"` so the channel question stays
separable from the conversion.

## Implications for this plugin

**Already relied on and now confirmed:**

- `SessionStart.additionalContext` works, and is a channel independent of
  `UserPromptSubmit`'s. GP-922 depends on this and it is verified both live and here.
- `initialUserMessage` was correctly rejected for the migration offer.

**Newly possible, not yet designed:**

- A non-blocking Stop context channel — pending the prompt-vs-command question in §3.
- `reloadSkills`, `sessionTitle`, `watchPaths` on `SessionStart`.
- Roughly twenty events we neither handle nor model in `tests/hook-architecture.test.cjs`.

**Now in use:**

- The Stop judge pins `"model": "claude-sonnet-5"` (§5) rather than taking the platform
  default fast model. Judge quality is the whole value of that hook, and the default was
  never chosen — it was inherited.

**Stale as a result:**

- The 2026-01-14 graph Insight quoted in §1.
- Any local reasoning that treats `additionalContext` as a two-event field.

## Follow-ups

None of these are done; recorded so they are not lost.

1. Write a correction episode superseding the 2026-01-14 Insight. Per house practice a
   contradicted memory is corrected by a new episode, not by editing the node — and per
   `memory-capture` rule 1 the pair goes through `conflict-adjudication` first.
2. Answer §3: can a **command** Stop hook return non-blocking `additionalContext` under
   our hook set? This is testable in the e2e tier and would need a real run, not a doc read.
   **Partly answered 2026-07-30 — see §7.** The sibling-dispatch half is settled: a command
   hook cannot suppress a prompt sibling. The `additionalContext` half is still open, and it
   is now the one that matters, because §6 + §7 force the Stop handler to a command hook and
   the non-blocking channel is what would keep it from re-entering the turn.
3. Decide whether `CwdChanged` should re-evaluate the GP-922 migration offer.
4. Guard the pinned `model` value in §5. A typo silently disables the Stop judge and no
   tier catches it: the unit tier skips prompt hooks, the e2e tier asserts on verdicts
   that a dead judge never emits. The cheap version is a structural assertion that the
   value matches a known-id shape; the honest version asserts a verdict was produced.

## Provenance

Two `WebFetch` passes against the URL above on 2026-07-29, two more on 2026-07-30 for §5.
`WebFetch` renders the page and answers via a small fast model, so it summarizes rather
than returning raw markdown.

Confidence differs by section, and the difference is worth respecting before anyone
builds on this:

- **§1–§3 are quoted tables and sentences**, requested verbatim, and the two passes
  agreed with each other where they overlapped. Treat as reliable.
- **§4's event list came from a single pass** and was not cross-checked. Re-read the
  source before designing against any individual event name here.
- **§5's field table is quoted**, and its two claims that matter — full-id-only, and the
  silent-failure mode — are **not doc reads at all**: they were measured against `claude`
  2.1.220 on 2026-07-30 by running the hook both ways and reading `--debug-file`. Highest
  confidence in the file. The two passes disagreed on whether `model` is a config field at
  all (one pass found only the SessionStart _input_ field of the same name); the live run
  settled it — it is both.
- **§6 and §7 are not doc reads at all** — both were measured against `claude` 2.1.220 on
  2026-07-30 with throwaway single-hook plugins loaded via `--plugin-dir`, reading
  `--debug-file`. Each was designed so the negative result could not be faked: §6 keeps the
  judging instruction out of `hooks.json` entirely, so text obeyed from the literal field
  could not pass as expansion; §7 has the command hook touch a marker file, so "0 prompt
  evaluations" could be distinguished from "neither hook ran". Highest confidence in the
  file, alongside §5.
- **§ "Implications" and "Follow-ups" are our inference**, not upstream text.
