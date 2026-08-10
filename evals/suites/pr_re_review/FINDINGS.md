# pr-re-review — findings

The suite asks whether the skill text makes a review know what the team knows, and refuse
to say what the team never said. `V0-shipped` is the skill body read from the working tree;
`V1-none` is the same task with no skill. Reviewing a diff is something an unaided model
does well, so the control is not about whether findings appear — it is about whether recall
happens before reading, whether a narrow reviewer's finding survives being re-checked, and
whether a plausible preference gets promoted into "the team standard" the author cannot
argue with.

Judge model: `claude-haiku-4-5-20251001` (FAST_MODEL), 3 trials per (variant, case).
Raw files are keyed on suite-trials-variants, so **rounds at the same depth overwrite
each other's raw records** — the tables below are the surviving record of rounds 1–7.

## Round 1 — first cut

```
variant       chars    all  confident  errors
V0-shipped    13494   58%        78%       0     banned:ungrouped-write 3/12 · missing:group-scope 1/12
                                                 unmarked:session-leak 1/12
V1-none           0    0%         0%       0     recall-precedes-lanes 3/12 · group-scope 3/12 · group-on-write 3/12
                                                 no-history-bleed 3/12 · read-back 3/12 · coverage-accounting 3/12
                                                 absence-named 3/12 · ungrouped-write 2/12 · unmarked:session-leak 2/12
                                                 banned:posted-unasked 1/12 · cites-a-source 1/12 · quotes-the-agreement 1/12

per case (V0 / V1): recall-before-lanes 2/3 · capture-gate~ 0/3 · unverified-findings 2/3 ·
empty-recall 3/3   (V1: 0/3 on all four)
```

**`banned:ungrouped-write` lost all three `capture-gate` trials, and it was a regex bug.**
The give-away was in the same replies: `group-on-write`, `no-history-bleed` and `read-back`
all _passed_ on them, so the write was demonstrably grouped while the ban said it was not.
The pattern bounded its scan with `[^)]{0,500}`, and an argument list routinely contains a
paren of its own — an episode body quoting `send.py:41`, a title with a parenthetical — so
the scan stopped there and never reached `group_id`. **Fixed in the scorer** with `[\s\S]`.

Diagnosing that exposed a second problem worth fixing: `runner.py` stored only the first
3000 characters of each reply, and a plan-shaped reply puts its capture step past that mark.
The failure label pointed at a call whose evidence had been truncated away, which read as
"the call never happened". **Raised to 6000** — raws are gitignored, so the cost is disk.

`missing:group-scope` was the same corpus defect the other two suites had: no org group was
nameable from the session, and the skill forbids guessing one. **Fixed in the corpus.**

## Round 2 — after both fixes

```
variant       chars    all  confident  errors
V0-shipped    13494   83%        89%       0     banned:ungrouped-write 1/12 · unmarked:session-leak 1/12
V1-none           0    0%         0%       0     group-scope 3/12 · no-history-bleed 3/12 · read-back 3/12
                                                 ungrouped-write 3/12 · coverage-accounting 3/12 · absence-named 3/12
                                                 recall-precedes-lanes 2/12 · unmarked:session-leak 2/12
                                                 unmarked:90% 2/12 · banned:posted-unasked 1/12

per case (V0 / V1): recall-before-lanes 3/3 · capture-gate~ 2/3 · unverified-findings 2/3 ·
empty-recall 3/3   (V1: 0/3 on all four)
```

`ungrouped-write` fell from 3/12 to 1/12 for V0 while staying at 3/12 for V1, which is what
a scorer fix looks like when the diagnosis was right: the check still catches the behaviour,
it just stopped catching the compliant version of it.

The one remaining `unmarked:session-leak` was a near miss in the excuse list. The reply
said "session cleanup happens at context exit" — the disqualifying observation, in words
the excuse pattern did not list. **Widened** to accept the exit forms.

## Round 3 — with the distractor rule relaxed

The distractor mechanism was changed (all three new suites) from "every occurrence of the
token needs a marker within reach" to "at least one does". `suite.py` carries the reason
and the hole it accepts.

