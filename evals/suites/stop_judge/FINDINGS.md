# stop-judge — what the bench found

Fourteen candidate wordings for the Stop hook's judge prompt, from the original 18-line
version down to a single line, scored against 14 turns lifted from real sessions.

**What shipped: V14 — 9 lines, 2112 characters, 79% of the 14-line prompt it replaced.**
The reasoning below matters more than the table, because the table did not decide it.

**What did not get fixed, and is the biggest thing here:** a fired verdict becomes the
user's answer perhaps 60% of the time. See "The leak" below. Two candidate fixes each
measured 0/6 on the leak and each cost more than they saved, so V14 ships with the defect
that the 14-line prompt also had.

## Screen for shippability before spending calls

Rounds 1–3 recommended **V8** (8 lines) and ranked **V9** highest on verdicts. Both are
undeployable. Checked against the guards in `tests/hook-architecture.test.cjs` —
mechanically, by `shippable.py` — V8 has **10** violations and V9 has **11**:

| Missing from V8/V9                            | What its absence cost when it was absent for real                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the `Nothing …` opening                       | Claude Code wraps the prompt as "has the following stopping condition been satisfied?" and maps satisfied → `ok:true`. A task-framed opening made a correct finding arrive as a fire-shaped reason attached to `ok:true`, discarded unread |
| `durable for the team` / `throwaway`          | the judge fired on a finding about test scaffolding — correctly typed, not durable                                                                                                                                                         |
| `omit `reason``                               | a 400-character reason written on the allow path, every turn, thrown away                                                                                                                                                                  |
| the bulleted type list                        | the guard tying the fire condition to the skill's auto-write tier reads that structure                                                                                                                                                     |
| naming `Lesson`/`Decision`/`WorkingAgreement` | the judge fired on a Decision, spending a continuation on Claude declining to write one                                                                                                                                                    |
| the closing anti-restatement clause           | a fenced `{"ok": true}` printed to the user as the assistant's answer, 4 times out of 4                                                                                                                                                    |

A number attached to a prompt that cannot ship is not a result. Every candidate from
round 4 on is a compression of the _shipped_ prompt that passes all fifteen checks.

## The rounds that compared shippable prompts

| variant     | lines | chars | round        | n   | accuracy | on confident labels | fires missed | names skill / typed |
| ----------- | ----- | ----- | ------------ | --- | -------- | ------------------- | ------------ | ------------------- |
| V0, 14-line | 14    | 2690  | 4 (3 trials) | 42  | 73.8%    | 87%                 | 8/21         | 100% / 100%         |
| V0, 14-line | 14    | 2690  | 5 (5 trials) | 70  | 66%      | 76%                 | 19/35        | 100% / 100%         |
| V12         | 11    | 2367  | 4 (3 trials) | 42  | 71.4%    | 80%                 | 10/21        | 100% / 100%         |
| V13         | 9     | 1981  | 4 (3 trials) | 42  | 81.0%    | 90%                 | 6/21         | 100% / 100%         |
| V13         | 9     | 1981  | 5 (5 trials) | 70  | 73%      | 82%                 | 15/35        | 100% / 100%         |
| V13         | 9     | 1981  | 6 (5 trials) | 70  | 70.0%    | 80%                 | 16/35        | 100% / 100%         |
| **V14**     | **9** | 2112  | 6 (5 trials) | 70  | 71.4%    | 82%                 | 16/35        | 100% / 100%         |

## The bench's noise floor is wider than every gap it measured

**V13 scored 81.0%, 73% and 70% on three rounds under identical conditions.** An 11-point
spread on one unchanged prompt. Against that, V13-over-V0 (about 7 points pooled) is
suggestive at best and V14-over-V13 (1.4 points) is nothing at all.

This is the most useful number the bench produced, and it only appeared because one
variant was re-run instead of each candidate being measured once. Re-run a control before
believing any ranking here.

So the ranking did not choose V14. Three things that are not verdict accuracy did:

