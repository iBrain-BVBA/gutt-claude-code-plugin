# capture-close — rounds 1–3

What happens to the user's answer once a Stop capture has fired and been written. GP-927.

Three rounds on `claude-haiku-4-5-20251001`, at 2, 4 and 2 trials per (variant, case) — 40,
80 and 40 calls. Rounds 1–2 ran before the shipped block was shortened and round 3 after, so
two variant _labels_ changed meaning between them; the tables below are keyed on character
counts where that matters. Raw records in `results/capture-close-{2t,4t}-5v.json` — note round
3 overwrote round 1's file, since both are 2-trial 5-variant runs.

## Headline

**An injected closing rule beats both the no-instruction baseline and the rule it replaced, by
18+ points pooled and in every round. Which of the two candidate wordings ships is not
resolvable on this bench.** Rounds 1–2, under the labels those rounds used:

| variant                   | chars | r1+r2 pooled | round 1 (n=8) | round 2 (n=16) |
| ------------------------- | ----: | -----------: | ------------: | -------------: |
| `V4-terse` → **now `V0`** |   878 |          92% |           75% |           100% |
| `V3-no-negatives`         |  1054 |          92% |           88% |            94% |
| `V0-shipped` → now `V5`   |  1213 |      **88%** |           88% |            88% |
| `V2-summary-only`         |   312 |          67% |           62% |            69% |
| `V1-none`                 |     0 |          54% |           62% |            50% |

### Round 3 flipped the ordering — read this before trusting the row above

A third round (2 trials, n=8) ran after the swap, to validate the re-labelled variant set. It
ranked the two candidate blocks the other way round. Pooled over all three rounds, n=32 per
wording:

| wording                            | chars | pooled |  r1 |   r2 |   r3 |
| ---------------------------------- | ----: | -----: | --: | ---: | ---: |
| block minus the negatives sentence |   719 |    94% | 88% |  94% | 100% |
| **1213-char block** (now `V5`)     |  1213 |    91% | 88% |  88% | 100% |
| **878-char block** (now `V0`)      |   878 |    84% | 75% | 100% |  62% |
| `memory-capture`'s old rule        |   312 |    66% | 62% |  69% |  62% |
| no instruction at all              |     0 |    59% | 62% |  50% |  75% |

Two things follow, and they point in different directions.

**The premise is robust.** Both candidate blocks beat the no-instruction baseline and the rule
they replaced, in every round, by 18 points or more pooled. That is the finding GP-927 rests
on and three rounds have not shaken it.

**The choice between the two blocks is not resolvable on this bench, and the shorter one is
now behind.** The 878-char form has scored 75%, 100% and 62% on the same wording and cases —
a 38-point spread, worse than the 11 points `evals/README.md` documents elsewhere. Its pooled
84% against the longer form's 91% is a 7-point gap in the direction opposite to the round that
motivated adopting it. Neither number is a measurement of anything; the honest statement is
that this suite cannot separate these two wordings at any n it has been run at, and that the
argument for the shorter one is now _only_ that it costs 335 fewer characters per fire — not
that it performs as well. It is still shipped, because that was a deliberate call and one
noisy round is not grounds to reverse it either. What would settle it is a round at 8+ trials
on those two wordings alone; until then, treat the shipped block as chosen on cost.

### Labels

**Labels in the round-1/2 table are the ones those rounds were run under, and two of them have
since moved.** The 878-char `V4-terse` was adopted as the shipped block, so it is now `V0-shipped`;
the 1213-char form it replaced is now `V5-plus-style`. `V3-no-negatives`'s 1054 was an
ablation of the old baseline and will read differently next round. Re-running this suite
today produces the same wordings under different names — compare wordings and character
counts, not labels, across that line.

`V1-none` is the capture path before this story: the fired reason alone. `V2-summary-only`
is the rule that used to live in `memory-capture/SKILL.md` and asked for "a short summary of
that work, placed last" — it was already in context on this path, so if it had scored the same
as an injected block, GP-927's premise would have been wrong. It does not: 66% pooled against
84% and 91% for the two candidate blocks, and it lost in all three rounds.

