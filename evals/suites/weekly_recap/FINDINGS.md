# weekly-recap — findings

The suite replays the originating incident: a memory-connected session asked for
"mentions of me from the previous week" and answered from relevance-ranked search,
which knows nothing about "last week". `V0-shipped` is the skill text read from the
working tree; `V1-none` is the incident condition — same tool surface, no skill.

Judge model: `claude-haiku-4-5-20251001` (FAST_MODEL), 3 trials per (variant, case)
unless stated. Raw files are keyed on suite-trials-variants, so **rounds at the same
depth overwrite each other's raw records** — the tables below are the surviving
record of rounds 1–2.

## Round 1 — draft wording

```
variant       chars    all  confident  errors
V0-shipped    10872   50%        33%       0     missing:window-start 6/12 · window-end 5/12 · unmarked:Meridian 1/12
V1-none           0   17%        22%       0     window-end 9/12 · window-start 8/12 · mention-walk 3/12 · subject-entry 3/12 · coverage-note 3/12

per case (V0 / V1): workshop-mentions 0/3 / 0/3 · bare-recap~ 3/3 / 0/3 ·
distractor-excluded 0/3 / 0/3 · quiet-week 3/3 / 2/3
```

Reading the raws: V0 resolved "last week" as the **trailing 7 days** (29 Jul → 5 Aug)
— everything else held (window printed, `center_on_user`, `last_n=4` pages, stop at
the window start, distractor excluded and explained in Coverage). The skill's rule 1
carried "last week" only as a parenthetical example of a named period; the model read
past it. **Fix applied to the skill, not the scorer:** rule 1 now states the boundary
outright — "last week" is the previous Monday-to-Sunday week; a named period is never
a trailing window.

## Round 2 — rule 1 reworded (calendar boundary explicit)

```
variant       chars    all  confident  errors
V0-shipped    10972   25%        11%       0     missing:window-start 9/12 · window-end 2/12 · invented-date-param 1/12
V1-none           0    8%         0%       0     window-start 8/12 · window-end 7/12 · coverage-note 3/12 · empty-is-named 3/12 · mention-walk 2/12

per case (V0 / V1): workshop-mentions 1/3 / 0/3 · bare-recap~ 2/3 / 1/3 ·
distractor-excluded 0/3 / 0/3 · quiet-week 0/3 / 0/3
```

The reworded rule landed — replies now choose the calendar week and write
"Monday … Sunday" headers — but the score _dropped_, and the raws show why: the
judge model computes the Monday **one day late** (Mon = 28 Jul against a true Mon
27 Jul) and writes dates day-first ("28 Jul"), and the round-1 scorer accepted
neither. That is weekday arithmetic, not the property under test; a session model
gets `currentDate` and the incident was never an off-by-one. **Fix applied to the
scorer, not the skill:** window checks tolerate ±1 day and both date orders. The
slack cannot blur the calendar-vs-trailing distinction — trailing resolves to the
29th/30th, outside it. (A quiet-week reply from this round is otherwise the
textbook artifact: "nothing recorded" per section, older mentions dated and
labelled as earlier, honest Coverage — failed on the one-day slip alone.)

## Round 3 — scorer slack (±1 day, both date orders); skill text unchanged

```
variant       chars    all  confident  errors
V0-shipped    10972   92%       100%       0     banned:invented-date-param 1/12
V1-none           0   17%         0%       0     window-end 7/12 · window-start 6/12 · subject-entry 3/12 · coverage-note 3/12 · empty-is-named 3/12 · mention-walk 2/12

per case (V0 / V1): workshop-mentions 3/3 / 0/3 · bare-recap~ 2/3 / 2/3 ·
distractor-excluded 3/3 / 0/3 · quiet-week 3/3 / 0/3
```

The gap is categorical on every confident case, and it is the incident's shape:
without the skill the reply carries no absolute window, no mention walk, no
coverage honesty. The one V0 miss is an `invented-date-param` ban scored by the
round-2 regex, which round 2's raws showed can fire on _prose_ — "repeat
get_episodes_for_entity … **until** the oldest episode crosses the window" is the
correct stop condition stated in words, and it matched. The regex now requires an
opening paren so only call arguments are inspected; V1's `bare-recap` 2/3 is the
case's `~` flag earning its keep (the plan-task instruction alone sometimes draws
dates out of a skill-less model — the case is diagnostic, not load-bearing).

## Round 4 — invented-param check paren-anchored; skill text unchanged

