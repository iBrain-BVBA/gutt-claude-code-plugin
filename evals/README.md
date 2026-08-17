# evals

A bench for the parts of this plugin whose behaviour is decided by **prose** rather
than by code: the Stop hook's judge prompt, the injected memory pointers, and the
skills. Unit tests can assert that a prompt contains a clause. They cannot tell you
whether the clause makes the model do the right thing. This directory answers that
question by running candidate wordings against turns pulled out of real Claude Code
session transcripts and scoring the verdicts against hand-assigned labels.

Nothing in here ships. It is outside `gutt-core/`, is not referenced by any hook, and
is excluded from `npm run test:all`.

## Running

```bash
python3 evals/run.py stop-judge                    # 1 trial per case
python3 evals/run.py stop-judge --trials 3         # 3 trials, to see variance
python3 evals/run.py stop-judge --variants V0 V6   # only these
python3 evals/run.py --list                        # available suites
```

Python 3 standard library only — no dependencies, no virtualenv. Each case is one
`claude -p` call against a fast model, run eight at a time; a 8-variant × 14-case ×
3-trial matrix is roughly 340 calls and about ten minutes.

Results land in `evals/results/<suite>-<trials>t-<variants>.json` (gitignored, they are
large) alongside a committed `report.md`. The variant set is in the name because a run
keyed on trial count alone overwrote an earlier round's raw records, and rounds are the
unit of comparison here. A re-run of the same config gets an `-rN` suffix rather than
replacing the earlier round, and the summary JSON carries the same suffix — it holds that
round's identity, so the next round must not overwrite it. Raw files are
`{"meta": …, "records": […]}` — the meta carries date, git SHA, model, a hash of each
variant's text, and the job count the round was supposed to produce, so a round stays
self-describing and a killed run is recognisable by holding fewer records than that;
rounds written before meta existed are bare lists. Replies are stored in full: records
are re-scored offline when a checker changes, and a truncated `raw` (an earlier
6000-char cap) makes a record permanently unverifiable.

Because replies are stored in full, a checker change is applied to rounds already
measured rather than paid for again:

```bash
cd evals   # unlike run.py above, this is a module and needs evals/ on the path
python3 -m lib.rescore results/<suite>-<n>t-<variants>.json [--write-report]
```

It reads either round shape and refuses to write a report for a round that cannot
support one — a reply stored at a retired length cap, a record count short of the
round's own job count, or a blocked record. Records whose call errored are kept
unscored rather than dropped, so the denominator matches the original. With
`--write-report` it regenerates the committed table, saying in the header that it was
re-scored rather than re-run, and naming both the tree whose skill text produced the
replies and the tree whose checkers scored them. That
distinction is the point: a re-scored table is the same sample under a new instrument and
may be compared against the table it replaces, while a fresh round is a new sample and
may not.

The committed `<suite>-report.md` keeps one stable name per suite, so its round archive
is git history — which works only because its header names the round, the date, the tree
and the variant hashes it measured. A round that hit a quota or availability wall writes
no report or summary at all and exits non-zero: the console warning scrolls away, and a
void all-zero table stamped with provenance is worse than no table.

## Coverage — every shipped skill, mapped

The bench measures prose-decided behaviour. Every shipped skill is either measured by a
suite of its own, measured by a suite it shares, or carries a one-line reason it is not
bench-measurable — a single `claude -p` call with no live tools cannot exercise a
multi-turn tool loop, and a behaviour nobody can hand-label has no ground truth to score
against. The hook prompts (not skills) have their own suites: `stop-judge`,
`prompt-pointer`, `capture-close`, and the `migrate_offer` probe.

