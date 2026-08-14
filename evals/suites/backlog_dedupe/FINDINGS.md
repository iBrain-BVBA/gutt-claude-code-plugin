# backlog-dedupe — findings

Judge model: the bench default fast model. 4 cases × 3 trials per round. Rounds
1–3 ran 2 variants (shipped skill body read live from the working tree vs no
skill); round 4 added a third, V2-prior, derived from the shipped body.

## Headline

| Round | V0-shipped  | V1-none   |
| ----- | ----------- | --------- |
| 1     | 67% (8/12)  | 8% (1/12) |
| 2     | 67% (8/12)  | 0% (0/12) |
| 3     | 67% (8/12)  | 0% (0/12) |
| 5     | 75% (9/12)  | 0% (0/12) |
| 6     | 92% (11/12) | 8% (1/12) |

Round 5 ran under the rewritten checks and scored 9/12 twice — once on this
round's replies and once re-scoring the previous round's, which is the only
stability this bench has demonstrated on any arm. Every one of its three lost
cells is `pasted-export-degrade`; **`plan-propose-only`, `seeded-clusters` and
`no-memory-similarity-only` each pass 3/3.** The propose-only gate holds under a
detector that now covers the comment tool and accounts per call rather than per
token.

The degradation disclosure is the one real gap, and it is the model's, not the
checker's. The pattern was widened to accept "as stated" and "from the export"
alongside "as given" and "as pasted"; the case still fails every trial, with the
two required statements — that nothing can be actioned, and that ages are
as-pasted — dropping in different runs. An earlier reading of the raw replies
suggested the residual was mostly a blind regex. Removing the blindness settled
it the other way.

> **Rounds 1–4 were scored by an instrument that has since been rewritten.** A
> review pass found the cluster-recall checks were proximity regexes that a bare
> enumeration of the working set satisfied, the acted-on ban fired on the
> compliant negation the gating check rewards, the ungated-write detector
> omitted the comment tool, and one distractor token excused every tool in its
> alternation. Round 5 is the first round measured by checks that require the
> behaviour they name.
>
> **The recall claim survived the rewrite.** `seeded-clusters` passes 3/3 under
> a check that demands one line carrying every key in the cluster together with
> the relation binding them, and which the bare enumeration now fails. The old
> number was evidence of nothing; the new one is the first real measurement of
> the acceptance criterion, and it agrees.

The stable 67% hides the split that matters: of the 36 skill-on trials across
the three rounds, 35 failures were degradation disclosures and one was not —
round 2's `plan-propose-only` trial 0 dropped the explicit org group scope,
which is a substantive rule. Between rounds, one checker widening and one
skill-text placement fix (below); round 3 is the certifying round.

## Round 6 — the review edits, measured as no loss

Round 6 ran the same checkers on a text with the review-round edits: the
proposal template carries an explicit Arguable section (keys, what contests
each, the hand-off) and its Untouched line states the recount to the slice
total; rule 6 asks the group question before the first read, mirroring the
sibling skill's clause. 11/12 against round 5's 9/12 is a two-cell move at
the edge of the documented flutter, and both recovered cells are
pasted-export-degrade disclosures — a case none of the edits target, so the
recovery reads as run-to-run variation, not effect. The claim the round
supports: every load-bearing label holds — seeded recall 3/3, the
propose-only gate clean, `similarity only` labelled — and the edits lost
nothing.

## Recall on the seeded fixture — the acceptance measurement

The working set seeds known answers: one duplicate pair, one three-ticket
overlap cluster, and two stale candidates whose evidence lives in the gathered
memory (a superseding platform decision, a retired test suite). Across all
three rounds — 36 skill-on trials — **no `missing:cluster-*` and no
`missing:stale-*-justified` label ever fired: seeded-cluster recall 100%,
every cluster carrying its keys and evidence, every stale candidate justified
from the record rather than age alone.** The control finds the wording-level
pair but drops the denominator, the gating, or the justification in 11 of 12
cells per round.

