# capture-close — round 1

What happens to the user's answer once a Stop capture has fired and been written. GP-927.

Two rounds, same variants and cases, `claude-haiku-4-5-20251001`, 2 and 4 trials per
(variant, case) — 40 and 80 calls. Pooled n = 24 per variant. Raw records in
`results/capture-close-2t-5v.json` and `results/capture-close-4t-5v.json`.

## Headline

**The shipped block beats both the no-instruction baseline and the rule it replaced, and the
gap is categorical.** Pooled accuracy:

| variant           | chars |  pooled | round 1 (n=8) | round 2 (n=16) |
| ----------------- | ----: | ------: | ------------: | -------------: |
| `V0-shipped`      |  1213 | **88%** |           88% |            88% |
| `V3-no-negatives` |  1054 |     92% |           88% |            94% |
| `V4-terse`        |   878 |     92% |           75% |           100% |
| `V2-summary-only` |   312 |     67% |           62% |            69% |
| `V1-none`         |     0 |     54% |           62% |            50% |

`V1-none` is the capture path before this story: the fired reason alone. `V2-summary-only`
is the rule that used to live in `memory-capture/SKILL.md` and asked for "a short summary of
that work, placed last" — it was already in context on this path, so if it had scored the
same as `V0`, GP-927's premise would have been wrong. It does not: 67% against 88%.

The dominant failure in both baselines is **`unreported`** — the reply never tells the user
a capture happened at all (5/16 for `V1`, 3/16 for `V2`, against 2/16 for `V0`). That is the
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

**That the shipped wording is the best of the three that work.** `V0` (88%), `V3` (92%) and
`V4` (92%) are inside the noise floor `evals/README.md` documents — the same prompt has
scored an 11-point spread across identical rounds elsewhere, and `V4` itself moved 75% → 100%
between these two rounds on n=8 and n=16. Nothing in a 4-point band means anything here.

The interesting shape of it is worth stating plainly anyway: `V4-terse` is `V0` with the
style list removed, 335 characters shorter, and it did not score worse. If that survives
pooled independent runs it is an argument for shortening the injected block, since those
characters are paid on every fire. It has not survived anything yet — one more round at 4+
trials, read pooled, is the next step, and until then the shipped block stays as it is.
Shrinking a prompt on a difference this size is how the repo lost a round to a drifted
baseline before.

**Anything about whether the capture actually ran.** Tools are off; the capture is presented
to the model as already complete. See the suite docstring — the first version of this suite
did _not_ do that, and measured nothing: with no capture in the reply there was nothing to
bury, `unreported` was 4/4 even on the shipped wording, and all five variants scored
identically for a reason that had nothing to do with their wording. That result is recorded
here because it is the more useful lesson than the table above. A suite that instructs the
model to use a tool it does not have measures the harness.

**Per-case numbers.** The denominators are 2 and 4. `V0` scoring 2/4 on `flaky-test` in
round 2 while `V4` scored 4/4 is not a finding about `flaky-test`.

## Running it

```bash
python3 evals/run.py capture-close --trials 4
python3 evals/run.py capture-close --variants V0-shipped V1-none --trials 6
```

`V0-shipped` is read out of `gutt-core/skills/output-style/SKILL.md` between its injection
markers rather than copied here, so it cannot drift from what ships; `variants.py` raises if
the markers are gone rather than silently measuring against an empty baseline.
