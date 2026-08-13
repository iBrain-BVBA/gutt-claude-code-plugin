# story-creation — findings

Judge model: the bench default fast model. 2 variants (shipped skill body read
live from the working tree vs no skill) × 4 cases × 3 trials per round.

## Headline

| Round              | V0-shipped   | V1-none   |
| ------------------ | ------------ | --------- |
| 1                  | 83% (10/12)  | 8% (1/12) |
| 2 (blind, re-run)  | 83% (10/12)  | 8% (1/12) |
| 3 (live-run edits) | 100% (12/12) | 8% (1/12) |

Between rounds 1 and 2 one checker bug was fixed (below); the skill text was
not changed. Round 3 ran the text hardened after the live run (rules 2, 3 and
6 extended — see the live-run section) and is the certifying round. Read its
100% honestly: the two cells rounds 1–2 lost were pasted-degrade disclosure
wordings, and a single-cell move sits inside this bench's documented flutter —
the claim the round supports is that the three substantive cases have been at
ceiling in every clean round and the degradation case no longer lags, not that
the edits bought seventeen points.

## What the skill buys, per case (round 2)

- **plan-gated-writes 3/3 vs 0/3.** With creation tools on the surface, the
  skill-on plan grounds drafts in memory with an explicit org `group_ids` and
  gates every `createJiraIssue` on approval. The control files ungated and
  skips grounding — `unmarked:createJiraIssue` and `missing:group-scope` are
  its top labels.
- **transcript-drafts 3/3 vs 0/3.** The seeded transcript carries a
  decided-against ask (an export request memory says was rejected in favour of
  an API) and a too-vague item. Skill-on replies surface the decision instead
  of redrafting it, cite a `Source:` per draft, and account for the vague item;
  the control drafts everything fluently with no sources and misses the
  decision.
- **edit-diff-not-rewrite 3/3 vs 1/3.** The one-value edit arrives as a
  per-field diff (`3 → 5`) with untouched fields named. The control
  regenerates and once claimed the edit as applied.
- **pasted-degrade 1/3 vs 0/3 — the wobbly case.** Skill-on replies always
  produce the drafts as paste-ready markdown; what they skip, roughly half the
  time across both rounds (3/6 cells), is one of the two required disclosures —
  "nothing was written" and "existing-ticket checks were skipped". The
  behaviour the disclosures describe is correct (no reply ever claimed a
  filed story); the _statement_ of the limitation is what the small judge
  model drops. Recorded as a known ceiling rather than tuned away: the checks
  measure the disclosure the skill text explicitly requires.

## Checker corrections during the rounds

- Round 1 scored one fully compliant reply as `banned:touches-priority`: the
  reply listed `Priority | (unchanged)` among untouched fields — exactly rule
  3's behaviour — and the ban regex matched the substring `chang` inside
  `unchanged`. Fixed with a word boundary; the label is trustworthy from
  round 2 on.

## Live-run round (real meeting, real ticket)

A manual acceptance run against the real tracker — a genuine meeting's notes
as the source, a filed ticket as the edit target — scored by hand against a
prepared checklist:

- **Drafting: strong, and not in the way the name suggests.** One story
  drafted and eight decided-against asks dismissed with citations, in 5m49s;
  the citations spot-checked at source were real and correctly characterised,
  and no invented detail appeared. Most of the value was in the sourced
  dismissals — the run's conclusion was that a time-to-ready number must be
  reported next to what was _established_, not only what was drafted, or the
  metric understates the thing that works.
- **Editing: substance held, the visible step did not.** The write carried
  exactly one field with exactly the asked value — but went fetch→write with
  no diff shown: a fully-specified ask ("change A to B") collapsed the
  proposal step, leaving the harness permission dialog as the only
  checkpoint. Rule 3 was extended ("the diff is shown before the write,
  always") and re-measured on the edit case alone at 10 trials: **8/10** —
  materially better, short of a guarantee. The remaining gap is a prose
  ceiling: closing it for real means a pre-tool-use gate in code, proposed as
  a follow-up rather than more wording.
- **Two more live-only findings became rules.** The opening memory read
  passed no explicit group scope and surfaced personal-scope material —
  contained by judgment, not by the rule — so rule 6 now requires explicit
  `group_ids` from the first read. And a full-text search rejected for output
  size was narrowed to one field and treated as complete, so Degradation now
  covers partial results and rule 2 requires dismissal evidence to carry its
  scope inside the claim.

## Reading guide

`missing:source-cited` and `missing:asks-before-filing` are the two labels
that separate the variants most: they encode the skill's two core rules
(drafts cite their source; nothing lands in Jira unapproved). A future variant
that loses either has lost the point of the skill, whatever its total score.
