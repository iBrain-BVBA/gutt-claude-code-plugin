# stop-judge — what the bench found

Eleven candidate wordings for the Stop hook's judge prompt, from the shipped 18-line
version down to a single line, scored against 14 turns lifted from real sessions.
Standing numbers are **round 2** (`results/stop-judge-round2-report.md`): 3 trials per
case, on the corrected labels.

| variant     | lines | chars | accuracy | on confident labels | fires missed | false fires | reason shape |
| ----------- | ----- | ----- | -------- | ------------------- | ------------ | ----------- | ------------ |
| V0, shipped | 18    | 3855  | 71%      | 73%                 | 11/21        | 1/21        | 100% / 100%  |
| V3          | 7     | 921   | 71%      | 70%                 | 12/21        | 0/21        | 11% / 11%    |
| V4          | 6     | 843   | 67%      | 70%                 | 12/21        | 2/21        | 22% / 44%    |
| V6          | 8     | 1261  | 71%      | 83%                 | 7/21         | 5/21        | 0% / 57%     |
| **V8**      | **8** | 1423  | **79%**  | **90%**             | **6/21**     | 3/21        | 100% / 100%  |
| V9          | 6     | 968   | 81%      | 93%                 | 5/21         | 3/21        | 69% / 81%    |

Reason shape is "names the skill / every bullet typed" — the two properties that decide
whether the fired reason works as a payload.

## Length was not the constraint

No variant lost to the shipped prompt by shortening it. Cutting 18 lines to 8 improved
accuracy, and the two mechanisms behind that are both about content, not size:

**Judging the activity instead of the finding.** The shipped prompt lists "routine
edits, answering a question, reading or searching code, formatting, work still in
progress" as reasons to stay quiet. But verifying, testing and debugging are _how_
findings get made, so the judge kept discarding real Insights on account of how they
were arrived at — "routine validation and testing work", "diagnostic work to answer a
user question". Replacing the activity list with "ask what the turn learned, not what it
did" cut missed fires from 11/21 to 6/21.

**Losing the role.** Push below about six lines and the judge stops judging. V7's
compression left the role implicit, and on a corpus full of turns about memory capture
eight of its calls joined the work instead of scoring it — "the memory server is
unreachable, so per the skill's degradation rule I will surface the episode drafts".
One sentence of role in V8 removed the failure mode entirely.

**Showing the skill line is not asking for it.** V6 opened its example with
`Run the … skill.` and named the skill in 14% of its reasons; models copy the bullets
and drop the line above them. Stating that the reason _begins_ with that line took it
to 100%.

## The per-fire cost this pays back

Claude Code injects the fired hook's prompt into the main conversation as
`Stop hook feedback:\n[<the whole prompt template>]: <reason>`. Measured on four real
fires in session `cda7e83e`: 3656–4721 characters delivered, of which the reason — the
part that is actually an instruction — was 150–250. The template is roughly 94% of it,
and `$ARGUMENTS` arrives **un-interpolated** in the echo, so it is the template verbatim.

V8 therefore saves about 2,400 characters (~600 tokens) of main-conversation context on
every single fire, on top of the judge-side saving.

## Recommendation

**V8, at 8 lines and 1423 characters — 37% of the shipped size.** It beats the shipped
prompt on recall (6 missed fires against 11) and on confidently-labelled accuracy (90%
against 73%) while matching it exactly on reason shape, which V9 and every other short
variant fail. V9 scored marginally better on verdicts at 6 lines, but typed only 81% of
its bullets, and a mistyped bullet asks the capture skill to write a gated class under
the wrong label.

## What actually shipped, and why it is not V8

`gutt-core/hooks/hooks.json` now carries a hybrid — 13 lines, 2405 characters, 62% of the
shipped size — not V8 verbatim. V8 violated five assertions in
`tests/hook-architecture.test.cjs`, and every one of them encodes a live failure this
bench structurally cannot see:

| V8 dropped                                    | What that cost when it was absent before                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the `Nothing …` opening                       | Claude Code wraps the prompt as "has the following stopping condition been satisfied?" and maps satisfied to `ok:true`. A task-framed opening made a correct finding arrive as a fire-shaped reason attached to `ok:true`, discarded unread |
| `durable for the team` / `throwaway`          | the judge fired on a finding about test scaffolding — correctly typed, not durable                                                                                                                                                          |
| `omit `reason``                               | a 400-character reason written on the allow path, every turn, thrown away                                                                                                                                                                   |
| the bulleted type list                        | the guard that ties the fire condition to the skill's auto-write tier reads that structure                                                                                                                                                  |
| naming `Lesson`/`Decision`/`WorkingAgreement` | the judge fired on a Decision, spending a whole continuation on Claude declining to write one                                                                                                                                               |

The harness fed prompts raw, with no "stopping condition" wrapper, so the polarity
property in row 1 was never under test — the bench would happily have rewarded a prompt
that inverts in production. **A bench measures what it reproduces, and silence from it is
not evidence.** The shipped prompt therefore keeps all five and takes the three wins:
finding-over-activity, the explicit role, and asking for the skill line.

Each of those three now has a guard in `hook-architecture.test.cjs`, mutation-tested by
removing the property and confirming the named test fails. The hybrid itself is
**unmeasured** — the spend limit closed the bench before it could be scored — so
re-running `V0-shipped` (which reads live from `hooks.json`) is the first thing to do when
quota returns.

## Caveats

- **42 calls per variant.** V8-vs-V9 (79% vs 81%) is inside the noise; V8-vs-V0 (11
  missed fires vs 6) is not.
- **Labels were wrong twice, and the bench caught it.** Case c08 was labelled quiet as
  "analysis of a merged PR, derivable from the diff"; V6 fired on it 3/3 naming the
  UserPromptSubmit/R11 consequence, and `memory/r11-orphaned-by-thin-router-design.md`
  carries `originSessionId: 6c7a2aef` — the finding was recorded from that very turn.
  Relabelled. Every "false fire" in the table above should be read with that in mind.
- **Round 3 is void** — the org spend limit landed mid-run and the CLI reports it on
  stdout with exit 0. `lib/runner.py` now halts on it.
- **Untested:** whether V8's gains hold on turns from other projects, and whether the
  reason's shape survives contact with the real skill rather than a regex.