1. **Guard compliance** — checked mechanically, not sampled.
2. **A live probe** — see below; it found a defect worth more than any gap in the table.
3. **Length**, which is real and paid back per fire (below), and where V13/V14 beat the
   14-line prompt by 578 characters with no measurable accuracy cost.

## The defect the bench structurally could not see

V13 compressed away the shipped prompt's gloss on `stop_hook_active` — the original said
`true` "means you have already asked during this turn"; V13 only said what to answer.
Nothing said what **false** means. On a live probe the judge named the turn's durable
Insight correctly and then answered `ok: true` anyway:

> "stop_hook_active=false means the hook is inactive and cannot itself request capture.
> The condition asks whether the turn needs to be written to memory — it does — but the
> hook being inactive means this is a false-positive case."

The model filled the undefined branch, and the meaning it chose suppresses every fire.
V14 restores the gloss and adds "its being false is the normal case and says nothing
either way": +131 characters, no extra line, fire rate on the probe fixture 3/4 → **5/6**,
and the invented-meaning reasoning did not recur across six sessions.

The bench scores V13 and V14 as identical because it never asks a variant what an unset
field implies. **Finish on a live probe, not a green table** — `README.md` has the
invocation.

## The leak: a fired verdict becomes the user's answer

The worst defect found this round, pre-existing and previously untested.

When the hook fires, Claude Code injects the whole template into the main conversation as
`Stop hook feedback:\n[<template>]: <reason>`. Its imperatives — "respond with exactly
`{"ok": true}` and no other field" — are then read by the **main** agent as instructions to
itself, and it complies. Measured on live sessions: **3 of 5 fires** came back with a
13-byte reply that was nothing but `{"ok": true}`. The user's question went unanswered.
The 14-line prompt leaked at the same 3/5 rate, so this is not new to the compression.

Two things kept it hidden:

- The e2e detector (`never leaks the judge protocol into the reply`) can only see a reply
  that follows a fire — and the fixture that was supposed to fire had silently stopped
  (it asked for a **Decision**, which GP-844 removed from unprompted capture). A
  suppression-only assertion with no firing vector passes vacuously.
- My own probe used `Reply with exactly: up`, which never fires. It tested the _allow_
  path and reported 6/6 clean, which was true and irrelevant.

`leak_probe.py` is the fix for that: it constructs the injection directly, so every trial
exercises the fire path. Two cases, both real:

| prompt        | leaks, durable turn | leaks, false fire on a trivial turn |
| ------------- | ------------------- | ----------------------------------- |
| V13           | 6/6                 | —                                   |
| V14 (shipped) | 6/6                 | 3/6                                 |
| V15           | 0/6                 | 0/6                                 |
| V16           | 0/6                 | 0/6                                 |

The second column matters because the judge false-fires on roughly one turn in seven, and a
false fire on a turn with nothing to capture leaves the agent with no finding to record and
no answer to give, so it answers the hook. It writes a _fresh_ `{"ok": true}` rather than
echoing the injected reason — which is why an echo-only probe scores that case 0%.

### Both fixes cost more than they saved

**V15 — a clause in the template addressed to whoever receives it as feedback.** Leaks
0/6. But the judge is the only reader actually being asked a question, and it applied the
prohibition to itself. On a turn whose Insight it had named in full it answered `ok: true`
because "the instruction to 'capture nothing yourself, call no tool' prevents me from
invoking memory-capture" and "without explicit user signal that this Insight should
persist". Live fire rate fell to **3/15**, against 5/6 for V14. A hook that does not fire
is worse than one that occasionally garbles a reply.

**V16 — a final line the fired reason must carry.** Leaks 0/6 on both cases, and it does
not suppress firing, because the reason is not part of the condition being scored. But
asking for a mandated line alongside a JSON field invites the judge to write it _outside_
the JSON: e2e went from 1 failure to 5, including `returns a parseable verdict from every
Stop evaluation`, `evaluates the Stop judge once per turn`, and an R23 violation where a
fire read as a block.

### Where the fix probably is