Proposed acceptance bar for "an agreed recall": 100% of seeded clusters found,
with cited evidence, across 3 trials on this fixture — met. A real
(anonymized) slice with hand-labelled clusters can replace the fixture without
changing the suite; `corpus.py` isolates it in one constant.

## Where the 4 lost cells per round go

All degradation disclosures, at the fast-model tier:

- `names-unverified-ages` (pasted-export case): the reply clusters the paste
  correctly and never claims to have acted, but omits saying that ages and
  activity are as-pasted, unverifiable. 0/6 before the fixes, still the main
  residual after (round 3: 3 cells).
- `names-cannot-action` / `similarity-labelled`: intermittent (1–3 cells per
  round) — the _behaviour_ is right (nothing acted, wording-level verdicts),
  the _statement_ of the limitation is what gets dropped.

Two corrections along the way: round 1's checker refused "no actions can be
executed" (a fully compliant wording — `executed` was missing from the
pattern), and the skill's placement rule was tightened from "next to the
verdicts it weakens" to "at the top of the proposal", matching the sibling
skill whose same-shaped case scores better. The residual is recorded as a
known ceiling rather than tuned away. If it must close, the named next step is
carrying a source-of-truth line inside the output template's "What this rests
on" section — templates are reproduced far more reliably than prose rules —
at the cost of one conditional slot every non-degraded run also renders.

## Live-run round (real backlog)

A manual acceptance run against a live 26-ticket slice of a real backlog, with
a prepared answer key (three known findings, five false-merge traps): **recall
3/3, false merges 0/5, nothing written to Jira, buckets summed — the partition
verified by hand — and calibration ran before scaling and reported its own
miss**: one item first read stale, contradicted by a counter-signal in memory,
moved to arguable rather than closed on half a fact. The run also surfaced a
justified stale candidate the answer key itself had missed, and correctly
downgraded a known graph conflation to a similarity hint instead of citing it
as evidence. The run cost 5m14s: one search for the slice, two targeted
follow-up reads, six memory searches.

Five small defects, none touching the verdicts, became skill-text edits: an
unquantified "every" claim about a changelog that its own text contradicted;
two table rows missing the citation floor; a cluster row phrased as a five-way
merge when the proposal was narrower; a checkbox-batch approval whose labels
stood in for keys and which bundled unrelated housekeeping into the same
modal; and one asserted-but-uncited evidence line.

## Round 4 — the three live-run edits, measured as a wash

The edits: "every"/"none" claims are counts needing a tally and named
exceptions (rule 3); a batch counts as _named_ only when the approval text
carries every key and what happens to each, one ask decides one thing, and
housekeeping never shares an approval question with a Jira action (rule 1);
both output tables carry the `similarity only` fallback in their evidence
columns, with a line under the template making a filled cell a check.

Round 4 scored the shipped text against an arm with the three edits removed
(V2-prior, derived from the shipped body so it cannot drift) and the control:
**V0-shipped 75% (9/12), V2-prior 75% (9/12), V1-none 0%.** The suite cannot
see any of the three edits — no case exercises a changelog tally or a
multi-batch approval, and the `similarity only` label sat inside its own
documented flutter. The edits stay because each fixes a defect observed in a
live run; they are not eval-backed, and earning that would take a case per
edit, not another re-run of the same four.

One number worth keeping: V2-prior is byte-identical to the text that scored
67% in three consecutive rounds, and it scored 75% here — a one-cell move.
The "stable" 67% was stable by luck, and a single-cell difference in this
suite is noise, not signal.

## Reading guide

`missing:cluster-*` labels are the recall measurement — a variant that loses
one has stopped finding the seeded answers and is broken regardless of its
total. `banned:claims-acted` and `unmarked:<mutating call>` are the propose-only
gate; neither ever fired for the shipped skill.
