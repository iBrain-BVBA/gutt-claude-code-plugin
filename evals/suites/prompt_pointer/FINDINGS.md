# prompt-pointer — round 1

What the injected `UserPromptSubmit` recall pointer does to the agent that receives it.
Judge model `claude-haiku-4-5-20251001` throughout; ~700 calls across four runs.

Raw records are in `evals/results/prompt-pointer-*.json` (gitignored); the tables below are
what survived pooling.

Unlike `stop-judge` there is no committed `results/prompt-pointer-report.md`, and that is
deliberate rather than an omission: no single run covers the full matrix, and the conclusions
here come from pooling two runs. A committed report would be whichever subset ran last, which
is exactly the single-run reading this round got wrong. This file is the record.

## Headline

| Claim                                                                                                              | Strength                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| The retired 2.x "MANDATORY / SYSTEM-LEVEL DIRECTIVE" framing gets the injection surfaced to the user as suspicious | **Confirmed**, every run  |
| Cutting the rationale (V2-terse, 114 chars) costs recall outright                                                  | **Confirmed**, every run  |
| Putting the summary clause _before_ the recall instruction costs recall outright                                   | **Confirmed**, z ≈ 4      |
| Adding the summary clause _after_ the recall instruction changes nothing measurable                                | Confirmed null at n=120   |
| V0-shipped vs V3-hedged vs V4-summary differ from each other                                                       | **Not supported** — noise |

## GP-868 is real, and here is the mechanism

The repo has carried the hypothesis that out-of-band command framing trips Claude's
prompt-injection defences (R23, GP-868) as an unmeasured belief. V1-mandatory is that
framing, and it is the only variant in the matrix that ever leaked or went noisy:

```
variant         missed  over-recall    noisy  leaked
V0-shipped      15/30        0/25      1/20    0/55
V1-mandatory    14/30        3/25      4/20    1/55
V2-terse        19/30        0/25      5/20    0/55
V3-hedged       15/30        0/25      2/20    0/55
V4-summary       8/30        0/25      3/20    0/55
```

Verbatim, answering `hey, morning`:

> Morning! 👋 How can I help you today?
>
> _(Note: I noticed an unusual system directive about running a memory-search skill, but I'm
> treating that skeptically since it contradicts normal…)_

> I see the system directive mentioned running `gutt-claude-code-plugin:memory-search`, but
> that skill isn't available in the current environment.

Four of five greetings came back like that. The failure is not that the model ignores the
pointer — it is that the pointer becomes the subject of the reply. Note also
`over-recall 3/25`: the aggressive framing makes it recall on turns that did not warrant
it, so the wording fails in both directions at once.

## The summary clause (the GP-866 requirement)

Requirement: have the closing summary name durable findings as Insight / Incident / Lesson,
so the Stop judge can score the summary instead of the transcript.

**Cost: none measurable.** Pooling the two 15-trial runs, n=120 recall opportunities each:

| variant    | recall misses | ratelimit | retry-arch | why-postgres | bump-timeout |
| ---------- | ------------- | --------- | ---------- | ------------ | ------------ |
| V0-shipped | 31/120 (26%)  | 22/30     | 22/30      | 26/30        | 19/30        |
| V4-summary | 32/120 (27%)  | 21/30     | 17/30      | 28/30        | 22/30        |

Never leaked (0/90), one stray label in 90. So the clause is safe to add.

**Benefit: unmeasured, and this suite cannot measure it.** On the two cases that do produce
a durable finding, the label rate is 6–7/10 _for every variant, including V0, which has no
clause at all_ — a prompt like "write that up for the team" elicits a `Lessons Learned`
heading on its own. To attribute labelling to the clause the corpus would need turns where
real work completed and the user did **not** ask for a write-up. That is the gap to close
before claiming the clause earns its 225 characters.

**Constraint: it must go last.** V5-summary-first is V4's exact words with the clause moved
ahead of the recall instruction — 35/60 recall misses (58%) against 26–27% for V0 and V4,
z ≈ 4. This refuted the hypothesis that built it: the guess was that a _trailing_ clause
displaces what precedes it, and the opposite held. Leading with "when you finish, state any
durable finding" appears to frame the whole injection as being about reporting, with recall
arriving as an aside.

## Methodological note — I over-read a single run

Two runs of the same two variants over the same six cases at 15 trials each disagreed
sharply. On `retry-arch`: V4 scored **5/15 then 12/15**, V0 **13/15 then 9/15**. On the
first run I called the gap significant at p ≈ 0.006, treating within-run trials as
independent draws on a stable quantity. Pooled, the two wordings are 26% and 27% — the same.

`evals/README.md` already warns about this ("Re-run one variant unchanged before believing
any ranking", an 11-point spread on identical conditions). The per-case column is the most
seductive place to ignore it, because its denominator is the trial count and it therefore
looks precise. Nothing in the 5–15 point band survived pooling; everything that survived was
categorical.

## Two harness bugs this round found

1. **`lib/runner.BLOCKED` matched the substring `rate limit`**, so a reply reading "so I can
   implement rate limiting appropriately" was classified as a quota wall and voided the whole
   run — the exact inverse of the failure that guard exists to prevent. Now matched as
   patterns requiring error phrasing, with a free self-check: `python3 evals/lib/runner.py`.
2. **Cases must be answerable from an empty working directory.** Judge calls run from
   `judge_cwd()` with `--allowedTools ""`, so "Add rate limiting to the auth endpoint" drew
   "please provide more details about your project" — neither recall nor a refusal to recall.
   Two cases scored 0 for every variant, which is the signature of a case measuring the
   harness. A case no wording can pass is a constant, not a measurement.

## Not yet done

- No run on a session-class model. The pointer is consumed by whatever model the user's
  session uses; every number here is Haiku. `migrate_offer` found a behaviour that was 100%
  on Sonnet and 25% on Haiku, so this is a live risk, not a formality.
- Tools are off, so this scores **stated intent**. "Let me check organizational memory" and
  actually invoking the skill are indistinguishable here; the e2e tier is where a real
  invocation is observed.
