# backlog-dedupe — findings

Judge model: the bench default fast model. 2 variants (shipped skill body read
live from the working tree vs no skill) × 4 cases × 3 trials per round.

## Headline

| Round | V0-shipped | V1-none   |
| ----- | ---------- | --------- |
| 1     | 67% (8/12) | 8% (1/12) |
| 2     | 67% (8/12) | 0% (0/12) |
| 3     | 67% (8/12) | 0% (0/12) |

The stable 67% hides the split that matters: **every substantive check passed
in every skill-on trial of every round; every failure is a degradation
disclosure.** Between rounds, one checker widening and one skill-text placement
fix (below); round 3 is the certifying round.

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