| Skill (plugin)                          | Coverage                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| weekly-recap (gutt-pro)                 | own suite                                                                                                                                          |
| bug-investigation (gutt-developer)      | own suite                                                                                                                                          |
| sub-task-breakdown (gutt-developer)     | own suite                                                                                                                                          |
| pr-re-review (gutt-developer)           | own suite                                                                                                                                          |
| story-creation (gutt-product)           | own suite                                                                                                                                          |
| backlog-dedupe (gutt-product)           | own suite                                                                                                                                          |
| backlog-prioritization (gutt-product)   | own suite                                                                                                                                          |
| memory-capture (gutt-pro)               | shared: `capture-close` scores the report-back and the close; the write path itself (dedup, tiers, gating) is a live tool loop                     |
| output-style (gutt-pro)                 | shared: `capture-close` scores exactly its closing rules                                                                                           |
| conflict-adjudication (gutt-pro)        | **gap** — a single-turn recommendation over a given pair of memories; the bench's proposal family fits it directly                                 |
| ticket-duplicates (gutt-developer)      | **gap** — candidate-to-verdict resolution with evidence and confidence is prose-decided                                                            |
| ticket-estimate (gutt-developer)        | **gap** — grounded ranges, cited comparables, and honest confidence labels are prose-decided                                                       |
| memory-search (gutt-pro)                | **gap** — the rung and scope decisions and the honest-empty report are prose-decided; its tool results fake into the prompt like any proposal case |
| ticket-research (gutt-developer)        | **gap**, lowest priority — a cited-brief shape; largely the behaviours `bug-investigation` already measures, on a different surface                |
| agent-memory-protocol (gutt-pro)        | not bench-measurable: an identity convention consumed by other skills; no reply of its own to score                                                |
| graph-traversal (gutt-pro)              | not bench-measurable: a live multi-hop tool loop, and bench calls run with no tools                                                                |
| memory-retrieval (gutt-pro)             | not bench-measurable: deprecated alias; measuring it would measure memory-search                                                                   |
| migrate-memory (gutt-pro)               | not bench-measurable: an interactive verify-then-delete flow against a live store                                                                  |
| onboard (gutt-pro)                      | not bench-measurable: interactive first-run setup against a live install                                                                           |
| skills-discovery (gutt-pro)             | not bench-measurable: open-ended gap analysis with no hand-labellable ground truth                                                                 |
| individual-program-design (gutt-mentor) | not bench-measurable: the deliverable is a personal-scope memory write whose correctness is a later session reconstructing it                      |
| progress-tracking (gutt-mentor)         | not bench-measurable: reads and chains personal-scope episodes; the continuity under test lives in tool calls                                      |

The gap rows are the remaining suite backlog, in rough value order:
conflict-adjudication, ticket-duplicates, and ticket-estimate are single-turn verdict
shapes the bench already handles well; memory-search needs its tool results faked into
the prompt, which the proposal family does; ticket-research last. backlog-prioritization
was the largest gap and now has its suite.

## Suites

| Suite                    | What it measures                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `stop-judge`             | The `Stop` prompt hook's verdict: does it fire on turns that produced a durable Insight or Incident, and stay quiet otherwise |
| `prompt-pointer`         | The `UserPromptSubmit` recall pointer: does the agent consume it, ignore it, or surface it to the user as suspicious          |
| `capture-close`          | After a fired capture has been written: does the reply report it _and_ close on the work, or drop one of the two              |
| `weekly-recap`           | The time-window recap skill: does "last week" become absolute dates and a mention walk, and does the report keep the window   |
| `bug-investigation`      | Bug triage: severity with a rubric, a refutable suspected area, cited history                                                 |
| `sub-task-breakdown`     | Story breakdown: Jira-native grammar, testable criteria, nothing filed                                                        |
| `pr-re-review`           | Memory-informed PR review: recall first, verify findings, cite standards                                                      |
| `story-creation`         | Story drafting: sources cited, gaps visible, no ungated Jira writes                                                           |
| `backlog-dedupe`         | Backlog dedupe: seeded clusters found, stale justified, nothing acted                                                         |
| `backlog-prioritization` | Backlog ranking: moves cited, evidence-less items held, basis stated, no writes                                               |

A suite is no longer confined to scoring verdicts. `run_matrix` takes a `system` argument
and `run.py` passes a suite's own `SYSTEM` when it defines one, so a suite can frame the
model as an ordinary agent rather than as a judge replying with one JSON object —
`prompt-pointer` does exactly that, and has to: framing the model as a judge would be the
largest thing in the prompt and would decide the result. Suites that define no `SYSTEM`
still inherit `JUDGE_SYS`, which is right for `stop-judge`.

