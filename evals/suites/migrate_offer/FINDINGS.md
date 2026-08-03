# migrate-offer — what the probe found

Five wordings of the `SessionStart` migration offer, scored on whether the offer reaches
the user without hijacking the turn. `V0-shipped` is read from `offerContext()` in
`gutt-core/hooks/lib/builtin-memory.cjs` at run time, so it cannot drift from what ships.

> ⚠ **The numbers below describe a wording that no longer ships.** `offerContext()` was
> changed after this run: the offer is now collected with **AskUserQuestion** instead of a
> one-line prose mention. Because `V0-shipped` is read from the module at run time, every
> `V0` row below is a record of the _previous_ string — preserved as the live
> `V4-prose-offer` arm so the two can still be compared. **Re-run before citing any number
> here as current**, and treat the ceiling claim in the next paragraph as historical. The
> change was made on a product requirement, not on evidence that it scores as well; the
> clause it replaced is the one this very file identifies as the whole mechanism.

**The shipped wording is at ceiling: 24/24 offered, 24/24 at the end of the reply, 24/24
with the user's question still answered, 0 overreach.** Two independent rounds of 4 trials
across three cases, `claude-sonnet-5`. Nothing here recommends changing it.

Three results matter more than that one.

## The placement clause is the whole mechanism

Removing eleven words — `in one line at the end of your next reply` — takes the offer from
**24/24 to 4/24**.

| variant            | round 1 | round 2 | pooled    |
| ------------------ | ------- | ------- | --------- |
| V0-shipped         | 12/12   | 12/12   | **24/24** |
| V1-no-placement    | 3/12    | 1/12    | **4/24**  |
| V2-no-scoping      | 12/12   | 12/12   | 24/24     |
| V3-sticky          | 12/12   | 12/12   | 24/24     |
| CONTROL-no-context | 0/12    | 0/12    | 0/24      |

The effect is not about placement. Without that clause the offer usually does not appear
**at all** — the model reads the context as background and never surfaces it. This is the
same shape as the Stop judge's `V6`, where _showing_ the skill line got it named 14% of the
time and _stating_ that the reason begins with it got 100%: telling the model where the
output goes is what makes the output happen.

This bench treats gaps under about 10 points as unresolved. This one is 83 points, and it
replicated across two rounds.

## The scoping sentence is unconfirmed — and must not be deleted on these numbers

`gutt-core/hooks/lib/builtin-memory.cjs` says of `— this is housekeeping, so do not interrupt whatever
they actually asked for`: "without it this reads as 'migrate now', and a session opened to
ask one quick question would get a migration run instead of an answer."

`V2-no-scoping` removes it and changes nothing measurable: 24/24 offered, `answered` 100%,
**overreach 0% — the same 0% as the shipped text**.

That is not evidence the sentence is dead weight. Overreach never occurred in _either_
arm, so the probe never created the conditions the sentence guards against. Two reasons it
probably cannot:

- Calls run with `--allowedTools ""`, so the model has no way to actually begin a
  migration and little pull toward announcing one.
- Every case is a single question with an obvious answer. Nothing competes for the turn in
  the way a real session's open task would.

The detector is not the weak link — it fires on `I'll run the migrate-memory skill now`
and stays quiet on `say the word and I'll migrate them`, checked both ways. The missing
piece is a case with genuine pull toward acting. **Verdict: not discriminated.** Anyone
proposing to cut that sentence needs a case where the unscoped wording actually overreaches
first.

## The displacement collision did not reproduce

The probe was built for a specific worry: the capture skill's reporting rule ends the reply
with a TL;DR "placed last, after everything else", and the offer also wants the last line.
Both cannot be last. The `displaced` case constructs that collision directly — offer
context live, a Stop-hook capture injection demanding a TL;DR last.

The shipped text wins it **8/8** across both rounds. The worry was unfounded for `V0`.

It is real for `V1`, and that is where the collision shows its teeth: with no placement
clause, one `displaced` reply came back as 105 characters — `TL;DR: git rev-list --count
HEAD prints the number of commits reachable from HEAD` — the competing instruction having
consumed the entire reply and the offer with it.

`V3-sticky`, written as the fix for a collision that turned out not to need fixing, adds
116 characters and matches `V0` on every column. It is cost without benefit. Rejected.

## The offer is mostly a property of the session model

Same text, same presentation, only the model changed:

| model              | offered      |
| ------------------ | ------------ |
| `claude-sonnet-5`  | 24/24 (100%) |
| `claude-haiku-4-5` | 3/12 (25%)   |

The user's question was answered cleanly in every call on both, so this is not degradation
— the fast model just drops the housekeeping half. A user whose session runs a fast model
sees the offer roughly one time in four.

Whether that is worth fixing is a product question this probe cannot answer, and the fix
would not be in the wording: `V3-sticky` is _stronger_ wording and it scored 0/6 on Haiku's
`simple` case against `V0`'s 1/6.

**This finding was nearly recorded backwards.** A first 1-trial pass read 0/5 on Haiku and
was written up here as "the offer never fires on the fast model". At 6 trials it is 25%.
One trial per cell is not a measurement — the same lesson `stop_judge/FINDINGS.md` records
as an 11-point spread on an unchanged prompt.

## What this probe cannot decide

- **Frontier models are untested.** Production runs a frontier model; the numbers above
  are `claude-sonnet-5` and `claude-haiku-4-5`.
- **Overreach has no natural firing vector here** — see above. The most valuable next case
  is a session with real work in flight, where interrupting costs something.
- **The channel is folded into the prompt.** The real offer arrives as its own
  `SessionStart` context block before the first user message; this presents it under the
  same label inside the prompt. Identical for every variant, so comparisons hold, but a
  live `--debug-file` run is what would confirm an absolute rate.
- **`named_skill` is inconsistent and unexplained** — 50–100% on `V0`. When the offer does
  not name `migrate-memory`, a user who accepts leaves the agent to find the skill by
  description. Not scored as a failure here; worth a look.
- **One store size.** The text carries a note count (35 here). Whether a store of 2 or 300
  changes how the model treats the offer is untested.
