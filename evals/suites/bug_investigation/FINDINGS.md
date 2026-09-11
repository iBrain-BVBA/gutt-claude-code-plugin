# bug-investigation — findings

The suite asks whether the skill text turns a bug report into a triage somebody can
check. `V0-shipped` is the skill body read from the working tree; `V1-none` is the same
task, same tool surface, no skill — which is the interesting control here, because an
unaided model produces a confident-looking severity, a suspected area and a cause
without difficulty. What it does not produce is the part that makes any of them
checkable.

Judge model: `claude-haiku-4-5-20251001` (FAST_MODEL), 3 trials per (variant, case).
Raw files are keyed on suite-trials-variants, so **rounds at the same depth overwrite
each other's raw records** — the tables below are the surviving record of rounds 1–6.

## Round 1 — first cut

```
variant       chars    all  confident  errors
V0-shipped    10196   50%        67%       0     missing:group-scope 5/12 · banned:cause-asserted 1/12
V1-none           0    0%         0%       0     signature-search 6/12 · group-scope 6/12 · severity-rubric 4/12
                                                 names-the-gap 3/12 · refutable-hypothesis 3/12 · absence-named 3/12
                                                 scope-of-absence 3/12 · cites-a-date 2/12

per case (V0 / V1): key-triage 1/3 · pasted-degrade~ 0/3 · resemblance-not-cause 2/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

Both V0 failure modes turned out to be the suite's, not the skill's, and reading the
raws is what separated them.

**`missing:group-scope` — the corpus was demanding what the skill forbids.** The plan
cases never named an org group anywhere in the session, and rule 7 says never to guess
one. So an ungrouped read was the compliant answer and the check was scoring compliance
as failure. Confirmed rather than assumed: the failing replies contained no mention of a
group or a scope at all — the model had no name available, not a rule it ignored. **Fixed
in the corpus:** the tool surface now carries the line a real session would supply —
earlier reads returned records carrying `group_id "org_main"`.

**`banned:cause-asserted` — the pattern could not tell whose cause was being stated.**
The flagged reply said: "Helios incident (org:Incident:Helios-pool-exhaustion,
2026-04-18) had identical PoolTimeout signature, caused by missing index holding
connections for minutes." That is the earlier incident's cause, reported in the column
the skill's own output template asks for. The pattern matched `caused by … missing index`
wherever it appeared. **Fixed in the scorer:** the ban now requires the claim to attach to
_this_ bug — `GP-1042`, "this bug", "the checkout failure" — so reporting history stays
legal and diagnosing from a resemblance does not.

## Round 2 — after both fixes

```
variant       chars    all  confident  errors
V0-shipped    10196   83%        78%       0     missing:signature-search 1/12 · unmarked:Borealis 1/12
V1-none           0    0%         0%       0     signature-search 6/12 · group-scope 6/12 · severity-rubric 4/12
                                                 names-the-gap 3/12 · cites-a-date 3/12 · refutable-hypothesis 3/12
                                                 absence-named 3/12 · scope-of-absence 3/12

per case (V0 / V1): key-triage 2/3 · pasted-degrade~ 3/3 · resemblance-not-cause 3/3 ·
novel-signature 2/3   (V1: 0/3 on all four)
```

`group-scope` and `cause-asserted` both went to zero for V0, which is what a corpus fix
looks like when the diagnosis was right. V1 lost `group-scope` 6/12 even with the group
named in the session — the name being available changes nothing without the rule that
says to use it.

## Round 3 — with the distractor rule relaxed

The distractor mechanism was changed (all three new suites) from "every occurrence of the
token needs a marker within reach" to "at least one does". `suite.py` carries the reason
and the hole it accepts.

```
variant       chars    all  confident  errors
V0-shipped    10196   75%        89%       0     missing:group-scope 2/12 · signature-search 1/12 · names-the-gap 1/12
V1-none           0    0%         0%       0     group-scope 6/12 · severity-rubric 5/12 · names-the-gap 3/12
                                                 cites-a-date 3/12 · refutable-hypothesis 3/12 · absence-named 3/12
                                                 scope-of-absence 3/12 · signature-search 2/12 · unmarked:Borealis 1/12

per case (V0 / V1): key-triage 2/3 · pasted-degrade~ 1/3 · resemblance-not-cause 3/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

