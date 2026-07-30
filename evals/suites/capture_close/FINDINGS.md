# capture-close — rounds 1–4

What happens to the user's answer once a Stop capture has fired and been written. GP-927.

Four rounds on `claude-haiku-4-5-20251001` at 2, 4, 2 and 6 trials per (variant, case) — 40,
80, 40 and 168 calls. `suite.py` and `corpus.py` have not changed since the first of them and
the harness has not either, so all four pool. Round 4 is a prompt-tuning round: three new
candidates (`W1`–`W3`) built to match the longest wording's quality at or below the shipped
block's length.

> **The shipped block changed after round 4 and has not been re-measured.** A PR review found
> that one clause of it — the one bounding the capture account's length — restated
> `memory-capture/SKILL.md` almost verbatim, on the one path where that file is always loaded
> already. Removing it took the block from 878 to **804 characters**. Every `V0-shipped` number
> below therefore describes the 878-character text, not what ships now. The edit only deletes a
> clause the surrounding rules do not depend on, and shorter has won every comparison this
> suite has run — but that is an argument for expecting no regression, not a measurement of
> one. A round 5 at n≥24 would settle it, and `R1-reanchor` in `variants.py` is a second
> candidate waiting on the same round.

**One hazard when reading the older rounds.** Variant _labels_ changed meaning after round 2,
when the shipped block was shortened from 1213 to 878 characters — `V4-terse` became
`V0-shipped` and the old `V0-shipped` became `V5-plus-style`. Every table here is keyed on
character count for that reason. Raw records are in `results/capture-close-{4t-5v,2t-5v,6t-7v}.json`
for rounds 2–4; round 3 overwrote round 1's file (both are 2-trial 5-variant runs), so round 1
survives only as the numbers recorded here at the time.

## Headline

**The shipped 878-character block is the best wording measured, and the longer one it replaced
is worse rather than merely more expensive.** Pooled over all four rounds:

| wording                      | chars |  pooled |  r1 |    r2 |  r3 |    r4 |
| ---------------------------- | ----: | ------: | --: | ----: | --: | ----: |
| **878-char block — shipped** |   878 | **89%** | 6/8 | 16/16 | 5/8 | 23/24 |
| 1213-char block (`V5`)       |  1213 |     80% | 7/8 | 14/16 | 8/8 | 16/24 |
| `memory-capture`'s old rule  |   312 |     66% | 5/8 | 11/16 | 5/8 |     — |
| no instruction at all        |     0 |     62% | 5/8 |  8/16 | 6/8 | 16/24 |

Two things this settles.

**An injected closing rule earns its place.** 89% against 62% for the fired reason alone and
66% for the rule that used to sit in `memory-capture/SKILL.md` — which was already in context
on this path, so if it had matched, GP-927's premise would have been wrong. It lost in all
three rounds it ran in.

**Round 3's caveat is retracted.** Round 3 (n=8) put the shorter block behind and this file
previously recorded that it shipped "on cost, not on measured performance", with a note that
what would settle it is a round at 8+ trials. Round 4 is that round: at n=24 the shorter block
takes 23/24 and the longer one 16/24, and pooled it now leads by 9 points. The shorter block is
the better wording on the evidence, not just the cheaper one. Round 3 was an 8-trial sample of
a metric with a wide tail, and the lesson is the one `evals/README.md` already states, learned
again at cost.

## Round 4 — the tuning round

| variant           | chars | acc | closed | unreported |
| ----------------- | ----: | --: | -----: | ---------: |
| `V0-shipped`      |   878 | 96% |  24/24 |       1/24 |
| `W3-presend`      |   700 | 88% |  21/24 |       0/24 |
| `W2-omission`     |   798 | 83% |  21/24 |       1/24 |
| `V3-no-negatives` |   719 | 83% |  23/24 |       3/24 |
| `V5-plus-style`   |  1213 | 67% |  19/24 |       4/24 |
| `V1-none`         |     0 | 67% |  23/24 |       7/24 |
| `W1-numbered`     |   773 | 62% |  22/24 |       8/24 |

`acc` is the conjunction — closed on the work _and_ reported the capture _and_ no preamble,
pleasantry, apology or echo — so it is not the two columns added up; a trial can fail both.

**No candidate beat the shipped block, so nothing changed.** All three are kept in
`variants.py` as documented negatives: each is a lever that looked obviously right and was not.

### Only one axis moves

Across all 288 calls with raw records: `echoed` 0, `apology` 0, `pleasantry` 0, `preamble` 2.
Every difference between wordings is on `unreported` (the reply never mentions the capture) and
`closed` (the tail is the bookkeeping rather than the work). The clauses about echoes,
pleasantries and preamble are not doing measurable work _here_ — read "What this does not
establish" before concluding they are useless.

That is what the candidates were designed from. Reading the dropped replies makes the failure
concrete: they continue the technical discussion as though the capture result had never been
handed to them.

### W1: an explicit permission to omit gets taken