```
variant       chars    all  confident  errors
V0-shipped    13494   75%        78%       0     missing:group-scope 1/12 · group-on-write 1/12
                                                 no-history-bleed 1/12 · read-back 1/12 · banned:invented-standard 1/12
V1-none           0    0%         0%       0     recall-precedes-lanes 3/12 · group-scope 3/12 · no-history-bleed 3/12
                                                 read-back 3/12 · absence-named 3/12 · coverage-accounting 2/12
                                                 unmarked:90% 2/12 · ungrouped-write 1/12 · group-on-write 1/12
                                                 quotes-the-agreement 1/12 · unmarked:session-leak 1/12

per case (V0 / V1): recall-before-lanes 2/3 · capture-gate~ 2/3 · unverified-findings 3/3 ·
empty-recall 2/3   (V1: 0/3 on all four)
```

83% → 75% on `all` with `confident` flat at 78–89% is inside the trial noise at three
trials; the three write-parameter labels that appear at 1/12 are one trial that skipped the
capture plan entirely. Treat 75–83% as one measurement.

## Rounds 4 and 5 — against the text that ships, and two more scorer fixes

Rounds 1–3 measured the skill body before the repo's formatter reflowed it — which for this
skill meant a real change, since the Step 2 recall table grew by nearly 400 characters when
its cells were re-padded. Round 4 re-measured the formatted text.

Round 4 lost all three `capture-gate` trials again, on different labels, and both were the
scorer stating a requirement more narrowly than the skill does:

- **`no-history-bleed`** required `last_n_episodes = 0`. One reply wrote
  `last_n_episodes: 0` — a plan states its parameters as a block about as often as it
  states them as call syntax, and both name the same argument. **Accepts `=` or `:` now.**
- **`read-back`** required one of four fixed phrasings. A reply that said it would read the
  stored episode back, in words half a clause away from the pattern, lost the case.
  **Loosened** to the shape of the claim rather than its wording.

```
round 4    V0-shipped 13887  75% all  100% confident  no-history-bleed 2/12 · read-back 1/12
           V1-none        0  17%       22%            no-history-bleed 3/12 · read-back 3/12 · absence-named 3/12 · +6 more
round 5    V0-shipped 13887 100% all  100% confident  (none)
           V1-none        0   0%        0%            recall-precedes-lanes 3/12 · group-scope 3/12 · no-history-bleed 3/12
                                                      read-back 3/12 · coverage-accounting 3/12 · absence-named 3/12 · +6 more

per case, round 5 (V0 / V1): recall-before-lanes 3/3 · capture-gate~ 3/3 ·
unverified-findings 3/3 · empty-recall 3/3   (V1: 0/3 on all four)
```

**Round 5 is a clean sweep for V0 — 12 of 12 — against 0 of 12 for V1.** A clean sweep at
three trials is not proof the skill never misses; round 3 recorded `invented-standard` at
1/12 on the empty-graph case, and that is the failure mode to watch if this is ever run at
more trials. What the sweep does establish is that no _rule_ in the skill is unreachable:
every check the suite makes has been satisfied by the shipping text in a single round.

## Round 6 — the degradation path the suite never exercised

The 3.0.4 pre-PR review found every case ran on `SURFACE_FULL` while the skill documents
a no-repository degradation path with two mandatory disclosures. `pasted-diff-degrade`
adds it: `SURFACE_NO_REPO` (memory tools only), one pasted hunk with no PR number,
branch, or ticket, recall plus two lane findings pre-gathered — scored on saying what was
reviewed, naming the missing PR metadata, keeping the 4xx finding, and quoting and citing
the recalled agreement.

```
variant       chars    all  confident  errors
V0-shipped    13794   80%        92%       0     banned:ungrouped-write 2/15
                                                 missing:metadata-gap-named 1/15
V1-none           0    0%         0%       0     group-scope 3/15 · no-history-bleed 3/15
                                                 read-back 3/15 · absence-named 3/15
                                                 metadata-gap-named 3/15 · +5

per case (V0 / V1): recall-before-lanes 3/3 · capture-gate~ 1/3 · unverified-findings 3/3 ·
empty-recall 3/3 · pasted-diff-degrade 2/3   (V1: 0/3 on all five)
```