`all` moved 83% → 75% while `confident` moved 78% → 89%. Both are inside the trial noise
at three trials, and the movement is one case: `pasted-degrade`, which is the case whose
label is held least firmly — a model may reasonably open by asking for the ticket key
rather than working the pasted text. Treat 75–83% as one measurement, not two.

## Rounds 4 and 5 — against the text that ships

Rounds 1–3 measured the skill body before it was run through the repo's formatter, which
reflowed it. Round 4 re-measured the formatted text, and round 5 repeated it after scorer
fixes made in the two sibling suites (nothing in this suite's scoring changed between them).

```
round 4    V0-shipped 10200  83% all  78% confident   group-scope 1/12 · unmarked:Borealis 1/12
           V1-none        0   0%       0%              group-scope 6/12 · severity-rubric 6/12 · +6 more
round 5    V0-shipped 10200  75% all  78% confident   group-scope 1/12 · signature-search 1/12 · uuid-leak 1/12
           V1-none        0   0%       0%              signature-search 6/12 · severity-rubric 6/12 · group-scope 5/12 · +7 more

per case, round 5 (V0 / V1): key-triage 2/3 · pasted-degrade~ 2/3 · resemblance-not-cause 2/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

**Read rounds 2–5 as one measurement: 75–83% for V0, 0% for V1.** Four rounds at three
trials put V0 in a nine-point band with no rule accounting for more than one failure in
twelve, and V1 at zero every time. The residual V0 failures move between rounds — a
signature search phrased past the pattern, a degradation line omitted, one reply pasting a
raw UUID into the brief — which is what a noise floor looks like rather than a defect with
a location.

## Round 6 — after the 3.0.4 follow-up edits

The pre-PR follow-up reworded rule 1 (the permitted comment is one the user explicitly
asked for), cut the proactive "Offering the comment" section, extended rule 7's output
filter to asked-for comments, and fixed the advertised `fetch_lessons_learned` signature
to carry `group_ids` — it had dropped the one parameter the suite scores (found by
Copilot review).

```
variant       chars    all  confident  errors
V0-shipped     9890  100%       100%       0
V1-none           0    0%         0%       0

per case (V0 / V1): key-triage 3/3 · pasted-degrade~ 3/3 · resemblance-not-cause 3/3 ·
novel-signature 3/3   (V1: 0/3 on all four)
```

First clean sweep for this suite — the cuts cost nothing the checks can see, and the
signature fix did not move the group-scope behaviour, which V0 carried before and after.

## Round 7 — the identifier lane, on the two new cases only

`identifier-lane` and `prose-control` were added after round 6; every per-case line above
is four cases wide because those rounds ran before the pair existed. This round scores
only the pair, so its `all` column is not comparable with rounds 1–6.

They are one measurement rather than two. The keyed case scores the bare-key call _and_
the phrasings that have to keep running beside it, because the lane is an addition to the
pass and a version that replaced the phrasings would pass half of it. The control is the
same report with the key taken off and nothing else changed, so a lane that leaked into
key-free asks shows up as the control losing checks it used to win.

```
variant       chars    all  confident  errors
V0-shipped    10473   50%        50%       0     missing:group-scope 1/6 · bare-key-call 1/6 · signature-search 1/6
V1-none           0    0%         0%       0     signature-search 4/6 · bare-key-call 3/6 · group-scope 3/6

per case (V0 / V1): identifier-lane 1/3 · prose-control 2/3   (V1: 0/3 on both)
```

**The lane check alone is 2/3 for V0 and 0/3 for V1.** The case-level 1/3 is lower than
that because the case deliberately requires all four calls, and one trial that did issue
the bare key lost the case on `group-scope` — the residual that rounds 3–5 already show as
V0's most common single failure, and nothing to do with identifiers.

**As first scored the lane check read 0/3, and that was the pattern's fault.** A model
asked for concrete parameter values types a plan three ways — `query="X"` inside a call,
`query: "X"` in a block under a heading that names the tool, and `- **query**: "X"` as a
bullet — and the first version of `bare-key-call` recognised only the first. One trial had
planned `search_memory_facts(query: "GP-1088", …)` and scored as never having planned it.
**Fixed in the corpus:** the pattern now takes the tool name, then either a `query` marker
or an open paren, then the delimited key — the delimiter still has to close immediately
after the key, which is what keeps "the bare key and nothing else" enforced. The numbers
above are the re-score of the same replies through the fixed instrument.

**The one real miss is a real miss.** V0 trial 2 read the ticket with `getJiraIssue` and
went straight to four phrased searches with no bare-key call on either memory surface. So
the rule lands twice in three trials at three trials — a signal, not yet a rate.

**V1 planned no bare-key memory call in any trial.** All three used the key only as
`getJiraIssue(issueIdOrKey="GP-1088")`, which is the ticket read, not the lookup. The
behaviour does not appear without the skill text, which is the comparison the pair exists
to make.

**Left unfixed, and visible here: `signature-search` breaks on a parenthesis.** The
pattern is `search_memory_(nodes|facts)[^)]{0,240}<term>`, and `[^)]` stops at the first
`)` — so a reply writing ``search_memory_facts`** (signature-focused)`` above
`query: "PoolTimeout acquire timed out 30s …"` scores as never having searched the
signature. That is one of the three V0/V1 misses in this round's `prose-control` column,
and the same pattern is what `key-triage` and `pasted-degrade` have used since round 1,
so some part of the historical `missing:signature-search` count is this and not the model.
Fixing it re-baselines three cases at once, which is why it was left for a decision of its
own rather than folded into this round.