`W1-numbered` turned the two parts into a numbered list and added a skip condition — "Omit
this part only if the turn did none of it". It is the **worst variant in the round at 62%**,
with 8/24 replies dropping the capture entirely: a higher omission rate than giving the model
**no instruction at all** (7/24), and spread evenly over all four cases rather than concentrated
in one.

The one thing `W1` adds that no other variant has is explicit permission to omit. That is
correlation with a plausible mechanism, not demonstrated causation — the failing replies simply
have no capture in them, and none of the 24 contains any language about skipping, omitting or
parts. Stated at that strength deliberately. The clean follow-up is `W1` minus that single
sentence, which separates the numbered structure from the permission.

The practical warning stands either way, and it generalises past this suite: **a conditional
escape clause is read more eagerly than the instruction it qualifies.** Note that the shipped
block's opener is also conditional — "Where the turn did something on the way" — and drops 1
in 24, so what costs is not conditionality but naming omission as a permitted option.

### W2 and W3: fixing the targeted axis cost the other one

`W3-presend` replaced a declarative rule with a pre-send check, the mechanism the baseline
skill used and this one dropped. It **worked on exactly what it targeted** — `unreported` fell
to 0/24, the best of any variant including the shipped block — and then lost 3 on `closed`. Net
88%.

`W2-omission`, which names the omission failure outright ("Saying the first part happened is
not optional"), did the same thing from a different angle: 1/24 unreported, 3 lost on `closed`.
Two independent attempts at the presence axis both paid for it in position. Worth knowing
before a third: on this corpus the two halves trade against each other, and the shipped wording
is the one that happens to hold both.

### Longer is worse, not neutral

`V5-plus-style` is the shipped block plus the whole-reply style list, 335 characters more.
Rounds 1–3 read it as neutral-to-better; at n=24 it scores 67% with 5/24 failing `closed` —
level with no instruction at all, and its 5 not-closed is the worst on that axis of any variant
in the round. A plausible reading is that more instruction text dilutes the closing demand, but
this suite cannot separate that from the style list being actively confusing. Either way
moving the list out of the injected region did not cost anything, which is the decision it was
kept alive to check.

### The negatives ablation still cannot be separated

`V3-no-negatives` is the shipped block minus the sentence excluding a verbatim echo and a
recap. Over the two rounds where it was an ablation of the _current_ block (719 chars, r3–r4)
it scores 28/32 — exactly what the shipped block scores over the same two rounds. This bench
cannot tell the sentence apart from its absence, and the reasons to keep it are that the
corpus cannot reach the failure it addresses (below) and that `tests/hook-architecture.test.cjs`
guards it.

## What this does not establish

**That the always-zero clauses are dead weight.** `echoed` and `apology` are 0 across 288
calls. This corpus cannot _reach_ those failures — the turns are not long or conversational
enough — so 0 means unmeasured, not passed. Cutting the "not a verbatim echo" sentence or the
"not an interruption" clause on this evidence would be reasoning from a blank instrument. All
three `W` candidates keep the interruption clause for that reason, even though dropping it
would have bought ~160 characters against the round's own length target.

**That 96% beats 88%.** `V0-shipped` over `W3-presend` is 23/24 against 21/24, inside noise.
The claim that survives is that no candidate beat the shipped block — not that it is measurably
better than `W3`.

**That `unreported` is exactly right.** The detector requires a concrete word about the write
(`captur|episode|memory|dedup|graph|Insight:|record(ed|ing)`). Four of the round's 24
unreported replies say something softer instead — "I've logged the insight", with no mention of
what was written. Counting those as reported would move `W1` from 8 to 7 and leave `V0` at 1,
so the ordering holds; and a reply that tells the user something was logged without saying what
is arguably the failure anyway.

**Anything about whether the capture actually ran.** Tools are off and the capture is presented
as already complete. A discarded pilot round (20 calls, `results/capture-close-1t-5v.json`) did
_not_ do that — it told the model to run `memory-capture` with tools disabled, so no capture
appeared in any reply, nothing was buried, `unreported` was 4/4 even on the shipped wording,
and all five variants scored alike for reasons unrelated to their wording, with the shipped
wording looking _worse_ than saying nothing. That failure is the more transferable lesson than
any table here: **a suite that instructs the model to use a tool it does not have measures the
harness.** Its numbers are excluded from every table above.

**Per-case numbers.** Denominators are 2–6. Round 2 had the 1213-char block at 2/4 on
`flaky-test` and the 878-char one at 4/4; round 3 reversed it. Those are not findings about
`flaky-test`.

## Running it

```bash
python3 evals/run.py capture-close --trials 6
# the tuning round as run
python3 evals/run.py capture-close --trials 6 \
  --variants V0-shipped V5-plus-style V3-no-negatives W1-numbered W2-omission W3-presend V1-none
```

`V0-shipped` and the style half of `V5-plus-style` are both read out of
`gutt-core/skills/output-style/SKILL.md` rather than pasted into `variants.py`, so neither can
drift from what ships; the module raises if the markers or the style section are gone rather
than silently measuring against an empty baseline, and it raises if a `W` candidate exceeds the
shipped length — the round's premise is "at or below", and a candidate that had quietly grown
past it could win on the extra words instead of on its idea.