Not in the wording. Every wording that suppresses the leak does so by adding an imperative,
and every added imperative is read by both agents. The template echo is the root cause and
it is Claude Code's behaviour, not ours. The structural option is to stop using a `prompt`
hook for this and use a `command` hook that calls the judge itself and returns only a short
reason — then no template is ever echoed. That is a design change, not a prompt change.

## Length was never the quality constraint

No variant lost by being shorter. Cutting the original 18 lines to 8 _improved_ accuracy,
and the mechanisms were all about content:

**Judging the activity instead of the finding.** The 18-line prompt listed "routine edits,
answering a question, reading or searching code, formatting, work still in progress" as
reasons to stay quiet. But verifying, testing and debugging are _how_ findings get made,
so the judge discarded real Insights on account of how they were arrived at — "routine
validation and testing work", "diagnostic work to answer a user question". Replacing the
list with "ask what the turn learned, not what it did" cut missed fires from 11/21 to 6/21.

**Losing the role.** Below about six lines the judge stops judging. V7 left the role
implicit and, on a corpus full of turns about memory capture, eight of its calls joined
the work instead of scoring it — "the memory server is unreachable, so per the skill's
degradation rule I will surface the episode drafts". One sentence of role removed it.

**Showing the skill line is not asking for it.** V6 opened its example with
`Run the … skill.` and named the skill in 14% of its reasons; models copy the bullets and
drop the line above them. Stating that the reason _begins_ with that line took it to 100%.

## The per-fire cost this pays back

Claude Code injects the fired hook's prompt into the main conversation as
`Stop hook feedback:\n[<the whole prompt template>]: <reason>`. Measured on four real
fires in session `cda7e83e`: 3656–4721 characters delivered, of which the reason — the
part that is actually an instruction — was 150–250. The template is roughly 94% of it, and
`$ARGUMENTS` arrives **un-interpolated**, so it is the template verbatim.

V14 therefore saves about 578 characters of main-conversation context on every fire
against the prompt it replaced, and about 1,750 against the original 18-line version.

## Caveats

- **Sample sizes are small and the noise floor is wide.** 42–70 calls per variant against
  an 11-point spread on a control. Treat every gap under ~10 points as unresolved.
- **Rounds 1–3 are not comparable** to later ones: they ran from the repo, with the
  project `CLAUDE.md` in the judge's context. Round 3 is void outright — the org spend
  limit landed mid-run and the CLI reports it on stdout with exit 0, so 52 of 56 calls
  scored as wrong answers. `lib/runner.py` now halts on it.
- **A round was lost to a filename collision.** `results/<suite>-<trials>t.json` was keyed
  on trial count alone, so round 6 overwrote round 5's raw records; round 5 survives only
  as the printed table above. Now keyed on the variant set too.
- **Labels were wrong twice, and the bench caught it.** Case c08 was labelled quiet as
  "analysis of a merged PR, derivable from the diff"; V6 fired on it 3/3 naming the
  UserPromptSubmit/R11 consequence, and `memory/r11-orphaned-by-thin-router-design.md`
  carries `originSessionId: 6c7a2aef` — the finding was recorded from that very turn.
  Relabelled. Read every "false fire" above with that in mind.
- **Cases c04, c07 and c10 fail for every candidate.** Worth re-reading as suspect labels
  rather than as prompt defects.
- **The session model changes the verdict, without changing the judge.** The judge is
  always Haiku — a prompt-hook dispatch is followed immediately by a
  `model=claude-haiku-4-5` call even inside a `--model sonnet` session, verified in the
  debug log. What changes is the _turn being judged_: on one fixture a Haiku assistant
  wrote ~1,850 bytes and a Sonnet assistant ~3,000, and the thinner answer read as less of
  a finding. Same fixture, same prompt: **0/3 fires from Haiku turns, 2/3 from Sonnet.** So
  a fire rate is a property of the pair, not of the prompt.
- **V16's verdict accuracy was never measured.** It was abandoned on the e2e evidence
  above before a bench round was spent on it.
- **Untested:** whether these gains hold on turns from other projects, and whether the
  reason's shape survives contact with the real skill rather than a regex.
