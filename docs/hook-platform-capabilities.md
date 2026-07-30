# Hook platform capabilities (upstream)

**Source:** <https://code.claude.com/docs/en/hooks.md>
**Read:** 2026-07-29 · **Method:** two `WebFetch` passes (see [Provenance](#provenance))
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

**This is a channel we do not have today, and the distinction is subtle.** Our Stop
handler is a `prompt` hook, not a command hook. The GP-862 spike established that a
native prompt hook's only output is `{ok, reason}` and that any context it emits is
stripped — that finding is about **prompt** hooks and is not contradicted by the table
above, which describes **command** hooks. Whether a command Stop hook can give us a
non-blocking context channel is therefore an open question, not a settled capability.

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

## Implications for this plugin

**Already relied on and now confirmed:**

- `SessionStart.additionalContext` works, and is a channel independent of
  `UserPromptSubmit`'s. GP-922 depends on this and it is verified both live and here.
- `initialUserMessage` was correctly rejected for the migration offer.

**Newly possible, not yet designed:**

- A non-blocking Stop context channel — pending the prompt-vs-command question in §3.
- `reloadSkills`, `sessionTitle`, `watchPaths` on `SessionStart`.
- Roughly twenty events we neither handle nor model in `tests/hook-architecture.test.cjs`.

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
3. Decide whether `CwdChanged` should re-evaluate the GP-922 migration offer.

## Provenance

Two `WebFetch` passes against the URL above on 2026-07-29. `WebFetch` renders the page
and answers via a small fast model, so it summarizes rather than returning raw markdown.

Confidence differs by section, and the difference is worth respecting before anyone
builds on this:

- **§1–§3 are quoted tables and sentences**, requested verbatim, and the two passes
  agreed with each other where they overlapped. Treat as reliable.
- **§4's event list came from a single pass** and was not cross-checked. Re-read the
  source before designing against any individual event name here.
- **§ "Implications" and "Follow-ups" are our inference**, not upstream text.
