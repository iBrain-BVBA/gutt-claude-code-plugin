# sub-task-breakdown — findings

The suite asks whether the skill text produces a breakdown a Jira board can actually
take. `V0-shipped` is the skill body read from the working tree; `V1-none` is the same
task with no skill. Splitting a story is something an unaided model does readily, so the
control is not about whether slices appear — it is about whether they arrive in the right
tracker's grammar, whether a story that needed no splitting gets left alone, and whether
criteria nobody could check get sized anyway.

Judge model: `claude-haiku-4-5-20251001` (FAST_MODEL), 3 trials per (variant, case).
Raw files are keyed on suite-trials-variants, so **rounds at the same depth overwrite
each other's raw records** — the tables below are the surviving record of rounds 1–6.

## Round 1 — first cut

```
variant       chars    all  confident  errors
V0-shipped     9627   33%        33%       0     missing:group-scope 3/12 · banned:filed-unasked 2/12
                                                 unmarked:#412 2/12 · proposes-a-threshold 2/12 · effort-range 1/12
V1-none           0    0%         0%       0     comparables-search 3/12 · group-scope 3/12 · filed-unasked 3/12
                                                 confidence 3/12 · unmarked:#412 3/12 · declines-to-split 3/12
                                                 criteria-called-out 3/12 · jira-dependency 2/12 · effort-range 2/12

per case (V0 / V1): plan-no-filing 0/3 · github-grammar-bait 0/3 · already-one-slice 3/3 ·
untestable-criteria~ 1/3   (V1: 0/3 on all four)
```

Round 1 also carried a corpus defect found by reading rather than by running: three of the
four cases shared one `gathered` fixture describing a different story's comparables. Each
proposal case now has comparables its own story would actually have returned, so round 1's
numbers describe a corpus that no longer exists and are kept only as the diagnostic record.

Three of the four V0 failure modes were the suite's:

**`banned:filed-unasked` — the gate was being scored as the violation.** The flagged reply
had a section headed "Filing (conditional on your approval)" followed by "If you approve
the exact set of titles and criteria, I would: `createJiraIssue(...)`". That is precisely
what rule 1 asks for. The ban matched the call shape wherever it appeared. **Fixed in the
scorer:** filing is now a distractor with an approval excuse, so a gated plan passes and an
unconditional one fails — which is the actual defect.

**`missing:proposes-a-threshold` — a requirement the skill never made.** Both flagged
replies named each criterion as untestable and either held the breakdown or recommended
replacement criteria: "Per the breakdown rules: without testable criteria, I cannot
write…". Demanding a numeric threshold on top imported a stricter rule than rule 3 states.
**Replaced in the scorer** with `holds-or-replaces`, which is the property the skill
actually asks for.

**`missing:group-scope` — the same corpus defect the bug-investigation suite had.** No org
group was nameable from the session, and the skill forbids guessing one. **Fixed in the
corpus** by having the tool surface report the group earlier reads returned.

The fourth was genuinely the skill's, and is the one worth keeping: **`unmarked:#412`**.
One reply wrote `GP-#412` — a hybrid belonging to neither tracker — and another carried
"The story depends on #412 … a hard prerequisite" straight through. **Fixed in the skill:**
rule 2 now says the parent's own text gets no pass, and every foreign reference is either
translated to the Jira key it means or explicitly named as untranslatable.

## Round 2 — after those four fixes

```
variant       chars    all  confident  errors
V0-shipped    10038   58%        44%       0     unmarked:#412 3/12 · missing:group-scope 2/12
                                                 reads-parent 1/12 · comparables-search 1/12
V1-none           0   17%         0%       0     comparables-search 3/12 · group-scope 3/12 · effort-range 3/12
                                                 confidence 3/12 · declines-to-split 3/12 · unmarked:createJiraIssue 2/12
                                                 jira-dependency 2/12 · reads-parent 1/12 · unmarked:#412 1/12

per case (V0 / V1): plan-no-filing 1/3 · github-grammar-bait 0/3 · already-one-slice 3/3 ·
untestable-criteria~ 3/3   (V1: 0/3 · 0/3 · 0/3 · 2/3)
```

`filed-unasked` and `proposes-a-threshold` went to zero. Two problems remained, and the
raws separated them cleanly again.

**`unmarked:#412` got worse-looking while the behaviour got better.** The round-2 replies
did exactly what the new rule 2 asks: "⚠️ **External references need translation**: the
story cites "#412" and "#388" as GitHub issue references, not Jira keys", closing with
"**Please confirm which Jira issues these map to**"; another wrote "**Depends on:** #412
(API-key issuance; untranslatable without confirmation — ask author if this is GP-412)".
They then referred to the same reference by name in later rows, with no marker within
reach, and the every-occurrence distractor rule scored all three trials as total failures.
**Fixed in the scorer:** accounting for a token is something a reply does once.

**`missing:group-scope` survived the corpus fix here** where it had not in
bug-investigation — the group was nameable and the model still read without it, 2 of 3
trials, above noise. **Fixed in the skill:** Step 3 now names the scope where the reads
actually happen, instead of leaving it to rule 7 at the end of a seven-rule list.

## Round 3 — after the scorer relaxation

```
variant       chars    all  confident  errors
V0-shipped    10167   92%        89%       0     missing:effort-range 1/12
V1-none           0    8%         0%       0     comparables-search 3/12 · group-scope 3/12 · jira-dependency 3/12
                                                 declines-to-split 3/12 · unmarked:createJiraIssue 2/12 · confidence 2/12
                                                 effort-range 2/12 · criteria-called-out 2/12 · reads-parent 1/12
                                                 unmarked:#412 1/12

per case (V0 / V1): plan-no-filing 3/3 · github-grammar-bait 2/3 · already-one-slice 3/3 ·
untestable-criteria~ 3/3   (V1: 0/3 · 0/3 · 0/3 · 1/3)
```