```
variant       chars    all  confident  errors
V0-shipped    10972   92%       100%       0     missing:window-start 1/12
V1-none           0    0%         0%       0     window-start 9/12 · window-end 8/12 · mention-walk 3/12 · subject-entry 3/12 · coverage-note 3/12 · empty-is-named 3/12

per case (V0 / V1): workshop-mentions 3/3 / 0/3 · bare-recap~ 2/3 / 0/3 ·
distractor-excluded 3/3 / 0/3 · quiet-week 3/3 / 0/3
```

Two rounds converged at 92% with every confident case at 3/3, against 0–17% for
the same model with the same tools and no skill.

## Round 5 — six clauses folded in from a live end-to-end run

A Sonnet subagent followed the skill verbatim against the real graph and a live
work tracker; its test log fed six clauses back into the text (a repeated-page
guard for broken listing pagination, a fixture/test-data provenance rule, the
late-ingested-item rule, `time_range`'s now-anchoring, tracker page caps and
timezone parsing). This round measures the enlarged text (~12.4k chars).

```
variant       chars    all  confident  errors
V0-shipped    12446   83%        78%       0     window-start 1/12 · window-end 1/12 · unmarked:Atlas 1/12 · unmarked:Quarterly 1/12
V1-none           0   25%        11%       0     window-end 7/12 · window-start 6/12 · subject-entry 3/12 · coverage-note 3/12

per case (V0 / V1): workshop-mentions 3/3 / 0/3 · bare-recap~ 3/3 / 2/3 ·
distractor-excluded 2/3 / 0/3 · quiet-week 2/3 / 1/3
```

Inside round 4's noise (the bench's floor is ~11 points), and the quiet-week
"miss" was the scorer again: the reply wrote "5 Jul … **predates the window**"
— exactly right — and the excuse regex knew "July"/"before" but neither
abbreviated months nor "predates".

## Round 6 — excuse vocabulary widened; certifying round

```
variant       chars    all  confident  errors
V0-shipped    12446  100%       100%       0
V1-none           0   17%        22%       0     window-start 9/12 · window-end 9/12 · mention-walk 3/12 · coverage-note 3/12

per case (V0 / V1): workshop-mentions 3/3 / 0/3 · bare-recap~ 3/3 / 0/3 ·
distractor-excluded 3/3 / 0/3 · quiet-week 3/3 / 2/3
```

Headline across rounds: **the shipped text sits at 83–100% (12/12 in the
certifying round) against 0–25% for the same model, same tools, no skill** —
the incident's failure mode does not survive the skill, and the control never
clears it. The round 1 → 6 path is the useful history: one real skill defect
(calendar-vs-trailing "last week") and three scorer defects (month-first-only
dates, a paren-less ban that punished the correct stop condition written as
prose, an excuse vocabulary blind to "predates"/"Jul") — every one found by
reading raws, not tables. Do not tighten the window or excuse regexes back
without re-reading rounds 2 and 5.

## Round 7 — validity clause added after external review

A PR review comment survived validation: the themed sweep inherits the
server's valid-only default (`include_invalidated=False`, per the tools
reference), so a fact created inside the window and superseded after it —
a reversed decision, a resolved incident — silently never enters the recap.
Neither the canned-result report cases nor the live run had exercised that
path. Rule 4 gained the counter-instruction (windowed sweeps pass
`include_invalidated=true`; superseded items enter labelled), both call
sites point at it, and `bare-recap` now also requires the parameter to be
named — its column is stricter than in rounds 1–6, so compare it only
forward from here.

```
variant       chars    all  confident  errors
V0-shipped    12913   83%        78%       0     missing:mention-walk 1/12 · window-start 1/12 · window-end 1/12
V1-none           0    8%        11%       0     window-start 8/12 · window-end 8/12 · sweep-validity 3/12 · coverage-note 3/12 · mention-walk 2/12 · subject-entry 2/12 · empty-is-named 2/12

per case (V0 / V1): workshop-mentions 2/3 / 0/3 · bare-recap~ 3/3 / 0/3 ·
distractor-excluded 2/3 / 0/3 · quiet-week 3/3 / 1/3
```

The new check earned its keep at once — every V0 `bare-recap` trial named
`include_invalidated` unprompted, one workshop plan even carrying rule 4's
rationale ("reversals are part of the week's story") — while the control
cannot produce it. Both V0 misses are known shapes, read from the raws,
and neither touches the new clause: one workshop-mentions plan jumped
straight to the centered-fact-search fallback on an _assumed_-busy subject
(the walk is the default; the fallback is for observed overflow or visible
bulk — a mild compliance miss worth watching, not yet worth text), and one
distractor-excluded report resolved "last week" as the trailing 7 days —
rule 1's residual, seen intermittently since round 1; that reply still
excluded the June distractor and kept only in-window items. 83% sits in
the measured band (rounds 5–7: 83, 100, 83) over an ~11-point floor.