The dominant failure in both baselines is **`unreported`** — the reply never tells the user
a capture happened at all; round 2 gave 5/16 with no instruction and 3/16 for the old rule,
against 2/16 for the 1213-char block and 0/16 for the 878-char one. That is the
failure mode the two-part demand was added for, and it is not the one the story predicted.
The predicted failure was burying the work under the bookkeeping; `closed` is 13/16 at worst
and 16/16 for three of five variants, so on this corpus the model rarely ends on the capture
unprompted. It just silently drops the capture instead. Both leave the user misinformed;
only one was anticipated.

`echoed` and `apology` are 0 everywhere, across 120 calls. Either those failures need a
longer or more conversational turn than this corpus provides, or the model does not reach for
them. Not evidence that the clauses forbidding them are unnecessary — evidence that this
bench cannot see them. Treat those two columns as unmeasured, not as passed.

## What this does not establish

**That the shipped wording is the best of the three that work.** Pooled over three rounds the
three effective wordings sit at 94%, 91% and 84% — a 10-point band across n=32, against a
documented noise floor of 11 points on identical rounds elsewhere and a 38-point spread
observed here on a single wording. Nothing in that band is a result.

The shape that prompted acting anyway: the 878-char block is the 1213-char one with the
whole-reply style list removed, and in rounds 1–2 it did not score worse.

**Adopted anyway, on the author's call, and the reasoning is worth being honest about.** The
eval does not show `V4` is better; it showed it was not detectably worse while being 28%
shorter, and those characters are paid on every fire. That is a decision under uncertainty
rather than a measured win: the cost is certain and the benefit was unmeasurable, so the
shorter form carried the burden of proof and did not fail. **Round 3 then put it behind — see
the round-3 section above.** The decision stands on cost, not on performance, and that section
says so rather than letting this paragraph be the last word. What the bench _does_ establish is
the
part that matters most here — the closing rule and the two-part demand in paragraphs 1–3
carry the effect against `V1` and `V2`; the style list was riding along.

The list did not stop being the style. It moved out of the injected region to the
`## Style for the whole reply` section of the skill, where anyone loading the skill still
reads it. `tests/hook-architecture.test.cjs` now guards that it is present there and absent
from the block, because nothing at runtime reads it any more and deleting it would otherwise
break no test.

The variant set inverted to match: `V5-plus-style` re-adds the list to the new, shorter
baseline and reconstitutes the old 1213-character block exactly. So the question stays open
and answerable in a later round instead of being settled by having been forgotten. Both
halves are read out of `SKILL.md` rather than pasted, so neither can drift from what ships.

**Anything about whether the capture actually ran.** Tools are off; the capture is presented
to the model as already complete. See the suite docstring — the first version of this suite
did _not_ do that, and measured nothing: with no capture in the reply there was nothing to
bury, `unreported` was 4/4 even on the shipped wording, and all five variants scored
identically for a reason that had nothing to do with their wording. That result is recorded
here because it is the more useful lesson than the table above. A suite that instructs the
model to use a tool it does not have measures the harness.

**Per-case numbers.** The denominators are 2 and 4. The 1213-char block scoring 2/4 on
`flaky-test` in round 2 while the 878-char one scored 4/4 is not a finding about `flaky-test`,
and round 3 duly reversed it.

## Running it

```bash
python3 evals/run.py capture-close --trials 4
# the run that would settle which block ships — the two candidates, nothing else, deep
python3 evals/run.py capture-close --variants V0-shipped V5-plus-style --trials 8
```

`V0-shipped` is read out of `gutt-core/skills/output-style/SKILL.md` between its injection
markers rather than copied here, so it cannot drift from what ships; `variants.py` raises if
the markers are gone rather than silently measuring against an empty baseline.