## Rounds 4–6 — against the text that ships, and the brittlest check removed

Round 4 re-measured after the repo's formatter reflowed the skill body, and dropped to 50%
— a 42-point fall, far outside the noise, with `reads-parent` failing 3 of 3 on
`plan-no-filing` where round 3 had passed 3 of 3. The skill text had changed by one
character, so the cause was elsewhere.

**It was the check.** `reads-parent` required `getJiraIssue(`. The round-4 replies wrote

```
### 1. **getJiraIssue** — Fetch parent and check for existing sub-tasks
    cloudId: ...
    issueIdOrKey: "GP-1131"
```

— the same call, stated as a heading with a parameter block. Worse, two of the three
replies planned no parent fetch at all, which is defensible: the prompt hands them the
story text, so re-fetching it is a coin flip rather than a property of the skill.
**`reads-parent` is gone** and `comparables-search` no longer requires a paren either.

Round 5's edit to this file silently did not land — the script carrying it died on its own
assertion before writing, so round 5 measured the unchanged corpus and is reported as such.
Round 6 is the first round with the check actually removed.

```
round 4    V0-shipped 10168  50% all  44% confident  reads-parent 3/12 · comparables-search 1/12 · +3
           V1-none        0   8%      11%            comparables-search 3/12 · group-scope 3/12 · +7
round 5    V0-shipped 10168  92% all  89% confident  reads-parent 1/12 · comparables-search 1/12
           V1-none        0   8%       0%            comparables-search 3/12 · group-scope 3/12 · +8
round 6    V0-shipped 10168  92% all  89% confident  unmarked:#412 1/12
           V1-none        0  17%       0%            comparables-search 3/12 · group-scope 3/12 · confidence 3/12
                                                     declines-to-split 3/12 · jira-dependency 2/12 · +3

per case, round 6 (V0 / V1): plan-no-filing 3/3 · github-grammar-bait 2/3 ·
already-one-slice 3/3 · untestable-criteria~ 3/3   (V1: 0/3 · 0/3 · 0/3 · 2/3)
```

Round 4 is the reason to distrust a single round of four cases at three trials: one brittle
check on one case moved the headline by 42 points while the skill was unchanged. Rounds 5
and 6 agree at 92%, and the surviving V0 failure is the same single `#412` trial in both.

## Round 7 — the degradation path the suite never exercised

The 3.0.4 pre-PR review found the suite varied fixture content but never tool-surface
availability: every case ran on `SURFACE_FULL` while the skill documents a no-Jira
degradation path with two mandatory disclosures. `pasted-degrade` adds it —
`SURFACE_NO_JIRA` (memory tools only), the multi-slice story pasted in, comparables from
memory — and scores the usual grammar set plus `names-cannot-file` and
`names-overlap-gap`.

```
variant       chars    all  confident  errors
V0-shipped    10168   87%        83%       0     unmarked:#412 1/15 · unmarked:#388 1/15
                                                 unmarked:closes-trailer 1/15 · declines-to-split 1/15
V1-none           0    7%         0%       0     jira-dependency 5/15 · confidence 5/15
                                                 comparables-search 3/15 · group-scope 3/15
                                                 declines-to-split 3/15 · names-cannot-file 3/15
                                                 names-overlap-gap 3/15 · +3

per case (V0 / V1): plan-no-filing 3/3 · github-grammar-bait 2/3 · already-one-slice 2/3 ·
untestable-criteria~ 3/3 · pasted-degrade 3/3   (V1: 0/3 · 0/3 · 0/3 · 1/3 · 0/3)
```

The new case separates completely — V0 3/3, V1 0/3, with V1 losing on exactly the two
disclosures every trial: an unaided reply produces the slices and never says that nothing
can be filed or that existing sub-tasks could not be checked for overlap. V0's two misses
are one trial each and both known shapes: the recurring single foreign-reference trial
(the same residual as rounds 3, 5, and 6), and one `already-one-slice` reply that did
decline — "File this story as-is" — in words the `declines-to-split` pattern does not
cover. There the check missed, not the skill; one trial in fifteen is not a reason to
rewrite it, so both are recorded for the next hardening pass instead.

## What the numbers say

**The checks V1 loses on every trial are the ones the skill exists for**:
`declines-to-split` 3/3 — an unaided model splits the one-slice story every time;
`jira-dependency` 3/3 — dependencies arrive in the input's grammar, not Jira's;
`group-scope` 3/3. `unmarked:createJiraIssue` 2/12 for V1 is the outward-facing one: two
unaided trials proposed filing with no gate at all.

**V0's residual failure is a single trial in every round** — a point estimate instead of a
range in round 3, one foreign reference used without being accounted for in rounds 5 and 6.
One trial in twelve is not evidence a rule needs rewriting.

**The skill's two real fixes came from this suite, not from review**: the foreign-reference
pass-through and the unscoped read. Neither was visible in the prose — both replies read as
correct work.

## What this suite does not measure

- **Whether the slices are the right slices.** Seam quality has no ground truth in a
  fixture. The suite checks the grammar, the honesty, and the refusals.
- **Whether filing actually works.** No issue is created in these runs; the plan family
  scores the intent to gate, not the creation path.
- **Effort accuracy.** `effort-range` checks that a range with a basis is given, not that
  the range is right.
