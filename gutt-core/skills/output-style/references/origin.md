# Where these rules came from

Background for the rules in `../SKILL.md`. Nothing here is injected into a fired reason —
the hook reads only the delimited block — and nothing here is an instruction.

## The problem they solve

Something other than the answer gets to write the end of a turn. When the Stop judge
fires, the reason is fed back as a system message, `memory-capture` runs, and the reply the
user is left looking at closes on capture bookkeeping — what was deduped, what was written,
which tier it was. The thing they asked for is somewhere above that, or gone.

That is structural rather than a wording slip: a hook can interpose between the user and
the end of their turn, so the shape of a reply has to be stated somewhere rather than left
to whatever the turn happened to end on.

The rules are nonetheless written for **any** closing summary, not for the capture path
alone, and that is deliberate. A style that only described how to recover from a capture
would be a patch on one hook rather than an account of how a turn should end, and it would
say nothing about the majority of turns, where the judge passes and nothing is injected —
which want the same shape for a cheaper reason: it is the right shape anyway. (No pass rate is
quoted because this repo does not measure one. The nearest figure,
`evals/suites/stop_judge/FINDINGS.md`, reports a false-fire rate on a labelled corpus, which
is a different quantity from how often real turns pass.) Where the rules are injected
automatically is a narrower question than what they cover, and the answer to it today is the
one path.

## Attribution

Adapted from [`ayghri/i-have-adhd`](https://github.com/ayghri/i-have-adhd)
(`skills/i-have-adhd/SKILL.md`), MIT licensed, © 2026 Ayoub Ghriss. This repo is MIT too, so
the licences are compatible.

The upstream copyright line is reproduced above deliberately. This file makes no claim about
what the licence does or does not require — that is not ours to assert — so the operating rule
is the conservative one: **if you copy substantial wording from the upstream skill into this
repo, carry the MIT copyright and permission notice with it.** What was taken here is the
mechanics rather than the wording (see below), and the credit is given regardless of whether
anything obliged it.

**Adapted, not copied.** Taken: the mechanics that solve the problem above — lead with
substance rather than framing, restate state each turn instead of assuming the reader
carried it, make finished work visible rather than burying it in a recap, cap and rank
lists, close on one concrete next action, stay matter-of-fact, prefer concrete estimates.

Narrowed: upstream has both "lead with action, not context" and "end with one concrete next
action". Only the second survives here — the first is about where a turn's _substance_ goes,
which the rules above already cover from the other end.

**Inverted, and this is the largest divergence.** Upstream's tenth rule forbids a closing
recap outright: "No preamble, recap, or closing pleasantries. Start with the answer. End when
the answer is done." This skill _mandates_ a closing summary, which is the whole point of
GP-927. The disagreement is real and the resolution is that the two are solving different
problems. Upstream addresses a reply nobody interrupted, where a recap is pure redundancy and
the answer is still the last thing on screen. Here a hook interposes between the answer and
the end of the turn, so without a closing summary the last thing on screen is bookkeeping.
Both rules serve the same goal — leave the user looking at the answer — and land opposite
because the hook changed what sits at the bottom. Note that "no preamble" and "no closing
pleasantry" were taken unchanged; it is only the recap that flips.

Dropped: the ADHD framing and its neurocognitive argument. There the reason to lead with
substance is a reader's working-memory load. Here it is the interposing hook. The mechanics
survive the change of cause; the rationale does not, and inheriting it would leave this
repo asserting a premise it has no evidence for. Also dropped: the persistent
on-until-cancelled mode (upstream's `~/.claude/.i-have-adhd-always`), which has no analogue
here — the Stop hook decides when the rules apply.

## Two decisions taken rather than inherited

**`disable-model-invocation: true` — not set.** The case for setting it is real: the only
automatic consumer is the Stop hook, which injects the block and never loads this skill, so
a model that also loads the skill on the capture path reads the same rules twice. The case
against is that we have no measurement of what the field does to a _skill_ — this repo uses
it only on `commands/gutt.md`, and `docs/plugin-platform-reference.md` does not cover skill
frontmatter — and a field that quietly delists the skill would cost more than the
duplication it prevents. Left unset pending a probe, which is the standing rule here for
unverified platform behaviour.

**Persistent, on-until-cancelled mode — dropped.** The baseline is a mode the reader turns
on and off. This is a description of how one path closes. A session-wide toggle would be
the always-on style that `../SKILL.md` puts out of scope, arriving through the wrong door.

## Editing the block — read this first

`../SKILL.md` carries the rules between `<!-- INJECTED:BEGIN -->` and
`<!-- INJECTED:END -->`. Those bytes are not only documentation: `shared/stop-judge.cjs`
(`readStyleBlock`) reads that region at Stop time and appends it verbatim to a fired
capture's reason. Three consequences for anyone rewording it:

- **Keep it self-sufficient.** On that path nothing loads `SKILL.md`, so a rule that
  depends on the surrounding sections does not arrive.
- **Keep it short.** It shares a budget with the judge's own reason and the `hitl`
  confirmation text. `tests/hook-architecture.test.cjs` fails if it grows past the slack;
  `tests/stop-capture.test.cjs` measures the composed worst case.
- **Keep the mechanism out of it.** No mention of hooks, events or file paths — the agent
  reading a fired reason has no model of any of that, and the words would cost budget while
  explaining nothing it can act on. Same reason `SKILL.md` itself stays free of them.

## Why the text lives in the skill rather than in the hook

Three homes were available, and the repo had been arguing two of them at once.

1. **Hook-only constant.** Loses the human-readable, user-invocable skill.
2. **Skill-only.** Never applies on the capture path: the fired reason names
   `memory-capture`, nothing loads this skill, so the rule would be written down and inert
   exactly when it matters.
3. **Single-sourced** — the skill holds the text, the hook reads a delimited region of it.
   The only option where the bytes an agent receives and the bytes a human reads are the
   same bytes. Implemented; see `shared/stop-judge.cjs`, `readStyleBlock`.

This resolves the objection recorded in `memory-capture/SKILL.md`, which argued against any
procedural text reaching the fired reason. That argument is about **duplication** — a rule
stated in the reason and again in a skill loaded moments later is paid for twice — and it
still holds for anything `memory-capture` itself covers. It does not reach text that exists
in one place and is loaded on no other path.