Some main-agent behaviour is still easier to probe directly with `ask(system=None)`, which
is what `leak_probe.py` and the offer probe below both do:

```bash
cd evals
python3 -m suites.migrate_offer.probe                    # SessionStart migration offer
python3 -m suites.migrate_offer.probe --case displaced   # offer vs a competing "last line"
python3 -m suites.migrate_offer.variants                 # diff the wordings, spend nothing
```

`suites/migrate_offer/FINDINGS.md` has the results. Headline: the shipped wording is at
ceiling (24/24), and the eleven words `in one line at the end of your next reply` are the
whole mechanism — removing them costs 24/24 → 4/24. It defaults to `claude-sonnet-5`, not
`FAST_MODEL`, because the offer is largely a property of the session model (25% on Haiku).

`suites/capture_close/FINDINGS.md` has rounds 1–4 of the closing suite. Headline: an injected
closing rule beats both the reason-only baseline (62% pooled) and the `memory-capture` rule it
replaced (66%) by 20+ points, in every round, and the shipped 878-char wording is now the best
measured — 89% pooled against 80% for the 1213-char form it replaced, after a 24-trial round
settled a ranking that three shallower rounds had flipped in both directions. Round 4 was a
tuning round: three candidates at or below the shipped length, designed from the failure data,
and none of them beat it. The most transferable of those negatives is that an explicit
permission to omit ("omit this part only if…") produced a **higher** omission rate than giving
no instruction at all. The dominant failure throughout is not the predicted one — the reply
drops the capture silently rather than closing on it. Its other lesson is methodological and
cost a whole pilot round: the first version told the model to run a tool it did not have, so no
capture appeared in any reply, nothing was buried, and all five variants scored the same for
reasons unrelated to their wording. Presenting the capture as already complete is what made the
property measurable.

`suites/prompt_pointer/FINDINGS.md` has round 1 of the pointer suite. Headline: the retired
2.x "MANDATORY / SYSTEM-LEVEL DIRECTIVE" framing is measurably the failure GP-868 predicted —
it is the only variant that ever leaked, and four of five greetings came back discussing the
directive instead of saying good morning. Cutting the rationale to one sentence costs recall.
The shipped wording, the hedged wording it replaced, and the wording plus GP-866's summary
clause are indistinguishable from each other at n=120. One constraint did fall out: the
summary clause is free to append and expensive to prepend (58% recall misses against 27%).

A verdict is not the only thing a judge prompt has to get right, so `leak_probe.py` sits
beside that suite and asks whether a _fired_ verdict turns into the user's answer — a
defect worth more than any accuracy gap in the tables below, and one the suite cannot see:

```bash
cd evals
python3 -m suites.stop_judge.leak_probe V14 --trials 6      # does a fire become the reply?
python3 -m suites.stop_judge.leak_probe V14 --case trivial  # ... after a false fire
```

Planned: `memory-capture` and `memory-search` skill evals — same corpus machinery, but
the runner needs tool access so the transcript can be scored on which tools the skill
actually led the model to call. `lib/runner.py` takes `allow_tools` for that.

## Screen candidates before spending calls on them

`suites/stop_judge/shippable.py` checks a candidate against the guards in
`tests/hook-architecture.test.cjs` and prints what it violates:

```bash
cd evals && python3 -m suites.stop_judge.shippable
```

This exists because a whole round was spent ranking prompts that could not be deployed.
V8 and V9 topped the accuracy table at 8 and 6 lines; they carry ten and eleven guard
violations respectively, and every guard encodes a live failure — inverted polarity,
a fired verdict printed to the user as the answer, a fire on a human-gated tier. A
number attached to an unshippable prompt is not a result. Run the screen first and
compare only what could actually ship.

The checker is a deliberate mirror of the `.cjs` assertions, not a shared source: the
tests are the contract. If the two drift, this file is the one that is wrong.

## How a suite is put together

A suite is one module exposing five names. `suites/stop_judge/suite.py` is the worked
example.