## Round 8 — `identifier-lane` at eight trials

Round 7 left the lane at 2/3, which sizes nothing. This round runs the keyed case alone at
eight trials per variant to find out whether the miss is one in three or one in ten.

```
variant       chars    all  confident  errors
V0-shipped    10473   50%        50%       0     missing:bare-key-call 3/8 · signature-search 1/8 · symptom-search 1/8 · group-scope 1/8
V1-none           0    0%         0%       0     missing:bare-key-call 8/8 · group-scope 4/8 · signature-search 1/8 · symptom-search 1/8

per case (V0 / V1): identifier-lane 4/8   (V1: 0/8)
```

**The bare-key call fires in 5 of 8 V0 trials and 0 of 8 V1 trials.** With round 7 that is
7 of 11 with the skill and 0 of 11 without. The skill is doing something no model does
unprompted, and it is doing it about two times in three.

**All three misses are real, and two of them share a shape.** Trials 0 and 4 spend the key
on the ticket read — `getJiraIssue(…, "GP-1088")` — and then run only phrased memory
queries; the key never becomes a memory query at all. Trial 2 never uses the key anywhere,
having pinned the failure from the pasted text. Nothing here is a pattern artefact: the
widened `bare-key-call` matches all three of the syntaxes these replies use, and it found
the call in the five trials that made one.

**Trial 2 is also the sharpest evidence yet for the `[^)]` fragility left unfixed above.**
It searched the signature (`query: "TemplateRenderError locale fallback exhausted"`) and
the symptom (`query: "invoice PDF blank rendering"`), and scored as having done neither —
because it wrote the tool name as `search_memory_nodes()` with empty parens, so `[^)]`
stops one character in. Two rounds, three manifestations: a parenthesised aside, an empty
parameter list, and a heading. The `bare-key-call` pattern does not use `[^)]` and is
unaffected; the three sibling checks are, in every case that carries them.

## What the numbers say

**V1 scores zero on every case in every round**, and it is worth being precise about
why, because "0%" invites the reading that the unaided replies were bad. They were not.
They were fluent, plausible triages that lost on the checkable parts: no rubric behind the
severity (4–5 of 12), no statement of what would refute the suspected area (3/12), no date
on a cited past failure (2–3/12), and no account of what was searched when nothing was
found (3/12). That is the whole thesis of the skill — the difference between a grounded
triage and an ungrounded one is invisible in the prose and visible in those four checks.

**The residual V0 failures are single trials** — one reply phrasing the signature search
in a way the pattern did not catch, one omitting the degradation line. Nothing here points
at a rule that needs rewriting; the next thing worth doing is more trials, not more prose.

## What this suite does not measure

- **Whether the tools were actually called correctly.** Tools are off; the plan family
  scores a stated intention. A plan and an execution can diverge.
- **The Jira-key happy path end to end.** The Atlassian connector does not authenticate
  in headless children, so a real key-driven run belongs to the interactive leg of
  pre-merge validation. The pasted-text path is the one exercised here, which is the
  right way round: it is also the path the acceptance criteria require to work.
- **Severity calibration.** The suite checks that a rubric is named and applied, not that
  the resulting label is the one a human would have chosen. That judgement has no
  ground truth in a fixture.
