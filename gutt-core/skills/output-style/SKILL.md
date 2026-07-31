---
name: output-style
description: "Shape a reply so the answer is the thing the user is left looking at: substance first, no preamble or closing pleasantry, state restated rather than assumed carried, finished work shown concretely, lists capped and ranked, concrete estimates, one next action last. Defines what the closing summary of a turn contains and what it must not be — neither a verbatim echo nor a recap of what you just did. Use this when writing the summary that ends a turn, when the user says the answer got buried or asks for tighter replies, and when something the turn did on the way (a memory capture, a migration, housekeeping) is at risk of becoming the last thing in the reply."
---

# Output style

Apply these to the reply you are writing. They shape the whole reply, and in particular the
summary that closes a turn — the part the user actually reads and carries away.

## The rules

The reply ends in two parts, in this order. Where the turn did something on the way —
recorded a finding, migrated a store, changed a setting — account for it first. Then, always,
the closing summary of the turn: what was delivered, what it means for the user, and what is
still open. Give both where there was bookkeeping and the summary alone where there was not.
Whatever sits at the bottom is what the user is left looking at, and it is the summary, never
the bookkeeping.

That closing summary is not a verbatim echo of text already written above it, and not an
account of what you just did — those are the two ways it goes wrong.

Work the turn had to do along the way is part of finishing it, not an interruption of it: no
"returning to", no "the work this interrupted", no apology for the detour.

## Style for the whole reply

Substance first, no preamble and no closing pleasantry. Restate state rather than assuming
it carried. Show finished work concretely. Cap lists at five and rank them. Concrete
estimates, not vague ones. Matter-of-fact about failures — cause, then fix. Close on one
next action small enough to start now, where anything is still open.

The only thing this file contributes to a fired reason is the one-line pointer under **What
the hook injects** below. No rule ships with it — the rules are stated here once, read when
the skill loads, and cost nothing at fire time.

This list was the first thing measured on that question, and the numbers are worth quoting
precisely rather than as a standing fact. `evals/suites/capture_close` **round 4** scored the
list _inside_ the markers at 67% against 96% for the 878-character block without it, n=24:
335 characters that made the payload worse rather than merely longer. Both figures belong to
that round and to an 878-character block this file no longer contains — round 5 put the same
arm at 54% and did not reproduce the 96%. `FINDINGS.md` records what the measurement does and
does not support; in particular it cannot separate dilution from the list being actively
confusing, so "worse" is the finding and the mechanism is not.

## Writing the closing summary

Build it from four things, in this order: what was delivered, what it means for the user,
what is still open, one next action. Drop any that do not apply — a turn with nothing open
needs no next action, and inventing one to fill the shape is worse than ending.

The test to apply before sending: if the user read only that block, would they have the
answer they asked for? If they would instead learn what you had been doing, rewrite it.

Two failure shapes to check against, since both feel like summarising:

**A verbatim echo** — pasting text from earlier in the reply back down at the end. On a long
turn this doubles the reply, and length is why the summary was needed in the first place.
Say the answer again shorter; do not say the same words again.

**An account of the turn** — "I searched, then found, then wrote, then fixed". This is a
report about your process. The user wants the result, and the process is above already.

## When the turn did something on the way

Some turns end with work that is not the answer: a memory capture, a migration, a config
change, housekeeping. That work is real and the user needs to know it happened — but it is
not what they came for, and it arrives last, which is the worst position for it. So the
reply carries both accounts, in this order, and neither substitutes for the other:

1. **What the turn did on the way.** A few lines: what happened, and anything the user still
   has to decide. That bound is `memory-capture`'s, not this file's — whichever skill owns
   the work also bounds the account of it, and `memory-capture` states the same sentence
   almost verbatim. Omitting the account itself is not an improvement; the user is entitled
   to know a capture was written.
2. **The closing summary.** Last, per the rules above. This is the answer.

Dropping either one is a failure of a different kind: without the first the write is
invisible, and without the second the bookkeeping becomes the turn.

**Example.** A turn that fixed a flaky test and then recorded an Insight about it.

Wrong — an account of the turn, with the work buried above it:

> I searched memory first, found no duplicate, then wrote an Insight episode about the race
> in the fixture teardown. The write is queued. Before that I'd fixed the test.

Right — the work last, the bookkeeping a footnote above it:

> Captured one Insight: the teardown race. Queued, not yet verified.
>
> **The flaky test** — `auth.spec.ts:42` passes reliably now. It was failing about one run
> in nine because teardown closed the pool before the last request drained, so the retry
> hit a dead socket. Fix is an `await` on the drain, in the fixture rather than the test,
> so every case in the file gets it.
>
> Still open: three other suites share that fixture and none have been re-run.
>
> Next: `npm test -- billing.spec.ts`, the shortest of the three.

## When a rule fights the task

The task wins and the shape stays. If a rule would delete the answer itself, keep the
answer. "What are my options" is answered with ranked options and a recommendation first,
not with one path — the options are the substance. Where the user asks to be walked
through something, the body runs as long as the topic needs; still no preamble, still no
closing pleasantry, and still a closing summary.

## What the hook injects

`shared/stop-judge.cjs` appends the region between these markers to every fired capture
reason. It is a pointer to this file, not a copy of it:

<!-- INJECTED:BEGIN -->

Then run the `gutt-claude-code-plugin:output-style` skill and follow it when writing the reply.

<!-- INJECTED:END -->

One line, and it is the whole payload. "Then" is load-bearing rather than decorative: the
region is appended after the judge's own `memory-capture` line, so the two instructions read
in the order they are meant to run.

⚠ **This replaced an 804-character prose copy of the rules above, and the swap is not yet
measured.** What the bench says today, in both directions:

- Against the pointer: the prose block scored **89% pooled over rounds 1–4** against 62% for
  no instruction at all and 66% for a 312-character short rule. On that evidence brevity here
  costs accuracy, and `prompt_pointer` separately confirmed in every run that cutting the
  rationale out of a pointer costs recall outright.
- For the pointer: round 5 put the same block at **54% against 54%** for no instruction, and
  the suite's own zero-length control moved 13 points between rounds — wider than most gaps
  the bench has been used to decide.

So the prose block is the better-evidenced wording and this is a deliberate bet against it,
taken because a payload that restates a skill it could name is duplication on every fire.
`V6-prose-block` in `evals/suites/capture_close/variants.py` is the frozen arm that settles
it; run that suite before treating the pointer as proven.

## References

- `references/origin.md` — where these rules came from, the attribution and licence owed
  for them, and the design decisions behind how they are stored. Read it before rewording
  the rules above, or to cite the source.
- `memory-capture` — the account of what was recorded, which sits above the closing summary.