| Name                          | Purpose                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `NAME`                        | CLI id                                                                              |
| `variants()`                  | `{label: prompt text}` — the candidates being compared                              |
| `cases()`                     | labelled inputs, each with `want_ok` and a `why` recording the ground for the label |
| `build_prompt(variant, case)` | assembles what the model receives                                                   |
| `evaluate(case, raw)`         | parses the reply and scores it                                                      |

## What the numbers are worth

The harness reproduces the judge's inputs closely but not exactly, and the gaps all
run in the same direction for every variant, so comparisons hold even where absolute
accuracy does not.

- **Conversation shape.** The real judge receives the turn as message history;
  the harness passes it inside a single user message. Verified by probe: a prompt hook
  can see the user's prompt, the assistant's prose, tool calls, _and_ tool output.
- **Turn length.** Long turns are elided in the middle. Cuts land on line boundaries
  on purpose — a cut mid-sentence reads to the judge as work left unfinished, which
  every candidate prompt treats as a reason to stay quiet, so sloppy clipping
  manufactures the verdict being measured.
- **Inherited instructions.** `--system-prompt` replaces the default but does not stop
  `CLAUDE.md` discovery, so judge calls run from a temp directory outside the repo
  (`lib/runner.judge_cwd`) to shed the project `CLAUDE.md` and project settings. That is
  a partial isolation and the limit is measured: asked what its instructions mention, a
  judge run from the repo cites this project's `CLAUDE.md`, and one run from the temp
  directory cites the **plugin's own skills and agents** instead — those come from the
  user-scope registration in `~/.claude/plugins/known_marketplaces.json` and are
  inherited whatever the cwd. `~/.claude/CLAUDE.md` loads in both. Shedding the rest
  needs the plugin disabled for the child, and `enabledPlugins` in a `--settings` file
  does not do it (measured; same wall as the e2e double-load). Constant across variants
  either way.
- **Round comparability.** Rounds 1–3 ran from the repo, with the project `CLAUDE.md` in
  the judge's context. Later rounds do not. Compare within a round, not across that line.
- **Noise floor.** Re-run one variant unchanged before believing any ranking. The same
  9-line prompt scored 81.0%, 73% and 70% on three rounds under identical conditions —
  an 11-point spread, wider than every gap the bench has been used to choose between.
  Sample sizes here are 42–70 calls per variant; that buys a direction, not a decimal.
- **Labels.** Ground truth for "should fire" is not a reconstruction: each of those
  turns is one whose finding was actually written to the graph or the memory directory
  at the time. Labels held less firmly are flagged `confident: False` and reported
  separately, so a variant is not marked down for a call the author is unsure of.

## What this bench cannot decide

Two defects in a shipped prompt were found by probing the live hook, and neither was
visible here. The bench feeds a variant one turn and reads one verdict, so it never asks
a variant what an _unset_ field implies, and it never sees the fired reason arrive back
in a real conversation:

- A judge that had correctly named the turn's Insight answered `ok: true` anyway,
  reasoning that "`stop_hook_active=false` means the hook is inactive and cannot itself
  request capture". The prompt said what `true` means and left `false` undefined, so the
  model supplied a meaning — and the one it chose suppresses every fire.
- A prompt that dropped its closing anti-restatement clause put a fenced `{"ok": true}`
  in front of the user as the assistant's answer, 4 times out of 4.

So finish with a live probe, not a green table: run the candidate through
`claude -p --plugin-dir <repo>/gutt-core --debug-file <log>` and read the verdicts out of
the log. Note that `--debug` prints nothing at all in `-p` mode — only `--debug-file`
works — and that a clean reply proves nothing unless the log also shows the judge ran.
Grep `Processing prompt hook` for invocations and `condition was (not )?met` for
verdicts; the count of `Read hooks.json for plugin` lines is **not** a proxy for either
(two reads of the same path still registered and fired once).

## Reading the report

`missed fire` is the column that matters. Staying quiet is cheap and firing wrongly is
expensive, so every candidate leans quiet; the interesting question is how much real
signal that costs. `livelock` counts trials where `stop_hook_active: true` did not
produce `ok: true` — each one is a turn that would have re-entered itself.