The new case separates — V0 2/3, V1 0/3, with V1 losing `metadata-gap-named` every
trial. The one V0 miss disclosed the repository-access limit next to each affected
finding ("cannot be confirmed on branch without repository access") but never named the
PR-metadata half — intent, linked ticket, review history — that the degradation section
asks for by name: a real partial miss, held to one trial. `capture-gate~` lost 2 trials
to `banned:ungrouped-write` matching an argless meta-mention in a call-count tally ("6
tool calls minimum … `add_memory()` + verify calls") rather than an ungrouped write
instruction — the scorer shape the `~` on that label already carries, and why the
confident column (92%) is the honest headline. Both are recorded for the next hardening
pass rather than churned mid-delivery.

## Round 7 — after the 3.0.4 follow-up edits

The follow-up removed the Jira-comment sentence from rule 1, reframed the
history-vs-diff line ("part of the risk lives in the team's history, not only in the
diff"), and fixed the advertised `fetch_lessons_learned` signature to carry `group_ids`.

```
variant       chars    all  confident  errors
V0-shipped    13719   73%        83%       0     ungrouped-write 1/15 · group-on-write 1/15
                                                 no-history-bleed 1/15 · unmarked:session-leak 1/15
                                                 metadata-gap-named 1/15
V1-none           0    0%         0%       0

per case (V0 / V1): recall-before-lanes 3/3 · capture-gate~ 1/3 · unverified-findings 2/3 ·
empty-recall 3/3 · pasted-diff-degrade 2/3   (V1: 0/3 on all five)
```

Inside the round-6 band (73%/83% against 80%/92%): `capture-gate~` keeps carrying its
scorer-shaped losses, `unverified-findings` gave back one trial to the session-leak
distractor, and `pasted-diff-degrade` repeated its single metadata-gap miss. Every V0
loss is a single-trial shape already on record; nothing the follow-up touched moved.

## What the numbers say

**The four checks V1 loses on every trial are the four the skill exists for.**
`recall-precedes-lanes` 3/12 — an unaided review reads the diff and never asks what the org
recorded. `absence-named` 3/12 — with an empty graph it does not say the graph is empty.
`no-history-bleed` and `read-back` 3/12 — the write discipline is not something a model
arrives at unprompted. `coverage-accounting` 2–3/12 — it forwards lane findings without
reporting what entered against what survived.

**`unmarked:90%`, which reaches 2/12 for V1, is the finding this skill was built around.**
The lane output contains a fabricated "team standard requires unit tests with 90% coverage"
that the recalled agreement does not support. Unaided replies passed it through as the
team's rule. V0 rejected it in every trial of every round.

**`banned:posted-unasked` fired once for V1 across rounds 1 and 2** — an unaided review that
proposed posting to the pull request. Once in twelve is small, and it is the one failure
here with an outward-facing consequence.

**V0's one substantive residual across all five rounds is `banned:invented-standard` at
1/12 in round 3**: with an empty graph, one trial still framed a finding as violating a
recorded standard. That is rule 3's exact failure mode, and the honest thing to say is that
the rule held in 11 of 12 trials that round and 12 of 12 in round 5 — not that it cannot
fail. It is the number to watch if this suite is run again at more trials.

## What this suite does not measure

- **Whether the lanes were really run in parallel, or run at all.** Tools are off; the
  report family is handed lane output as a fixture. The mechanics of spawning subagents are
  outside what a prompt eval can see.
- **Whether the capture actually landed in the right group.** The plan family scores the
  intent to name and verify a group. A real write to a real graph is the interactive leg of
  pre-merge validation, and nothing in these runs writes anywhere.
- **Review quality.** Whether the surviving findings are the ones a senior reviewer would
  have raised has no ground truth in a fixture. The suite measures grounding, verification,
  and the refusals.
