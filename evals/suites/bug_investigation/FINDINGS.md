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
